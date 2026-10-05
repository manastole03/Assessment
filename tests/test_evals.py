"""The eval harness: dataset schema, metrics, sandboxing, graders, and a few cases run for real."""

from __future__ import annotations

import time
from datetime import UTC, datetime
from pathlib import Path

import httpx
import pytest
import yaml
from pydantic import ValidationError

from rote.artifact.store import Library
from rote.evals.dataset import ReplayDataset, load_datasets, parse_dataset
from rote.evals.graders import Check, grade_replay, leak_check
from rote.evals.runner import CaseResult, EvalRun, EvalRunner, TrialResult, load_result, summarize
from rote.evals.sandbox import make_workspace
from rote.replay.result import CapabilityRef, RunResult, RunStatus
from rote.runtime import Settings

REPO = Path(__file__).resolve().parent.parent
BALANCE = "legacycore.member.get_savings_balance"


@pytest.fixture
def repo_settings(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Settings:
    """The real library and datasets, with eval output kept out of the repository."""
    monkeypatch.setenv("ROTE_RUNS_DIR", str(tmp_path / "runs"))
    return Settings.load(REPO)


# ============================================================================================ datasets


def test_bundled_datasets_are_valid() -> None:
    datasets = {d.id: d for d in load_datasets(REPO)}
    assert set(datasets) == {"replay", "probe", "discovery"}
    assert not datasets["replay"].uses_model
    assert datasets["probe"].uses_model
    assert all(c.standin for c in datasets["discovery"].cases)


def test_dataset_schema_rejects_mistakes() -> None:
    base = {"schema": "rote.eval/v1", "id": "x", "kind": "replay", "title": "t", "description": "d"}
    case = {"id": "a", "title": "a", "expect": {"status": "succeeded"}}
    with pytest.raises(ValidationError, match="duplicate case ids"):
        parse_dataset(yaml.safe_dump({**base, "cases": [case, case]}))
    with pytest.raises(ValidationError):
        parse_dataset(yaml.safe_dump({**base, "cases": [{**case, "expect": {"status": "maybe"}}]}))
    with pytest.raises(ValidationError):  # replay cases have no probe expectations
        parse_dataset(yaml.safe_dump({**base, "cases": [{**case, "expect": {"handler": "none"}}]}))


# ============================================================================================ metrics


def _trial(passed: bool, ms: int = 100) -> TrialResult:
    return TrialResult(trial=1, passed=passed, checks=[Check(name="status", passed=passed)], duration_ms=ms)


def test_summary_metrics() -> None:
    run = EvalRun(
        id="x",
        dataset="d",
        dataset_title="d",
        kind="probe",
        dataset_sha="0",
        mode="live",
        model="m",
        trials=2,
        threshold=0.5,
        started_at=datetime.now(UTC),
        total_cases=3,
        cases=[
            CaseResult(id="a", title="a", tags=["x"], trials=[_trial(True), _trial(True)]),
            CaseResult(id="b", title="b", tags=["x", "y"], trials=[_trial(True), _trial(False, 900)]),
            CaseResult(id="c", title="c", tags=[], trials=[_trial(False), _trial(False)]),
        ],
    )
    summary = summarize(run)
    assert summary.passed == 1
    assert summary.pass_at_k == pytest.approx(2 / 3, abs=1e-3)  # a and b passed at least once
    assert summary.pass_hat_k == pytest.approx(1 / 3, abs=1e-3)  # only a passed every time
    assert summary.by_tag["x"].cases == 2
    assert summary.by_tag["x"].passed == 1
    assert summary.by_tag["untagged"].cases == 1
    assert summary.p95_ms == 900
    assert not summary.gate  # 1/3 < 0.5


# ============================================================================================ sandbox + graders


def test_workspace_is_isolated_and_rewritten(repo_settings: Settings, tmp_path: Path) -> None:
    ws = make_workspace(
        repo_settings,
        tmp_path / "ws",
        "http://127.0.0.1:9999",
        library="all",
        strip_overrides=("bayview",),
        pin=f"{BALANCE}@1.0.0",
    )
    library = Library(ws.root)
    assert library.versions(BALANCE) == ["1.0.0"], "later versions are dropped when pinned"
    bayview = library.tenant("bayview").apps["legacycore"]
    assert bayview.base_url == "http://127.0.0.1:9999/bayview"
    assert bayview.overrides == []
    assert library.tenant("acme").apps["legacycore"].base_url == "http://127.0.0.1:9999/acme"
    assert "http://127.0.0.1:9999" in yaml.safe_load(ws.policy_path.read_text())["allowed_origins"]
    assert Library(repo_settings.root).tenant("bayview").apps["legacycore"].overrides, "the source is untouched"

    session_only = Library(make_workspace(repo_settings, tmp_path / "s", "http://x:1", library="session").root)
    assert not session_only.has(BALANCE)
    assert session_only.has("legacycore.session.sign_on")


def test_replay_grader_never_records_pii_values(repo_settings: Settings) -> None:
    capability = Library(repo_settings.root).capability(BALANCE)
    result = RunResult(
        run_id="r",
        capability=CapabilityRef(id=BALANCE, version=capability.version, effective_hash="h", layers=[]),
        tenant="acme",
        status=RunStatus.SUCCEEDED,
        outputs={"savings_balance": "2418.07", "member_name": "SAMPLE, JORDAN Q"},
        started_at=datetime.now(UTC),
    )
    dataset = parse_dataset((REPO / "evals/datasets/replay.yaml").read_text())
    assert isinstance(dataset, ReplayDataset)
    checks = {c.name: c for c in grade_replay(result, dataset.cases[0].expect, capability)}
    assert all(c.passed for c in checks.values())
    assert checks["output savings_balance"].observed == "2418.07"
    assert checks["output member_name"].observed == "matches"
    assert "SAMPLE" not in Check.model_validate(checks["output member_name"]).model_dump_json()


def test_leak_check(tmp_path: Path) -> None:
    (tmp_path / "events.jsonl").write_text('{"member": "[pii]"}')
    assert leak_check("redacted", tmp_path, ["12345"]).passed
    (tmp_path / "dom.html").write_text("<td>12345</td>")
    leak = leak_check("redacted", tmp_path, ["12345"])
    assert leak.passed is False
    assert "12345" not in (leak.observed or ""), "the check reports a count, never the value"


# ============================================================================================ end to end


@pytest.mark.browser
async def test_replay_eval_runs_hermetically(repo_settings: Settings, bank_url: str) -> None:
    runner = EvalRunner(repo_settings, "replay", case_ids=["happy-path", "invalid-input"], bank_url=bank_url)
    assert runner.mode == "deterministic"
    result = await runner.execute()
    assert result.status == "completed"
    assert result.summary is not None
    assert result.summary.gate
    assert [c.id for c in result.cases] == ["happy-path", "invalid-input"]
    happy = result.cases[0].trials[0]
    assert happy.evidence is not None
    assert (runner.dir / happy.evidence / "report.html").exists()
    assert {c.name for c in happy.checks} >= {"status", "output member_name", "evidence is redacted"}
    persisted = (runner.dir / "result.json").read_text()
    assert "SAMPLE, JORDAN Q" not in persisted
    assert "12345" not in persisted
    assert load_result(repo_settings, result.id).summary == result.summary


@pytest.mark.browser
async def test_probe_eval_refuses_to_turn_drift_into_an_outcome(repo_settings: Settings, bank_url: str) -> None:
    runner = EvalRunner(repo_settings, "probe", case_ids=["relabelled-tenant-is-not-an-outcome"], bank_url=bank_url)
    result = await runner.execute()
    [trial] = result.cases[0].trials
    assert trial.passed, trial.checks
    assert "does not match the live screen" in (trial.observed or "") or "not classified" in (trial.observed or "")


@pytest.mark.browser
def test_eval_api(ui_url: str) -> None:
    datasets = {d["id"]: d for d in httpx.get(f"{ui_url}/api/evals/datasets").json()}
    assert datasets["replay"]["cases"] >= 10
    assert not datasets["replay"]["uses_model"]
    detail = httpx.get(f"{ui_url}/api/evals/datasets/probe").json()
    assert detail["cases"][0]["expect"]["handler"] == "proposed"
    assert httpx.get(f"{ui_url}/api/evals/datasets/nope").status_code == 404
    bad = httpx.post(f"{ui_url}/api/evals/runs", json={"dataset": "replay", "cases": ["no-such-case"]})
    assert bad.status_code == 400

    eval_id = httpx.post(f"{ui_url}/api/evals/runs", json={"dataset": "replay", "cases": ["invalid-input"]}).json()[
        "id"
    ]
    deadline = time.monotonic() + 120
    while (run := httpx.get(f"{ui_url}/api/evals/results/{eval_id}").json())["status"] == "running":
        assert time.monotonic() < deadline, "eval did not finish"
        time.sleep(0.5)
    assert run["status"] == "completed"
    assert run["cases"][0]["passed"] is True
    assert run["summary"]["gate"] is True
    listed = httpx.get(f"{ui_url}/api/evals/results").json()
    assert listed[0]["id"] == eval_id
    escape = httpx.get(f"{ui_url}/api/evals/results/{eval_id}/files/..%2F..%2F..%2Fpyproject.toml")
    assert escape.status_code == 404
