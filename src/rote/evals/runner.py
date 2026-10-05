"""Run an eval dataset: every trial of every case in its own sandbox, graded, summarised and persisted.

Results live under ``runs/evals/<eval-id>/`` next to the evidence of every trial (``runs/<run-id>/``,
each with its ``report.html``) and the sandbox the trial ran in (``cases/<case>-t<n>/``, including any
artifact a discovery or probe recorded). ``result.json`` is rewritten after every trial, so a reader —
the web UI, or a person — can follow a long run while it is in flight.

Metrics:
* **pass rate** — cases whose every trial passed every graded check;
* **pass@k / pass^k** — with ``trials > 1``: cases that passed at least once / every time. For the
  deterministic engine pass^k is a determinism check; for the model it measures consistency;
* latency p50/p95 per trial, and model cost where a model was used.
"""

from __future__ import annotations

import dataclasses
import math
import os
import time
from collections.abc import Callable
from datetime import UTC, datetime
from pathlib import Path
from typing import Literal, NamedTuple

from pydantic import BaseModel, Field, computed_field

from ..artifact.resolve import resolve
from ..artifact.schema import Capability
from ..artifact.store import Library, to_yaml
from ..replay.engine import ReplayEngine, ReplayOptions
from ..replay.result import RunResult
from ..runtime import Settings, open_session
from .dataset import (
    DiscoveryCase,
    DiscoveryDataset,
    ProbeCase,
    ProbeDataset,
    ReplayCase,
    ReplayDataset,
    ReplayExpect,
    load_dataset,
)
from .graders import (
    Check,
    check,
    grade_discovery,
    grade_probe,
    grade_replay,
    leak_check,
    sensitive_values,
    skipped,
)
from .sandbox import MockBank, make_workspace, tenant_path

Mode = Literal["offline", "live"]
RunMode = Literal["offline", "live", "deterministic"]  # replay datasets never use a model
Dataset = ReplayDataset | ProbeDataset | DiscoveryDataset
Case = ReplayCase | ProbeCase | DiscoveryCase


class _Outcome(NamedTuple):
    """What one executed case hands to the trial record."""

    checks: list[Check]
    observed: str
    evidence: str | None
    run_id: str
    cost_usd: float


class TrialResult(BaseModel):
    trial: int
    passed: bool
    checks: list[Check]
    duration_ms: int
    observed: str | None = Field(None, description="One-line summary of what the run did.")
    run_id: str | None = None
    evidence: str | None = Field(None, description="Evidence directory, relative to the eval directory.")
    cost_usd: float = 0.0
    error: str | None = None


class CaseResult(BaseModel):
    id: str
    title: str
    tags: list[str]
    trials: list[TrialResult] = Field(default_factory=list)

    @computed_field  # type: ignore[prop-decorator]
    @property
    def passed(self) -> bool:
        return bool(self.trials) and all(t.passed for t in self.trials)


class TagStat(BaseModel):
    cases: int = 0
    passed: int = 0


class Summary(BaseModel):
    cases: int
    passed: int
    pass_rate: float
    pass_at_k: float
    pass_hat_k: float
    checks: int
    checks_passed: int
    by_tag: dict[str, TagStat]
    p50_ms: int | None
    p95_ms: int | None
    cost_usd: float
    gate: bool


class EvalRun(BaseModel):
    id: str
    dataset: str
    dataset_title: str
    kind: str
    dataset_sha: str
    mode: RunMode
    model: str | None
    trials: int
    threshold: float
    status: Literal["running", "completed", "error"] = "running"
    started_at: datetime
    finished_at: datetime | None = None
    error: str | None = None
    total_cases: int
    cases: list[CaseResult] = Field(default_factory=list)
    summary: Summary | None = None


def evals_dir(settings: Settings) -> Path:
    return settings.runs_dir / "evals"


def _percentile(values: list[int], q: float) -> int | None:
    if not values:
        return None
    ordered = sorted(values)
    return ordered[min(len(ordered) - 1, max(0, math.ceil(q * len(ordered)) - 1))]


