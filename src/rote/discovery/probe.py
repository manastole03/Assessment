"""`rote probe`: let the model name an unknown exceptional screen, once, and turn it into a handler.

Discovery records the happy path. Business outcomes ("no such member", "restricted account") live
on other paths. Probing replays the *recorded* capability deterministically with an input expected
to leave the happy path. If replay stops on a screen no handler recognises, one bounded model call
classifies it (business outcome or known failure, with an evidence element). The resulting handler
is verified against the live screen and saved as a new PATCH version in ``draft`` status — so it
goes through the same review/approval gate as everything else. The model is never asked to *act*.
"""

from __future__ import annotations

import base64
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any, Literal

import anthropic
from pydantic import BaseModel, Field

from ..artifact.resolve import ResolvedCapability
from ..artifact.schema import Capability, Handler, StepTargetCondition
from ..artifact.store import to_yaml
from ..artifact.templates import TemplateContext
from ..policy.redaction import Redactor
from ..replay.engine import ReplayEngine, ReplayOptions, _Probe
from ..replay.result import FailureCode, RunResult, RunStatus
from ..runtime import LiveSession
from ..surface.base import Observation
from .recorder import Recorder

PROBE_SYSTEM = """\
You review screens where a recorded back-office automation (a "capability") stopped because the \
screen did not match what it expected. Decide what the screen means for the agent that invoked the \
capability, and call classify_screen exactly once.

- business_outcome: the application gave a legitimate answer that is not the happy path (no matching \
record, account restricted, not eligible, ...). The caller should receive it as a result, not an error.
- failure: a known application error the caller cannot fix by choosing different inputs (permission \
problem, system error, ...).
- unknown: anything else, including screens that look like the automation itself went wrong.

code is a short UPPER_SNAKE_CASE name for the outcome. message is one sentence for the calling agent. \
evidence_ref is the element whose text identifies this screen: it must be stable application text \
(a message or title), never data such as names, numbers or amounts.
evidence_type is "message" when the screen states the outcome explicitly (e.g. "NO RECORDS MATCH"), or \
"absence" when you infer it because something expected is simply not there (e.g. a list without the \
row the capability reads). Be honest here: absence-based outcomes get extra safeguards."""

CLASSIFY_TOOL = {
    "name": "classify_screen",
    "description": "Classify the screen where the capability stopped.",
    "input_schema": {
        "type": "object",
        "properties": {
            "kind": {"type": "string", "enum": ["business_outcome", "failure", "unknown"]},
            "code": {"type": "string", "description": "UPPER_SNAKE_CASE"},
            "message": {"type": "string"},
            "evidence_ref": {"type": "string"},
            "evidence_type": {"type": "string", "enum": ["message", "absence"]},
            "rationale": {"type": "string"},
        },
        "required": ["kind", "code", "message", "evidence_ref", "evidence_type", "rationale"],
        "additionalProperties": False,
    },
}


class Classification(BaseModel):
    kind: str
    code: str = Field(pattern=r"^[A-Z][A-Z0-9_]*$")
    message: str
    evidence_ref: str
    evidence_type: Literal["message", "absence"] = "message"
    rationale: str
    source: str = "model"


@dataclass
class ProbeOutcome:
    replay: RunResult
    classification: Classification | None = None
    handler: Handler | None = None
    capability: Capability | None = None
    path: str | None = None
    note: str = ""


def guard_handler(
    handler: Handler, capability: Capability, step_id: str | None, *, kind: str, evidence_type: str = "message"
) -> Handler:
    """Make a proposed handler safe by construction.

    * scoped to the step that stopped, and only while that step's target is absent
      (``unless: step_target``) — it can never pre-empt the happy path;
    * if the outcome is inferred from *absence*, it must also see the structure the target is read
      from (``when: step_target.anchor`` — e.g. the column header). If that structure is missing the
      screen has drifted, and drift must surface as a failure, never as a wrong business answer.

    Both conditions reference the step by id, so tenant overrides of the target apply automatically.
    """
    update: dict[str, Any] = {"kind": kind}
    if step_id is not None and getattr(capability.step(step_id).action, "target", None) is not None:
        update["scope"] = [step_id]
        update["unless"] = [StepTargetCondition(step=step_id)]
        if evidence_type == "absence":
            update["when"] = [*handler.when, StepTargetCondition(step=step_id, part="anchor")]
    return Handler.model_validate({**handler.model_dump(), **update})


