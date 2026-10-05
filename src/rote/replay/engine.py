"""Deterministic replay: execute a capability with no model in the decision loop.

Every step runs the same three phases::

    resolve target ──▶ policy gate ──▶ act ──▶ await postconditions
         ▲                                            │
         └───────── known-state handlers ◀────────────┘   (checked on every poll)

While waiting — for a control to appear or for a postcondition to hold — the engine also evaluates
every declared handler. The first thing that becomes true wins: the expected state (continue), a
business outcome (return it), a recoverable condition (recover, keep waiting), or a known failure
(stop). If the timeout passes with none of them, the screen is in an *unknown* state; that is the
one case where a human is asked to help (``--escalation wait``) or the run fails with evidence.

Determinism here means *same inputs, same decisions*: all branching is driven by declared
conditions, never by a model, and waits are condition-based rather than fixed sleeps.
"""

from __future__ import annotations

import asyncio
import re
import time
from collections import Counter
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any, Literal, TypeVar

from ..artifact.resolve import BoundHandler, ResolvedCapability, resolve, version_in_range
from ..artifact.schema import (
    AppProfile,
    Capability,
    ClickAction,
    ClickRecovery,
    Condition,
    DialogCondition,
    DialogRecovery,
    ElementCondition,
    ExtractAction,
    FillAction,
    LabelLocator,
    NavigateAction,
    OutputCondition,
    PressAction,
    ReauthenticateRecovery,
    ReloadRecovery,
    SelectAction,
    Step,
    StepTargetCondition,
    TableCellLocator,
    Target,
    Tenant,
    TextCondition,
    UrlCondition,
    WaitRecovery,
)
from ..artifact.store import Library
from ..artifact.templates import TemplateContext
from ..evidence.runlog import RunLog
from ..handoff.control import Actor, ControlError
from ..handoff.interventions import Intervention, InterventionBroker, ReasonCode, new_intervention_id
from ..policy.policy import ElementFacts, PolicyEngine
from ..policy.redaction import Redactor
from ..surface.base import Resolved, Unresolved
from ..surface.web import ActionFailed, DialogBlocked, WebSurface
from .result import (
    ESCALATABLE,
    RETRYABLE,
    BusinessOutcome,
    CapabilityRef,
    Failure,
    FailureCode,
    Recovery,
    RunResult,
    RunStatus,
    StepTrace,
    Warning,
)
from .values import ValueError_, check_inputs, coerce_output

T = TypeVar("T")
POLL_S = 0.15
SETTLE_S = 0.25


# ============================================================================================ control flow


class StepFailed(Exception):
    def __init__(
        self,
        code: FailureCode,
        message: str,
        *,
        expected: str | None = None,
        observed: str | None = None,
        app_code: str | None = None,
    ):
        super().__init__(message)
        self.code, self.message = code, message
        self.expected, self.observed, self.app_code = expected, observed, app_code
        self.step: Step | None = None
        self.step_index: int | None = None
        self.capability: str | None = None


class OutcomeReached(Exception):
    def __init__(self, outcome: BusinessOutcome):
        super().__init__(outcome.code)
        self.outcome = outcome


class RestartCapability(Exception):
    """Raised after re-authentication: start the current capability again from step one."""


class _WaitTimeout(Exception):
    pass


@dataclass
class ReplayOptions:
    escalation: Literal["wait", "fail"] = "fail"
    escalation_timeout_s: float = 600
    allow_draft: bool = False
    capture_steps: bool = True


@dataclass
class _RunState:
    outputs: dict[str, Any] = field(default_factory=dict)
    recoveries: list[Recovery] = field(default_factory=list)
    warnings: list[Warning] = field(default_factory=list)
    steps: list[StepTrace] = field(default_factory=list)
    interventions: list[str] = field(default_factory=list)
    attempts: Counter[str] = field(default_factory=Counter)
    restarts: int = 0


# ============================================================================================ conditions


