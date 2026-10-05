"""The agent-facing API: REST invocation and the MCP server, end to end against the live mock."""

from __future__ import annotations

import os
import sys
import time
from pathlib import Path

import httpx
import pytest
from mcp import Client
from mcp.client.stdio import StdioServerParameters

from rote.runtime import Settings

pytestmark = pytest.mark.browser
BALANCE = "legacycore.member.get_savings_balance"
TOOL = "legacycore__member__get_savings_balance"


def test_invoke_returns_the_result_contract(ui_url: str) -> None:
    response = httpx.post(
        f"{ui_url}/api/capabilities/{BALANCE}/invoke",
        json={"inputs": {"member_id": "12345"}, "wait_s": 600},  # hold for the result even on a loaded machine
        timeout=620,
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["status"] == "succeeded"
    assert body["capability"].startswith(f"{BALANCE}@")
    assert body["outputs"] == {"savings_balance": "2418.07", "member_name": "SAMPLE, JORDAN Q"}
    assert "failure" not in body
    run = httpx.get(f"{ui_url}{body['links']['run']}").json()
    assert run["status"] == "succeeded"
    assert run["kind"] == "replay"
    assert body["links"]["ui"].endswith(f"/runs/{body['run_id']}")


def test_invoke_hands_back_a_run_to_poll_when_it_takes_too_long(ui_url: str) -> None:
    response = httpx.post(
        f"{ui_url}/api/capabilities/{BALANCE}/invoke",
        json={"inputs": {"member_id": "20417"}, "wait_s": 0.05},
        timeout=60,
    )
    assert response.status_code == 202, response.text
    assert response.headers["location"] == response.json()["links"]["run"]
    assert response.json()["status"] == "running"
    deadline = time.monotonic() + 90
    while (run := httpx.get(ui_url + response.headers["location"]).json())["active"]:
        assert time.monotonic() < deadline
        time.sleep(0.3)
    assert run["status"] == "succeeded"
    assert run["result"]["outputs"]["savings_balance"] == "15002.50"


def test_invoke_rejects_bad_calls_before_starting_a_browser(ui_url: str) -> None:
    runs_before = len(httpx.get(f"{ui_url}/api/runs").json())
    bad = httpx.post(f"{ui_url}/api/capabilities/{BALANCE}/invoke", json={"inputs": {"member_id": "12-AB", "pin": "1"}})
    assert bad.status_code == 422
    assert set(bad.json()["problems"]) == {
        "unknown input 'pin'",
        "input 'member_id' does not match the required pattern ^[0-9]{5,10}$",
    }
    assert httpx.post(f"{ui_url}/api/capabilities/no.such/invoke", json={}).status_code == 404
    assert httpx.post(f"{ui_url}/api/capabilities/{BALANCE}/invoke", json={"tenant": "x"}).status_code == 404
    assert httpx.post(f"{ui_url}/api/capabilities/legacycore.session.sign_on/invoke", json={}).status_code == 400
    assert len(httpx.get(f"{ui_url}/api/runs").json()) == runs_before, "nothing may start for a rejected call"


def test_api_hardening(ui_url: str) -> None:
    assert httpx.get(f"{ui_url}/api/health").json()["status"] == "ok"
    # DNS rebinding: a page on another origin that resolves to 127.0.0.1 names its own host.
    assert httpx.get(f"{ui_url}/api/health", headers={"host": "attacker.example"}).status_code == 400
    missing = httpx.get(f"{ui_url}/api/capabilities/{BALANCE}", params={"tenant": "nobody"})
    assert missing.status_code == 404
    assert "/" not in missing.json()["detail"].split("expected")[0], "no filesystem paths in errors"
    spec = httpx.get(f"{ui_url}/api/openapi.json").json()
    assert "/api/capabilities/{capability_id}/invoke" in spec["paths"]
    assert {t["name"] for t in spec["tags"]} >= {"agents", "runs", "operator", "evals"}


async def test_mcp_lists_capabilities_as_tools_and_calls_them(ui_url: str) -> None:
    async with Client(f"{ui_url}/mcp") as client:
        listed = await client.list_tools()
        tool = next(t for t in listed.tools if t.name == TOOL)
        assert tool.annotations is not None
        assert tool.annotations.read_only_hint is False  # reversible: it signs on and navigates
        assert tool.input_schema["properties"]["tenant"]["enum"] == ["acme", "bayview"]
        assert tool.input_schema["required"] == ["member_id"]

        ok = await client.call_tool(TOOL, {"member_id": "12345"})
        assert not ok.is_error
        assert ok.structured_content is not None
        assert ok.structured_content["status"] == "succeeded"
        assert ok.structured_content["outputs"]["savings_balance"] == "2418.07"

        bad = await client.call_tool(TOOL, {"member_id": "nope"})
        assert bad.is_error
        assert "does not match the required pattern" in getattr(bad.content[0], "text", "")


async def test_mcp_over_stdio(recorded: Settings, tmp_path: Path) -> None:
    """`rote mcp`: the same tools over stdio, as Claude Desktop or an IDE would launch them."""
    keep = ("PATH", "HOME", "PLAYWRIGHT_BROWSERS_PATH")
    env = {k: v for k, v in os.environ.items() if k in keep or k.endswith(("_USERNAME", "_PASSWORD"))}
    env |= {"ROTE_HOME": str(recorded.root), "ROTE_RUNS_DIR": str(tmp_path / "runs")}
    server = StdioServerParameters(command=str(Path(sys.executable).with_name("rote")), args=["mcp"], env=env)
    async with Client(server) as client:
        assert TOOL in {t.name for t in (await client.list_tools()).tools}
        result = await client.call_tool(TOOL, {"member_id": "20417"})
        assert result.structured_content is not None
        assert result.structured_content["status"] == "succeeded"
        assert result.structured_content["outputs"]["savings_balance"] == "15002.50"
    assert any((tmp_path / "runs").glob("*/report.html")), "the call left its evidence where the UI lists runs"
