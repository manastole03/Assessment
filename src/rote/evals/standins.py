"""Deterministic stand-ins for the model, shared by the tests, the evidence script and offline evals.

* Scripted discovery plans drive the real agent loop and recorder through ``ScriptedDecider``. They pick
  elements by role/label/column, so they are independent of ref numbering.
* ``rule_classifier`` names the known off-happy-path screens by their stable text, standing in for the
  one bounded model call ``rote probe`` makes.

Offline evals with these stand-ins measure the harness and the deterministic pipeline around the model;
``--live`` swaps in the model itself.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

from ..artifact.resolve import ResolvedCapability
from ..discovery.decider import ScriptStep
from ..discovery.probe import Classification
from ..policy.redaction import Redactor
from ..replay.result import RunResult
from ..surface.base import Observation


def ref(obs: Observation, **match: Any) -> str:
    """The ref of the first element whose attributes all match (strings case-insensitively, or a predicate)."""
    for element in obs.elements:
        if element.ref and all(_matches(getattr(element, key), value) for key, value in match.items()):
            return element.ref
    raise LookupError(
        f"no element matching {match} in:\n"
        + "\n".join(f"{e.ref} {e.frame} {e.role} {e.name!r} {e.label!r} col={e.column!r}" for e in obs.elements)
    )


def _matches(actual: Any, expected: Any) -> bool:
    if callable(expected):
        return bool(expected(actual))
    if isinstance(expected, str) and isinstance(actual, str):
        return actual.strip().lower() == expected.lower()
    return bool(actual == expected)


SESSION_SCRIPT: list[ScriptStep] = [
    lambda o: (
        "define_capability",
        {
            "id": "legacycore.session.sign_on",
            "title": "Sign on to LegacyCore",
            "description": "Signs on with the service account so other capabilities start from the home screen.",
            "inputs": [],
            "outputs": [],
        },
    ),
    lambda o: ("fill", {"ref": ref(o, role="textbox", label="User ID"), "secret": "username"}),
    lambda o: ("fill", {"ref": ref(o, role="textbox", label="Password"), "secret": "password"}),
    lambda o: ("click", {"ref": ref(o, role="button", name="Sign On")}),
    lambda o: ("finish", {"summary": "signed on", "success_text": "FUNCTIONS"}),
]


def balance_script(member_id: str) -> list[ScriptStep]:
    return [
        lambda o: (
            "define_capability",
            {
                "id": "legacycore.member.get_savings_balance",
                "title": "Get a member's savings balance",
                "description": "Looks up a member by member number and reads the current balance of their share "
                "savings account and the member's name.",
                "inputs": [
                    {
                        "name": "member_id",
                        "type": "string",
                        "description": "Member number",
                        "sensitivity": "pii",
                        "pattern": "^[0-9]{5,10}$",
                    }
                ],
                "outputs": [
                    {
                        "name": "savings_balance",
                        "type": "money",
                        "description": "Current savings balance",
                        "sensitivity": "internal",
                    },
                    {
                        "name": "member_name",
                        "type": "string",
                        "description": "Member name as on file",
                        "sensitivity": "pii",
                    },
                ],
            },
        ),
        lambda o: ("click", {"ref": ref(o, role="link", name="Member Inquiry")}),
        lambda o: ("fill", {"ref": ref(o, role="textbox", label="Member Number"), "input": "member_id"}),
        lambda o: ("click", {"ref": ref(o, role="button", name="Search")}),
        lambda o: ("click", {"ref": ref(o, role="link", name=member_id)}),
        lambda o: (
            "extract",
            {
                "ref": ref(o, column="CURRENT BALANCE", row=lambda r: bool(r) and "SHARE SAVINGS" in r),
                "output": "savings_balance",
            },
        ),
        lambda o: ("extract", {"ref": ref(o, role="cell", label="NAME"), "output": "member_name"}),
        lambda o: ("finish", {"summary": "read balance", "success_text": "MEMBER DETAIL"}),
    ]


# Plans by name, built from the case's inputs (eval datasets reference them as `standin:`).
SCRIPTS: dict[str, Callable[[dict[str, str]], list[ScriptStep]]] = {
    "sign_on": lambda inputs: SESSION_SCRIPT,
    "savings_balance": lambda inputs: balance_script(inputs["member_id"]),
}


# needle on screen -> (kind, code, message, evidence type)
CLASSIFICATION_RULES: dict[str, tuple[str, str, str, str]] = {
    "NO RECORDS MATCH": ("business_outcome", "MEMBER_NOT_FOUND", "No member has that member number.", "message"),
    "ACCESS DENIED": (
        "business_outcome",
        "ACCESS_RESTRICTED",
        "The member's account is restricted; a supervisor override is required to view it.",
        "message",
    ),
    "SHARES / LOANS": ("business_outcome", "NO_SAVINGS_ACCOUNT", "The member has no share savings account.", "absence"),
}


async def rule_classifier(
    observation: Observation, result: RunResult, rc: ResolvedCapability, redactor: Redactor
) -> Classification | None:
    """Offline stand-in for the probe's model call: classify by stable screen text, or decline."""
    for needle, (kind, code, message, evidence_type) in CLASSIFICATION_RULES.items():
        element = next((e for e in observation.elements if needle in (e.text or "")), None)
        if element is not None and element.ref:
            return Classification(
                kind=kind,
                code=code,
                message=message,
                evidence_ref=element.ref,
                evidence_type=evidence_type,
                rationale="offline rule (stand-in for the model)",
                source="authored",
            )
    return None
