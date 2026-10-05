"""Shared fixtures: an in-process LegacyCore mock and an isolated project root pointing at it."""

from __future__ import annotations

import os
import re
import shutil
import socket
import threading
import time
from collections.abc import Iterator
from pathlib import Path

import httpx
import pytest
import uvicorn
import yaml

from mockbank.app import app as bank_app
from rote.runtime import Settings

REPO = Path(__file__).resolve().parent.parent

os.environ.setdefault("ACME_LEGACYCORE_USERNAME", "TELLER01")
os.environ.setdefault("ACME_LEGACYCORE_PASSWORD", "acme-demo-pass")
os.environ.setdefault("BAYVIEW_LEGACYCORE_USERNAME", "OPS_USER")
os.environ.setdefault("BAYVIEW_LEGACYCORE_PASSWORD", "bayview-demo-pass")


def _free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


@pytest.fixture(scope="session")
def bank_url() -> Iterator[str]:
    port = _free_port()
    server = uvicorn.Server(uvicorn.Config(bank_app, host="127.0.0.1", port=port, log_level="error"))
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    url = f"http://127.0.0.1:{port}"
    for _ in range(100):
        try:
            httpx.get(url + "/", timeout=0.5)
            break
        except httpx.HTTPError:
            time.sleep(0.05)
    yield url
    server.should_exit = True
    thread.join(timeout=5)


@pytest.fixture(scope="module")
def ui_url(recorded: Settings, tmp_path_factory: pytest.TempPathFactory) -> Iterator[str]:
    """`rote ui` on a free port, serving the recorded test library."""
    from rote.web.server import create_app

    port = _free_port()
    url = f"http://127.0.0.1:{port}"
    settings = Settings(**{**recorded.__dict__, "runs_dir": tmp_path_factory.mktemp("ui-runs")})
    server = uvicorn.Server(uvicorn.Config(create_app(settings, url), host="127.0.0.1", port=port, log_level="error"))
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    for _ in range(100):
        try:
            httpx.get(url + "/api/status", timeout=1)
            break
        except httpx.HTTPError:
            time.sleep(0.05)
    yield url
    server.should_exit = True
    thread.join(timeout=10)


@pytest.fixture(scope="session")
def project(tmp_path_factory: pytest.TempPathFactory, bank_url: str) -> Path:
    """A throwaway ROTE_HOME: app profile, policy and tenants rewritten to the test bank's port."""
    root = tmp_path_factory.mktemp("rote-home")
    (root / "capabilities" / "legacycore").mkdir(parents=True)
    shutil.copy(REPO / "capabilities" / "legacycore" / "app.yaml", root / "capabilities" / "legacycore" / "app.yaml")
    (root / "config" / "tenants").mkdir(parents=True)
    policy = (REPO / "config" / "policy.yaml").read_text()
    policy = re.sub(r"http://(127\.0\.0\.1|localhost):8600", bank_url, policy)
    (root / "config" / "policy.yaml").write_text(policy)
    for tenant in (REPO / "config" / "tenants").glob("*.yaml"):
        data = yaml.safe_load(tenant.read_text().replace("http://127.0.0.1:8600", bank_url))
        for binding in data["apps"].values():
            binding["overrides"] = []  # tests add the overrides they exercise
        (root / "config" / "tenants" / tenant.name).write_text(yaml.safe_dump(data, sort_keys=False))
    shutil.copytree(REPO / "evals" / "datasets", root / "evals" / "datasets")
    return root


@pytest.fixture
def settings(project: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Settings:
    monkeypatch.setenv("ROTE_RUNS_DIR", str(tmp_path / "runs"))
    monkeypatch.setenv("ROTE_CONSOLE_PORT", str(_free_port()))
    return Settings.load(project)


@pytest.fixture(autouse=True)
def reset_bank(request: pytest.FixtureRequest) -> None:
    if "bank_url" in request.fixturenames:
        httpx.post(request.getfixturevalue("bank_url") + "/__admin/reset")


def set_faults(bank_url: str, tenant: str, **faults: object) -> None:
    httpx.put(f"{bank_url}/__admin/faults/{tenant}", json=faults).raise_for_status()


@pytest.fixture(scope="session")
def recorded(project: Path, bank_url: str, tmp_path_factory: pytest.TempPathFactory) -> Settings:
    """Record both capabilities once per test session (scripted decider), approve them, share them."""
    import asyncio

    from rote.artifact.store import Library
    from rote.discovery.agent import DiscoveryAgent, DiscoveryRequest
    from rote.discovery.decider import ScriptedDecider
    from rote.evals.standins import SESSION_SCRIPT, balance_script
    from rote.runtime import open_session

    httpx.post(bank_url + "/__admin/reset")
    os.environ["ROTE_RUNS_DIR"] = str(tmp_path_factory.mktemp("runs"))
    settings = Settings.load(project)

    async def discover(script: list, goal: str, kind: str, inputs: dict[str, str]) -> None:
        async with open_session(
            settings, kind="discovery", subject=goal, label=kind, tenant_id="acme", app_id="legacycore", console=False
        ) as session:
            request = DiscoveryRequest(goal=goal, inputs=inputs, kind=kind)  # type: ignore[arg-type]
            result = await DiscoveryAgent(session, ScriptedDecider(script), request).run()
        assert result.status == "succeeded", result.failure
        library = Library(settings.root)
        cap = library.capability(result.capability or "")
        cap.status = "approved"
        library.save(cap)

    asyncio.run(discover(SESSION_SCRIPT, "Sign on to LegacyCore", "session", {}))
    asyncio.run(
        discover(
            balance_script("12345"),
            "Look up member 12345 and read their savings balance",
            "task",
            {"member_id": "12345"},
        )
    )
    return settings
