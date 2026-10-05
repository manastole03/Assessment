"""Code-based graders: each turns one observed run into named, independently readable checks.

Checks state what was expected and what was observed, so a failing eval reads like a failing test.
Values of ``pii``/``secret`` inputs and outputs are compared but never written into a check — eval
results are persisted, and the same rule applies to them as to evidence.
"""

from __future__ import annotations

import os
import re
from collections.abc import Iterable
from pathlib import Path

from pydantic import BaseModel

from ..artifact.schema import Capability, Handler, StepTargetCondition, Tenant
from ..discovery.agent import DiscoveryResult
from ..discovery.probe import ProbeOutcome
from ..replay.result import RunResult
from .dataset import DiscoveryExpect, ProbeExpect, ReplayExpect

SENSITIVE = ("pii", "secret")
EVIDENCE_SUFFIXES = (".jsonl", ".json", ".txt", ".html", ".yaml")


class Check(BaseModel):
    name: str
    passed: bool | None  # None: not graded in this mode (e.g. needs the model)
    expected: str | None = None
    observed: str | None = None


def check(name: str, passed: bool | None, expected: object = None, observed: object = None) -> Check:
    def fmt(value: object) -> str | None:
        return None if value is None else str(value)

    return Check(name=name, passed=passed, expected=fmt(expected), observed=fmt(observed))


def skipped(name: str, why: str) -> Check:
    return Check(name=name, passed=None, observed=why)


# ============================================================================================ privacy


def sensitive_values(
    capability: Capability | None, inputs: dict[str, str], tenant: Tenant | None, extra: Iterable[str] = ()
) -> list[str]:
    """Values that must never appear in evidence or artifacts: pii/secret inputs and the tenant's credentials."""
    values = [str(v) for v in extra]
    for name, value in inputs.items():
        spec = capability.inputs.get(name) if capability else None
        if spec is None or spec.sensitivity in SENSITIVE:
            values.append(value)
    for binding in tenant.apps.values() if tenant else []:
        values.extend(
            os.environ[ref[4:]]
            for ref in binding.secrets.values()
            if ref.startswith("env:") and os.environ.get(ref[4:])
        )
    return sorted({v for v in values if len(v) >= 4})  # shorter strings collide with ordinary text


def leak_check(name: str, directory: Path | None, values: list[str]) -> Check:
    if directory is None or not directory.exists():
        return skipped(name, "no evidence directory")
    leaked: set[str] = set()
    files = 0
    for path in directory.rglob("*"):
        if path.is_file() and path.suffix in EVIDENCE_SUFFIXES:
            files += 1
            text = path.read_text(errors="ignore")
            leaked.update(v for v in values if v in text)
    return check(
        name,
        not leaked,
        f"none of {len(values)} sensitive values in {files} evidence files",
        f"{len(leaked)} leaked" if leaked else "clean",
    )


# ============================================================================================ replay


def grade_replay(result: RunResult, expect: ReplayExpect, capability: Capability, prefix: str = "") -> list[Check]:
    checks = [check(f"{prefix}status", result.status.value == expect.status, expect.status, result.status.value)]
    if expect.outputs is not None:
        observed = result.outputs or {}
        for name, want in expect.outputs.items():
            got = observed.get(name)
            ok = got is not None and str(got) == want
            spec = capability.outputs.get(name)
            if spec is not None and spec.sensitivity in SENSITIVE:
                checks.append(
                    check(f"{prefix}output {name}", ok, f"[{spec.sensitivity}]", "matches" if ok else "differs")
                )
            else:
                checks.append(check(f"{prefix}output {name}", ok, want, got))
    if expect.outcome is not None:
        got_code = result.outcome.code if result.outcome else None
        checks.append(check(f"{prefix}outcome", got_code == expect.outcome, expect.outcome, got_code))
    if expect.failure is not None:
        got_failure = result.failure.code.value if result.failure else None
        checks.append(
            check(f"{prefix}failure code", got_failure in expect.failure, " | ".join(expect.failure), got_failure)
        )
    if expect.recoveries:
        fired = [r.handler for r in result.recoveries]
        missing = [h for h in expect.recoveries if h not in fired]
        checks.append(
            check(f"{prefix}recoveries", not missing, ", ".join(expect.recoveries), ", ".join(fired) or "none")
        )
    if expect.warnings is not None:
        codes = sorted({w.code for w in result.warnings})
        unexpected = [c for c in codes if c not in expect.warnings]
        checks.append(
            check(
                f"{prefix}drift warnings",
                not unexpected,
                ", ".join(expect.warnings) or "none",
                ", ".join(codes) or "none",
            )
        )
    if expect.max_duration_ms is not None:
        checks.append(
            check(
                f"{prefix}latency",
                result.duration_ms <= expect.max_duration_ms,
                f"≤ {expect.max_duration_ms} ms",
                f"{result.duration_ms} ms",
            )
        )
    return checks


