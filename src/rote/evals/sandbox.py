"""Hermetic environments for evals: a private LegacyCore mock and a throwaway library per case.

Evals never touch the mock you started with ``make bank``, its fault switches, your capability library
or ``runs/``: every trial gets a fresh copy of the library and tenant config, rewritten to point at a
mock bank on a free port, so cases cannot leak state into each other (probes and discoveries write new
versions) and scores are reproducible.
"""

from __future__ import annotations

import asyncio
import dataclasses
import shutil
import socket
import threading
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

import httpx
import uvicorn
import yaml

from ..runtime import Settings
from .dataset import LibraryScope


def _free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def _origin(url: str) -> str:
    parts = urlsplit(url)
    return f"{parts.scheme}://{parts.netloc}"


class MockBank:
    """The bundled LegacyCore mock on a private port (or an existing one, e.g. a test fixture's)."""

    def __init__(self, url: str | None = None):
        self.url = url
        self._server: uvicorn.Server | None = None
        self._thread: threading.Thread | None = None

    async def start(self) -> str:
        if self.url is not None:
            return self.url
        from mockbank.app import app as bank_app

        port = _free_port()
        self._server = uvicorn.Server(uvicorn.Config(bank_app, host="127.0.0.1", port=port, log_level="error"))
        self._thread = threading.Thread(target=self._server.run, name="eval-mockbank", daemon=True)
        self._thread.start()
        self.url = f"http://127.0.0.1:{port}"
        async with httpx.AsyncClient(timeout=0.5) as client:
            for _ in range(200):
                try:
                    await client.get(self.url + "/")
                    return self.url
                except httpx.HTTPError:
                    await asyncio.sleep(0.05)
        raise RuntimeError("the eval mock bank did not start")

    async def stop(self) -> None:
        if self._server is not None and self._thread is not None:
            self._server.should_exit = True
            await asyncio.to_thread(self._thread.join, 10)
            self._server = None

    async def prepare(self, tenant_path: str, faults: dict[str, Any]) -> None:
        """Reset every tenant, then inject this case's faults."""
        assert self.url is not None, "start() the bank first"
        async with httpx.AsyncClient(timeout=5) as client:
            (await client.post(f"{self.url}/__admin/reset")).raise_for_status()
            if faults:
                (await client.put(f"{self.url}/__admin/faults/{tenant_path}", json=faults)).raise_for_status()


def _is_session_capability(path: Path) -> bool:
    data = yaml.safe_load(path.read_text()) or {}
    return data.get("kind") == "session" and data.get("status") == "approved"


def make_workspace(
    base: Settings,
    dest: Path,
    bank_url: str,
    *,
    library: LibraryScope = "all",
    strip_overrides: tuple[str, ...] = (),
    pin: str | None = None,
) -> Settings:
    """Copy the library and config into ``dest`` with every tenant re-pointed at ``bank_url``.

    ``library`` picks what the sandbox starts with: everything (``all``), only app profiles and approved
    session capabilities (``session`` — what task discovery needs to start signed on), or app profiles
    only (``app``). Tenants named in ``strip_overrides`` lose their reviewed overrides. ``pin``
    (``id@version``) drops later versions of that capability, recreating the library as it was then.
    """
    from ..artifact.store import version_key

    pin_id, _, pin_version = (pin or "").partition("@")
    dest.mkdir(parents=True, exist_ok=True)
    source_caps = base.root / "capabilities"
    for app_dir in sorted(p for p in source_caps.iterdir() if p.is_dir()) if source_caps.exists() else []:
        target = dest / "capabilities" / app_dir.name
        target.mkdir(parents=True, exist_ok=True)
        for path in sorted(app_dir.glob("*.yaml")):
            cap_id, _, version = path.stem.partition("@")
            keep = (
                path.name == "app.yaml" or library == "all" or (library == "session" and _is_session_capability(path))
            ) and not (pin_version and cap_id == pin_id and version_key(version) > version_key(pin_version))
            if keep:
                shutil.copy(path, target / path.name)

    origins: set[str] = set()
    tenants_out = dest / "config" / "tenants"
    tenants_out.mkdir(parents=True, exist_ok=True)
    for path in sorted((base.root / "config" / "tenants").glob("*.yaml")):
        data = yaml.safe_load(path.read_text())
        for binding in data.get("apps", {}).values():
            origin = _origin(binding["base_url"])
            origins.add(origin)
            binding["base_url"] = bank_url + binding["base_url"][len(origin) :]
            if data["id"] in strip_overrides:
                binding["overrides"] = []
        (tenants_out / path.name).write_text(yaml.safe_dump(data, sort_keys=False))

    policy = yaml.safe_load(base.policy_path.read_text())
    policy["allowed_origins"] = sorted(
        {bank_url if _origin(o) in origins else o for o in policy.get("allowed_origins", [])} | {bank_url}
    )
    policy_path = dest / "config" / "policy.yaml"
    policy_path.write_text(yaml.safe_dump(policy, sort_keys=False))
    return dataclasses.replace(base, root=dest, policy_path=policy_path)


def tenant_path(settings: Settings, tenant: str, app: str = "legacycore") -> str:
    """The mock bank addresses tenants by URL path (``/acme/``); fault switches use the same key."""
    from ..artifact.store import Library

    return urlsplit(Library(settings.root).tenant(tenant).apps[app].base_url).path.strip("/")
