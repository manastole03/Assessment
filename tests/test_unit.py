"""Fast, browser-free tests for the schema, redaction, policy, typed values and catalog."""

from __future__ import annotations

import copy
from pathlib import Path
from typing import Any

import pytest
import yaml
from pydantic import ValidationError

from rote.artifact.resolve import apply_override, version_in_range
from rote.artifact.schema import Capability, CapabilityOverride
from rote.artifact.store import load_yaml, to_yaml
from rote.artifact.templates import TemplateContext, TemplateError, parameterize
from rote.catalog import catalog, to_tool
from rote.policy.policy import ElementFacts, Policy, PolicyEngine
from rote.policy.redaction import Redactor
from rote.replay.values import ValueError_, parse, validate_input

REPO = Path(__file__).resolve().parent.parent

BASE: dict[str, Any] = yaml.safe_load("""
schema: rote.capability/v1
id: legacycore.member.get_savings_balance
version: 1.0.0
kind: task
title: Get savings balance
description: Reads a member's savings balance.
status: draft
app: {id: legacycore}
idempotent: true
side_effects: reversible
inputs:
  member_id: {type: string, description: Member number, pattern: '^[0-9]{5,10}$', sensitivity: pii}
outputs:
  savings_balance: {type: money, description: Balance, sensitivity: internal}
steps:
  - id: s01_open
    intent: Open home
    action: {type: navigate, url: '{{app.base_url}}/default.asp'}
    risk: read_only
  - id: s02_fill
    intent: Enter member number
    action:
      type: fill
      value: '{{inputs.member_id}}'
      target:
        description: Member Number field
        frame: {name: main}
        locators: [{by: attribute, tag: input, attribute: name, value: MBRNO}]
    risk: reversible
  - id: s03_read
    intent: Read balance
    action:
      type: extract
      output: savings_balance
      target:
        description: savings balance cell
        locators: [{by: table_cell, row: SHARE SAVINGS, column: Current Balance}]
    risk: read_only
success:
  description: balance read
  all_of: [{type: output, name: savings_balance}]
provenance: {method: authored, recorded_at: '2026-09-30T00:00:00Z', goal: test, tenant: acme}
""")


def make(**changes: Any) -> Capability:
    data = copy.deepcopy(BASE)
    for dotted, value in changes.items():
        node = data
        *path, last = dotted.split(".")
        for part in path:
            node = node[int(part)] if part.isdigit() else node[part]
        node[last] = value
    return Capability.model_validate(data)


# ============================================================================================ schema


def test_valid_capability_round_trips_through_yaml(tmp_path: Path) -> None:
    cap = make()
    path = tmp_path / "cap.yaml"
    path.write_text(to_yaml(cap))
    assert load_yaml(path, Capability) == cap
    assert "timeout_ms" not in path.read_text()  # uninformative defaults are pruned for reviewers


@pytest.mark.parametrize(
    ("change", "message"),
    [
        ({"steps.1.action.value": "{{inputs.account}}"}, "undeclared input"),
        ({"steps.2.action.target.locators": [{"by": "css", "selector": "td"}]}, "semantic locator"),
        ({"steps.2.action.output": "other"}, "undeclared output"),
        ({"side_effects": "read_only"}, "understates"),
        ({"inputs.member_id.example": "12345"}, "must not carry an example"),
        ({"steps.1.id": "s01_open"}, "duplicate step id"),
        ({"steps.1.action.value": "{{app.tenant}}"}, "unknown app template"),
    ],
)
def test_schema_invariants(change: dict[str, Any], message: str) -> None:
    with pytest.raises(ValidationError, match=message):
        make(**change)


def test_shipped_library_is_valid() -> None:
    for path in (REPO / "capabilities").glob("*/*@*.yaml"):
        load_yaml(path, Capability)


def test_templates_render_and_parameterize() -> None:
    ctx = TemplateContext(inputs={"member_id": "12345"}, app={"base_url": "http://x"})
    assert ctx.render("{{app.base_url}}/m?id={{ inputs.member_id }}") == "http://x/m?id=12345"
    with pytest.raises(TemplateError):
        ctx.render("{{secrets.password}}")
    assert (
        parameterize("mbrdtl.asp?M=12345&x=123456", {"member_id": "12345"})
        == "mbrdtl.asp?M={{inputs.member_id}}&x=123456"
    )


def test_override_patches_by_step_id_and_rejects_stale_ids() -> None:
    cap = make()
    override = CapabilityOverride.model_validate(
        {
            "capability": cap.id,
            "reason": "tenant renamed product",
            "steps": {
                "s03_read": {
                    "prepend_locators": [{"by": "table_cell", "row": "REGULAR SAVINGS", "column": "Ledger Balance"}]
                }
            },
        }
    )
    patched = apply_override(cap, override)
    assert patched.step("s03_read").action.target.locators[0].row == "REGULAR SAVINGS"  # type: ignore[union-attr]
    assert cap.step("s03_read").action.target.locators[0].row == "SHARE SAVINGS"  # type: ignore[union-attr]
    stale = override.model_copy(update={"steps": {"s99_gone": override.steps["s03_read"]}})
    with pytest.raises(KeyError):
        apply_override(cap, stale)


def test_version_ranges() -> None:
    assert version_in_range("1.4.0", ">=1.0.0,<2.0.0")
    assert not version_in_range("2.0.0", ">=1.0.0,<2.0.0")
    assert version_in_range("4.3.0", "*")


