"""The engine API end to end: its contract, streaming, a human handoff over the operator API, and the engine token.

The web UI itself is served and tested by the control plane (backend/ and ui/); this is the API it calls.
"""

from __future__ import annotations

import time

import httpx
import pytest
from starlette.testclient import TestClient

from rote.runtime import Settings
from rote.web.server import create_app

pytestmark = pytest.mark.browser
BALANCE = "legacycore.member.get_savings_balance"


def test_api_contract(ui_url: str) -> None:
    status = httpx.get(f"{ui_url}/api/status").json()
    assert {t["id"] for t in status["tenants"]} == {"acme", "bayview"}
    assert all(t["reachable"] for t in status["tenants"])
    caps = {c["id"]: c for c in httpx.get(f"{ui_url}/api/capabilities").json()}
    assert caps[BALANCE]["status"] == "approved"
    assert caps[BALANCE]["inputs"]["member_id"]["sensitivity"] == "pii"
    detail = httpx.get(f"{ui_url}/api/capabilities/{BALANCE}", params={"tenant": "bayview"}).json()
    assert detail["layers"][0].startswith(f"capability {BALANCE}")
    assert detail["tool"]["name"] == "legacycore__member__get_savings_balance"
    assert any(h["source"] == "app" and h["id"] == "session_expired" for h in detail["handlers"])
    missing = httpx.post(f"{ui_url}/api/runs", json={"kind": "replay", "capability": "nope.missing", "tenant": "acme"})
    assert missing.status_code == 404, "an unknown capability is a missing resource, checked before anything starts"
    invalid = httpx.post(f"{ui_url}/api/runs", json={"kind": "teleport", "tenant": "acme"})
    assert invalid.status_code == 422
    assert httpx.get(f"{ui_url}/api/not-a-route").status_code == 404


def test_replay_runs_and_streams(ui_url: str) -> None:
    run_id = httpx.post(
        f"{ui_url}/api/runs",
        json={
            "kind": "replay",
            "capability": BALANCE,
            "tenant": "acme",
            "inputs": {"member_id": "99999"},
            "escalation": "fail",
            "faults": {},
        },
        timeout=60,
    ).json()["id"]
    with httpx.stream("GET", f"{ui_url}/api/runs/{run_id}/stream", timeout=120) as response:
        lines = [line for line in response.iter_lines() if line.startswith("event:")]
    assert lines[-1] == "event: end"
    assert len(lines) > 10
    run = httpx.get(f"{ui_url}/api/runs/{run_id}").json()
    # The test library has no probed MEMBER_NOT_FOUND handler, so this is an honest, debuggable failure.
    assert run["status"] == "failed"
    # A finished run still held in memory reports the duration it recorded, like one read from disk.
    assert run["active"] is False
    assert isinstance(run["duration_ms"], int)
    assert run["duration_ms"] > 0
    listed = next(r for r in httpx.get(f"{ui_url}/api/runs").json() if r["id"] == run_id)
    assert listed["duration_ms"] == run["duration_ms"]
    assert run["result"]["failure"]["code"] == "TARGET_NOT_FOUND"
    assert "NO RECORDS MATCH" in run["result"]["failure"]["observed"]
    assert httpx.get(f"{ui_url}/api/runs/{run_id}/files/report.html").status_code == 200
    escape = httpx.get(f"{ui_url}/api/runs/{run_id}/files/..%2F..%2F..%2F..%2Fetc%2Fpasswd")
    assert escape.status_code == 404, "files outside the run directory must never be served"


def test_operator_handoff_over_the_api(ui_url: str) -> None:
    """An unknown screen pauses the replay; an operator claims the live session, clicks, and hands back."""
    run_id = httpx.post(
        f"{ui_url}/api/runs",
        json={
            "kind": "replay",
            "capability": BALANCE,
            "tenant": "acme",
            "inputs": {"member_id": "12345"},
            "escalation": "wait",
            "faults": {"compliance_popup": True},
        },
        timeout=60,
    ).json()["id"]
    operator = f"{ui_url}/api/runs/{run_id}/operator"

    deadline = time.monotonic() + 240
    while ((state := httpx.get(f"{operator}/state").json())["active"] or {}).get("status") != "open":
        assert time.monotonic() < deadline, "the run never asked for a human"
        time.sleep(0.5)
    intervention = state["active"]["id"]
    assert state["control"]["state"] == "awaiting_human"

    epoch = httpx.post(f"{operator}/interventions/{intervention}/claim", json={"operator": "dana.ops"}).json()["epoch"]
    stale = httpx.post(
        f"{operator}/input", json={"operator": "dana.ops", "epoch": epoch - 1, "kind": "press", "key": "Tab"}
    )
    assert stale.status_code == 409, "input carrying a stale lease epoch is fenced off"
    intruder = httpx.post(
        f"{operator}/input", json={"operator": "mallory", "epoch": epoch, "kind": "press", "key": "Tab"}
    )
    assert intruder.status_code == 409, "only the lease holder may act"

    elements = httpx.get(f"{operator}/screen").json()["elements"]
    for element in (
        next(e for e in elements if e["role"] == "checkbox"),
        next(e for e in elements if e["role"] == "button" and e["name"] == "Continue"),
    ):
        click = {"operator": "dana.ops", "epoch": epoch, "kind": "click", "x": element["x"], "y": element["y"]}
        httpx.post(f"{operator}/input", json=click, timeout=30).raise_for_status()
    httpx.post(
        f"{operator}/interventions/{intervention}/resolve",
        json={
            "operator": "dana.ops",
            "epoch": epoch,
            "resolution": "step_completed",
            "note": "Completed the attestation",
        },
    ).raise_for_status()

    with httpx.stream("GET", f"{ui_url}/api/runs/{run_id}/stream", timeout=240) as response:
        assert any(line == "event: end" for line in response.iter_lines())
    run = httpx.get(f"{ui_url}/api/runs/{run_id}").json()
    assert run["status"] == "succeeded"
    assert run["result"]["outputs"]["savings_balance"] == "2418.07"
    [record] = run["interventions"]
    assert record["claimed_by"] == "dana.ops"
    assert record["resolution"] == "step_completed"
    assert any("Continue" in action["description"] for action in record["human_actions"])


def test_engine_token_guards_every_route_but_health(recorded: Settings) -> None:
    token = "t" * 32
    app = create_app(recorded, "http://localhost:3000", bind_url="http://127.0.0.1:8700", engine_token=token)
    with TestClient(app, base_url="http://127.0.0.1:8700") as client:
        assert client.get("/api/health").status_code == 200, "probes need no token"
        assert client.get("/api/capabilities").status_code == 401
        assert client.get("/api/capabilities", headers={"x-engine-token": "wrong"}).status_code == 401
        assert client.post("/mcp", json={}).status_code == 401, "MCP is behind the token too"
        assert client.get("/api/capabilities", headers={"x-engine-token": token}).status_code == 200
        foreign = client.get("/api/health", headers={"host": "evil.example"})
        assert foreign.status_code == 400, "requests must name the bound host"