def summarize(run: EvalRun) -> Summary:
    cases = run.cases
    by_tag: dict[str, TagStat] = {}
    for case in cases:
        for tag in case.tags or ["untagged"]:
            stat = by_tag.setdefault(tag, TagStat())
            stat.cases += 1
            stat.passed += case.passed
    trials = [t for c in cases for t in c.trials]
    graded = [ch for t in trials for ch in t.checks if ch.passed is not None]
    n = len(cases) or 1
    passed = sum(c.passed for c in cases)
    return Summary(
        cases=len(cases),
        passed=passed,
        pass_rate=round(passed / n, 4),
        pass_at_k=round(sum(any(t.passed for t in c.trials) for c in cases) / n, 4),
        pass_hat_k=round(passed / n, 4),
        checks=len(graded),
        checks_passed=sum(bool(ch.passed) for ch in graded),
        by_tag=dict(sorted(by_tag.items())),
        p50_ms=_percentile([t.duration_ms for t in trials], 0.5),
        p95_ms=_percentile([t.duration_ms for t in trials], 0.95),
        cost_usd=round(sum(t.cost_usd for t in trials), 4),
        gate=bool(cases) and passed / n >= run.threshold,
    )


def _describe(result: RunResult) -> str:
    if result.outcome is not None:
        return f"business_outcome {result.outcome.code}"
    if result.failure is not None:
        at = f" at {result.failure.step_id}" if result.failure.step_id else ""
        return f"failed {result.failure.code.value}{at}"
    return result.status.value