Classifier = Callable[[Observation, RunResult, ResolvedCapability, Redactor], Awaitable["Classification | None"]]


def claude_classifier(model: str, effort: str) -> Classifier:
    """One bounded, non-agentic model call: classify the screen. The model never acts on the UI."""

    async def classify(
        observation: Observation, result: RunResult, rc: ResolvedCapability, redactor: Redactor
    ) -> Classification | None:
        assert result.failure is not None
        content: list[dict[str, Any]] = [
            {
                "type": "text",
                "text": (
                    f"Capability: {rc.capability.ref} — {rc.capability.description}\n"
                    f"Stopped at step {result.failure.step_id}: {result.failure.step_intent}\n"
                    f"Expected: {result.failure.expected}\n\nScreen:\n{observation.render(redactor)}"
                ),
            }
        ]
        if observation.screenshot:
            content.append(
                {
                    "type": "image",
                    "source": {
                        "type": "base64",
                        "media_type": "image/jpeg",
                        "data": base64.standard_b64encode(observation.screenshot).decode(),
                    },
                }
            )
        client = anthropic.AsyncAnthropic(max_retries=4)
        response = await client.messages.create(  # type: ignore[call-overload]
            model=model,
            max_tokens=8_000,
            system=PROBE_SYSTEM,
            tools=[CLASSIFY_TOOL],
            tool_choice={"type": "auto"},
            thinking={"type": "adaptive"},
            output_config={"effort": effort},
            messages=[{"role": "user", "content": content}],
        )
        call = next((b for b in response.content if b.type == "tool_use"), None)
        return Classification.model_validate(call.input) if call is not None else None

    return classify


async def probe(
    session: LiveSession, rc: ResolvedCapability, inputs: dict[str, str], *, classifier: Classifier, save: bool
) -> ProbeOutcome:
    engine = ReplayEngine(
        surface=session.surface,
        library=session.library,
        policy=session.policy,
        redactor=session.redactor,
        log=session.log,
        broker=None,
        options=ReplayOptions(allow_draft=True),
    )
    result = await engine.run(rc, inputs)
    if result.status is not RunStatus.FAILED:
        return ProbeOutcome(result, note=f"replay ended with {result.status.value}; nothing new to learn")
    assert result.failure is not None
    if result.failure.code not in (FailureCode.TARGET_NOT_FOUND, FailureCode.UNEXPECTED_STATE):
        return ProbeOutcome(result, note=f"{result.failure.code.value} is not an unknown-screen failure")

    observation = await session.surface.observe(screenshot=True)
    classification = await classifier(observation, result, rc, session.redactor)
    if classification is None:
        return ProbeOutcome(result, note="the screen was not classified")
    session.log.event("probe.classified", **classification.model_dump())
    if classification.kind == "unknown":
        return ProbeOutcome(result, classification, note="model could not classify the screen; escalate to a human")

    recorder = Recorder(
        base_url=rc.base_url,
        inputs=dict(inputs),
        redactor=session.redactor,
        preference=rc.app.locator_preference,
        volatile_params=rc.app.volatile_query_params,
        relative=session.surface.relative,
    )
    origin = "probed" if classification.source == "model" else "authored"
    handler = recorder.outcome_handler(
        classification.code, classification.message, observation.element(classification.evidence_ref), origin=origin
    )
    handler = guard_handler(
        handler,
        rc.capability,
        result.failure.step_id,
        kind="failure" if classification.kind == "failure" else "business_outcome",
        evidence_type=classification.evidence_type,
    )

    ctx = TemplateContext(inputs=inputs, app={"base_url": rc.base_url})
    probe_now = _Probe(session.surface, ctx, {}, rc.capability)
    if not all([await probe_now.holds(c) for c in handler.when]):
        return ProbeOutcome(result, classification, handler, note="proposed handler does not match the live screen")
    session.log.write_text("probed-handler.yaml", to_yaml(handler))

    base = session.library.capability(rc.capability.ref)
    if any(h.id == handler.id for h in base.handlers):
        return ProbeOutcome(result, classification, handler, note=f"handler {handler.id} already exists")
    major, minor, patch = (int(p) for p in base.version.split("."))
    updated = base.model_copy(deep=True, update={"version": f"{major}.{minor}.{patch + 1}", "status": "draft"})
    updated.handlers.append(handler)
    updated.provenance.review = None
    updated = Capability.model_validate(updated.model_dump(by_alias=True))
    path = str(session.library.save(updated)) if save else None
    return ProbeOutcome(result, classification, handler, updated, path)
