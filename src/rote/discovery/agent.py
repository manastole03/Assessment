"""The discovery loop: observe → decide (LLM) → act (policy-gated) → record, until done or stuck.

Stopping conditions: the model calls ``finish`` (artifact built and verified), ``report_outcome``
(a business outcome — recorded as a handler proposal), max turns, wall-clock timeout, or an
operator aborts. "Stuck" is detected, not just declared: three state-changing actions that leave
the screen unchanged, or three failed/blocked actions in a row, escalate to a human automatically.
"""

from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal

from pydantic import BaseModel, Field, ValidationError

from ..artifact.resolve import BoundHandler, resolve_secret_ref
from ..artifact.schema import Risk
from ..artifact.store import to_yaml, version_key
from ..artifact.templates import TemplateContext
from ..handoff.interventions import Intervention, ReasonCode, Resolution, new_intervention_id
from ..policy.policy import ElementFacts
from ..replay.engine import ReplayEngine, ReplayOptions, StepFailed
from ..replay.values import ValueError_, coerce_output
from ..runtime import LiveSession
from ..surface.base import ElementInfo, Observation, Resolved
from ..surface.web import ActionFailed, DialogBlocked
from .decider import Decider, DeciderError, ToolCall, ToolResult
from .recorder import Recorder, RecorderError
from .tools import (
    AnswerDialog,
    Click,
    ClickAt,
    DefineCapability,
    Extract,
    Fill,
    Finish,
    Navigate,
    PressKey,
    ReportOutcome,
    RequestHuman,
    SelectOption,
    Wait,
    parse_call,
)

# USD per million tokens: (input, output, cache read, cache write). Used only for the cost estimate.
PRICES = {
    "claude-opus-5-5": (4.0, 20.0, 0.20, 5.0),
    "claude-sonnet-5-5": (2.0, 10.0, 0.20, 2.5),
}
STATE_CHANGING = {"click", "click_at", "fill", "select_option", "press_key", "navigate", "answer_dialog"}


@dataclass
class DiscoveryRequest:
    goal: str
    inputs: dict[str, str] = field(default_factory=dict)
    kind: Literal["task", "session"] = "task"
    capability_id: str | None = None
    max_turns: int = 30
    timeout_s: float = 900
    save: bool = True


class DiscoveryResult(BaseModel):
    run_id: str
    status: Literal["succeeded", "business_outcome", "failed"]
    goal: str
    capability: str | None = None
    artifact_path: str | None = None
    outcome: dict[str, str] | None = None
    failure: str | None = None
    turns: int = 0
    actions: int = 0
    interventions: list[str] = Field(default_factory=list)
    usage: dict[str, int] = Field(default_factory=dict)
    estimated_cost_usd: float = 0.0
    model: str
    duration_ms: int = 0
    evidence_dir: str


class _Stop(Exception):
    def __init__(self, status: str, **detail: Any):
        super().__init__(status)
        self.status, self.detail = status, detail


