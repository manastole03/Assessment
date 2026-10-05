"""One artifact, two institutions on the same vendor product.

Bayview relabels fields, renames share products and enables the vendor's daily security notice.
Without an override the shared capability degrades *gracefully*: contract attributes carry the clicks
and fills, drift is reported, and the one read it cannot do safely fails loudly instead of guessing.
A small reviewed override (keyed by step id) makes it succeed.
"""

from __future__ import annotations

import pytest
import yaml

from rote.artifact.store import Library
from rote.replay.result import FailureCode, RunStatus
from rote.runtime import Settings

from .test_end_to_end import BALANCE, replay

pytestmark = pytest.mark.browser


async def test_shared_capability_degrades_gracefully_on_variant_tenant(recorded: Settings) -> None:
    result = await replay(recorded, BALANCE, tenant="bayview", member_id="12345")
    assert result.status is RunStatus.FAILED
    assert result.failure
    assert result.failure.code is FailureCode.TARGET_NOT_FOUND
    assert result.failure.step_id
    assert "savings_balance" in result.failure.step_id
    assert "daily_security_notice" in [r.handler for r in result.recoveries]  # vendor knowledge, no override
    drift = {w.step_id for w in result.warnings if w.code == "LOCATOR_DRIFT"}
    assert any("member_number" in (s or "") for s in drift), result.warnings


async def test_tenant_override_specialises_the_shared_capability(recorded: Settings) -> None:
    path = recorded.root / "config" / "tenants" / "bayview.yaml"
    original = path.read_text()
    tenant = yaml.safe_load(original)
    step = next(s.id for s in Library(recorded.root).capability(BALANCE).steps if "savings_balance" in s.id)
    tenant["apps"]["legacycore"]["overrides"] = [
        {
            "capability": BALANCE,
            "versions": ">=1.0.0,<2.0.0",
            "reason": "Bayview renames SHARE SAVINGS to REGULAR SAVINGS and shows a Ledger Balance column",
            "steps": {
                step: {"prepend_locators": [{"by": "table_cell", "row": "REGULAR SAVINGS", "column": "Ledger Balance"}]}
            },
        }
    ]
    path.write_text(yaml.safe_dump(tenant, sort_keys=False))
    try:
        result = await replay(recorded, BALANCE, tenant="bayview", member_id="20417")
        assert result.status is RunStatus.SUCCEEDED, result.failure
        assert result.outputs
        assert result.outputs["savings_balance"] == "15002.50"
        assert any("override" in layer for layer in result.capability.layers)
    finally:
        path.write_text(original)


async def test_absence_based_outcome_never_masks_drift(recorded: Settings) -> None:
    """A probed 'no savings account' handler is inferred from a *missing row*. On a tenant whose table
    is labelled differently it must not fire — that would hand the caller a wrong business answer."""
    from rote.artifact.schema import Handler, TextCondition
    from rote.discovery.probe import guard_handler

    library = Library(recorded.root)
    original = library.capability(BALANCE)
    step = next(s.id for s in original.steps if "savings_balance" in s.id)
    handler = guard_handler(
        Handler(
            id="no_savings_account",
            description="No savings share on file",
            kind="business_outcome",
            when=[TextCondition(text="SHARES / LOANS", frame="main")],
            outcome={"code": "NO_SAVINGS_ACCOUNT", "message": "The member has no share savings account."},
        ),  # type: ignore[arg-type]
        original,
        step,
        kind="business_outcome",
        evidence_type="absence",
    )
    patched = original.model_copy(deep=True)
    patched.handlers.append(handler)
    library.save(patched)
    path = recorded.root / "config" / "tenants" / "bayview.yaml"
    tenant_file = path.read_text()
    try:
        acme = await replay(recorded, BALANCE, member_id="31008")
        assert acme.outcome
        assert acme.outcome.code == "NO_SAVINGS_ACCOUNT"
        happy = await replay(recorded, BALANCE, member_id="12345")
        assert happy.status is RunStatus.SUCCEEDED  # the guard keeps it off the happy path

        drifted = await replay(recorded, BALANCE, tenant="bayview", member_id="20417")
        assert drifted.status is RunStatus.FAILED, "drift must not be reported as 'no savings account'"

        tenant = yaml.safe_load(tenant_file)
        tenant["apps"]["legacycore"]["overrides"] = [
            {
                "capability": BALANCE,
                "reason": "Bayview product naming",
                "steps": {
                    step: {
                        "prepend_locators": [{"by": "table_cell", "row": "REGULAR SAVINGS", "column": "Ledger Balance"}]
                    }
                },
            }
        ]
        path.write_text(yaml.safe_dump(tenant, sort_keys=False))
        bayview = await replay(recorded, BALANCE, tenant="bayview", member_id="31008")
        assert bayview.outcome
        assert bayview.outcome.code == "NO_SAVINGS_ACCOUNT"
    finally:
        path.write_text(tenant_file)
        library.save(original)