class _Probe:
    """Evaluates conditions against one moment of the screen, fetching each frame's text once."""

    def __init__(
        self, surface: WebSurface, ctx: TemplateContext, outputs: dict[str, Any], capability: Capability | None = None
    ):
        self.surface, self.ctx, self.outputs, self.capability = surface, ctx, outputs, capability
        self._texts: dict[str | None, str] | None = None

    async def texts(self) -> dict[str | None, str]:
        if self._texts is None:
            self._texts = await self.surface.frame_texts()
        return self._texts

    async def holds(self, condition: Condition) -> bool:
        if isinstance(condition, OutputCondition):
            return condition.name in self.outputs
        if isinstance(condition, StepTargetCondition):
            return await self._step_target(condition)
        if isinstance(condition, TextCondition):
            texts = await self.texts()
            needle = self.ctx.render(condition.text)
            haystacks = [texts.get(condition.frame, "")] if condition.frame else list(texts.values())
            if condition.regex:
                return any(re.search(needle, h, re.IGNORECASE) for h in haystacks)
            needle = " ".join(needle.split()).lower()
            return any(needle in h for h in haystacks)
        return await self.surface.check(condition, self.ctx)

    async def _step_target(self, condition: StepTargetCondition) -> bool:
        if self.capability is None:
            return False
        target: Target | None = getattr(self.capability.step(condition.step).action, "target", None)
        if target is None:
            return False
        if condition.part == "element":
            return isinstance(await self.surface.resolve(target, self.ctx), Resolved)
        frame = target.frame.name if target.frame else None
        for locator in target.locators:
            anchor = (
                locator.column
                if isinstance(locator, TableCellLocator)
                else locator.label
                if isinstance(locator, LabelLocator)
                else None
            )
            if anchor and await self.holds(TextCondition(text=anchor, frame=frame)):
                return True
        return False


def describe_condition(condition: Condition) -> str:
    if isinstance(condition, UrlCondition):
        query = "&".join(f"{k}={v}" for k, v in condition.query.items())
        return f"{condition.frame or 'top'} frame at {condition.path}{'?' + query if query else ''}"
    if isinstance(condition, TextCondition):
        return f"text {condition.text!r} visible" + (f" in {condition.frame}" if condition.frame else "")
    if isinstance(condition, ElementCondition):
        return f"{condition.target.description} present"
    if isinstance(condition, DialogCondition):
        return f"dialog containing {condition.text!r}"
    if isinstance(condition, StepTargetCondition):
        return f"{condition.part} of step {condition.step}'s target present"
    return f"output {condition.name!r} extracted"


# ============================================================================================ engine