# ============================================================================================ redaction


def test_redaction_layers() -> None:
    redactor = Redactor([r"\bssn\b", "date of birth"])
    redactor.register("inputs.member_id", "12345")
    redactor.register("secrets.password", "s3cr3t-pass")
    text = (
        "member 12345 pw s3cr3t-pass ssn 123-45-6789 card 4111 1111 1111 1111 "
        "mail jo@example.com call (555) 010-4477 acct 123456789012 ref 123456"
    )
    out = redactor.text(text)
    assert "{{inputs.member_id}}" in out
    assert "{{secrets.password}}" in out
    assert "[SSN ***-**-6789]" in out
    assert "[CARD ****1111]" in out
    assert "[EMAIL]" in out
    assert "[PHONE]" in out
    assert "[ACCT ****9012]" in out
    assert "ref 123456" in out
    assert redactor.field("DATE OF BIRTH", "04/12/1984") == "[REDACTED DATE OF BIRTH]"
    assert redactor.text("capability legacycore.x@1.0.0") == "capability legacycore.x@1.0.0"
    assert redactor.text("123412341234") == "[ACCT ****1234]"


def test_short_values_are_not_registered() -> None:
    redactor = Redactor()
    redactor.register("inputs.flag", "00")
    assert redactor.text("suffix 00") == "suffix 00"


# ============================================================================================ policy


@pytest.fixture
def engine() -> PolicyEngine:
    return PolicyEngine(Policy.load(REPO / "config" / "policy.yaml"))


def test_network_allowlist(engine: PolicyEngine) -> None:
    assert engine.url_allowed("http://127.0.0.1:8600/acme/default.asp")
    assert not engine.url_allowed("https://evil.example.com/")
    assert not engine.url_allowed("http://127.0.0.1:8600/__admin/faults/acme")


def test_irreversible_actions_are_never_autonomous(engine: PolicyEngine) -> None:
    post = ElementFacts(role="button", name="Post")
    assert engine.check_action("discovery", "click", post).verdict == "escalate"
    assert engine.check_action("replay", "click", post).verdict == "deny"  # draft capability
    assert engine.check_action("replay", "click", post, capability_approved=True).verdict == "escalate"
    search = ElementFacts(role="button", name="Search")
    assert engine.check_action("replay", "click", search).verdict == "allow"
    assert (
        engine.check_action("discovery", "click", ElementFacts(role="link", name="Change Password")).verdict == "deny"
    )


def test_declared_risk_cannot_be_downgraded_by_a_benign_label(engine: PolicyEngine) -> None:
    benign = ElementFacts(role="button", name="Continue")
    decision = engine.check_action("replay", "click", benign, declared_risk="irreversible", capability_approved=True)
    assert decision.verdict == "escalate"
    assert decision.risk == "irreversible"


# ============================================================================================ values


@pytest.mark.parametrize(
    ("raw", "kind", "expected"),
    [
        ("$2,418.07", "money", "2418.07"),
        ("($12.00)", "money", "-12.00"),
        ("-$9,120.33", "money", "-9120.33"),
        ("1,000.00 DR", "money", "-1000.00"),
        ("03/14/2009", "date", "2009-03-14"),
        ("1,204", "integer", 1204),
        ("Y", "boolean", True),
    ],
)
def test_typed_parsing(raw: str, kind: str, expected: object) -> None:
    assert parse(raw, kind) == expected  # type: ignore[arg-type]


def test_wrong_type_is_rejected() -> None:
    with pytest.raises(ValueError_):
        parse("SAMPLE, JORDAN Q", "money")
    spec = make().inputs["member_id"]
    with pytest.raises(ValueError_, match="pattern"):
        validate_input("member_id", spec, "12AB")


# ============================================================================================ catalog


def test_catalog_lists_only_approved_task_capabilities() -> None:
    draft = make()
    approved = make(status="approved")
    assert catalog([draft]) == []
    [tool] = catalog([approved])
    assert tool == to_tool(approved)
    assert tool["name"] == "legacycore__member__get_savings_balance"
    assert tool["input_schema"]["required"] == ["member_id"]
    assert tool["input_schema"]["properties"]["member_id"]["pattern"] == "^[0-9]{5,10}$"
    assert "business_outcome" in tool["description"]


def test_probed_handlers_are_guarded_by_construction() -> None:
    from rote.artifact.schema import Handler, StepTargetCondition, TextCondition
    from rote.discovery.probe import guard_handler

    cap = make()
    base = Handler(
        id="x",
        description="d",
        kind="business_outcome",
        when=[TextCondition(text="SHARES / LOANS")],
        outcome={"code": "X", "message": "m"},
    )  # type: ignore[arg-type]
    message = guard_handler(base, cap, "s03_read", kind="business_outcome", evidence_type="message")
    assert message.scope == ["s03_read"]
    assert message.unless == [StepTargetCondition(step="s03_read")]
    assert len(message.when) == 1
    absence = guard_handler(base, cap, "s03_read", kind="business_outcome", evidence_type="absence")
    assert StepTargetCondition(step="s03_read", part="anchor") in absence.when


def test_versioned_file_names_are_not_mistaken_for_emails() -> None:
    assert Redactor().text("legacycore.session.sign_on@1.0.0.yaml") == "legacycore.session.sign_on@1.0.0.yaml"
