"""Turns what the discovery agent *did* into a capability artifact — decoupled from the transcript.

Rules the recorder applies (each is a deliberate robustness or safety choice):

* **Locators** come from the live element at the moment of the action, and every one was verified to
  match exactly that element (``synthesize``). They are ordered by the app's preference
  (contract attribute → role/name → table cell → visual label → css).
* **Reads never use positional or content locators.** For ``extract`` targets, ``css`` (position)
  and ``role`` (the element's own text — i.e. the data) are dropped; only semantic anchors remain.
* **Values become references.** Input values found in locators/URLs become ``{{inputs.x}}``;
  credentials are only ever ``{{secrets.y}}``. Any locator still containing sensitive data is dropped.
* **Postconditions** are derived from what actually changed: the frame URL (with input-valued query
  parameters templated) plus one new, stable, non-data text in that frame. Tenant branding is
  excluded so the condition holds for every institution on the same product.
* **Dialogs** the agent answered become recoverable *handlers*, not steps, because dialogs are
  conditional by nature.
"""

from __future__ import annotations

import re
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any
from urllib.parse import urlencode

from pydantic import TypeAdapter, ValidationError

from ..artifact.schema import (
    RISK_ORDER,
    Action,
    AppRef,
    Capability,
    ClickAction,
    Condition,
    DialogCondition,
    DialogRecovery,
    ExtractAction,
    FillAction,
    FrameRef,
    Handler,
    InputSpec,
    Locator,
    NavigateAction,
    Outcome,
    OutputCondition,
    OutputSpec,
    PressAction,
    Provenance,
    Risk,
    SecretSpec,
    SelectAction,
    Step,
    SuccessSpec,
    Target,
    TextCondition,
    UrlCondition,
)
from ..artifact.templates import TEMPLATE_RE, parameterize
from ..policy.redaction import Redactor
from ..surface.base import ElementInfo, Observation
from .tools import DefineCapability

_LOCATOR: TypeAdapter[Any] = TypeAdapter(Locator)
_DATAISH = re.compile(r"\d{3,}|\$|\d+\.\d{2}")
_NON_TITLE_ROLES = {"link", "button", "textbox", "combobox", "listbox", "checkbox", "radio", "option"}


def _strings(node: Any) -> list[str]:
    if isinstance(node, str):
        return [node]
    if isinstance(node, dict):
        return [s for v in node.values() for s in _strings(v)]
    if isinstance(node, list):
        return [s for v in node for s in _strings(v)]
    return []


class RecorderError(ValueError):
    """The run cannot be turned into a valid artifact yet (explained to the model so it can fix it)."""


@dataclass
class _Draft:
    action: Action
    risk: Risk
    intent: str
    slug: str
    source: str = "agent"
    before: Observation | None = None
    expect: list[Condition] | None = None


