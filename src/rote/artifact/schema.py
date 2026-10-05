"""The capability artifact — the typed, versioned unit this system produces and executes.

A capability has two halves that are deliberately kept apart:

* the **contract** a calling agent sees: ``id``/``version``, ``description``, typed ``inputs`` and
  ``outputs``, the business-outcome codes it can return, its ``side_effects`` and approval ``status``;
* the **implementation** replay executes: ``steps`` with multi-strategy ``Target`` locators,
  per-step postconditions (``expect``), exception ``handlers`` and the ``success`` checkpoint.

Callers depend only on the contract, so implementation can be patched per tenant or per product
version (see ``TenantApp.overrides``) without changing what an agent is promised. The schema is
surface-neutral: locators name *what* a control is (role, label, table position, contract
attribute), and each surface adapter decides *how* to find it (DOM, UIA, AX, OCR).
"""

from __future__ import annotations

import re
from datetime import datetime
from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from .templates import TEMPLATE_RE

CapabilityId = Annotated[str, Field(pattern=r"^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$")]
SemVer = Annotated[str, Field(pattern=r"^\d+\.\d+\.\d+$")]
Slug = Annotated[str, Field(pattern=r"^[a-z][a-z0-9_]*$")]
OutcomeCode = Annotated[str, Field(pattern=r"^[A-Z][A-Z0-9_]*$")]

ValueType = Literal["string", "integer", "decimal", "money", "date", "boolean"]
Sensitivity = Literal["public", "internal", "pii", "secret"]
Risk = Literal["read_only", "reversible", "irreversible"]
RISK_ORDER: dict[str, int] = {"read_only": 0, "reversible": 1, "irreversible": 2}


class Model(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)


# ============================================================================================ contract


class InputSpec(Model):
    """A typed parameter the calling agent supplies per invocation."""

    type: ValueType = "string"
    description: str
    required: bool = True
    pattern: str | None = Field(None, description="Regex the value must fully match (checked before any UI work).")
    enum: list[str] | None = None
    sensitivity: Sensitivity = Field(description="Drives redaction in logs/evidence; always declared explicitly.")
    example: str | None = Field(None, description="Illustrative value. Never present for pii/secret inputs.")

    @model_validator(mode="after")
    def _no_sensitive_examples(self) -> InputSpec:
        if self.example is not None and self.sensitivity in ("pii", "secret"):
            raise ValueError("pii/secret inputs must not carry an example value")
        if self.pattern is not None:
            re.compile(self.pattern)
        return self


class OutputSpec(Model):
    """A typed value the capability returns. Values are returned to the caller but never persisted."""

    type: ValueType
    description: str
    sensitivity: Sensitivity = Field(description="pii/secret outputs are returned to the caller but never persisted.")


class SecretSpec(Model):
    """A credential the capability needs. Resolved at runtime from the tenant's secret bindings;
    the value is never shown to the model, written to the artifact, or logged."""

    description: str


class AppRef(Model):
    id: Slug
    surface: Literal["web", "desktop"] = "web"
    product_versions: str | None = Field(None, description="Compatible vendor versions, e.g. '>=4.2.0,<5.0.0'.")


# ============================================================================================ targeting


class FrameRef(Model):
    """Which document/window the control lives in. On the web: a frame by name or URL path.
    On desktop the same slot names a top-level window."""

    name: str | None = None
    path: str | None = None


class AttributeLocator(Model):
    """A contract attribute: a form-field ``name`` or a link ``href``. Legacy apps have no test IDs,
    but server-rendered forms post these names to the vendor's back end, so they are stable across
    tenants and versions of the same product. (Desktop analogue: UIA AutomationId.)"""

    by: Literal["attribute"] = "attribute"
    tag: str
    attribute: str
    value: str


class RoleLocator(Model):
    """Role plus accessible name, i.e. what a screen reader announces ("link 'Member Inquiry'")."""

    by: Literal["role"] = "role"
    role: str
    name: str


class LabelLocator(Model):
    """Role plus the *visual* label a human reads next to the control — the text in the adjacent
    table cell for table-layout forms. Also used to read label/value pairs ("NAME: | J DOE")."""

    by: Literal["label"] = "label"
    role: str
    label: str


class TableCellLocator(Model):
    """A cell addressed by meaning: the row whose key cell reads ``row`` and the column whose header
    reads ``column``. Survives row re-ordering, which positional selectors do not."""

    by: Literal["table_cell"] = "table_cell"
    row: str
    column: str
    role: str | None = Field(None, description="Target a control inside the cell (e.g. 'link').")


