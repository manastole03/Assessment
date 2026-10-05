"""Discovery (scripted decider) → artifact → approval → deterministic replay, against the live mock."""

from __future__ import annotations

from pathlib import Path

import pytest
import yaml

from rote.artifact.resolve import resolve
from rote.artifact.schema import Capability, Handler, TextCondition
from rote.artifact.store import Library
from rote.discovery.agent import DiscoveryAgent, DiscoveryRequest
from rote.discovery.decider import ScriptedDecider
from rote.replay.engine import ReplayEngine, ReplayOptions
from rote.replay.result import FailureCode, RunResult, RunStatus
from rote.runtime import Settings, open_session

from .conftest import set_faults

pytestmark = pytest.mark.browser
BALANCE = "legacycore.member.get_savings_balance"


async def discover(settings: Settings, script: list, goal: str, kind: str = "task", **inputs: str) -> object:
    async with open_session(
        settings, kind="discovery", subject=goal, label=kind, tenant_id="acme", app_id="legacycore", console=False
    ) as session:
        request = DiscoveryRequest(goal=goal, inputs=inputs, kind=kind)  # type: ignore[arg-type]
        return await DiscoveryAgent(session, ScriptedDecider(script), request).run()


async def replay(settings: Settings, capability: str, tenant: str = "acme", **inputs: str) -> RunResult:
    library = Library(settings.root)
    cap = library.capability(capability)
    async with open_session(
        settings, kind="replay", subject=cap.ref, label=cap.id, tenant_id=tenant, app_id="legacycore", console=False
    ) as session:
        engine = ReplayEngine(
            surface=session.surface,
            library=library,
            policy=session.policy,
            redactor=session.redactor,
            log=session.log,
            options=ReplayOptions(),
        )
        return await engine.run(resolve(cap, session.app, session.tenant), inputs)


def approve(settings: Settings, capability: str) -> None:
    library = Library(settings.root)
    cap = library.capability(capability)
    cap.status = "approved"
    library.save(cap)


def test_artifact_is_parameterized_and_free_of_data(recorded: Settings) -> None:
    library = Library(recorded.root)
    path = library.capability_path(BALANCE, "1.0.0")
    text = path.read_text()
    assert "12345" not in text, "input value leaked into the artifact"
    assert "acme-demo-pass" not in text
    assert "TELLER01" not in text
    assert "{{inputs.member_id}}" in text
    cap = Capability.model_validate(yaml.safe_load(text))
    extract = next(s for s in cap.steps if s.action.type == "extract" and s.action.output == "savings_balance")
    assert [loc.by for loc in extract.action.target.locators] == ["table_cell"]  # type: ignore[union-attr]
    fill = next(s for s in cap.steps if s.action.type == "fill")
    assert fill.action.target.locators[0].by == "attribute"  # type: ignore[union-attr]
    session_text = library.capability_path("legacycore.session.sign_on", "1.0.0").read_text()
    assert "{{secrets.password}}" in session_text
    assert "acme-demo-pass" not in session_text


async def test_replay_succeeds_without_model(recorded: Settings) -> None:
    result = await replay(recorded, BALANCE, member_id="12345")
    assert result.status is RunStatus.SUCCEEDED, result.failure
    assert result.outputs == {"savings_balance": "2418.07", "member_name": "SAMPLE, JORDAN Q"}
    assert not [w for w in result.warnings if w.code != "LOCATOR_DRIFT"]


async def test_replay_generalises_to_another_member_with_reordered_rows(recorded: Settings) -> None:
    result = await replay(recorded, BALANCE, member_id="20417")
    assert result.status is RunStatus.SUCCEEDED, result.failure
    assert result.outputs
    assert result.outputs["savings_balance"] == "15002.50"