# ============================================================================================ probe


def _is_guarded(handler: Handler, step_id: str | None) -> bool:
    """A probed handler must be scoped to the stopped step and never fire while its target is present."""
    scoped = step_id is None or handler.scope == [step_id]
    unless = any(isinstance(c, StepTargetCondition) and c.step == step_id for c in handler.unless)
    return scoped and (step_id is None or unless)


def grade_probe(outcome: ProbeOutcome, expect: ProbeExpect) -> list[Check]:
    proposed = outcome.capability is not None and outcome.handler is not None
    observed = "proposed" if proposed else f"none ({outcome.note or 'no handler'})"
    checks = [check("handler", proposed == (expect.handler == "proposed"), expect.handler, observed)]
    classification = outcome.classification
    if expect.kind is not None:
        checks.append(
            check(
                "classification",
                classification is not None and classification.kind == expect.kind,
                expect.kind,
                classification.kind if classification else "not classified",
            )
        )
    if expect.code_pattern is not None:
        code = classification.code if classification else None
        checks.append(
            check(
                "outcome code",
                code is not None and re.fullmatch(expect.code_pattern, code) is not None,
                f"/{expect.code_pattern}/",
                code,
            )
        )
    if expect.evidence_type is not None:
        got = classification.evidence_type if classification else None
        checks.append(check("evidence type", got == expect.evidence_type, expect.evidence_type, got))
    if proposed and outcome.handler is not None:
        step_id = outcome.replay.failure.step_id if outcome.replay.failure else None
        checks.append(
            check(
                "handler is guarded",
                _is_guarded(outcome.handler, step_id),
                "scoped + unless target",
                f"scope={outcome.handler.scope}",
            )
        )
    return checks


# ============================================================================================ discovery


def grade_discovery(
    result: DiscoveryResult,
    capability: Capability | None,
    artifact_text: str | None,
    expect: DiscoveryExpect,
    secrets: list[str],
) -> list[Check]:
    checks = [
        check(
            "status",
            result.status == expect.status,
            expect.status,
            f"{result.status}" + (f" ({result.failure})" if result.failure else ""),
        )
    ]
    checks.append(check("turns", result.turns <= expect.max_turns, f"≤ {expect.max_turns}", result.turns))
    if expect.max_cost_usd is not None:
        checks.append(
            check(
                "cost",
                result.estimated_cost_usd <= expect.max_cost_usd,
                f"≤ ${expect.max_cost_usd:.2f}",
                f"${result.estimated_cost_usd:.3f}",
            )
        )
    if capability is None or artifact_text is None:
        if expect.status == "succeeded":
            checks.append(check("artifact recorded", False, "an artifact", "none"))
        return checks
    if expect.inputs is not None:
        got = sorted(capability.inputs)
        checks.append(
            check(
                "declared inputs",
                got == sorted(expect.inputs),
                ", ".join(sorted(expect.inputs)) or "none",
                ", ".join(got) or "none",
            )
        )
    if expect.outputs is not None:
        got_outputs = {name: spec.type for name, spec in capability.outputs.items()}
        checks.append(
            check(
                "declared outputs",
                got_outputs == expect.outputs,
                ", ".join(f"{k}:{v}" for k, v in sorted(expect.outputs.items())) or "none",
                ", ".join(f"{k}:{v}" for k, v in sorted(got_outputs.items())) or "none",
            )
        )
    for name in expect.sensitive:
        spec = capability.inputs.get(name) or capability.outputs.get(name)
        got_sensitivity = spec.sensitivity if spec else "undeclared"
        checks.append(check(f"{name} is sensitive", got_sensitivity in SENSITIVE, "pii | secret", got_sensitivity))
    leaked = [v for v in secrets if v in artifact_text]
    checks.append(
        check(
            "artifact is free of data",
            not leaked,
            "no input values or credentials",
            f"{len(leaked)} found" if leaked else "clean",
        )
    )
    return checks
