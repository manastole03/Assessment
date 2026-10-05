"""Injectable runtime faults, set per tenant through the admin API (or `mockbank fault`).

Each fault models a runtime condition the brief lists. Most are one-shot so a single replay can
demonstrate detection *and* recovery.
"""

from __future__ import annotations

from pydantic import BaseModel, Field


class Faults(BaseModel):
    session_expire_after: int | None = Field(
        None, description="Expire the session after N more main-frame page loads (one-shot)."
    )
    maintenance_notice: bool = Field(False, description="One-shot HTML interstitial with an Acknowledge button.")
    session_warning_dialog: bool = Field(False, description="One-shot native confirm() on the next page load.")
    slow_ms: int = Field(0, ge=0, le=30_000, description="Delay every main-frame page by this many ms.")
    transient_errors: int = Field(0, ge=0, description="The next N main-frame loads return an HTTP 503 page.")
    compliance_popup: bool = Field(
        False, description="Attestation screen no automation knows about; blocks each session until attested."
    )
    vendor_upgrade: bool = Field(
        False, description="Simulate an unannounced vendor upgrade that redesigned the member search screen."
    )


FAULT_STATE: dict[str, Faults] = {}


def faults_for(tenant: str) -> Faults:
    return FAULT_STATE.setdefault(tenant, Faults())