@dataclass
class Recorder:
    base_url: str
    inputs: dict[str, str]
    redactor: Redactor
    preference: list[str]
    volatile_params: list[str]
    relative: Callable[[str], tuple[str, dict[str, str]]]
    tenant_terms: list[str] = field(default_factory=list)
    drafts: list[_Draft] = field(default_factory=list)
    handlers: list[Handler] = field(default_factory=list)
    secrets_used: set[str] = field(default_factory=set)
    outputs_raw: dict[str, str] = field(default_factory=dict)
    notes: list[str] = field(default_factory=list)

    # ================================================================================ templating

    def _template(self, text: str) -> str:
        return parameterize(text, self.inputs)

    def _clean(self, text: str) -> str:
        """Templated and redacted text for human-readable fields (intent, description)."""
        return self.redactor.text(self._template(text))

    def _is_safe(self, text: str) -> bool:
        return self.redactor.text(text) == text and not any(v and v in text for v in self.outputs_raw.values())

    # ================================================================================ targets

    def target(self, element: ElementInfo, candidates: list[dict[str, Any]], *, for_extract: bool) -> Target:
        locators: list[Locator] = []
        for raw in candidates:
            by = raw.get("by")
            if for_extract and by in ("css", "role"):
                continue
            templated = {k: self._template(v) if isinstance(v, str) else v for k, v in raw.items()}
            if not all(self._is_safe(v) for v in templated.values() if isinstance(v, str)):
                continue
            try:
                locators.append(_LOCATOR.validate_python(templated))
            except ValidationError:
                continue
        rank = {name: i for i, name in enumerate(self.preference)}
        locators.sort(key=lambda loc: rank.get(loc.by, len(rank)))
        if not locators:
            raise RecorderError(
                f"no robust way to identify {element.describe()}: it has no label, column header or stable "
                "attribute"
                + (
                    " — for extract, choose the cell that shows the value inside a labelled row or column"
                    if for_extract
                    else ""
                )
            )
        frame = FrameRef(name=element.frame) if element.frame else None
        return Target(description=self._describe(element, locators), frame=frame, role=element.role, locators=locators)

    def _describe(self, element: ElementInfo, locators: list[Locator]) -> str:
        """A reviewer-facing name for the control, built only from non-data anchors."""
        role = element.role or element.tag
        cell = next((loc for loc in locators if loc.by == "table_cell"), None)
        if element.label:
            text = f"'{element.label}' {role}"
        elif element.name and role in ("link", "button", "heading", "columnheader", "tab", "menuitem"):
            text = f"{role} '{element.name[:40]}'"
        elif cell is not None:
            text = f"{role} in column '{cell.column}', row '{cell.row}'"
        else:
            text = role
        if element.frame:
            text += f" ({element.frame} frame)"
        return self._clean(text)

    @staticmethod
    def _slug(text: str) -> str:
        text = TEMPLATE_RE.sub(lambda m: m.group(2), text)
        text = re.sub(r"\([^)]*frame\)", "", text)
        words = re.findall(r"[a-z0-9]+", text.lower())
        return "_".join(words)[:36].strip("_") or "step"

    # ================================================================================ recording

    def start(self, landed_url: str, before: Observation) -> _Draft:
        path, query = self.relative(landed_url)
        kept = {k: self._template(v) for k, v in query.items() if k not in self.volatile_params}
        url = "{{app.base_url}}/" + path + (f"?{urlencode(kept, safe='{}.')}" if kept else "")
        draft = _Draft(
            action=NavigateAction(url=url),
            risk="read_only",
            intent=f"Open {path or 'the entry page'}",
            slug=f"open_{self._slug(path) or 'entry'}",
            before=before,
            expect=[UrlCondition(frame=None, path=path)],
        )
        self.drafts.append(draft)
        return draft

    def click(
        self,
        element: ElementInfo,
        candidates: list[dict[str, Any]],
        risk: Risk,
        before: Observation,
        source: str = "agent",
    ) -> _Draft:
        target = self.target(element, candidates, for_extract=False)
        return self._add(
            ClickAction(target=target),
            risk,
            f"Click {target.description}",
            f"click {target.description}",
            before,
            source,
        )

    def fill(
        self,
        element: ElementInfo,
        candidates: list[dict[str, Any]],
        value: str,
        before: Observation,
        source: str = "agent",
    ) -> _Draft:
        target = self.target(element, candidates, for_extract=False)
        for match in TEMPLATE_RE.finditer(value):
            if match.group(1) == "secrets":
                self.secrets_used.add(match.group(2))
        shown = value if TEMPLATE_RE.search(value) else repr(value)
        # Consecutive edits of the same field collapse into the last one.
        if self.drafts and isinstance(self.drafts[-1].action, FillAction) and self.drafts[-1].action.target == target:
            self.drafts.pop()
        return self._add(
            FillAction(target=target, value=value),
            "reversible",
            f"Enter {shown} in {target.description}",
            f"fill {target.description}",
            before,
            source,
        )

    def select(
        self,
        element: ElementInfo,
        candidates: list[dict[str, Any]],
        option: str,
        before: Observation,
        source: str = "agent",
    ) -> _Draft:
        target = self.target(element, candidates, for_extract=False)
        return self._add(
            SelectAction(target=target, option=option),
            "reversible",
            f"Choose {option} in {target.description}",
            f"select {target.description}",
            before,
            source,
        )

    def press(
        self,
        key: str,
        element: ElementInfo | None,
        candidates: list[dict[str, Any]],
        risk: Risk,
        before: Observation,
        source: str = "agent",
    ) -> _Draft:
        target = self.target(element, candidates, for_extract=False) if element is not None else None
        where = f" in {target.description}" if target else ""
        return self._add(
            PressAction(key=key, target=target), risk, f"Press {key}{where}", f"press {key}{where}", before, source
        )

    def extract(
        self, element: ElementInfo, candidates: list[dict[str, Any]], output: str, raw: str, before: Observation
    ) -> _Draft:
        target = self.target(element, candidates, for_extract=True)
        self.outputs_raw[output] = raw
        self.drafts = [
            d for d in self.drafts if not (isinstance(d.action, ExtractAction) and d.action.output == output)
        ]
        draft = self._add(
            ExtractAction(target=target, output=output),
            "read_only",
            f"Read {output} from {target.description}",
            f"read {output}",
            before,
            "agent",
        )
        draft.expect = []
        return draft

    def navigate(self, url: str, before: Observation) -> _Draft:
        path, query = self.relative(url)
        kept = {k: self._template(v) for k, v in query.items() if k not in self.volatile_params}
        templated = "{{app.base_url}}/" + path + (f"?{urlencode(kept, safe='{}.')}" if kept else "")
        return self._add(NavigateAction(url=templated), "read_only", f"Open {path}", f"open {path}", before, "agent")

    def _add(self, action: Action, risk: Risk, intent: str, slug_text: str, before: Observation, source: str) -> _Draft:
        draft = _Draft(
            action=action, risk=risk, intent=intent, slug=self._slug(slug_text), source=source, before=before
        )
        self.drafts.append(draft)
        return draft

    def discard_last(self) -> None:
        if self.drafts:
            self.drafts.pop()

    def observed(self, after: Observation) -> None:
        """Called with each new observation: settles postconditions for the step that just ran."""
        if self.drafts and self.drafts[-1].expect is None and self.drafts[-1].before is not None:
            draft = self.drafts[-1]
            assert draft.before is not None
            draft.expect = self._expectations(draft.before, after)

    def dialog_handler(self, message: str, accept: bool) -> None:
        text = self._clean(message)[:60]
        handler_id = "dialog_" + (self._slug(text)[:30] or "prompt")
        if any(h.id == handler_id for h in self.handlers):
            return
        self.handlers.append(
            Handler(
                id=handler_id,
                description=f"Native dialog seen during discovery: {text!r}",
                kind="recoverable",
                when=[DialogCondition(text=text)],
                recovery=DialogRecovery(do="accept_dialog" if accept else "dismiss_dialog"),
                origin="discovered",
            )
        )

    # ================================================================================ postconditions

    def _url_condition(self, frame: str | None, url: str) -> UrlCondition:
        path, query = self.relative(url)
        values = {v: k for k, v in self.inputs.items() if v}
        templated = {
            k: f"{{{{inputs.{values[v]}}}}}" for k, v in query.items() if k not in self.volatile_params and v in values
        }
        return UrlCondition(frame=frame, path=path, query=templated)

    def _stable_text(self, after: Observation, frame: str | None, before_text: str) -> str | None:
        for element in after.elements:
            if element.frame != frame or element.role in _NON_TITLE_ROLES:
                continue
            text = " ".join((element.text or element.name or "").split())
            if not 3 <= len(text) <= 50 or _DATAISH.search(text) or TEMPLATE_RE.search(self._template(text)):
                continue
            if text.lower() in before_text or not self._is_safe(text):
                continue
            if any(term and term.lower() in text.lower() for term in self.tenant_terms):
                continue
            return text
        return None

    def _expectations(self, before: Observation, after: Observation) -> list[Condition]:
        prev = {f.name: f.url for f in before.frames}
        now = {f.name: f.url for f in after.frames}
        conditions: list[Condition] = []
        if None in now and now[None] != prev.get(None):
            conditions.append(self._url_condition(None, now[None]))
            changed = list(now)
        else:
            changed = [name for name, url in now.items() if name is not None and name in prev and prev[name] != url]
            conditions += [self._url_condition(name, now[name]) for name in changed]
        if not changed:
            return conditions
        for frame in changed:
            before_text = " ".join(
                (e.text or e.name).lower() for e in before.elements if e.frame == frame and frame in prev
            )
            text = self._stable_text(after, frame, before_text)
            if text:
                conditions.append(TextCondition(text=text, frame=frame))
                break
        return conditions

    # ================================================================================ outcomes

    def outcome_handler(self, code: str, message: str, evidence: ElementInfo | None, origin: str) -> Handler:
        text = " ".join((evidence.text or evidence.name).split()) if evidence else ""
        if not text or not self._is_safe(self._template(text)) or TEMPLATE_RE.search(self._template(text)):
            text = message
        condition = TextCondition(text=text[:80], frame=evidence.frame if evidence else None)
        return Handler(
            id=code.lower()[:40],
            description=self._clean(message),
            kind="business_outcome",
            when=[condition],
            outcome=Outcome(code=code, message=self._clean(message)),
            origin=origin,
        )

    # ================================================================================ build

    def _sanitize(self) -> None:
        """Final privacy pass. Some sensitive values (e.g. a pii output) only become known *after* the
        steps that displayed them were recorded, so re-check everything that will be persisted."""

        def safe(model: Any) -> bool:
            return all(self._is_safe(v) for v in _strings(model.model_dump()))

        for draft in self.drafts:
            target = getattr(draft.action, "target", None)
            if target is not None:
                target.locators = [loc for loc in target.locators if safe(loc)]
                if not target.locators:
                    raise RecorderError(f"every locator for '{draft.intent}' contains sensitive data")
                target.description = self._clean(target.description)
            draft.intent = self._clean(draft.intent)
            draft.slug = self._slug(self._clean(draft.slug.replace("_", " ")))
            if draft.expect:
                draft.expect = [c for c in draft.expect if safe(c)]
        self.handlers = [h for h in self.handlers if safe(h)]

    def build(
        self,
        *,
        contract: DefineCapability,
        kind: str,
        version: str,
        app_id: str,
        product_version: str | None,
        requires_session: str | None,
        success_text: str,
        success_frame: str | None,
        success_url: str | None,
        goal: str,
        run_id: str,
        model: str,
        tenant: str,
        human_steps: list[int],
    ) -> Capability:
        if not self._is_safe(success_text) or _DATAISH.search(success_text):
            raise RecorderError("success_text must be a stable screen title, not data (no names, numbers or amounts)")
        self._sanitize()
        steps: list[Step] = []
        seen: set[str] = set()
        human_ids: list[str] = []
        for index, draft in enumerate(self.drafts, start=1):
            step_id = f"s{index:02d}_{draft.slug}"[:48]
            while step_id in seen:
                step_id += "_x"
            seen.add(step_id)
            if index - 1 in human_steps or draft.source == "human":
                human_ids.append(step_id)
            steps.append(
                Step(
                    id=step_id,
                    intent=draft.intent,
                    action=draft.action,
                    risk=draft.risk,
                    expect=draft.expect or [],
                    source=draft.source,
                )
            )

        declared_inputs = {p.name for p in contract.inputs}
        missing = set(self.inputs) - declared_inputs
        if missing:
            raise RecorderError(f"inputs provided but not declared in define_capability: {sorted(missing)}")
        produced = {d.action.output for d in self.drafts if isinstance(d.action, ExtractAction)}
        unread = {p.name for p in contract.outputs} - produced
        if unread:
            raise RecorderError(f"declared outputs never extracted: {sorted(unread)}")

        success: list[Condition] = []
        if success_url is not None:
            success.append(self._url_condition(success_frame, success_url))
        success.append(TextCondition(text=self._template(success_text), frame=success_frame))
        success += [OutputCondition(name=p.name) for p in contract.outputs]

        side_effects: Risk = max((s.risk for s in steps), key=lambda r: RISK_ORDER[r], default="read_only")
        major, minor = (product_version or "0.0").split(".")[:2]
        try:
            return Capability(
                schema_="rote.capability/v1",
                id=contract.id,
                version=version,
                kind=kind,
                title=contract.title,
                description=self._clean(contract.description),
                status="draft",
                app=AppRef(
                    id=app_id,
                    surface="web",
                    product_versions=f">={major}.{minor}.0,<{int(major) + 1}.0.0" if product_version else None,
                ),
                requires_session=requires_session,
                idempotent=side_effects != "irreversible",
                side_effects=side_effects,
                inputs={
                    p.name: InputSpec(
                        type=p.type,
                        description=p.description,
                        sensitivity=p.sensitivity,
                        pattern=p.pattern,
                        example=self.inputs.get(p.name) if p.sensitivity in ("public", "internal") else None,
                    )
                    for p in contract.inputs
                },
                secrets={
                    name: SecretSpec(description=f"{name} for the {app_id} service account")
                    for name in sorted(self.secrets_used)
                },
                outputs={
                    p.name: OutputSpec(type=p.type, description=p.description, sensitivity=p.sensitivity)
                    for p in contract.outputs
                },
                steps=steps,
                handlers=self.handlers,
                success=SuccessSpec(
                    description=f"'{self._template(success_text)}' is shown"
                    + (" and every output was read" if contract.outputs else ""),
                    all_of=success,
                ),
                provenance=Provenance(
                    method="discovery",
                    recorded_at=datetime.now(UTC),
                    source_run=run_id,
                    model=model,
                    goal=self._clean(goal),
                    tenant=tenant,
                    product_version=product_version,
                    human_steps=human_ids,
                ),
            )
        except ValidationError as exc:
            raise RecorderError(f"the recorded flow is not a valid capability yet: {exc.errors()[0]['msg']}") from exc
