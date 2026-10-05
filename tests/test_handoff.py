"""Human-in-the-loop: an unknown screen pauses replay, an operator takes the *same* live session through
the console API, acts, and hands control back; the run then completes."""

from __future__ import annotations

import asyncio
import json
from pathlib import Path

import httpx
import pytest

from rote.artifact.resolve import resolve
from rote.artifact.store import Library
from rote.handoff.control import Actor, ControlError, LeaseState, SessionControl
from rote.replay.engine import ReplayEngine, ReplayOptions
from rote.replay.result import RunStatus
from rote.runtime import Settings, open_session

from .conftest import set_faults
from .test_end_to_end import BALANCE

pytestmark = pytest.mark.browser


async def operator(console: str, *, resolution: str = "step_completed") -> dict:
    """A stand-in for a person at the console: look at the screen, take control, act, hand back."""
    async with httpx.AsyncClient(base_url=console, timeout=10) as client:
        for _ in range(300):
            state = (await client.get("/api/state")).json()
            if state["active"]:
                break
            await asyncio.sleep(0.1)
        else:
            raise AssertionError("no intervention was raised")
        active = state["active"]
        assert state["control"]["state"] == "awaiting_human"
        epoch = (await client.post(f"/api/interventions/{active['id']}/claim", json={"operator": "dana"})).json()[
            "epoch"
        ]

        screen = (await client.get("/api/screen")).json()["elements"]
        checkbox = next(e for e in screen if e["role"] == "checkbox")
        cont = next(e for e in screen if e["role"] == "button" and e["name"] == "Continue")
        for target in (checkbox, cont):
            response = await client.post(
                "/api/input",
                json={"operator": "dana", "epoch": epoch, "kind": "click", "x": target["x"], "y": target["y"]},
            )
            assert response.status_code == 200, response.text
        await asyncio.sleep(1.0)
        response = await client.post(
            f"/api/interventions/{active['id']}/resolve",
            json={
                "operator": "dana",
                "epoch": epoch,
                "resolution": resolution,
                "note": "completed the annual attestation",
            },
        )
        assert response.status_code == 200, response.text

        stale = await client.post(
            "/api/input", json={"operator": "dana", "epoch": epoch, "kind": "click", "x": 5, "y": 5}
        )
        assert stale.status_code == 409, "input with a stale lease epoch must be rejected after hand-back"
        return active


async def test_operator_takes_over_live_session_and_hands_back(recorded: Settings, bank_url: str) -> None:
    set_faults(bank_url, "acme", compliance_popup=True)
    library = Library(recorded.root)
    cap = library.capability(BALANCE)
    async with open_session(
        recorded, kind="replay", subject=cap.ref, label=cap.id, tenant_id="acme", app_id="legacycore", console=True
    ) as session:
        engine = ReplayEngine(
            surface=session.surface,
            library=library,
            policy=session.policy,
            redactor=session.redactor,
            log=session.log,
            broker=session.broker,
            options=ReplayOptions(escalation="wait", escalation_timeout_s=60),
        )
        assert session.console_url
        run = asyncio.create_task(engine.run(resolve(cap, session.app, session.tenant), {"member_id": "12345"}))
        raised = await operator(session.console_url)
        result = await run

    assert raised["reason_code"] == "UNEXPECTED_STATE"
    assert result.status is RunStatus.SUCCEEDED, result.failure
    assert result.outputs
    assert result.outputs["savings_balance"] == "2418.07"
    assert result.interventions == [raised["id"]]
    record = json.loads((Path(result.evidence_dir or "") / "interventions" / f"{raised['id']}.json").read_text())
    assert record["resolution"] == "step_completed"
    assert record["claimed_by"] == "dana"
    described = " ".join(a["description"] for a in record["human_actions"])
    assert "checkbox" in described
    assert "Continue" in described
    events = [json.loads(line) for line in (Path(result.evidence_dir or "") / "events.jsonl").read_text().splitlines()]
    transitions = [(e["from"]["state"], e["to"]["state"]) for e in events if e["type"] == "control.changed"]
    assert transitions == [("automated", "awaiting_human"), ("awaiting_human", "human"), ("human", "automated")]


async def test_escalation_disabled_fails_fast_with_evidence(recorded: Settings, bank_url: str) -> None:
    set_faults(bank_url, "acme", compliance_popup=True)
    from .test_end_to_end import replay

    result = await replay(recorded, BALANCE, member_id="12345")
    assert result.status is RunStatus.FAILED
    assert result.failure
    assert result.failure.code.value == "UNEXPECTED_STATE"
    assert "COMPLIANCE ATTESTATION" in (result.failure.observed or "")


def test_lease_is_enforced_and_fenced() -> None:
    control = SessionControl("s1")
    automation = Actor.automation("run")
    control.ensure(automation)
    control.pause_for_human("stuck")
    assert control.state is LeaseState.AWAITING_HUMAN
    with pytest.raises(ControlError):
        control.ensure(automation)  # nobody acts while waiting for a human
    epoch = control.grant("dana")
    control.ensure(Actor.human("dana", epoch))
    with pytest.raises(ControlError):
        control.ensure(Actor.human("eve", epoch))  # not the holder
    with pytest.raises(ControlError):
        control.ensure(automation)  # automation is locked out while a human drives
    control.hand_back("dana", epoch, "done")
    with pytest.raises(ControlError):
        control.ensure(Actor.human("dana", epoch))  # stale lease after hand-back
    control.ensure(automation)


async def test_console_page_renders_without_script_errors(recorded: Settings) -> None:
    library = Library(recorded.root)
    cap = library.capability(BALANCE)
    async with open_session(
        recorded, kind="replay", subject=cap.ref, label=cap.id, tenant_id="acme", app_id="legacycore", console=True
    ) as session:
        page = await session.surface.browser.new_page()
        errors: list[str] = []
        page.on("pageerror", lambda exc: errors.append(str(exc)))
        await page.goto(session.console_url or "")
        await page.wait_for_function("document.getElementById('lease').textContent.includes('automated')")
        await page.close()
    assert errors == []
