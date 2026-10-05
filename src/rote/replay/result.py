"""The replay result contract returned to the calling agent.

Three terminal statuses, never conflated:

* ``succeeded`` — the success checkpoint was verified; ``outputs`` are typed per the contract.
* ``business_outcome`` — a *legitimate answer* that is not the happy path (MEMBER_NOT_FOUND,
  ACCESS_RESTRICTED, ...). The capability worked; the world said no. Not an error.
* ``failed`` — the automation could not do its job. ``failure`` says which step, what was expected,
  what was observed, whether retrying later can help, and where the evidence is.

Recoverable conditions (a dismissed interstitial, a retried 503, a re-authentication) are not a
status: they are listed in ``recoveries`` on whatever the final status is, so callers stay simple
and operators still see how often the happy path needed help. Drift that did *not* cause a failure
is reported in ``warnings`` — that is the early signal to review a capability before it breaks.
"""

from __future__ import annotations

from datetime import datetime
from enum import StrEnum
from typing import Any

from pydantic import BaseModel, Field


class RunStatus(StrEnum):
    SUCCEEDED = "succeeded"
    BUSINESS_OUTCOME = "business_outcome"
    FAILED = "failed"


class FailureCode(StrEnum):
    INVALID_INPUT = "INVALID_INPUT"  # caller error, rejected before touching the UI
    CAPABILITY_NOT_APPROVED = "CAPABILITY_NOT_APPROVED"
    POLICY_VIOLATION = "POLICY_VIOLATION"
    SESSION_UNAVAILABLE = "SESSION_UNAVAILABLE"  # could not sign on
    TARGET_NOT_FOUND = "TARGET_NOT_FOUND"  # no locator resolved: UI changed or unknown screen
    TARGET_AMBIGUOUS = "TARGET_AMBIGUOUS"
    UNEXPECTED_STATE = "UNEXPECTED_STATE"  # postcondition unmet and no handler recognised the screen
    ACTION_FAILED = "ACTION_FAILED"  # the control was found but the action did not take effect
    OUTPUT_INVALID = "OUTPUT_INVALID"  # extracted text did not parse as the declared type
    CHECKPOINT_FAILED = "CHECKPOINT_FAILED"  # all steps ran but success could not be verified
    KNOWN_APP_ERROR = "KNOWN_APP_ERROR"  # a declared failure handler matched (see app_code)
    RECOVERY_EXHAUSTED = "RECOVERY_EXHAUSTED"  # a recoverable condition kept recurring
    UNSAFE_TO_RESUME = "UNSAFE_TO_RESUME"  # recovery would repeat side effects of a non-idempotent flow
    ESCALATION_ABORTED = "ESCALATION_ABORTED"
    ESCALATION_TIMEOUT = "ESCALATION_TIMEOUT"
    REJECTED_BY_OPERATOR = "REJECTED_BY_OPERATOR"
    SURFACE_ERROR = "SURFACE_ERROR"  # browser/driver failure


RETRYABLE = {
    FailureCode.SESSION_UNAVAILABLE,
    FailureCode.KNOWN_APP_ERROR,
    FailureCode.RECOVERY_EXHAUSTED,
    FailureCode.ESCALATION_TIMEOUT,
    FailureCode.SURFACE_ERROR,
}

# Failures a human operator can plausibly fix on the live screen.
ESCALATABLE = {
    FailureCode.TARGET_NOT_FOUND,
    FailureCode.TARGET_AMBIGUOUS,
    FailureCode.UNEXPECTED_STATE,
    FailureCode.ACTION_FAILED,
    FailureCode.RECOVERY_EXHAUSTED,
    FailureCode.UNSAFE_TO_RESUME,
}


class Failure(BaseModel):
    code: FailureCode
    message: str
    app_code: str | None = None
    capability: str | None = None
    step_id: str | None = None
    step_index: int | None = None
    step_intent: str | None = None
    expected: str | None = None
    observed: str | None = None
    retryable: bool = False
    evidence: dict[str, str] = Field(default_factory=dict)


class BusinessOutcome(BaseModel):
    code: str
    message: str
    step_id: str | None = None
    handler: str


class Recovery(BaseModel):
    handler: str
    source: str
    step_id: str
    action: str
    attempt: int


class Warning(BaseModel):
    code: (
        str  # LOCATOR_DRIFT | LOCATOR_FALLBACK | LOCATOR_CONFLICT | FRAME_DRIFT | VERSION_MISMATCH | UNSOLICITED_INPUT
    )
    step_id: str | None = None
    message: str


class StepTrace(BaseModel):
    capability: str
    step_id: str
    status: str  # ok | failed | human_completed
    duration_ms: int
    locator: str | None = None


class CapabilityRef(BaseModel):
    id: str
    version: str
    effective_hash: str
    layers: list[str]


class RunResult(BaseModel):
    run_id: str
    capability: CapabilityRef
    tenant: str
    status: RunStatus
    outputs: dict[str, Any] | None = None
    outcome: BusinessOutcome | None = None
    failure: Failure | None = None
    recoveries: list[Recovery] = Field(default_factory=list)
    warnings: list[Warning] = Field(default_factory=list)
    interventions: list[str] = Field(default_factory=list)
    steps: list[StepTrace] = Field(default_factory=list)
    started_at: datetime
    duration_ms: int = 0
    evidence_dir: str | None = None

    def for_caller(self) -> dict[str, Any]:
        """The minimal payload an AI agent needs to decide its next move."""
        payload: dict[str, Any] = {
            "status": self.status.value,
            "capability": f"{self.capability.id}@{self.capability.version}",
        }
        if self.outputs is not None:
            payload["outputs"] = self.outputs
        if self.outcome is not None:
            payload["outcome"] = {"code": self.outcome.code, "message": self.outcome.message}
        if self.failure is not None:
            payload["failure"] = {
                "code": self.failure.code.value,
                "message": self.failure.message,
                "retryable": self.failure.retryable,
            }
        payload["run_id"] = self.run_id
        return payload
