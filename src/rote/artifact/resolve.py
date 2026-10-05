"""Compose the *effective* capability for one tenant: base artifact ⊕ app profile ⊕ tenant overrides.

One capability recorded against a reference tenant is shared by every institution running the same
vendor product. Differences are expressed as small, reviewed patches keyed by step id — never as a
re-recorded copy. The effective artifact is hashed, and that hash is what a run reports, so any
result can be traced back to the exact layers that produced it.
"""

from __future__ import annotations

import hashlib
import json
import os
from dataclasses import dataclass, field
from typing import Literal

from .schema import (
    AppProfile,
    Capability,
    CapabilityOverride,
    Handler,
    Tenant,
    TenantApp,
)
from .store import version_key

HandlerSource = Literal["tenant", "capability", "app"]


@dataclass(frozen=True)
class BoundHandler:
    source: HandlerSource
    handler: Handler


@dataclass
class ResolvedCapability:
    capability: Capability
    app: AppProfile
    tenant: Tenant
    binding: TenantApp
    handlers: list[BoundHandler]
    layers: list[str] = field(default_factory=list)
    applied_overrides: list[str] = field(default_factory=list)

    @property
    def base_url(self) -> str:
        return self.binding.base_url.rstrip("/")

    @property
    def effective_hash(self) -> str:
        payload = {
            "capability": self.capability.model_dump(mode="json", by_alias=True),
            "handlers": [(b.source, b.handler.model_dump(mode="json")) for b in self.handlers],
        }
        return "sha256:" + _digest(payload)[:16]

    def resolve_secrets(self) -> dict[str, str]:
        """Resolve only the secrets this capability declares, from the tenant's bindings."""
        values: dict[str, str] = {}
        for name in self.capability.secrets:
            ref = self.binding.secrets.get(name)
            if ref is None:
                raise KeyError(f"tenant {self.tenant.id} has no binding for secret {name!r}")
            values[name] = resolve_secret_ref(ref)
        return values


def resolve_secret_ref(ref: str) -> str:
    scheme, _, key = ref.partition(":")
    if scheme != "env":
        raise ValueError(f"unsupported secret reference {ref!r} (only env:VAR is implemented)")
    value = os.environ.get(key)
    if not value:
        raise KeyError(f"secret environment variable {key} is not set (see .env.example)")
    return value


def _digest(payload: object) -> str:
    return hashlib.sha256(json.dumps(payload, sort_keys=True, default=str).encode()).hexdigest()


def version_in_range(version: str, spec: str) -> bool:
    """Minimal range check: '*', or comma-separated comparators like '>=1.0.0,<2.0.0'."""
    if spec.strip() in ("", "*"):
        return True
    v = version_key(version)
    for clause in (c.strip() for c in spec.split(",")):
        for op in (">=", "<=", "==", ">", "<"):
            if clause.startswith(op):
                bound = version_key(clause[len(op) :].strip())
                ok = {">=": v >= bound, "<=": v <= bound, "==": v == bound, ">": v > bound, "<": v < bound}[op]
                if not ok:
                    return False
                break
        else:
            raise ValueError(f"bad version clause {clause!r}")
    return True


def apply_override(capability: Capability, override: CapabilityOverride) -> Capability:
    data = capability.model_copy(deep=True)
    for step_id, patch in override.steps.items():
        step = data.step(step_id)  # KeyError surfaces a stale override loudly
        target = getattr(step.action, "target", None)
        if patch.replace_target is not None:
            if target is None:
                raise ValueError(f"override {override.reason!r}: step {step_id} has no target")
            step.action.target = patch.replace_target  # type: ignore[union-attr]
        elif patch.prepend_locators:
            if target is None:
                raise ValueError(f"override {override.reason!r}: step {step_id} has no target")
            target.locators = [*patch.prepend_locators, *target.locators]
        if patch.timeout_ms is not None:
            step.timeout_ms = patch.timeout_ms
    return Capability.model_validate(data.model_dump(by_alias=True))


def resolve(capability: Capability, app: AppProfile, tenant: Tenant) -> ResolvedCapability:
    if capability.app.id != app.id:
        raise ValueError(f"{capability.ref} targets app {capability.app.id!r}, not {app.id!r}")
    binding = tenant.apps.get(app.id)
    if binding is None:
        raise ValueError(f"tenant {tenant.id!r} does not run app {app.id!r}")

    effective = capability
    tenant_handlers: list[Handler] = []
    applied: list[str] = []
    for override in binding.overrides:
        if override.capability != capability.id or not version_in_range(capability.version, override.versions):
            continue
        effective = apply_override(effective, override)
        tenant_handlers.extend(override.handlers)
        applied.append(override.reason)

    handlers = (
        [BoundHandler("tenant", h) for h in tenant_handlers]
        + [BoundHandler("capability", h) for h in effective.handlers]
        + [BoundHandler("app", h) for h in app.handlers]
    )
    layers = [
        f"capability {capability.ref} ({_digest(capability.model_dump(mode='json', by_alias=True))[:12]})",
        f"app {app.id} ({_digest(app.model_dump(mode='json', by_alias=True))[:12]})",
    ]
    layers += [f"tenant {tenant.id} override: {reason}" for reason in applied]
    return ResolvedCapability(
        capability=effective,
        app=app,
        tenant=tenant,
        binding=binding,
        handlers=handlers,
        layers=layers,
        applied_overrides=applied,
    )