class ReplayEngine:
    def __init__(
        self,
        *,
        surface: WebSurface,
        library: Library,
        policy: PolicyEngine,
        redactor: Redactor,
        log: RunLog,
        broker: InterventionBroker | None = None,
        options: ReplayOptions | None = None,
    ):
        self.surface = surface
        self.library = library
        self.policy = policy
        self.redactor = redactor
        self.log = log
        self.broker = broker
        self.options = options or ReplayOptions()
        self.actor = Actor.automation(log.run_id)

    # ------------------------------------------------------------------------------ entry point

    async def run(self, rc: ResolvedCapability, inputs: dict[str, Any]) -> RunResult:
        cap = rc.capability
        started = datetime.now(UTC)
        t0 = time.monotonic()
        state = _RunState()
        result = RunResult(
            run_id=self.log.run_id,
            capability=CapabilityRef(
                id=cap.id, version=cap.version, effective_hash=rc.effective_hash, layers=rc.layers
            ),
            tenant=rc.tenant.id,
            status=RunStatus.FAILED,
            started_at=started,
            evidence_dir=self.log.display_dir,
        )
        self.log.event(
            "run.started",
            kind="replay",
            run_id=self.log.run_id,
            subject=cap.ref,
            tenant=rc.tenant.id,
            evidence_dir=self.log.display_dir,
            layers=rc.layers,
            effective_hash=rc.effective_hash,
            inputs=sorted(inputs),
        )
        try:
            ctx = self._admit(rc, inputs)
            if cap.requires_session:
                await self._establish_session(rc, state)
            await self._check_version(rc, state)
            await self._run_capability(rc, ctx, state)
            await self._verify_success(rc, ctx, state)
            result.status, result.outputs = RunStatus.SUCCEEDED, dict(state.outputs)
            await self.log.capture(self.surface, "success")
        except OutcomeReached as reached:
            result.status, result.outcome = RunStatus.BUSINESS_OUTCOME, reached.outcome
            await self.protect_sensitive_outputs(rc, TemplateContext(app={"base_url": rc.base_url}))
            await self.log.capture(self.surface, f"outcome-{reached.outcome.code}")
        except StepFailed as failed:
            await self.protect_sensitive_outputs(rc, TemplateContext(app={"base_url": rc.base_url}))
            evidence = await self.log.capture(self.surface, f"failure-{failed.code.value}", dom=True)
            result.failure = Failure(
                code=failed.code,
                message=failed.message,
                app_code=failed.app_code,
                capability=failed.capability or cap.ref,
                step_id=failed.step.id if failed.step else None,
                step_index=failed.step_index,
                step_intent=failed.step.intent if failed.step else None,
                expected=failed.expected,
                observed=failed.observed,
                retryable=failed.code in RETRYABLE,
                evidence=evidence,
            )
        except Exception as exc:  # driver crash, closed browser, ... — still a structured result
            evidence = await self.log.capture(self.surface, "failure-surface", dom=True)
            result.failure = Failure(
                code=FailureCode.SURFACE_ERROR,
                message=f"{type(exc).__name__}: {exc}",
                retryable=True,
                evidence=evidence,
            )
        result.recoveries, result.warnings = state.recoveries, state.warnings
        result.interventions, result.steps = state.interventions, state.steps
        result.duration_ms = int((time.monotonic() - t0) * 1000)
        self._persist_result(rc, result)
        self.log.event(
            "run.finished",
            status=result.status.value,
            duration_ms=result.duration_ms,
            outcome=result.outcome.code if result.outcome else None,
            failure=result.failure.code.value if result.failure else None,
        )
        return result

    def _persist_result(self, rc: ResolvedCapability, result: RunResult) -> None:
        """Outputs go back to the caller in full; the persisted copy keeps only non-sensitive ones."""
        stored = result.model_dump(mode="json")
        if stored.get("outputs"):
            stored["outputs"] = {
                name: (
                    value
                    if rc.capability.outputs[name].sensitivity in ("public", "internal")
                    else f"{{{{outputs.{name}}}}}"
                )
                for name, value in stored["outputs"].items()
            }
        self.log.write_json("result.json", stored)

    # ------------------------------------------------------------------------------ admission

    def _admit(self, rc: ResolvedCapability, inputs: dict[str, Any]) -> TemplateContext:
        cap = rc.capability
        if cap.status == "deprecated":
            raise StepFailed(FailureCode.CAPABILITY_NOT_APPROVED, f"{cap.ref} is deprecated")
        if cap.status != "approved" and self.policy.policy.replay.require_approved and not self.options.allow_draft:
            raise StepFailed(
                FailureCode.CAPABILITY_NOT_APPROVED,
                f"{cap.ref} is {cap.status}; review it and run `rote approve {cap.ref}` "
                "(or pass --allow-draft for a supervised trial run)",
            )
        clean, problems = check_inputs(cap.inputs, inputs)
        if problems:
            raise StepFailed(FailureCode.INVALID_INPUT, "; ".join(problems))
        for name, value in clean.items():
            if cap.inputs[name].sensitivity in ("pii", "secret"):
                self.redactor.register(f"inputs.{name}", value)
        for step in cap.steps:
            if step.action.type not in self.policy.policy.replay.allowed_actions:
                raise StepFailed(
                    FailureCode.POLICY_VIOLATION, f"step {step.id} uses disallowed action {step.action.type}"
                )
        secrets = rc.resolve_secrets()
        for name, value in secrets.items():
            self.redactor.register(f"secrets.{name}", value)
        return TemplateContext(inputs=clean, secrets=secrets, app={"base_url": rc.base_url})

    async def establish_session(self, app: AppProfile, tenant: Tenant) -> None:
        """Sign on by replaying the app's session capability (discovery uses this before a task)."""
        if app.session_capability is None:
            return
        session = resolve(self.library.capability(app.session_capability), app, tenant)
        await self._run_session(session, _RunState())

    async def _establish_session(self, rc: ResolvedCapability, state: _RunState) -> None:
        session_id = rc.capability.requires_session
        assert session_id is not None
        await self._run_session(resolve(self.library.capability(session_id), rc.app, rc.tenant), state)

    async def _run_session(self, session: ResolvedCapability, state: _RunState) -> None:
        if session.capability.status != "approved" and not self.options.allow_draft:
            raise StepFailed(
                FailureCode.CAPABILITY_NOT_APPROVED,
                f"session capability {session.capability.ref} is {session.capability.status}",
            )
        secrets = session.resolve_secrets()
        for name, value in secrets.items():
            self.redactor.register(f"secrets.{name}", value)
        ctx = TemplateContext(secrets=secrets, app={"base_url": session.base_url})
        self.log.event("session.establishing", capability=session.capability.ref)
        try:
            await self._run_capability(session, ctx, state, nested=True)
            await self._verify_success(session, ctx, state)
        except (StepFailed, OutcomeReached) as exc:
            detail = exc.message if isinstance(exc, StepFailed) else exc.outcome.message
            failure = StepFailed(
                FailureCode.SESSION_UNAVAILABLE,
                f"could not establish a session: {detail}",
                expected=getattr(exc, "expected", None),
                observed=getattr(exc, "observed", None),
            )
            failure.capability = session.capability.ref
            failure.step, failure.step_index = getattr(exc, "step", None), getattr(exc, "step_index", None)
            raise failure from exc

    async def _check_version(self, rc: ResolvedCapability, state: _RunState) -> None:
        probe, supported = rc.app.version_probe, rc.capability.app.product_versions
        if probe is None or supported is None:
            return
        texts = await self.surface.frame_texts()
        haystacks = [texts.get(probe.frame, "")] if probe.frame else list(texts.values())
        for text in haystacks:
            match = re.search(probe.pattern, text, re.IGNORECASE)
            if match:
                version = match.group("version")
                ok = version_in_range(version, supported)
                self.log.event("app.version", version=version, supported=supported, compatible=ok)
                if not ok:
                    state.warnings.append(
                        Warning(
                            code="VERSION_MISMATCH",
                            message=(
                                f"{rc.app.product} {version} is outside the range this capability was verified on "
                                f"({supported}); running anyway, watch for drift"
                            ),
                        )
                    )
                return

    # ------------------------------------------------------------------------------ steps

    async def _run_capability(
        self, rc: ResolvedCapability, ctx: TemplateContext, state: _RunState, *, nested: bool = False
    ) -> None:
        cap = rc.capability
        index = 0
        while index < len(cap.steps):
            step = cap.steps[index]
            try:
                await self._run_step(rc, step, index, ctx, state, nested=nested)
                index += 1
            except RestartCapability:
                state.restarts += 1
                if state.restarts > 2:
                    raise StepFailed(FailureCode.RECOVERY_EXHAUSTED, "capability restarted too many times") from None
                self.log.event("capability.restarted", capability=cap.ref, reason="re-authenticated")
                for name in cap.outputs:
                    state.outputs.pop(name, None)
                index = 0
            except StepFailed as failure:
                failure.step, failure.step_index, failure.capability = step, index, cap.ref
                state.steps.append(StepTrace(capability=cap.ref, step_id=step.id, status="failed", duration_ms=0))
                decision = await self._escalate_or_raise(rc, step, index, ctx, failure, state)
                if decision == "next":
                    index += 1

    async def _run_step(
        self, rc: ResolvedCapability, step: Step, index: int, ctx: TemplateContext, state: _RunState, *, nested: bool
    ) -> None:
        cap = rc.capability
        t0 = time.monotonic()
        self.log.event(
            "step.started",
            capability=cap.ref,
            step=step.id,
            index=index,
            intent=step.intent,
            action=step.action.type,
            nested=nested,
        )
        action = step.action
        target: Target | None = getattr(action, "target", None)
        resolved: Resolved | None = None
        if target is not None:
            resolved = await self._await_target(rc, step, target, ctx, state)
            self._report_locators(step, resolved, state)
            if step.risk == "irreversible" and resolved.strategy == "css":
                raise StepFailed(
                    FailureCode.TARGET_NOT_FOUND,
                    f"only the positional locator matched {target.description}; refusing to perform an "
                    "irreversible step on a structural guess",
                    expected=target.description,
                    observed=await self._observed(),
                )

        await self._gate(rc, step, index, resolved, ctx, state)
        await self._act(rc, step, resolved, ctx, state)
        await self._await_expect(rc, step, ctx, state)

        duration = int((time.monotonic() - t0) * 1000)
        locator = resolved.strategy if resolved else None
        state.steps.append(
            StepTrace(capability=cap.ref, step_id=step.id, status="ok", duration_ms=duration, locator=locator)
        )
        self.log.event(
            "step.completed", capability=cap.ref, step=step.id, duration_ms=duration, locator=locator, nested=nested
        )
        if self.options.capture_steps:
            await self.protect_sensitive_outputs(rc, ctx)
            await self.log.capture(self.surface, f"{step.id}")

    async def protect_sensitive_outputs(self, rc: ResolvedCapability, ctx: TemplateContext) -> None:
        """The artifact says where pii lives (extract targets of pii outputs). Register whatever those
        targets show *now*, before evidence is captured, so screenshots and text are masked from the
        first moment the value is on screen — not only after the step that reads it."""
        for step in rc.capability.steps:
            action = step.action
            if not isinstance(action, ExtractAction):
                continue
            if rc.capability.outputs[action.output].sensitivity not in ("pii", "secret"):
                continue
            found = await self.surface.resolve(action.target, ctx)
            if isinstance(found, Resolved):
                try:
                    self.redactor.register(f"outputs.{action.output}", await self.surface.read(found))
                except ActionFailed:
                    continue

    # ------------------------------------------------------------------------------ waiting

    async def _await_state(
        self,
        rc: ResolvedCapability,
        step: Step,
        ctx: TemplateContext,
        state: _RunState,
        until: Callable[[_Probe], Awaitable[T | None]],
        timeout_ms: int,
    ) -> T:
        """Poll until ``until`` yields a value, reacting to handlers on every iteration."""
        deadline = time.monotonic() + timeout_ms / 1000
        while True:
            probe = _Probe(self.surface, ctx, state.outputs, rc.capability)
            fired = await self._match_handler(rc, step, probe)
            if fired is not None:
                extend_s = await self._handle(fired, rc, step, ctx, state)
                deadline = max(deadline, time.monotonic() + extend_s)
                continue
            value = await until(probe)
            if value is not None:
                return value
            if time.monotonic() > deadline:
                raise _WaitTimeout
            await asyncio.sleep(POLL_S)

    async def _match_handler(self, rc: ResolvedCapability, step: Step, probe: _Probe) -> BoundHandler | None:
        for bound in rc.handlers:
            handler = bound.handler
            if handler.scope is not None and step.id not in handler.scope:
                continue
            if not all([await probe.holds(c) for c in handler.when]):
                continue
            if any([await probe.holds(c) for c in handler.unless]):
                continue
            return bound
        return None

    async def _await_target(
        self, rc: ResolvedCapability, step: Step, target: Target, ctx: TemplateContext, state: _RunState
    ) -> Resolved:
        last: list[Unresolved] = []

        async def attempt(_: _Probe) -> Resolved | None:
            outcome = await self.surface.resolve(target, ctx)
            if isinstance(outcome, Resolved):
                return outcome
            last[:] = [outcome]
            return None

        try:
            return await self._await_state(rc, step, ctx, state, attempt, step.timeout_ms)
        except _WaitTimeout:
            unresolved = last[0] if last else None
            code = (
                FailureCode.TARGET_AMBIGUOUS
                if unresolved and unresolved.reason == "ambiguous"
                else FailureCode.TARGET_NOT_FOUND
            )
            strategies = ", ".join(f"{loc.by}" for loc in target.locators)
            raise StepFailed(
                code,
                f"could not find {target.description} within {step.timeout_ms} ms",
                expected=f"{target.description} (locators tried: {strategies})",
                observed=await self._observed(unresolved.detail if unresolved else ""),
            ) from None

    async def _await_expect(self, rc: ResolvedCapability, step: Step, ctx: TemplateContext, state: _RunState) -> None:
        if not step.expect:
            await asyncio.sleep(SETTLE_S if step.action.type in ("click", "press", "navigate") else 0)
            return

        async def satisfied(probe: _Probe) -> bool | None:
            return True if all([await probe.holds(c) for c in step.expect]) else None

        try:
            await self._await_state(rc, step, ctx, state, satisfied, step.timeout_ms)
        except _WaitTimeout:
            raise StepFailed(
                FailureCode.UNEXPECTED_STATE,
                f"after '{step.intent}' the screen did not reach the expected state, and no known handler "
                "recognised what it shows instead",
                expected="; ".join(describe_condition(c) for c in step.expect),
                observed=await self._observed(),
            ) from None

    async def _observed(self, detail: str = "") -> str:
        dialog = self.surface.dialog()
        if dialog is not None:
            return f"native {dialog.kind} dialog open: {self.redactor.text(dialog.message)!r}"
        texts = await self.surface.frame_texts(raw=True)
        lines = []
        for frame, text in texts.items():
            frame_obj = self.surface.find_frame(frame) if frame else self.surface.page.main_frame
            path = self.surface.relative(frame_obj.url)[0] if frame_obj else "?"
            snippet = " | ".join(line.strip() for line in text.splitlines() if line.strip())[:220]
            lines.append(f"[{frame or 'top'} @ {path}] {snippet}")
        observed = "\n".join(lines)
        if detail:
            observed = f"locator results: {detail}\n{observed}"
        return self.redactor.text(observed)

    # ------------------------------------------------------------------------------ handlers

    async def _handle(
        self, bound: BoundHandler, rc: ResolvedCapability, step: Step, ctx: TemplateContext, state: _RunState
    ) -> float:
        """Act on a matched handler. Returns extra seconds to add to the current wait."""
        handler = bound.handler
        self.log.event(
            "handler.fired",
            handler=handler.id,
            kind=handler.kind,
            source=bound.source,
            step=step.id,
            description=handler.description,
        )
        if handler.kind == "business_outcome":
            assert handler.outcome is not None
            raise OutcomeReached(
                BusinessOutcome(
                    code=handler.outcome.code, message=handler.outcome.message, step_id=step.id, handler=handler.id
                )
            )
        if handler.kind == "failure":
            assert handler.outcome is not None
            raise StepFailed(
                FailureCode.KNOWN_APP_ERROR,
                handler.outcome.message,
                app_code=handler.outcome.code,
                expected="; ".join(describe_condition(c) for c in step.expect) or None,
                observed=await self._observed(),
            )

        key = f"{rc.capability.id}:{handler.id}"
        state.attempts[key] += 1
        attempt = state.attempts[key]
        if attempt > handler.max_attempts:
            raise StepFailed(
                FailureCode.RECOVERY_EXHAUSTED,
                f"'{handler.id}' recurred {attempt} times (limit {handler.max_attempts})",
                observed=await self._observed(),
            )
        if isinstance(handler.recovery, ReauthenticateRecovery):
            if rc.capability.kind == "session":  # expired while signing on: just sign on again
                self._record_recovery(bound, step, "restart sign-on", attempt, state)
                raise RestartCapability
            if not rc.capability.idempotent:
                raise StepFailed(
                    FailureCode.UNSAFE_TO_RESUME,
                    f"session lost during non-idempotent {rc.capability.ref}; restarting could repeat a side effect",
                    observed=await self._observed(),
                )
            self._record_recovery(bound, step, "re-authenticate and restart capability", attempt, state)
            await self._establish_session(rc, state)
            raise RestartCapability
        action, extend_s = await self._perform_recovery(bound, ctx, attempt)
        self._record_recovery(bound, step, action, attempt, state)
        return extend_s

    async def _perform_recovery(self, bound: BoundHandler, ctx: TemplateContext, attempt: int) -> tuple[str, float]:
        handler, recovery = bound.handler, bound.handler.recovery
        extend_s = 0.0
        if isinstance(recovery, ClickRecovery):
            target = await self.surface.resolve(recovery.target, ctx)
            if not isinstance(target, Resolved):
                raise StepFailed(
                    FailureCode.RECOVERY_EXHAUSTED,
                    f"handler '{handler.id}' matched but {recovery.target.description} is missing",
                    observed=await self._observed(),
                )
            await self.surface.click(target, actor=self.actor)
            action = f"clicked {recovery.target.description}"
        elif isinstance(recovery, DialogRecovery):
            await self.surface.answer_dialog(recovery.do == "accept_dialog", actor=self.actor)
            action = recovery.do.replace("_", " ")
        elif isinstance(recovery, ReloadRecovery):
            await asyncio.sleep(recovery.backoff_ms * attempt / 1000)
            await self.surface.reload(recovery.frame, actor=self.actor)
            action = f"reloaded {recovery.frame or 'page'} after {recovery.backoff_ms * attempt} ms backoff"
        elif isinstance(recovery, WaitRecovery):
            await asyncio.sleep(recovery.ms / 1000)
            extend_s = recovery.ms / 1000
            action = f"waited {recovery.ms} ms for a known progress state"
        else:  # pragma: no cover - reauthenticate is handled by the caller
            raise AssertionError(recovery)
        await asyncio.sleep(SETTLE_S)
        return action, extend_s

    async def settle(self, handlers: list[BoundHandler], ctx: TemplateContext, *, rounds: int = 4) -> list[str]:
        """Apply any *recoverable* known-state handlers that currently match (interstitials, dialogs,
        transient errors). Discovery calls this before every observation, so the model never has to
        learn vendor interstitials and they never pollute a recording."""
        applied: list[str] = []
        for _ in range(rounds):
            probe = _Probe(self.surface, ctx, {})
            for bound in handlers:
                handler = bound.handler
                if handler.kind != "recoverable" or isinstance(handler.recovery, ReauthenticateRecovery):
                    continue
                if all([await probe.holds(c) for c in handler.when]) and not any(
                    [await probe.holds(c) for c in handler.unless]
                ):
                    self.log.event(
                        "handler.fired",
                        handler=handler.id,
                        kind=handler.kind,
                        source=bound.source,
                        step=None,
                        description=handler.description,
                    )
                    action, _ = await self._perform_recovery(bound, ctx, attempt=1)
                    self.log.event("recovery.performed", handler=handler.id, step=None, action=action, attempt=1)
                    applied.append(handler.id)
                    break
            else:
                return applied
        return applied

    def _record_recovery(self, bound: BoundHandler, step: Step, action: str, attempt: int, state: _RunState) -> None:
        state.recoveries.append(
            Recovery(handler=bound.handler.id, source=bound.source, step_id=step.id, action=action, attempt=attempt)
        )
        self.log.event("recovery.performed", handler=bound.handler.id, step=step.id, action=action, attempt=attempt)

    # ------------------------------------------------------------------------------ act

    async def _gate(
        self,
        rc: ResolvedCapability,
        step: Step,
        index: int,
        resolved: Resolved | None,
        ctx: TemplateContext,
        state: _RunState,
    ) -> None:
        facts = None
        if resolved is not None:
            e = resolved.element
            facts = ElementFacts(
                role=e.role, name=e.name or e.text, label=e.label, value=e.value if e.role == "button" else None
            )
        url = ctx.render(step.action.url) if isinstance(step.action, NavigateAction) else None
        decision = self.policy.check_action(
            "replay",
            step.action.type,
            facts,
            declared_risk=step.risk,
            url=url,
            capability_approved=rc.capability.status == "approved",
        )
        self.log.event(
            "policy.decision", step=step.id, verdict=decision.verdict, risk=decision.risk, reason=decision.reason
        )
        if decision.verdict == "deny":
            raise StepFailed(FailureCode.POLICY_VIOLATION, decision.reason)
        if decision.verdict == "escalate":
            if self.options.escalation != "wait" or self.broker is None:
                raise StepFailed(
                    FailureCode.POLICY_VIOLATION,
                    f"{decision.reason}; re-run with --escalation wait so an operator can confirm",
                )
            item = await self._raise_intervention(
                rc,
                step,
                index,
                "APPROVAL_REQUIRED",
                f"confirm irreversible step: {step.intent}",
                ["approve", "reject"],
                state,
            )
            if item.status == "expired":
                raise StepFailed(FailureCode.ESCALATION_TIMEOUT, "no operator confirmed the irreversible step")
            if item.resolution != "approve":
                raise StepFailed(FailureCode.REJECTED_BY_OPERATOR, f"operator rejected: {item.note or 'no note'}")

    async def _act(
        self, rc: ResolvedCapability, step: Step, resolved: Resolved | None, ctx: TemplateContext, state: _RunState
    ) -> None:
        action = step.action
        for attempt in (1, 2):
            try:
                if isinstance(action, NavigateAction):
                    await self.surface.navigate(ctx.render(action.url), actor=self.actor)
                elif isinstance(action, ClickAction):
                    assert resolved is not None
                    await self.surface.click(resolved, actor=self.actor)
                elif isinstance(action, FillAction):
                    assert resolved is not None
                    await self.surface.fill(resolved, ctx.render(action.value), actor=self.actor)
                elif isinstance(action, SelectAction):
                    assert resolved is not None
                    await self.surface.select(resolved, ctx.render(action.option), actor=self.actor)
                elif isinstance(action, PressAction):
                    await self.surface.press(action.key, resolved, actor=self.actor)
                elif isinstance(action, ExtractAction):
                    assert resolved is not None
                    await self._extract(rc, action, resolved, state)
                return
            except DialogBlocked:
                if attempt == 2:
                    raise StepFailed(
                        FailureCode.UNEXPECTED_STATE,
                        "a native dialog blocked the action",
                        observed=await self._observed(),
                    ) from None
                # Let the handlers deal with the dialog, then retry the action once.
                await self._await_state(rc, step, ctx, state, lambda _p: self._no_dialog(), timeout_ms=3_000)
            except ControlError as exc:
                raise StepFailed(FailureCode.ACTION_FAILED, f"lost control of the session: {exc}") from exc
            except PermissionError as exc:
                raise StepFailed(FailureCode.POLICY_VIOLATION, str(exc)) from exc
            except ActionFailed as exc:
                raise StepFailed(
                    FailureCode.ACTION_FAILED, f"{action.type} failed: {exc}", observed=await self._observed()
                ) from exc

    async def _no_dialog(self) -> bool | None:
        return True if self.surface.dialog() is None else None

    async def _extract(
        self, rc: ResolvedCapability, action: ExtractAction, resolved: Resolved, state: _RunState
    ) -> None:
        spec = rc.capability.outputs[action.output]
        raw = await self.surface.read(resolved)
        try:
            value = coerce_output(action.output, spec, raw)
        except ValueError_ as exc:
            raise StepFailed(
                FailureCode.OUTPUT_INVALID, str(exc), expected=f"a {spec.type} value", observed=self.redactor.text(raw)
            ) from exc
        if spec.sensitivity in ("pii", "secret"):
            self.redactor.register(f"outputs.{action.output}", raw)
            self.redactor.register(f"outputs.{action.output}", str(value))
        state.outputs[action.output] = value
        self.log.event(
            "output.extracted",
            output=action.output,
            type=spec.type,
            value=value if spec.sensitivity in ("public", "internal") else f"{{{{outputs.{action.output}}}}}",
        )

    # ------------------------------------------------------------------------------ verification

    async def _verify_success(self, rc: ResolvedCapability, ctx: TemplateContext, state: _RunState) -> None:
        cap = rc.capability
        last = cap.steps[-1]
        pending = list(cap.success.all_of)

        async def verified(probe: _Probe) -> bool | None:
            return True if all([await probe.holds(c) for c in pending]) else None

        try:
            await self._await_state(rc, last, ctx, state, verified, 5_000)
        except _WaitTimeout:
            probe = _Probe(self.surface, ctx, state.outputs, cap)
            unmet = [describe_condition(c) for c in pending if not await probe.holds(c)]
            raise StepFailed(
                FailureCode.CHECKPOINT_FAILED,
                f"success checkpoint for {cap.ref} not verified: {cap.success.description}",
                expected="; ".join(unmet),
                observed=await self._observed(),
            ) from None
        self.log.event("checkpoint.verified", capability=cap.ref, description=cap.success.description)

    # ------------------------------------------------------------------------------ drift & escalation

    def _report_locators(self, step: Step, resolved: Resolved, state: _RunState) -> None:
        def warn(code: str, message: str) -> None:
            state.warnings.append(Warning(code=code, step_id=step.id, message=message))
            self.log.event("locator.warning", step=step.id, code=code, message=message)

        if resolved.strategy_index > 0:
            warn(
                "LOCATOR_FALLBACK",
                f"primary locator failed; resolved with #{resolved.strategy_index + 1} ({resolved.strategy})",
            )
        for check in resolved.checks:
            if check.verdict in ("missing", "ambiguous", "role_mismatch") and check.index != resolved.strategy_index:
                warn(
                    "LOCATOR_DRIFT",
                    f"{check.strategy} locator no longer matches ({check.verdict}, {check.count} hit(s))",
                )
            elif check.verdict == "conflict":
                warn("LOCATOR_CONFLICT", f"{check.strategy} locator points at a different element")
        for message in resolved.warnings:
            warn("FRAME_DRIFT", message)

    async def _raise_intervention(
        self,
        rc: ResolvedCapability,
        step: Step,
        index: int,
        code: ReasonCode,
        reason: str,
        allowed: list[Any],
        state: _RunState,
    ) -> Intervention:
        assert self.broker is not None
        evidence = await self.log.capture(self.surface, f"escalation-{step.id}", dom=True)
        observation = await self.surface.observe(screenshot=False)
        item = Intervention(
            id=new_intervention_id(),
            session_id=self.surface.control.session_id,
            run_id=self.log.run_id,
            run_kind="replay",
            subject=rc.capability.ref,
            step_id=step.id,
            step_index=index,
            step_intent=step.intent,
            reason_code=code,
            reason=self.redactor.text(reason),
            url=self.redactor.text(self.surface.page.url),
            screenshot=str(self.log.dir / evidence["screenshot"]) if "screenshot" in evidence else None,
            observation=observation.render(self.redactor)[:8000],
            allowed_resolutions=allowed,
        )
        state.interventions.append(item.id)
        return await self.broker.escalate(item, timeout_s=self.options.escalation_timeout_s)

    async def _escalate_or_raise(
        self,
        rc: ResolvedCapability,
        step: Step,
        index: int,
        ctx: TemplateContext,
        failure: StepFailed,
        state: _RunState,
    ) -> Literal["retry", "next"]:
        if self.options.escalation != "wait" or self.broker is None or failure.code not in ESCALATABLE:
            raise failure
        reason_code: ReasonCode = (
            "TARGET_NOT_FOUND"
            if failure.code in (FailureCode.TARGET_NOT_FOUND, FailureCode.TARGET_AMBIGUOUS)
            else "RECOVERY_EXHAUSTED"
            if failure.code == FailureCode.RECOVERY_EXHAUSTED
            else "UNEXPECTED_STATE"
        )
        detail = f"{failure.message}. Expected: {failure.expected or '-'}"
        item = await self._raise_intervention(
            rc, step, index, reason_code, detail, ["retry_step", "step_completed", "abort"], state
        )
        if item.status == "expired":
            timeout = StepFailed(
                FailureCode.ESCALATION_TIMEOUT,
                "no operator resolved the intervention in time",
                expected=failure.expected,
                observed=failure.observed,
            )
            timeout.step, timeout.step_index, timeout.capability = step, index, rc.capability.ref
            raise timeout
        if item.resolution == "abort":
            aborted = StepFailed(
                FailureCode.ESCALATION_ABORTED,
                f"operator aborted: {item.note or 'no note'}",
                expected=failure.expected,
                observed=failure.observed,
            )
            aborted.step, aborted.step_index, aborted.capability = step, index, rc.capability.ref
            raise aborted
        if item.resolution == "step_completed":
            if step.expect:

                async def satisfied(probe: _Probe) -> bool | None:
                    return True if all([await probe.holds(c) for c in step.expect]) else None

                try:
                    await self._await_state(rc, step, ctx, state, satisfied, 5_000)
                except _WaitTimeout:
                    raise StepFailed(
                        FailureCode.UNEXPECTED_STATE,
                        "operator marked the step complete but its postconditions do not hold",
                        expected="; ".join(describe_condition(c) for c in step.expect),
                        observed=await self._observed(),
                    ) from None
            state.steps.append(
                StepTrace(capability=rc.capability.ref, step_id=step.id, status="human_completed", duration_ms=0)
            )
            return "next"
        return "retry"