class CssLocator(Model):
    """Structural last resort. Positional, so never trusted alone to *read* data."""

    by: Literal["css"] = "css"
    selector: str


Locator = Annotated[
    AttributeLocator | RoleLocator | LabelLocator | TableCellLocator | CssLocator,
    Field(discriminator="by"),
]


class Target(Model):
    """How to find one control. ``locators`` are independent, ordered strategies; each was verified
    to match exactly this element when recorded. Replay uses the first that resolves uniquely and
    checks the others for agreement — disagreement is reported as drift before it becomes breakage."""

    description: str
    frame: FrameRef | None = None
    role: str | None = Field(None, description="Expected role of the resolved element (sanity check).")
    locators: list[Locator] = Field(min_length=1)


# ============================================================================================ conditions


class UrlCondition(Model):
    type: Literal["url"] = "url"
    frame: str | None = Field(None, description="Frame name; omitted means the top-level document.")
    path: str = Field(description="Path relative to the tenant's base URL, e.g. 'mbrdtl.asp'.")
    query: dict[str, str] = Field(default_factory=dict, description="Required query values (templated).")


class TextCondition(Model):
    type: Literal["text"] = "text"
    text: str = Field(description="Case-insensitive substring (or regex) of visible text.")
    frame: str | None = Field(None, description="Restrict to one frame; omitted means any frame.")
    regex: bool = False


class ElementCondition(Model):
    type: Literal["element"] = "element"
    target: Target


class DialogCondition(Model):
    type: Literal["dialog"] = "dialog"
    text: str = Field(description="Case-insensitive substring of a native alert/confirm message.")


class OutputCondition(Model):
    type: Literal["output"] = "output"
    name: str


class StepTargetCondition(Model):
    """Refers to another step's target *by id*, so tenant overrides of that target apply here too.

    ``element``: the target itself is present. ``anchor``: the structure the target is read from is
    present (its column header or visual label) — used to tell "the row is legitimately absent"
    apart from "the screen drifted and we can no longer recognise it"."""

    type: Literal["step_target"] = "step_target"
    step: str
    part: Literal["element", "anchor"] = "element"


Condition = Annotated[
    UrlCondition | TextCondition | ElementCondition | DialogCondition | OutputCondition | StepTargetCondition,
    Field(discriminator="type"),
]


# ============================================================================================ actions


class NavigateAction(Model):
    type: Literal["navigate"] = "navigate"
    url: str = Field(description="Templated; always relative to {{app.base_url}} so it is tenant-portable.")


class ClickAction(Model):
    type: Literal["click"] = "click"
    target: Target


class FillAction(Model):
    type: Literal["fill"] = "fill"
    target: Target
    value: str = Field(description="Template ({{inputs.x}} / {{secrets.y}}) or a constant.")


class SelectAction(Model):
    type: Literal["select"] = "select"
    target: Target
    option: str = Field(description="Visible option text or value; templated.")


class PressAction(Model):
    type: Literal["press"] = "press"
    key: str
    target: Target | None = None


class ExtractAction(Model):
    type: Literal["extract"] = "extract"
    target: Target
    output: str


Action = Annotated[
    NavigateAction | ClickAction | FillAction | SelectAction | PressAction | ExtractAction,
    Field(discriminator="type"),
]


class Step(Model):
    id: Slug = Field(description="Stable key; tenant overrides address steps by id, not position.")
    intent: str = Field(description="What this step does, in words a reviewer can check.")
    action: Action
    risk: Risk
    expect: list[Condition] = Field(
        default_factory=list, description="Postconditions that must hold before the next step runs."
    )
    timeout_ms: int = Field(15_000, ge=500, le=120_000)
    source: Literal["agent", "human", "authored"] = "agent"


# ============================================================================================ handlers


class ClickRecovery(Model):
    do: Literal["click"] = "click"
    target: Target


class DialogRecovery(Model):
    do: Literal["accept_dialog", "dismiss_dialog"]


class ReloadRecovery(Model):
    do: Literal["reload"] = "reload"
    frame: str | None = None
    backoff_ms: int = Field(1_000, ge=0, le=60_000)


class WaitRecovery(Model):
    do: Literal["wait"] = "wait"
    ms: int = Field(2_000, ge=100, le=60_000)


class ReauthenticateRecovery(Model):
    """Re-run the app's session capability, then restart this capability from its first step.
    Only permitted for idempotent capabilities — replaying a non-idempotent prefix could repeat a
    side effect, so for those the engine escalates instead."""

    do: Literal["reauthenticate"] = "reauthenticate"


