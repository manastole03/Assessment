"""Typed request/response models for the `rote ui` API.

They mirror the JSON the endpoints have always returned, so the OpenAPI document at /api/docs is an
accurate contract for the web UI and for any other client. Nested artifact structures stay as plain
objects here: their schema is the artifact schema itself (schemas/*.schema.json).
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field

RunStatus = Literal["running", "succeeded", "business_outcome", "failed", "error", "interrupted"]
RunKind = Literal["replay", "discovery", "probe"]


class ApiError(BaseModel):
    """Every error response: a human-readable reason (validation errors list their fields)."""

    detail: str | list[dict[str, Any]]


# ============================================================================================ status


class Health(BaseModel):
    status: Literal["ok"] = "ok"
    version: str


class TenantStatus(BaseModel):
    id: str
    name: str
    app: str
    base_url: str
    product_version: str | None
    overrides: int
    reachable: bool


class Status(BaseModel):
    version: str
    model: str
    effort: str
    has_api_key: bool
    tenants: list[TenantStatus]
    active_runs: int


# ============================================================================================ capabilities


class VersionRef(BaseModel):
    version: str
    status: str


class CapabilitySummary(BaseModel):
    id: str
    version: str
    title: str
    description: str
    status: Literal["draft", "approved", "deprecated"]
    kind: Literal["task", "session"]
    side_effects: Literal["read_only", "reversible", "irreversible"]
    idempotent: bool
    requires_session: str | None
    inputs: dict[str, dict[str, Any]]
    outputs: dict[str, dict[str, Any]]
    outcomes: list[str]
    steps: int
    versions: list[VersionRef]
    provenance: dict[str, Any]


class CapabilityDetail(BaseModel):
    summary: CapabilitySummary
    capability: dict[str, Any] = Field(description="The effective artifact (see schemas/capability.schema.json).")
    yaml: str
    tenant: str | None
    layers: list[str] = Field(description="Resolution layers, base first: capability ⊕ app profile ⊕ tenant.")
    effective_hash: str | None
    overridden: dict[str, int] = Field(description="Step id → number of locators a tenant override added.")
    handlers: list[dict[str, Any]]
    expect_text: dict[str, list[str]]
    success_text: list[str]
    tool: dict[str, Any] | None = Field(description="The tool definition a calling agent sees (task capabilities).")


class ApproveRequest(BaseModel):
    reviewer: str = Field(min_length=1, max_length=120)
    notes: str | None = Field(None, max_length=2000)


class Approved(BaseModel):
    ok: bool
    ref: str


class PolicyView(BaseModel):
    policy: dict[str, Any]
    apps: list[dict[str, Any]]
    tenants: list[dict[str, Any]]


# ============================================================================================ runs


class RunSummary(BaseModel):
    id: str
    source: Literal["active", "runs", "evidence"]
    kind: RunKind
    subject: str
    tenant: str | None
    status: str
    started_at: str | None
    duration_ms: int | None
    active: bool


class RunDetail(RunSummary):
    result: dict[str, Any] | None = Field(description="result.json: the full run result, as recorded.")
    caller: dict[str, Any] | None = Field(description="What the caller received (live runs only).")
    error: str | None
    files: dict[str, str] = Field(description="Artifacts the run produced (artifact.yaml, probed handler, ...).")
    interventions: list[dict[str, Any]]
    has_report: bool


class RunStarted(BaseModel):
    id: str


class DemoMember(BaseModel):
    member_id: str
    label: str
    expect: str


class EvidenceIndex(BaseModel):
    mode: Literal["live", "offline"] | None
    runs: list[dict[str, Any]]


# ============================================================================================ agents


class InvokeRequest(BaseModel):
    tenant: str = Field("acme", description="The institution to run against.")
    inputs: dict[str, str] = Field(default_factory=dict, description="Values for the capability's declared inputs.")
    escalation: Literal["fail", "wait"] = Field(
        "fail",
        description="On an unknown screen: fail with evidence, or wait for an operator to take over in the UI "
        "(the call then returns when they hand back, or 202 if wait_s runs out first).",
    )
    wait_s: float = Field(120, gt=0, le=1800, description="How long to hold the request open for the result.")


class Outcome(BaseModel):
    code: str
    message: str


class FailureInfo(BaseModel):
    code: str
    message: str
    retryable: bool


class Links(BaseModel):
    run: str = Field(description="API resource for the run (poll it after a 202).")
    ui: str = Field(description="The run in the web UI: live timeline, evidence, handoff.")


class Invocation(BaseModel):
    """The capability's result contract, exactly what `rote replay --json` and the MCP tool return."""

    status: Literal["succeeded", "business_outcome", "failed", "running"]
    capability: str = Field(description="id@version that ran.")
    run_id: str
    outputs: dict[str, Any] | None = None
    outcome: Outcome | None = None
    failure: FailureInfo | None = None
    links: Links


class InputProblems(BaseModel):
    detail: str
    problems: list[str]


# ============================================================================================ evals


class EvalRunSummary(BaseModel):
    id: str
    dataset: str
    dataset_title: str
    kind: str
    mode: str
    model: str | None
    trials: int
    status: Literal["running", "completed", "error"]
    started_at: str
    finished_at: str | None
    total_cases: int
    done_cases: int
    summary: dict[str, Any] | None


class EvalDatasetSummary(BaseModel):
    id: str
    title: str
    description: str
    kind: Literal["replay", "probe", "discovery"]
    uses_model: bool
    threshold: float
    cases: int
    tags: list[str]
    latest: EvalRunSummary | None


class EvalStarted(BaseModel):
    id: str