class EvalRunner:
    """Executes one dataset. Construct, ``prepare()`` (cheap, validates), then ``await execute()``."""

    def __init__(
        self,
        settings: Settings,
        dataset_id: str,
        *,
        mode: Mode = "offline",
        trials: int = 1,
        case_ids: list[str] | None = None,
        bank_url: str | None = None,
        on_progress: Callable[[EvalRun], None] | None = None,
    ):
        if trials < 1:
            raise ValueError("trials must be at least 1")
        self.settings = settings
        self.dataset, self.sha = load_dataset(settings.root, dataset_id)
        self.mode: RunMode = mode if self.dataset.uses_model else "deterministic"
        if self.mode == "live" and not os.environ.get("ANTHROPIC_API_KEY"):
            raise ValueError("live evals call the model: set ANTHROPIC_API_KEY in .env, or run offline")
        self.trials = trials
        self.cases: list[Case] = list(self.dataset.cases)
        if case_ids:
            unknown = sorted(set(case_ids) - {c.id for c in self.cases})
            if unknown:
                raise ValueError(f"unknown case ids: {', '.join(unknown)}")
            self.cases = [c for c in self.cases if c.id in case_ids]
        self.bank = MockBank(bank_url)
        self.on_progress = on_progress
        started = datetime.now(UTC)
        self.result = EvalRun(
            id=f"{started:%Y%m%dT%H%M%SZ}-{self.dataset.id}-{self.mode}",
            dataset=self.dataset.id,
            dataset_title=self.dataset.title,
            kind=self.dataset.kind,
            dataset_sha=self.sha,
            mode=self.mode,
            model=settings.model if self.mode == "live" else None,
            trials=trials,
            threshold=self.dataset.threshold,
            started_at=started,
            total_cases=len(self.cases),
        )
        self.dir = evals_dir(settings) / self.result.id

    # ------------------------------------------------------------------ lifecycle

    def _save(self) -> None:
        self.dir.mkdir(parents=True, exist_ok=True)
        (self.dir / "result.json").write_text(self.result.model_dump_json(indent=2))
        if self.on_progress is not None:
            self.on_progress(self.result)

    async def execute(self) -> EvalRun:
        self._save()
        final: Literal["completed", "error"] = "error"
        try:
            bank_url = await self.bank.start()
            for case in self.cases:
                case_result = CaseResult(id=case.id, title=case.title, tags=case.tags)
                self.result.cases.append(case_result)
                for trial in range(1, self.trials + 1):
                    case_result.trials.append(await self._trial(case, trial, bank_url))
                    self._save()
            final = "completed"
        except Exception as exc:  # recorded on the result, never swallowed
            self.result.error = f"{type(exc).__name__}: {exc}"
            raise
        finally:
            await self.bank.stop()
            self.result.finished_at = datetime.now(UTC)
            self.result.summary = summarize(self.result)
            # Published last: a reader never sees a finished run without its summary.
            self.result.status = final
            self._save()
        return self.result

    async def _trial(self, case: Case, trial: int, bank_url: str) -> TrialResult:
        workspace = make_workspace(
            self.settings,
            self.dir / "cases" / f"{case.id}-t{trial}",
            bank_url,
            library=case.library or self.dataset.library,
            strip_overrides=() if case.tenant_overrides else (case.tenant,),
            pin=self._capability_ref(case) if isinstance(case, ProbeCase) else None,
        )
        workspace = dataclasses.replace(workspace, runs_dir=self.dir / "runs")
        await self.bank.prepare(tenant_path(workspace, case.tenant), case.faults)
        t0 = time.monotonic()
        try:
            if isinstance(case, ReplayCase):
                outcome = await self._replay_case(workspace, case)
            elif isinstance(case, ProbeCase):
                outcome = await self._probe_case(workspace, case)
            else:
                outcome = await self._discovery_case(workspace, case)
        except Exception as exc:
            return TrialResult(
                trial=trial,
                passed=False,
                checks=[check("ran to completion", False, "a result", f"{type(exc).__name__}: {exc}")],
                duration_ms=int((time.monotonic() - t0) * 1000),
                error=f"{type(exc).__name__}: {exc}",
            )
        return TrialResult(
            trial=trial,
            passed=all(c.passed is not False for c in outcome.checks),
            checks=outcome.checks,
            duration_ms=int((time.monotonic() - t0) * 1000),
            observed=outcome.observed,
            run_id=outcome.run_id,
            evidence=self._relative(outcome.evidence),
            cost_usd=outcome.cost_usd,
        )

    # ------------------------------------------------------------------ helpers

    def _relative(self, evidence: str | None) -> str | None:
        return str(Path(evidence).resolve().relative_to(self.dir.resolve())) if evidence else None

    def _capability_ref(self, case: ReplayCase | ProbeCase) -> str:
        ref = case.capability or self.dataset.capability
        if not ref:
            raise ValueError(f"case {case.id} names no capability and the dataset has no default")
        return ref

    async def _replay(
        self, workspace: Settings, capability: Capability, tenant: str, inputs: dict[str, str], *, allow_draft: bool
    ) -> RunResult:
        async with open_session(
            workspace,
            kind="replay",
            subject=capability.ref,
            label=f"eval-{capability.id}-{tenant}",
            tenant_id=tenant,
            app_id=capability.app.id,
            console=False,
            quiet=True,
        ) as session:
            engine = ReplayEngine(
                surface=session.surface,
                library=session.library,
                policy=session.policy,
                redactor=session.redactor,
                log=session.log,
                options=ReplayOptions(escalation="fail", allow_draft=allow_draft),
            )
            return await engine.run(resolve(capability, session.app, session.tenant), inputs)

    def _privacy(
        self,
        session_settings: Settings,
        capability: Capability,
        case_inputs: dict[str, str],
        tenant: str,
        evidence: str | None,
        extra: list[str],
    ) -> Check:
        library = Library(session_settings.root)
        values = sensitive_values(capability, case_inputs, library.tenant(tenant), extra)
        return leak_check("evidence is redacted", Path(evidence) if evidence else None, values)

    # ------------------------------------------------------------------ kinds

    async def _replay_case(self, workspace: Settings, case: ReplayCase) -> _Outcome:
        capability = Library(workspace.root).capability(self._capability_ref(case))
        result = await self._replay(workspace, capability, case.tenant, case.inputs, allow_draft=False)
        checks = grade_replay(result, case.expect, capability)
        pii_outputs = [
            str(v)
            for k, v in (result.outputs or {}).items()
            if k in capability.outputs and capability.outputs[k].sensitivity in ("pii", "secret")
        ]
        checks.append(self._privacy(workspace, capability, case.inputs, case.tenant, result.evidence_dir, pii_outputs))
        return _Outcome(checks, _describe(result), result.evidence_dir, result.run_id, 0.0)

    async def _probe_case(self, workspace: Settings, case: ProbeCase) -> _Outcome:
        from ..discovery.probe import claude_classifier, probe
        from .standins import rule_classifier

        library = Library(workspace.root)
        capability = library.capability(self._capability_ref(case))
        classifier = (
            claude_classifier(self.settings.model, self.settings.effort) if self.mode == "live" else rule_classifier
        )
        async with open_session(
            workspace,
            kind="probe",
            subject=capability.ref,
            label=f"eval-probe-{case.id}",
            tenant_id=case.tenant,
            app_id=capability.app.id,
            console=False,
            quiet=True,
        ) as session:
            outcome = await probe(
                session, resolve(capability, session.app, session.tenant), case.inputs, classifier=classifier, save=True
            )
        checks = grade_probe(outcome, case.expect)
        checks.append(self._privacy(workspace, capability, case.inputs, case.tenant, outcome.replay.evidence_dir, []))
        if outcome.classification is not None:
            observed = f"{outcome.classification.kind} {outcome.classification.code}"
        else:
            observed = f"not classified ({_describe(outcome.replay)})"
        if outcome.handler is not None and outcome.capability is not None:
            observed += f" → {outcome.capability.ref}"
        elif outcome.note:
            observed += f" · {outcome.note}"
        return _Outcome(checks, observed, outcome.replay.evidence_dir, outcome.replay.run_id, 0.0)

    async def _discovery_case(self, workspace: Settings, case: DiscoveryCase) -> _Outcome:
        from ..discovery.agent import DiscoveryAgent, DiscoveryRequest
        from ..discovery.decider import ClaudeDecider, Decider, ScriptedDecider
        from .standins import SCRIPTS

        async with open_session(
            workspace,
            kind="discovery",
            subject=case.goal,
            label=f"eval-discovery-{case.id}",
            tenant_id=case.tenant,
            app_id="legacycore",
            console=False,
            quiet=True,
        ) as session:
            decider: Decider
            if self.mode == "live":
                decider = ClaudeDecider(
                    model=self.settings.model,
                    effort=self.settings.effort,
                    redactor=session.redactor,
                    fallbacks=self.settings.fallbacks,
                )
            else:
                decider = ScriptedDecider(SCRIPTS[case.standin](case.inputs))
            request = DiscoveryRequest(
                goal=case.goal,
                inputs=case.inputs,
                kind=case.kind,
                capability_id=case.capability_id,
                max_turns=case.expect.max_turns,
            )
            result = await DiscoveryAgent(session, decider, request).run()

        library = Library(workspace.root)
        capability = library.capability(result.capability) if result.capability else None
        artifact = to_yaml(capability) if capability else None
        tenant = library.tenant(case.tenant)
        secrets = sensitive_values(None, case.inputs, tenant)
        checks = grade_discovery(result, capability, artifact, case.expect, secrets)
        checks.append(leak_check("evidence is redacted", Path(result.evidence_dir), secrets))
        cost = result.estimated_cost_usd

        if capability is not None:
            for index, holdout in enumerate(case.holdout, start=1):
                checks.append(
                    await self._holdout(
                        workspace, capability, holdout.title, holdout.tenant, holdout.inputs, holdout.expect, index
                    )
                )
            if case.rubric:
                rubric_check, rubric_cost = await self._rubric(case.goal, artifact or "")
                checks.append(rubric_check)
                cost += rubric_cost
        observed = f"{result.status} in {result.turns} turns" + (f" → {result.capability}" if result.capability else "")
        if result.failure:
            observed += f" · {result.failure}"
        return _Outcome(checks, observed, result.evidence_dir, result.run_id, cost)

    async def _holdout(
        self,
        workspace: Settings,
        capability: Capability,
        title: str,
        tenant: str,
        inputs: dict[str, str],
        expect: ReplayExpect,
        index: int,
    ) -> Check:
        name = f"holdout {index}: {title}"
        await self.bank.prepare(tenant_path(workspace, tenant), {})
        try:
            result = await self._replay(workspace, capability, tenant, inputs, allow_draft=True)
        except Exception as exc:
            return check(name, False, expect.status, f"{type(exc).__name__}: {exc}")
        failed = [c for c in grade_replay(result, expect, capability) if c.passed is False]
        detail = "; ".join(f"{c.name}: expected {c.expected}, got {c.observed}" for c in failed)
        return check(name, not failed, expect.status, detail or _describe(result))

    async def _rubric(self, goal: str, artifact: str) -> tuple[Check, float]:
        if self.mode != "live":
            return skipped("rubric (model-graded)", "needs --live"), 0.0
        from .judge import ContractJudge, JudgeError

        judge = ContractJudge(model=self.settings.model, effort=self.settings.effort, fallbacks=self.settings.fallbacks)
        try:
            verdict = await judge.grade(goal=goal, artifact_yaml=artifact)
        except JudgeError as exc:
            return check("rubric (model-graded)", False, "a verdict", str(exc)), 0.0
        failed = [c for c in verdict.criteria if not c.passed]
        observed = f"{verdict.score:.0%}" + (
            "" if not failed else " · " + "; ".join(f"{c.id}: {c.rationale}" for c in failed)
        )
        return check("rubric (model-graded)", verdict.score >= 0.8, "≥ 80% of criteria", observed), verdict.cost_usd


# ============================================================================================ persisted results


def list_results(settings: Settings) -> list[EvalRun]:
    base = evals_dir(settings)
    results = []
    for path in base.glob("*/result.json") if base.exists() else []:
        try:
            results.append(EvalRun.model_validate_json(path.read_text()))
        except ValueError:
            continue  # a result written by an incompatible version; skip rather than fail the listing
    return sorted(results, key=lambda r: r.started_at, reverse=True)


def load_result(settings: Settings, eval_id: str) -> EvalRun:
    if "/" in eval_id or ".." in eval_id:
        raise ValueError("bad eval id")
    path = evals_dir(settings) / eval_id / "result.json"
    if not path.is_file():
        raise FileNotFoundError(f"no eval result {eval_id}")
    return EvalRun.model_validate_json(path.read_text())