Recovery = Annotated[
    ClickRecovery | DialogRecovery | ReloadRecovery | WaitRecovery | ReauthenticateRecovery,
    Field(discriminator="do"),
]


class Outcome(Model):
    code: OutcomeCode
    message: str


class Handler(Model):
    """A known exceptional state, declared as data. Replay checks handlers while it waits on every
    step, so a known state is recognised the moment it appears rather than after a timeout.

    * ``business_outcome`` — a legitimate answer the caller needs (e.g. MEMBER_NOT_FOUND).
    * ``recoverable`` — dismiss/accept/reload/wait/re-authenticate, then continue (bounded).
    * ``failure`` — a known-bad state; stop with a clear, specific error.
    """

    id: Slug
    description: str
    kind: Literal["business_outcome", "recoverable", "failure"]
    when: list[Condition] = Field(min_length=1, description="All must hold.")
    unless: list[Condition] = Field(default_factory=list, description="None may hold.")
    scope: list[str] | None = Field(None, description="Only active while executing these step ids.")
    outcome: Outcome | None = None
    recovery: Recovery | None = None
    max_attempts: int = Field(2, ge=1, le=10)
    origin: Literal["discovered", "probed", "authored"] = Field(
        "authored",
        description="How this handler came to exist: seen during discovery, found by `rote probe`, "
        "or written by a reviewer.",
    )

    @model_validator(mode="after")
    def _kind_fields(self) -> Handler:
        if self.kind == "recoverable" and self.recovery is None:
            raise ValueError(f"handler {self.id}: recoverable handlers need a recovery")
        if self.kind != "recoverable" and self.outcome is None:
            raise ValueError(f"handler {self.id}: {self.kind} handlers need an outcome code and message")
        return self


class SuccessSpec(Model):
    description: str
    all_of: list[Condition] = Field(min_length=1)


# ============================================================================================ provenance


class Review(Model):
    reviewed_by: str
    reviewed_at: datetime
    notes: str | None = None


class Provenance(Model):
    method: Literal["discovery", "authored"]
    recorded_at: datetime
    source_run: str | None = Field(None, description="Run id of the discovery run (see its evidence).")
    model: str | None = None
    goal: str = Field(description="The goal as given, with input values replaced by their templates.")
    tenant: str
    product_version: str | None = None
    human_steps: list[str] = Field(default_factory=list, description="Step ids a human demonstrated.")
    review: Review | None = None


# ============================================================================================ capability