class DiscoveryAgent:
    def __init__(self, session: LiveSession, decider: Decider, request: DiscoveryRequest):
        self.s = session
        self.decider = decider
        self.request = request
        self.surface = session.surface
        self.log = session.log
        self.redactor = session.redactor
        self.engine = ReplayEngine(
            surface=session.surface,
            library=session.library,
            policy=session.policy,
            redactor=session.redactor,
            log=session.log,
            broker=session.broker,
            options=ReplayOptions(allow_draft=True, capture_steps=False),
        )
        self.actor = self.engine.actor
        self.app_handlers = [BoundHandler("app", h) for h in session.app.handlers]
        self.secrets: dict[str, str] = {}
        if request.kind == "session":
            self.secrets = {name: resolve_secret_ref(ref) for name, ref in session.binding.secrets.items()}
        for name, value in request.inputs.items():
            self.redactor.register(f"inputs.{name}", value)
        for name, value in self.secrets.items():
            self.redactor.register(f"secrets.{name}", value)
        self.ctx = TemplateContext(
            inputs=request.inputs, secrets=self.secrets, app={"base_url": session.binding.base_url.rstrip("/")}
        )
        self.recorder = Recorder(
            base_url=session.binding.base_url,
            inputs=dict(request.inputs),
            redactor=self.redactor,
            preference=session.app.locator_preference,
            volatile_params=session.app.volatile_query_params,
            relative=self.surface.relative,
            tenant_terms=[session.tenant.name.split()[0], session.tenant.id],
        )
        self.contract: DefineCapability | None = None
        self.observation: Observation | None = None
        self.outputs: dict[str, Any] = {}
        self.usage = {
            "input_tokens": 0,
            "output_tokens": 0,
            "cache_read_input_tokens": 0,
            "cache_creation_input_tokens": 0,
        }
        self.turns = 0
        self.actions = 0
        self.interventions: list[str] = []
        self.human_step_indexes: list[int] = []
        self.capability_ref: str | None = None
        self.artifact_path: str | None = None
        self.outcome: dict[str, str] | None = None

    # ================================================================================ main loop

    async def run(self) -> DiscoveryResult:
        t0 = time.monotonic()
        goal = self.redactor.text(self.request.goal)
        self.log.event(
            "run.started",
            kind="discovery",
            run_id=self.log.run_id,
            subject=goal,
            model=self.decider.model,
            tenant=self.s.tenant.id,
            evidence_dir=self.log.display_dir,
            inputs=sorted(self.request.inputs),
        )
        status, failure = "failed", None
        try:
            await self._prepare()
            await self.decider.start(self._brief(goal), self._require_observation())
            await self._loop(t0)
        except _Stop as stop:
            status = stop.status
            failure = stop.detail.get("failure")
        except DeciderError as exc:
            failure = f"model error: {exc}"
        except StepFailed as exc:
            failure = f"{exc.code.value}: {exc.message}"
        result = DiscoveryResult(
            run_id=self.log.run_id,
            status=status,
            goal=goal,
            capability=self.capability_ref,
            artifact_path=self.artifact_path,
            outcome=self.outcome,
            failure=failure,
            turns=self.turns,
            actions=self.actions,
            interventions=self.interventions,
            usage=self.usage,
            estimated_cost_usd=self._cost(),
            model=self.decider.model,
            duration_ms=int((time.monotonic() - t0) * 1000),
            evidence_dir=self.log.display_dir,
        )
        self.log.write_json("result.json", result.model_dump(mode="json"))
        self.log.event(
            "discovery.finished",
            status=status,
            capability=self.capability_ref,
            failure=failure,
            turns=self.turns,
            usage=self.usage,
            estimated_cost_usd=result.estimated_cost_usd,
        )
        return result

    async def _prepare(self) -> None:
        if self.request.kind == "task" and self.s.app.session_capability:
            if not self.s.library.has(self.s.app.session_capability):
                raise _Stop(
                    "failed",
                    failure=(
                        f"no session capability {self.s.app.session_capability} yet — discover it first with "
                        f"--kind session"
                    ),
                )
            await self.engine.establish_session(self.s.app, self.s.tenant)
            path = self.s.app.home_path
        else:
            path = ""
        before = await self.surface.observe(screenshot=False)
        await self.surface.navigate(f"{self.ctx.app['base_url']}/{path}", actor=self.actor)
        await self._observe()
        self.recorder.start(self.surface.page.url, before)
        self.recorder.observed(self._require_observation())

    async def _loop(self, t0: float) -> None:
        no_progress = errors = 0
        while True:
            if self.turns >= self.request.max_turns:
                raise _Stop("failed", failure=f"stopped after {self.turns} turns without finishing")
            if time.monotonic() - t0 > self.request.timeout_s:
                raise _Stop("failed", failure=f"discovery timed out after {self.request.timeout_s:.0f}s")
            self.turns += 1
            turn = await self.decider.next_turn()
            for key in self.usage:
                self.usage[key] += turn.usage.get(key, 0)
            self.log.event(
                "agent.turn",
                turn=self.turns,
                reasoning=turn.reasoning[:1500],
                text=turn.text[:500],
                usage=turn.usage,
                stop_reason=turn.stop_reason,
            )
            if not turn.calls:
                errors += 1
                await self.decider.feed([], None, "Continue by calling exactly one tool.")
                continue
            call = turn.calls[0]
            before = self._require_observation()
            result, terminal = await self._execute(call)
            self.log.event("agent.action_result", tool=call.name, ok=result.ok, message=result.message)
            if terminal is not None:
                raise terminal

            observation: Observation | None = None
            if call.name in STATE_CHANGING or call.name in ("wait", "request_human"):
                observation = await self._observe()
                self.recorder.observed(observation)
                changed = observation.fingerprint != before.fingerprint
                no_progress = 0 if (changed or not result.ok or call.name not in STATE_CHANGING) else no_progress + 1
            errors = 0 if result.ok else errors + 1

            note = None
            if no_progress >= 3 or errors >= 3:
                reason_code: ReasonCode = "NO_PROGRESS" if no_progress >= 3 else "REPEATED_ERRORS"
                reason = (
                    "three actions in a row left the screen unchanged"
                    if no_progress >= 3
                    else "three actions in a row failed or were blocked"
                )
                note = await self._escalate(reason_code, reason, ["continue", "abort"])
                observation = self.observation
                no_progress = errors = 0
            await self.decider.feed([result], observation, note)

    # ================================================================================ observation

    async def _observe(self) -> Observation:
        await self._settle_screen()
        await self.engine.settle(self.app_handlers, self.ctx)
        await self._settle_screen()
        self.observation = await self.surface.observe(screenshot=True)
        await self.log.capture(self.surface, f"turn-{self.turns:02d}", observation=self.observation)
        return self.observation

    def _require_observation(self) -> Observation:
        assert self.observation is not None
        return self.observation

    async def _settle_screen(self, timeout_s: float = 10) -> None:
        """Wait for in-flight document loads to finish and the screen to stop changing."""
        deadline = time.monotonic() + timeout_s
        await asyncio.sleep(0.3)
        last, stable = None, 0
        while time.monotonic() < deadline:
            if self.surface.dialog() is not None:
                return
            if self.surface.navigation_pending():
                stable = 0
            else:
                texts = await self.surface.frame_texts()
                key = (tuple(f.url for f in self.surface.page.frames), tuple(sorted(texts.items(), key=str)))
                stable = stable + 1 if key == last else 0
                last = key
                if stable >= 2:
                    return
            await asyncio.sleep(0.25)

    # ================================================================================ tools

    async def _execute(self, call: ToolCall) -> tuple[ToolResult, _Stop | None]:
        def ok(message: str) -> tuple[ToolResult, None]:
            return ToolResult(call.id, True, message), None

        def error(message: str) -> tuple[ToolResult, None]:
            return ToolResult(call.id, False, message), None

        try:
            args = parse_call(call.name, call.input)
        except (ValidationError, ValueError) as exc:
            return error(f"invalid arguments for {call.name}: {exc}")
        self.log.event("agent.action", tool=call.name, summary=self._summarize(call), rationale=args.rationale)

        if isinstance(args, DefineCapability):
            return self._define(call, args)
        if self.contract is None and not isinstance(args, (RequestHuman, ReportOutcome)):
            return error("call define_capability first to declare the capability contract")

        try:
            if isinstance(args, (Click, ClickAt)):
                return await self._click(call, args)
            if isinstance(args, Fill):
                return await self._fill(call, args)
            if isinstance(args, SelectOption):
                return await self._select(call, args)
            if isinstance(args, PressKey):
                return await self._press(call, args)
            if isinstance(args, Navigate):
                url = f"{self.ctx.app['base_url']}/{args.path.lstrip('/')}"
                decision = self.s.policy.check_action("discovery", "navigate", url=url)
                if not decision.allowed:
                    return error(f"blocked by policy: {decision.reason}")
                before = self._require_observation()
                await self.surface.navigate(url, actor=self.actor)
                self.recorder.navigate(url, before)
                self.actions += 1
                return ok(f"navigated to {args.path}")
            if isinstance(args, Extract):
                return await self._extract(call, args)
            if isinstance(args, AnswerDialog):
                dialog = self.surface.dialog()
                if dialog is None:
                    return error("no dialog is open")
                await self.surface.answer_dialog(args.accept, actor=self.actor)
                self.recorder.dialog_handler(dialog.message, args.accept)
                self.actions += 1
                return ok(f"{'accepted' if args.accept else 'dismissed'} dialog (recorded as a handler, not a step)")
            if isinstance(args, Wait):
                await asyncio.sleep(args.seconds)
                return ok(f"waited {args.seconds:.1f}s")
            if isinstance(args, ReportOutcome):
                return self._report_outcome(call, args)
            if isinstance(args, RequestHuman):
                note = await self._escalate("AGENT_REQUESTED", args.reason, ["continue", "abort"])
                return ok(note)
            if isinstance(args, Finish):
                return await self._finish(call, args)
        except DialogBlocked as exc:
            return error(f"a native dialog is open ({self.redactor.text(str(exc))!r}); answer it first")
        except ActionFailed as exc:
            self.recorder.discard_last()
            return error(f"action failed: {self.redactor.text(str(exc))}")
        except RecorderError as exc:
            return error(str(exc))
        return error(f"unsupported tool {call.name}")

    def _define(self, call: ToolCall, args: DefineCapability) -> tuple[ToolResult, None]:
        declared = {p.name for p in args.inputs}
        provided = set(self.request.inputs)
        if provided - declared:
            return ToolResult(
                call.id, False, f"declare every provided input: missing {sorted(provided - declared)}"
            ), None
        if declared - provided:
            return ToolResult(
                call.id,
                False,
                f"inputs {sorted(declared - provided)} have no value in this run; "
                f"only these inputs exist: {sorted(provided)}",
            ), None
        if self.request.capability_id:
            args = args.model_copy(update={"id": self.request.capability_id})
        self.contract = args
        return ToolResult(
            call.id,
            True,
            f"capability {args.id} declared with inputs {sorted(declared)} and outputs "
            f"{[p.name for p in args.outputs]}",
        ), None

    async def _target(self, ref: str) -> Resolved:
        resolved = await self.surface.by_ref(ref)
        if resolved is None:
            raise ActionFailed(f"unknown or stale ref {ref!r}; use refs from the latest screen")
        return resolved

    def _gate(self, action: str, element: ElementInfo) -> tuple[str, str, Any]:
        facts = ElementFacts(
            role=element.role,
            name=element.name or element.text,
            label=element.label,
            value=element.value if element.role == "button" else None,
        )
        decision = self.s.policy.check_action("discovery", action, facts)  # type: ignore[arg-type]
        self.log.event(
            "policy.decision",
            step=None,
            verdict=decision.verdict,
            risk=decision.risk,
            reason=decision.reason,
            target=element.describe(),
        )
        return decision.verdict, decision.reason, decision.risk

    async def _approval(self, element: ElementInfo, reason: str) -> bool:
        note = await self._escalate(
            "APPROVAL_REQUIRED", f"approve '{element.describe()}': {reason}", ["approve", "reject"]
        )
        return note.startswith("approved")

    async def _click(self, call: ToolCall, args: Click | ClickAt) -> tuple[ToolResult, None]:
        if isinstance(args, ClickAt):
            resolved = await self.surface.element_at(args.x, args.y)
            if resolved is None:
                return ToolResult(call.id, False, "nothing clickable at that point"), None
        else:
            resolved = await self._target(args.ref)
        element = resolved.element
        verdict, reason, risk = self._gate("click", element)
        if verdict == "deny":
            return ToolResult(call.id, False, f"blocked by policy: {reason}"), None
        if verdict == "escalate" and not await self._approval(element, reason):
            return ToolResult(call.id, False, "a human operator rejected this irreversible action"), None
        candidates = await self.surface.synthesize(resolved, prefer_values=list(self.request.inputs.values()))
        before = self._require_observation()
        self.recorder.click(element, candidates, risk, before)
        await self.surface.click(resolved, actor=self.actor)
        self.actions += 1
        return ToolResult(call.id, True, f"clicked {self.redactor.text(element.describe())}"), None

    async def _fill(self, call: ToolCall, args: Fill) -> tuple[ToolResult, None]:
        resolved = await self._target(args.ref)
        if args.input is not None:
            if args.input not in self.request.inputs:
                return ToolResult(call.id, False, f"unknown input {args.input!r}"), None
            value, template = self.request.inputs[args.input], f"{{{{inputs.{args.input}}}}}"
        elif args.secret is not None:
            if args.secret not in self.secrets:
                return ToolResult(call.id, False, f"no credential named {args.secret!r} is available"), None
            value, template = self.secrets[args.secret], f"{{{{secrets.{args.secret}}}}}"
        else:
            value = template = args.text or ""
            if self.redactor.text(value) != value:
                return ToolResult(call.id, False, "that text looks sensitive; use an input or secret reference"), None
        verdict, reason, _ = self._gate("fill", resolved.element)
        if verdict != "allow":
            return ToolResult(call.id, False, f"blocked by policy: {reason}"), None
        candidates = await self.surface.synthesize(resolved, prefer_values=list(self.request.inputs.values()))
        self.recorder.fill(resolved.element, candidates, template, self._require_observation())
        await self.surface.fill(resolved, value, actor=self.actor)
        self.actions += 1
        return ToolResult(
            call.id, True, f"entered {template} in {self.redactor.text(resolved.element.describe())}"
        ), None

    async def _select(self, call: ToolCall, args: SelectOption) -> tuple[ToolResult, None]:
        resolved = await self._target(args.ref)
        if args.input is not None:
            if args.input not in self.request.inputs:
                return ToolResult(call.id, False, f"unknown input {args.input!r}"), None
            value, template = self.request.inputs[args.input], f"{{{{inputs.{args.input}}}}}"
        else:
            value = template = args.option or ""
        verdict, reason, _ = self._gate("select", resolved.element)
        if verdict != "allow":
            return ToolResult(call.id, False, f"blocked by policy: {reason}"), None
        candidates = await self.surface.synthesize(resolved, prefer_values=list(self.request.inputs.values()))
        self.recorder.select(resolved.element, candidates, template, self._require_observation())
        await self.surface.select(resolved, value, actor=self.actor)
        self.actions += 1
        return ToolResult(call.id, True, f"selected {template!r}"), None

    async def _press(self, call: ToolCall, args: PressKey) -> tuple[ToolResult, None]:
        resolved = await self._target(args.ref) if args.ref else None
        risk: Risk = "reversible"
        candidates: list[dict[str, Any]] = []
        if resolved is not None:
            verdict, reason, risk = self._gate("press", resolved.element)
            if verdict == "deny":
                return ToolResult(call.id, False, f"blocked by policy: {reason}"), None
            if verdict == "escalate" and not await self._approval(resolved.element, reason):
                return ToolResult(call.id, False, "a human operator rejected this irreversible action"), None
            candidates = await self.surface.synthesize(resolved, prefer_values=list(self.request.inputs.values()))
        self.recorder.press(
            args.key, resolved.element if resolved else None, candidates, risk, self._require_observation()
        )
        await self.surface.press(args.key, resolved, actor=self.actor)
        self.actions += 1
        return ToolResult(call.id, True, f"pressed {args.key}"), None

    async def _extract(self, call: ToolCall, args: Extract) -> tuple[ToolResult, None]:
        assert self.contract is not None
        spec = next((p for p in self.contract.outputs if p.name == args.output), None)
        if spec is None:
            return ToolResult(call.id, False, f"{args.output!r} is not a declared output"), None
        resolved = await self._target(args.ref)
        raw = await self.surface.read(resolved)
        try:
            value = coerce_output(args.output, spec, raw)  # type: ignore[arg-type]
        except ValueError_ as exc:
            return ToolResult(call.id, False, f"{exc} — is this the element that shows the value itself?"), None
        candidates = await self.surface.synthesize(resolved, prefer_values=list(self.request.inputs.values()))
        if spec.sensitivity in ("pii", "secret"):
            self.redactor.register(f"outputs.{args.output}", raw)
        self.recorder.extract(resolved.element, candidates, args.output, raw, self._require_observation())
        self.outputs[args.output] = value
        shown = value if spec.sensitivity in ("public", "internal") else "(hidden: sensitive)"
        self.log.event("output.extracted", output=args.output, value=shown)
        return ToolResult(call.id, True, f"extracted {args.output} = {shown}"), None

    def _report_outcome(self, call: ToolCall, args: ReportOutcome) -> tuple[ToolResult, _Stop]:
        observation = self._require_observation()
        evidence = observation.element(args.evidence_ref) if args.evidence_ref else None
        handler = self.recorder.outcome_handler(args.code, args.message, evidence, origin="discovered")
        path = self.log.write_text("outcome-handler.yaml", to_yaml(handler))
        self.outcome = {"code": args.code, "message": self.redactor.text(args.message), "handler": str(path)}
        return ToolResult(call.id, True, "outcome recorded"), _Stop("business_outcome")

    async def _finish(self, call: ToolCall, args: Finish) -> tuple[ToolResult, _Stop | None]:
        assert self.contract is not None
        texts = await self.surface.frame_texts()
        needle = " ".join(args.success_text.split()).lower()
        frame = next((name for name, text in texts.items() if needle in text), "missing")
        if frame == "missing":
            return ToolResult(call.id, False, f"{args.success_text!r} is not visible on the current screen"), None
        frame_obj = self.surface.find_frame(frame) if frame else self.surface.page.main_frame
        existing = self.s.library.versions(self.contract.id)
        if existing:
            major, minor, _ = version_key(existing[-1])
            version = f"{major}.{minor + 1}.0"
        else:
            version = "1.0.0"
        session_cap = self.s.app.session_capability if self.request.kind == "task" else None
        capability = self.recorder.build(
            contract=self.contract,
            kind=self.request.kind,
            version=version,
            app_id=self.s.app.id,
            product_version=self.s.binding.product_version,
            requires_session=session_cap,
            success_text=args.success_text,
            success_frame=frame,
            success_url=frame_obj.url if frame_obj else None,
            goal=self.request.goal,
            run_id=self.log.run_id,
            model=self.decider.model,
            tenant=self.s.tenant.id,
            human_steps=self.human_step_indexes,
        )
        self.log.write_text("artifact.yaml", to_yaml(capability))
        self.capability_ref = capability.ref
        if self.request.save:
            saved = self.s.library.save(capability)
            try:
                self.artifact_path = str(saved.resolve().relative_to(Path.cwd().resolve()))
            except ValueError:
                self.artifact_path = str(saved)
        self.log.event(
            "artifact.recorded",
            capability=capability.ref,
            steps=len(capability.steps),
            path=self.artifact_path,
            summary=self.redactor.text(args.summary),
        )
        return ToolResult(call.id, True, f"recorded {capability.ref}"), _Stop("succeeded")

    # ================================================================================ escalation

    async def _escalate(self, code: ReasonCode, reason: str, allowed: list[Resolution]) -> str:
        observation = self._require_observation()
        evidence = await self.log.capture(self.surface, f"escalation-{code.lower()}", dom=True)
        item = Intervention(
            id=new_intervention_id(),
            session_id=self.s.control.session_id,
            run_id=self.log.run_id,
            run_kind="discovery",
            subject=self.redactor.text(self.request.goal),
            step_index=len(self.recorder.drafts),
            reason_code=code,
            reason=self.redactor.text(reason),
            url=self.redactor.text(self.surface.page.url),
            screenshot=str(self.log.dir / evidence["screenshot"]) if "screenshot" in evidence else None,
            observation=observation.render(self.redactor)[:8000],
            allowed_resolutions=allowed,
        )
        self.interventions.append(item.id)
        resolved = await self.s.broker.escalate(item, timeout_s=self.request.timeout_s)
        if resolved.status == "expired":
            raise _Stop("failed", failure="no operator answered the intervention")
        if resolved.resolution == "abort":
            raise _Stop("failed", failure=f"operator aborted discovery: {resolved.note or 'no note'}")
        if resolved.resolution == "reject":
            return f"rejected by operator: {resolved.note or 'no note'}"
        if resolved.resolution == "approve":
            return f"approved by operator: {resolved.note or 'no note'}"
        self._record_human_steps(resolved)
        await self._observe()
        self.recorder.observed(self._require_observation())
        done = "; ".join(a.description for a in resolved.human_actions) or "no recorded actions"
        return (
            f"A human operator took control ({code}) and handed it back. Their note: "
            f"{resolved.note or '(none)'}. They did: {done}. Continue from the current screen."
        )

    def _record_human_steps(self, item: Intervention) -> None:
        """Operator actions become steps (source: human) so the artifact covers what they demonstrated."""
        before = self._require_observation()
        for action in item.human_actions:
            element = ElementInfo.from_js({**action.element, "ref": None}, action.frame, (0, 0))
            locators = action.locators
            try:
                if action.kind == "click" and element.role not in ("textbox", "combobox", "listbox"):
                    _, _, risk = self._gate("click", element)
                    self.recorder.click(element, locators, risk, before, source="human")
                elif action.kind == "change" and element.role == "combobox" and action.value:
                    self.recorder.select(element, locators, action.value, before, source="human")
                elif action.kind == "change" and element.role == "textbox" and action.value:
                    if action.value == "[secret]":
                        self.recorder.notes.append("operator typed a credential; bind it to a secret before approval")
                        continue
                    self.recorder.fill(element, locators, action.value, before, source="human")
                elif action.kind == "enter":
                    self.recorder.press("Enter", element, locators, "reversible", before, source="human")
                else:
                    continue
                self.human_step_indexes.append(len(self.recorder.drafts) - 1)
                self.recorder.drafts[-1].expect = []
            except RecorderError as exc:
                self.recorder.notes.append(f"could not record operator action '{action.description}': {exc}")

    # ================================================================================ helpers

    def _brief(self, goal: str) -> str:
        app, tenant = self.s.app, self.s.tenant
        lines = [
            f"GOAL: {goal}",
            (
                f"APPLICATION: {app.product}, as configured for {tenant.name} (tenant '{tenant.id}'). "
                f"Base URL: {self.ctx.app['base_url']}"
            ),
        ]
        if self.request.kind == "session":
            lines.append(
                f"You are recording the SESSION capability: sign on so that every other capability can start "
                f"from a signed-on session. Use the id {self.request.capability_id or app.id + '.session.sign_on'}."
            )
        else:
            lines.append(
                f"A session was already established for you by replaying {app.session_capability}; you start "
                f"on the application's home screen. Capability ids start with '{app.id}.'."
            )
            if self.request.capability_id:
                lines.append(f"Use the capability id {self.request.capability_id}.")
        inputs = ", ".join(self.request.inputs) or "none"
        lines.append(f"INPUTS (values hidden from you; reference them by name): {inputs}")
        lines.append(f"CREDENTIALS (reference by name with fill(secret=...)): {', '.join(self.secrets) or 'none'}")
        lines.append("Begin by calling define_capability.")
        return "\n".join(lines)

    def _summarize(self, call: ToolCall) -> str:
        args = {k: v for k, v in call.input.items() if k != "rationale"}
        ref = args.get("ref")
        if ref and self.observation is not None:
            element = self.observation.element(ref)
            if element is not None:
                args["target"] = element.describe()
        return self.redactor.text(", ".join(f"{k}={v}" for k, v in args.items()))[:300]

    def _cost(self) -> float:
        prices = PRICES.get(self.decider.model)
        if prices is None:
            return 0.0
        p_in, p_out, p_read, p_write = prices
        u = self.usage
        return round(
            (
                u["input_tokens"] * p_in
                + u["output_tokens"] * p_out
                + u["cache_read_input_tokens"] * p_read
                + u["cache_creation_input_tokens"] * p_write
            )
            / 1_000_000,
            4,
        )