async def test_invalid_input_rejected_before_touching_ui(recorded: Settings) -> None:
    result = await replay(recorded, BALANCE, member_id="12-AB")
    assert result.status is RunStatus.FAILED
    assert result.failure
    assert result.failure.code is FailureCode.INVALID_INPUT
    assert not result.steps


async def test_unknown_member_without_handler_is_a_debuggable_failure(recorded: Settings) -> None:
    result = await replay(recorded, BALANCE, member_id="99999")
    assert result.status is RunStatus.FAILED
    assert result.failure
    assert result.failure.code is FailureCode.TARGET_NOT_FOUND
    assert "NO RECORDS MATCH" in (result.failure.observed or "")
    assert "screenshot" in result.failure.evidence


async def test_declared_business_outcome_is_not_a_failure(recorded: Settings) -> None:
    library = Library(recorded.root)
    cap = library.capability(BALANCE)
    cap.handlers.append(
        Handler(
            id="member_not_found",
            description="Search returned no members",
            kind="business_outcome",
            when=[TextCondition(text="NO RECORDS MATCH SEARCH CRITERIA", frame="main")],
            outcome={"code": "MEMBER_NOT_FOUND", "message": "No member has that member number."},
        )
    )  # type: ignore[arg-type]
    library.save(cap)
    try:
        result = await replay(recorded, BALANCE, member_id="99999")
        assert result.status is RunStatus.BUSINESS_OUTCOME
        assert result.outcome
        assert result.outcome.code == "MEMBER_NOT_FOUND"
    finally:
        cap.handlers.pop()
        library.save(cap)


@pytest.mark.parametrize(
    ("faults", "handler"),
    [
        ({"maintenance_notice": True}, "maintenance_notice"),
        ({"session_warning_dialog": True}, "session_warning_dialog"),
        ({"transient_errors": 1}, "service_unavailable"),
        ({"session_expire_after": 1}, "session_expired"),
    ],
)
async def test_recoverable_conditions_are_handled(
    recorded: Settings, bank_url: str, faults: dict, handler: str
) -> None:
    set_faults(bank_url, "acme", **faults)
    result = await replay(recorded, BALANCE, member_id="12345")
    assert result.status is RunStatus.SUCCEEDED, result.failure
    assert handler in [r.handler for r in result.recoveries]
    assert result.outputs
    assert result.outputs["savings_balance"] == "2418.07"


async def test_slow_application_is_absorbed_by_condition_waits(recorded: Settings, bank_url: str) -> None:
    set_faults(bank_url, "acme", slow_ms=2500)
    result = await replay(recorded, BALANCE, member_id="12345")
    assert result.status is RunStatus.SUCCEEDED, result.failure
    assert not result.recoveries  # slowness is not an error: waits are condition-based, never fixed sleeps


async def test_broken_deployment_fails_with_evidence(recorded: Settings, bank_url: str) -> None:
    set_faults(bank_url, "acme", vendor_upgrade=True)
    result = await replay(recorded, BALANCE, member_id="12345")
    assert result.failure
    assert result.failure.code is FailureCode.TARGET_NOT_FOUND
    assert result.failure.step_id
    assert "member_number" in result.failure.step_id
    evidence_dir = Path(result.evidence_dir or "")
    assert (evidence_dir / result.failure.evidence["screenshot"]).exists()
    assert (evidence_dir / "report.html").exists()


def _evidence_text(evidence_dir: Path) -> str:
    return "\n".join(
        p.read_text(errors="ignore")
        for p in evidence_dir.rglob("*")
        if p.suffix in (".jsonl", ".json", ".txt", ".html")
    )


async def test_evidence_is_redacted(recorded: Settings) -> None:
    result = await replay(recorded, BALANCE, member_id="12345")
    blob = _evidence_text(Path(result.evidence_dir or ""))
    for secret in ("12345", "123-45-6789", "acme-demo-pass", "SAMPLE, JORDAN Q", "jordan.sample@example.com"):
        assert secret not in blob, f"{secret!r} leaked into evidence"
