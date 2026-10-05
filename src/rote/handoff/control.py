"""Who is allowed to drive the live session, right now.

The session has exactly one controller at a time, tracked as a lease::

    AUTOMATED ──escalate──▶ AWAITING_HUMAN ──claim──▶ HUMAN ──hand back──▶ AUTOMATED
        ▲                        │ timeout / abort                              │
        └────────────────────────┴──────────────────────────────────────────────┘

* In ``AWAITING_HUMAN`` *nobody* may act: automation has paused and no operator has claimed.
* Every transition bumps ``epoch``, a fencing token. An operator's commands carry the epoch they
  were granted, so a late click from a stale console tab after hand-back is rejected rather than
  racing the resumed automation.
* Every mutating surface call names its ``Actor`` and is checked here — the lease is enforced, not
  advisory.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from enum import StrEnum
from typing import Any


class LeaseState(StrEnum):
    AUTOMATED = "automated"
    AWAITING_HUMAN = "awaiting_human"
    HUMAN = "human"


class ActorKind(StrEnum):
    AUTOMATION = "automation"
    HUMAN = "human"


@dataclass(frozen=True)
class Actor:
    kind: ActorKind
    id: str
    epoch: int | None = None

    @classmethod
    def automation(cls, run_id: str) -> Actor:
        return cls(ActorKind.AUTOMATION, run_id)

    @classmethod
    def human(cls, operator: str, epoch: int) -> Actor:
        return cls(ActorKind.HUMAN, operator, epoch)


class ControlError(PermissionError):
    """Raised when an actor tries to drive a session it does not currently control."""


class SessionControl:
    def __init__(self, session_id: str, on_change: Callable[[dict[str, Any]], object] | None = None):
        self.session_id = session_id
        self.state = LeaseState.AUTOMATED
        self.holder = "automation"
        self.epoch = 0
        self.since = datetime.now(UTC)
        self._on_change = on_change

    def snapshot(self) -> dict[str, Any]:
        return {
            "session_id": self.session_id,
            "state": self.state.value,
            "holder": self.holder,
            "epoch": self.epoch,
            "since": self.since.isoformat(),
        }

    def ensure(self, actor: Actor) -> None:
        if actor.kind is ActorKind.AUTOMATION:
            if self.state is not LeaseState.AUTOMATED:
                raise ControlError(f"automation may not act while the session is {self.state.value}")
            return
        if self.state is not LeaseState.HUMAN or actor.id != self.holder:
            raise ControlError(f"{actor.id} does not hold this session (holder: {self.holder})")
        if actor.epoch != self.epoch:
            raise ControlError(f"stale lease epoch {actor.epoch}; current epoch is {self.epoch}")

    # ------------------------------------------------------------------ transitions

    def pause_for_human(self, reason: str) -> None:
        self._transition(LeaseState.AUTOMATED, LeaseState.AWAITING_HUMAN, "pending-operator", reason)

    def grant(self, operator: str) -> int:
        self._transition(LeaseState.AWAITING_HUMAN, LeaseState.HUMAN, operator, "operator claimed control")
        return self.epoch

    def hand_back(self, operator: str, epoch: int, reason: str) -> None:
        self.ensure(Actor.human(operator, epoch))
        self._transition(LeaseState.HUMAN, LeaseState.AUTOMATED, "automation", reason)

    def reclaim(self, reason: str) -> None:
        """Automation takes the session back without a hand-back (operator timeout or abort)."""
        if self.state is LeaseState.AUTOMATED:
            return
        self._transition(self.state, LeaseState.AUTOMATED, "automation", reason)

    def _transition(self, expected: LeaseState, target: LeaseState, holder: str, reason: str) -> None:
        if self.state is not expected:
            raise ControlError(f"cannot move to {target.value} from {self.state.value}")
        previous = self.snapshot()
        self.state, self.holder, self.epoch = target, holder, self.epoch + 1
        self.since = datetime.now(UTC)
        if self._on_change:
            self._on_change({"from": previous, "to": self.snapshot(), "reason": reason})
