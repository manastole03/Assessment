"""The seam between *how we perceive and act on a surface* and *the recorded flow*.

Replay and discovery depend only on the ``Surface`` protocol below. A surface adapter turns the
schema's semantic vocabulary into concrete lookups:

=================  ==========================  ============================  =========================
schema concept     web (implemented)           Windows desktop (UIA)         pixels only (VDI/Citrix)
=================  ==========================  ============================  =========================
frame              frame / iframe              top-level window              screen region
attribute          form ``name`` / ``href``    AutomationId                  —
role + name        ARIA role + accname         ControlType + Name            OCR text + detector class
label              adjacent table-cell text    LabeledBy / spatial neighbour OCR text left of the box
table_cell         header text + row key       GridPattern / TablePattern    OCR table structure
css                structural selector         tree path                     template image
=================  ==========================  ============================  =========================

A new surface therefore needs a new adapter, not a new artifact format.
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass, field
from typing import Any, Protocol, runtime_checkable

from ..artifact.schema import Condition, Target
from ..artifact.templates import TemplateContext
from ..handoff.control import Actor
from ..policy.redaction import Redactor


@dataclass
class ElementInfo:
    ref: str | None
    frame: str | None
    role: str | None
    name: str = ""
    label: str = ""
    tag: str = ""
    type: str | None = None
    attrs: dict[str, str] = field(default_factory=dict)
    text: str = ""
    value: str | None = None
    disabled: bool = False
    checked: bool | None = None
    options: list[str] | None = None
    column: str | None = None
    row: list[str] | None = None
    bbox: tuple[int, int, int, int] | None = None

    @classmethod
    def from_js(cls, data: dict[str, Any], frame: str | None, offset: tuple[float, float]) -> ElementInfo:
        bbox = data.get("bbox")
        page_box = None
        if bbox:
            page_box = (int(bbox[0] + offset[0]), int(bbox[1] + offset[1]), int(bbox[2]), int(bbox[3]))
        return cls(
            ref=data.get("ref"),
            frame=frame,
            role=data.get("role"),
            name=data.get("name") or "",
            label=data.get("label") or "",
            tag=data.get("tag") or "",
            type=data.get("type"),
            attrs=data.get("attrs") or {},
            text=data.get("text") or "",
            value=data.get("value"),
            disabled=bool(data.get("disabled")),
            checked=data.get("checked"),
            options=data.get("options"),
            column=data.get("column"),
            row=data.get("row"),
            bbox=page_box,
        )

    @property
    def display_name(self) -> str:
        return self.name or self.label or self.text

    def describe(self) -> str:
        what = self.role or self.tag
        name = self.name or self.text
        label = f" (label '{self.label}')" if self.label and self.label != name else ""
        return f"{what} '{name[:60]}'{label}" if name else f"{what}{label}"


@dataclass
class FrameInfo:
    name: str | None
    url: str
    path: str


@dataclass
class DialogInfo:
    kind: str
    message: str


@dataclass
class Observation:
    url: str
    title: str
    frames: list[FrameInfo]
    elements: list[ElementInfo]
    dialog: DialogInfo | None = None
    screenshot: bytes | None = None

    def element(self, ref: str) -> ElementInfo | None:
        return next((e for e in self.elements if e.ref == ref), None)

    def texts(self, frame: str | None = None) -> list[str]:
        return [e.text for e in self.elements if e.text and (frame is None or e.frame == frame)]

    def frame_path(self, frame: str | None) -> str | None:
        return next((f.path for f in self.frames if f.name == frame), None)

    @property
    def fingerprint(self) -> str:
        parts = [f"{f.name}:{f.path}" for f in self.frames]
        parts += [f"{e.frame}|{e.role}|{e.name}|{e.label}|{e.value}|{e.text[:40]}" for e in self.elements]
        parts.append(self.dialog.message if self.dialog else "")
        return hashlib.sha1("\n".join(parts).encode()).hexdigest()[:12]

    def render(self, redactor: Redactor, *, max_elements: int = 400) -> str:
        """Compact, redacted text form used as model input and as evidence."""
        lines = [f"URL: {redactor.text(self.url)}  (title: {redactor.text(self.title)})"]
        if self.frames:
            lines.append("Frames: " + ", ".join(f"{f.name or 'top'} ({redactor.text(f.path)})" for f in self.frames))
        lines.append(
            f"Native dialog: {self.dialog.kind} — {redactor.text(self.dialog.message)!r}"
            if self.dialog
            else "Native dialog: none"
        )
        current: object = object()
        for element in self.elements[:max_elements]:
            if element.frame != current:
                current = element.frame
                lines.append(
                    f"[frame {element.frame or 'top'} — {redactor.text(self.frame_path(element.frame) or '')}]"
                )
            lines.append("  " + _render_element(element, redactor))
        if len(self.elements) > max_elements:
            lines.append(f"  … {len(self.elements) - max_elements} more elements omitted")
        return "\n".join(lines)


def _render_element(e: ElementInfo, redactor: Redactor) -> str:
    ref = e.ref or "-"
    role = e.role or e.tag
    parts = [ref, role]
    shown = e.name if e.role in ("link", "button", "heading", "columnheader") else (e.text or e.name)
    if e.role in ("textbox", "combobox", "listbox", "checkbox", "radio"):
        shown = e.name
    if shown:
        parts.append(repr(redactor.field(e.label, shown)[:120]))
    if e.label and e.label != shown:
        parts.append(f"label={e.label!r}")
    if e.column:
        parts.append(f"col={e.column!r}")
    if "name" in e.attrs and e.role in ("textbox", "combobox", "listbox", "button", "checkbox", "radio"):
        parts.append(f"name={e.attrs['name']}")
    if e.value is not None:
        parts.append(f"value={redactor.field(e.label, e.value)!r}")
    if e.options:
        parts.append("options=" + "|".join(e.options[:12]))
    if e.checked is not None:
        parts.append("checked" if e.checked else "unchecked")
    if e.disabled:
        parts.append("disabled")
    return " ".join(parts)


@dataclass
class LocatorCheck:
    index: int
    strategy: str
    count: int
    verdict: str = "missing"  # chosen | agree | conflict | missing | ambiguous | role_mismatch


@dataclass
class Resolved:
    frame: str | None
    ref: str
    element: ElementInfo
    strategy_index: int
    checks: list[LocatorCheck]
    warnings: list[str] = field(default_factory=list)

    @property
    def strategy(self) -> str:
        return self.checks[self.strategy_index].strategy


@dataclass
class Unresolved:
    reason: str  # not_found | ambiguous | frame_missing
    checks: list[LocatorCheck]
    detail: str = ""


@runtime_checkable
class Surface(Protocol):
    kind: str

    async def observe(self, *, screenshot: bool = True) -> Observation: ...
    async def resolve(self, target: Target, ctx: TemplateContext) -> Resolved | Unresolved: ...
    async def check(self, condition: Condition, ctx: TemplateContext) -> bool: ...
    async def navigate(self, url: str, *, actor: Actor) -> None: ...
    async def click(self, resolved: Resolved, *, actor: Actor) -> None: ...
    async def fill(self, resolved: Resolved, value: str, *, actor: Actor) -> None: ...
    async def select(self, resolved: Resolved, option: str, *, actor: Actor) -> None: ...
    async def press(self, key: str, resolved: Resolved | None, *, actor: Actor) -> None: ...
    async def read(self, resolved: Resolved) -> str: ...
    async def reload(self, frame: str | None, *, actor: Actor) -> None: ...
    async def answer_dialog(self, accept: bool, *, actor: Actor) -> None: ...
    def dialog(self) -> DialogInfo | None: ...
    async def screenshot(self, *, mask: bool = True) -> bytes | None: ...
    async def dom_snapshot(self) -> dict[str, str]: ...
    async def close(self) -> None: ...