class Capability(Model):
    # Fields that matter for review have no defaults, so they are always written out explicitly.
    schema_: Literal["rote.capability/v1"] = Field(alias="schema")
    id: CapabilityId
    version: SemVer = Field(description="MAJOR: contract change. MINOR: steps change. PATCH: locator/handler fixes.")
    kind: Literal["task", "session"]
    title: str
    description: str
    status: Literal["draft", "approved", "deprecated"]
    app: AppRef
    requires_session: CapabilityId | None = None
    idempotent: bool = Field(description="Safe to restart from step one (enables re-auth recovery).")
    side_effects: Risk = Field(description="The riskiest step; lets a caller or policy gate on it up front.")
    inputs: dict[Slug, InputSpec] = Field(default_factory=dict)
    secrets: dict[Slug, SecretSpec] = Field(default_factory=dict)
    outputs: dict[Slug, OutputSpec] = Field(default_factory=dict)
    steps: list[Step] = Field(min_length=1)
    handlers: list[Handler] = Field(default_factory=list)
    success: SuccessSpec
    provenance: Provenance

    # ---------------------------------------------------------------- invariants

    @field_validator("steps")
    @classmethod
    def _unique_step_ids(cls, steps: list[Step]) -> list[Step]:
        seen: set[str] = set()
        for step in steps:
            if step.id in seen:
                raise ValueError(f"duplicate step id {step.id!r}")
            seen.add(step.id)
        return steps

    @model_validator(mode="after")
    def _consistency(self) -> Capability:
        step_ids = {s.id for s in self.steps}
        handler_ids = [h.id for h in self.handlers]
        if len(handler_ids) != len(set(handler_ids)):
            raise ValueError("duplicate handler ids")
        for handler in self.handlers:
            for sid in handler.scope or []:
                if sid not in step_ids:
                    raise ValueError(f"handler {handler.id}: scope names unknown step {sid!r}")
            for cond in [*handler.when, *handler.unless]:
                if isinstance(cond, StepTargetCondition):
                    if cond.step not in step_ids:
                        raise ValueError(f"handler {handler.id}: step_target names unknown step {cond.step!r}")
                    if getattr(self.step(cond.step).action, "target", None) is None:
                        raise ValueError(f"handler {handler.id}: step {cond.step!r} has no target")

        produced: dict[str, str] = {}
        for step in self.steps:
            if isinstance(step.action, ExtractAction):
                name = step.action.output
                if name not in self.outputs:
                    raise ValueError(f"step {step.id}: extracts undeclared output {name!r}")
                if name in produced:
                    raise ValueError(f"output {name!r} extracted by both {produced[name]} and {step.id}")
                produced[name] = step.id
                if all(isinstance(loc, CssLocator) for loc in step.action.target.locators):
                    raise ValueError(
                        f"step {step.id}: extraction needs at least one semantic locator; a positional "
                        "selector alone could silently return another row's value"
                    )
        missing = set(self.outputs) - set(produced)
        if missing:
            raise ValueError(f"outputs never extracted: {sorted(missing)}")

        for cond in self.success.all_of:
            if isinstance(cond, OutputCondition) and cond.name not in self.outputs:
                raise ValueError(f"success condition references unknown output {cond.name!r}")

        worst = max((RISK_ORDER[s.risk] for s in self.steps), default=0)
        if RISK_ORDER[self.side_effects] < worst:
            raise ValueError("side_effects understates the riskiest step")

        for ref_kind, name in self.template_refs():
            if ref_kind == "inputs" and name not in self.inputs:
                raise ValueError(f"template references undeclared input {name!r}")
            if ref_kind == "secrets" and name not in self.secrets:
                raise ValueError(f"template references undeclared secret {name!r}")
            if ref_kind == "app" and name != "base_url":
                raise ValueError(f"unknown app template variable {name!r}")
        return self

    # ---------------------------------------------------------------- helpers

    def template_refs(self) -> set[tuple[str, str]]:
        refs: set[tuple[str, str]] = set()

        def walk(node: Any) -> None:
            if isinstance(node, str):
                refs.update((m.group(1), m.group(2)) for m in TEMPLATE_RE.finditer(node))
            elif isinstance(node, dict):
                for value in node.values():
                    walk(value)
            elif isinstance(node, list):
                for value in node:
                    walk(value)

        walk(self.model_dump(mode="json", include={"steps", "handlers", "success"}))
        return refs

    def step(self, step_id: str) -> Step:
        for step in self.steps:
            if step.id == step_id:
                return step
        raise KeyError(step_id)

    @property
    def ref(self) -> str:
        return f"{self.id}@{self.version}"

    def outcome_codes(self) -> list[str]:
        return sorted({h.outcome.code for h in self.handlers if h.kind == "business_outcome" and h.outcome})


# ============================================================================================ app profile


class VersionProbe(Model):
    frame: str | None = None
    pattern: str = Field(description="Regex with a (?P<version>...) group, matched against visible text.")


class AppProfile(Model):
    """Knowledge about a vendor product shared by every tenant and every capability that uses it:
    its session capability, known interstitials and error screens, and volatile URL parameters."""

    schema_: Literal["rote.app/v1"] = Field(alias="schema")
    id: Slug
    product: str
    surface: Literal["web", "desktop"] = "web"
    session_capability: CapabilityId | None = None
    home_path: str = Field("", description="Where task capabilities start once a session exists.")
    version_probe: VersionProbe | None = None
    volatile_query_params: list[str] = Field(default_factory=list)
    locator_preference: list[str] = Field(default_factory=lambda: ["attribute", "role", "table_cell", "label", "css"])
    handlers: list[Handler] = Field(default_factory=list)


# ============================================================================================ tenant


class StepPatch(Model):
    prepend_locators: list[Locator] = Field(default_factory=list)
    replace_target: Target | None = None
    timeout_ms: int | None = None


class CapabilityOverride(Model):
    """A reviewed, per-tenant specialisation of a shared capability, keyed by step id."""

    capability: CapabilityId
    versions: str = Field("*", description="Version range this override applies to, e.g. '>=1.0.0,<2.0.0'.")
    reason: str
    steps: dict[str, StepPatch] = Field(default_factory=dict)
    handlers: list[Handler] = Field(default_factory=list)


class TenantApp(Model):
    base_url: str
    product_version: str | None = None
    secrets: dict[str, str] = Field(default_factory=dict, description="name -> 'env:VAR_NAME'.")
    overrides: list[CapabilityOverride] = Field(default_factory=list)


class Tenant(Model):
    schema_: Literal["rote.tenant/v1"] = Field(alias="schema")
    id: Slug
    name: str
    apps: dict[str, TenantApp]
