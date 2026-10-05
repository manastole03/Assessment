"""Intervention requests: detect → route → human takes the live session → hand back → resume.

The broker is the seam between automation (which calls ``escalate`` and awaits a decision) and
operators (who ``claim``, act on the *same* live session, and ``resolve``). Routing is a pluggable
``Notifier``; the operator console and ``rote operator`` CLI are two clients of the same API.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import os
import uuid
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Literal, Protocol

import httpx
from pydantic import BaseModel, Field

from .control import SessionControl

ReasonCode = Literal[
    "AGENT_REQUESTED",  # the discovery model asked for help
    "NO_PROGRESS",  # discovery: the screen stopped changing
    "REPEATED_ERRORS",  # discovery: consecutive failed/blocked actions
    "APPROVAL_REQUIRED",  # an irreversible action needs a human decision
    "UNEXPECTED_STATE",  # replay: postcondition unmet and no handler recognises the screen
    "TARGET_NOT_FOUND",  # replay: a recorded control cannot be found
    "RECOVERY_EXHAUSTED",  # replay: a known condition kept recurring
]
Resolution = Literal["retry_step", "step_completed", "approve", "reject", "abort", "continue"]
Status = Literal["open", "claimed", "resolved", "expired"]


class HumanAction(BaseModel):
    at: datetime
    kind: str
    description: str
    frame: str | None = None
    value: str | None = None
    locators: list[dict[str, Any]] = Field(default_factory=list)
    element: dict[str, Any] = Field(default_factory=dict)
    url: str | None = None


class Intervention(BaseModel):
    id: str
    session_id: str
    run_id: str
    run_kind: Literal["discovery", "replay"]
    subject: str = Field(description="Capability ref (replay) or redacted goal (discovery).")
    step_id: str | None = None
    step_index: int | None = None
    step_intent: str | None = None
    reason_code: ReasonCode
    reason: str
    url: str | None = None
    screenshot: str | None = Field(None, description="Path to the (masked) screenshot at escalation time.")
    observation: str | None = Field(None, description="Redacted text snapshot of the screen.")
    allowed_resolutions: list[Resolution]
    status: Status = "open"
    created_at: datetime = Field(default_factory=lambda: datetime.now(UTC))
    claimed_by: str | None = None
    claimed_at: datetime | None = None
    resolved_at: datetime | None = None
    resolution: Resolution | None = None
    note: str | None = None
    human_actions: list[HumanAction] = Field(default_factory=list)


class Notifier(Protocol):
    async def notify(self, intervention: Intervention, console_url: str | None) -> None: ...


class WebhookNotifier:
    """Posts a compact JSON summary (e.g. to a Slack/Teams incoming webhook or a pager)."""

    def __init__(self, url: str):
        self.url = url

    async def notify(self, intervention: Intervention, console_url: str | None) -> None:
        payload = {
            "text": f"[rote] intervention {intervention.id}: {intervention.reason_code} on {intervention.subject}",
            "reason": intervention.reason,
            "step": intervention.step_id,
            "console": f"{console_url}/interventions/{intervention.id}" if console_url else None,
        }
        async with httpx.AsyncClient(timeout=5) as client:
            with contextlib.suppress(httpx.HTTPError):
                await client.post(self.url, json=payload)


class InterventionBroker:
    def __init__(
        self,
        control: SessionControl,
        *,
        record_dir: Path,
        notifiers: list[Notifier] | None = None,
        console_url: str | None = None,
        on_event: Callable[[str, dict[str, Any]], object] | None = None,
    ):
        self.control = control
        self.record_dir = record_dir
        self.notifiers = notifiers or []
        self.console_url = console_url
        self.items: dict[str, Intervention] = {}
        self._waiters: dict[str, asyncio.Future[Intervention]] = {}
        self._on_event = on_event or (lambda _type, _data: None)
        self.listeners: list[Callable[[Intervention], Awaitable[None] | None]] = []

    @property
    def active(self) -> Intervention | None:
        return next((i for i in self.items.values() if i.status in ("open", "claimed")), None)

    # ------------------------------------------------------------------ automation side

    async def escalate(self, intervention: Intervention, *, timeout_s: float) -> Intervention:
        """Pause automation, route the request, and wait for an operator's decision."""
        self.control.pause_for_human(f"{intervention.reason_code}: {intervention.reason}")
        self.items[intervention.id] = intervention
        future: asyncio.Future[Intervention] = asyncio.get_running_loop().create_future()
        self._waiters[intervention.id] = future
        self._persist(intervention)
        self._on_event("intervention.raised", self._summary(intervention))
        for notifier in self.notifiers:
            await notifier.notify(intervention, self.console_url)
        try:
            return await asyncio.wait_for(future, timeout=timeout_s)
        except TimeoutError:
            intervention.status = "expired"
            intervention.resolved_at = datetime.now(UTC)
            self.control.reclaim("no operator resolved the intervention in time")
            self._persist(intervention)
            self._on_event("intervention.expired", self._summary(intervention))
            return intervention
        finally:
            self._waiters.pop(intervention.id, None)

    # ------------------------------------------------------------------ operator side

    def get(self, intervention_id: str) -> Intervention:
        if intervention_id not in self.items:
            raise KeyError(f"no intervention {intervention_id}")
        return self.items[intervention_id]

    def claim(self, intervention_id: str, operator: str) -> int:
        item = self.get(intervention_id)
        if item.status != "open":
            raise ValueError(f"intervention {intervention_id} is {item.status}")
        epoch = self.control.grant(operator)
        item.status, item.claimed_by, item.claimed_at = "claimed", operator, datetime.now(UTC)
        self._persist(item)
        self._on_event("intervention.claimed", {"id": item.id, "operator": operator, "epoch": epoch})
        return epoch

    def record_action(self, action: HumanAction) -> None:
        item = self.active
        if item is None or item.status != "claimed":
            return
        item.human_actions.append(action)
        self._persist(item)
        self._on_event("human.action", {"intervention": item.id, **action.model_dump(mode="json")})

    def resolve(self, intervention_id: str, operator: str, epoch: int, resolution: Resolution, note: str) -> None:
        item = self.get(intervention_id)
        if item.status != "claimed":
            raise ValueError(f"intervention {intervention_id} must be claimed before it is resolved")
        if resolution not in item.allowed_resolutions:
            raise ValueError(f"{resolution!r} is not allowed here; choose one of {item.allowed_resolutions}")
        self.control.hand_back(operator, epoch, f"operator resolved: {resolution}")
        item.status, item.resolution, item.note = "resolved", resolution, note
        item.resolved_at = datetime.now(UTC)
        self._persist(item)
        self._on_event(
            "intervention.resolved",
            {"id": item.id, "resolution": resolution, "note": note, "human_actions": len(item.human_actions)},
        )
        future = self._waiters.get(item.id)
        if future is not None and not future.done():
            future.set_result(item)

    # ------------------------------------------------------------------ persistence

    def _persist(self, item: Intervention) -> None:
        self.record_dir.mkdir(parents=True, exist_ok=True)
        path = self.record_dir / f"{item.id}.json"
        data = item.model_dump(mode="json")
        if data.get("screenshot"):  # keep evidence free of absolute local paths
            data["screenshot"] = os.path.relpath(data["screenshot"], self.record_dir.parent)
        path.write_text(json.dumps(data, indent=2))

    @staticmethod
    def _summary(item: Intervention) -> dict[str, Any]:
        return {
            "id": item.id,
            "reason_code": item.reason_code,
            "reason": item.reason,
            "step": item.step_id,
            "allowed_resolutions": item.allowed_resolutions,
        }


def new_intervention_id() -> str:
    return "iv_" + uuid.uuid4().hex[:8]
