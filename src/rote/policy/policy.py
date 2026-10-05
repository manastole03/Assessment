"""Guardrail policy: what automation may touch, and how risky actions are treated.

Enforced at three points so no single bypass defeats it:

* **network** — the browser context aborts any request to an origin outside ``allowed_origins``
  (catches redirects, scripts and links the agent never "chose");
* **action** — every discovery and replay action is classified and checked before it runs;
* **artifact** — capabilities are validated against the policy before replay starts.

Risk handling (the conservative choice, justified in REPORT.md):

* discovery: the model may never commit an irreversible action on its own — it escalates to a human
  for approval (or is blocked outright, per config);
* replay: irreversible steps run only in ``approved`` capabilities and, by default, still need a
  per-invocation human confirmation (maker-checker). Read-only and reversible steps run unattended.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path
from typing import Literal
from urllib.parse import urlsplit

import yaml
from pydantic import BaseModel, ConfigDict, Field

from ..artifact.schema import RISK_ORDER, Risk

ActionType = Literal["navigate", "click", "fill", "select", "press", "extract", "dialog"]
Phase = Literal["discovery", "replay"]


class _Model(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)


class TargetRule(_Model):
    name_pattern: str
    roles: list[str] | None = None
    reason: str

    def matches(self, element: ElementFacts) -> bool:
        if self.roles and element.role not in self.roles:
            return False
        pattern = re.compile(self.name_pattern, re.IGNORECASE)
        return any(pattern.search(text) for text in element.texts() if text)


class RiskRule(TargetRule):
    risk: Risk


class DiscoveryPolicy(_Model):
    allowed_actions: list[ActionType]
    irreversible: Literal["escalate", "block"] = "escalate"


class ReplayPolicy(_Model):
    allowed_actions: list[ActionType]
    irreversible: Literal["confirm", "block", "allow"] = "confirm"
    require_approved: bool = True


class Policy(_Model):
    schema_: Literal["rote.policy/v1"] = Field("rote.policy/v1", alias="schema")
    id: str
    allowed_origins: list[str]
    blocked_url_patterns: list[str] = Field(default_factory=list)
    discovery: DiscoveryPolicy
    replay: ReplayPolicy
    risk_rules: list[RiskRule] = Field(default_factory=list)
    blocked_targets: list[TargetRule] = Field(default_factory=list)
    sensitive_labels: list[str] = Field(default_factory=list)

    @classmethod
    def load(cls, path: Path) -> Policy:
        return cls.model_validate(yaml.safe_load(path.read_text()))


@dataclass(frozen=True)
class ElementFacts:
    """What the policy gets to see about a target control."""

    role: str | None = None
    name: str | None = None
    label: str | None = None
    value: str | None = None

    def texts(self) -> list[str]:
        return [t for t in (self.name, self.label, self.value) if t]


@dataclass(frozen=True)
class Decision:
    verdict: Literal["allow", "deny", "escalate"]
    risk: Risk
    reason: str

    @property
    def allowed(self) -> bool:
        return self.verdict == "allow"


def _origin(url: str) -> str:
    parts = urlsplit(url)
    return f"{parts.scheme}://{parts.netloc}".lower()


class PolicyEngine:
    def __init__(self, policy: Policy):
        self.policy = policy
        self._origins = {o.rstrip("/").lower() for o in policy.allowed_origins}
        self._blocked_urls = [re.compile(p, re.IGNORECASE) for p in policy.blocked_url_patterns]

    # ------------------------------------------------------------------ urls

    def url_allowed(self, url: str) -> bool:
        if url.startswith(("about:", "data:", "blob:")):
            return True
        if _origin(url) not in self._origins:
            return False
        return not any(p.search(url) for p in self._blocked_urls)

    def check_url(self, url: str) -> Decision:
        if self.url_allowed(url):
            return Decision("allow", "read_only", "url within allowlist")
        return Decision("deny", "read_only", f"{_origin(url)} is outside the allowlist")

    # ------------------------------------------------------------------ actions

    def classify(self, action: ActionType, element: ElementFacts | None) -> tuple[Risk, str]:
        if action in ("navigate", "extract"):
            return "read_only", f"{action} does not change application state"
        if element is not None:
            for rule in self.policy.risk_rules:
                if rule.matches(element):
                    return rule.risk, rule.reason
        if action in ("fill", "select"):
            return "reversible", "edits unsaved form state"
        return "reversible", "navigates or submits without a commit keyword"

    def check_action(
        self,
        phase: Phase,
        action: ActionType,
        element: ElementFacts | None = None,
        *,
        declared_risk: Risk | None = None,
        url: str | None = None,
        capability_approved: bool = False,
    ) -> Decision:
        phase_policy = self.policy.discovery if phase == "discovery" else self.policy.replay
        risk, reason = self.classify(action, element)
        if declared_risk is not None and RISK_ORDER[declared_risk] > RISK_ORDER[risk]:
            risk, reason = declared_risk, "declared irreversible in the reviewed artifact"

        if action not in phase_policy.allowed_actions:
            return Decision("deny", risk, f"action {action!r} is not allowed during {phase}")
        if url is not None and not self.url_allowed(url):
            return Decision("deny", risk, f"{url} is outside the allowlist")
        if element is not None:
            for rule in self.policy.blocked_targets:
                if rule.matches(element):
                    return Decision("deny", risk, f"target is blocked: {rule.reason}")

        if risk != "irreversible":
            return Decision("allow", risk, reason)
        if phase == "discovery":
            if self.policy.discovery.irreversible == "block":
                return Decision("deny", risk, f"irreversible actions are blocked during discovery ({reason})")
            return Decision("escalate", risk, f"irreversible action needs human approval ({reason})")
        mode = self.policy.replay.irreversible
        if mode == "block":
            return Decision("deny", risk, f"irreversible steps are blocked by policy ({reason})")
        if not capability_approved:
            return Decision("deny", risk, "irreversible steps only run in approved capabilities")
        if mode == "confirm":
            return Decision("escalate", risk, f"irreversible step needs per-run confirmation ({reason})")
        return Decision("allow", risk, reason)
