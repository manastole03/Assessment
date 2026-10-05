"""Model-graded rubric for what code can't check: is a recorded contract good for its callers and reviewers?

The judge sees only the artifact YAML and the goal. Artifacts are data-free by construction (and the
code-based grader checks that independently), so no member data reaches the model. Each criterion is
graded pass/fail with a one-sentence rationale, using structured output, so a score is never a vibe.
"""

from __future__ import annotations

import json
from typing import Any

import anthropic
from pydantic import BaseModel

RUBRIC: dict[str, str] = {
    "contract_clarity": (
        "The description tells a calling agent what the capability does, what it needs and what it returns, "
        "without referring to screens, clicks or other UI details."
    ),
    "typed_contract": (
        "Inputs and outputs use the most specific type available (money for currency amounts, a pattern for "
        "identifiers), and every value the goal asks for is declared as an output."
    ),
    "sensitivity": (
        "Every input or output that identifies or describes a person (names, member numbers, contact details) "
        "is marked pii, and credentials are only referenced as secrets."
    ),
    "reviewable_steps": (
        "Every step has an intent a reviewer understands without seeing the screen, and the steps follow the "
        "direct path a trained operator would take, with no exploratory or redundant actions."
    ),
    "robust_targets": (
        "Values are read by meaning (label, table row and column, role and name) rather than by position; "
        "positional CSS appears only as a fallback for clicks."
    ),
}

JUDGE_SYSTEM = """\
You review capability artifacts recorded by an automation-discovery agent. A capability is a typed, \
versioned YAML description of a back-office task that will later be replayed deterministically with no \
model in the loop, for many different inputs, and called by other AI agents through its contract.

Grade the artifact against each rubric criterion independently. Pass a criterion only when the artifact \
clearly meets it; when in doubt, fail it and say what is missing. Give one sentence of rationale per \
criterion, citing the field or step id you relied on."""

_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "criteria": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "id": {"type": "string", "enum": list(RUBRIC)},
                    "passed": {"type": "boolean"},
                    "rationale": {"type": "string"},
                },
                "required": ["id", "passed", "rationale"],
                "additionalProperties": False,
            },
        }
    },
    "required": ["criteria"],
    "additionalProperties": False,
}


class CriterionGrade(BaseModel):
    id: str
    passed: bool
    rationale: str


class Verdict(BaseModel):
    model: str
    criteria: list[CriterionGrade]
    cost_usd: float = 0.0

    @property
    def score(self) -> float:
        return sum(c.passed for c in self.criteria) / len(self.criteria) if self.criteria else 0.0


class JudgeError(RuntimeError):
    pass


# $ per million tokens (input, output) for cost reporting; unknown models report 0.
_PRICES = {"claude-opus-5-5": (4.0, 20.0), "claude-sonnet-5-5": (2.0, 10.0), "claude-fable-5-1": (10.0, 50.0)}


class ContractJudge:
    def __init__(self, *, model: str, effort: str, fallbacks: bool = True):
        self.model = model
        self.effort = effort
        self.fallbacks = fallbacks
        self.client = anthropic.AsyncAnthropic(max_retries=4)

    async def grade(self, *, goal: str, artifact_yaml: str) -> Verdict:
        rubric = "\n".join(f"- {key}: {text}" for key, text in RUBRIC.items())
        request: dict[str, Any] = {
            "model": self.model,
            "max_tokens": 16_000,
            "system": JUDGE_SYSTEM,
            "thinking": {"type": "adaptive"},
            "output_config": {"effort": self.effort, "format": {"type": "json_schema", "schema": _SCHEMA}},
            "messages": [
                {
                    "role": "user",
                    "content": f"Goal given to the discovery agent:\n{goal}\n\nRubric:\n{rubric}\n\n"
                    f"Artifact:\n```yaml\n{artifact_yaml}\n```",
                }
            ],
        }
        try:
            if self.fallbacks:
                response = await self.client.beta.messages.create(
                    **request, betas=["server-side-fallback-2026-07-01"], fallbacks="default"
                )
            else:
                response = await self.client.beta.messages.create(**request)
        except anthropic.AuthenticationError as exc:
            raise JudgeError("Anthropic API rejected the credentials (set ANTHROPIC_API_KEY in .env)") from exc
        except anthropic.RateLimitError as exc:
            raise JudgeError("rate limited by the Anthropic API; retry later") from exc
        except anthropic.BadRequestError as exc:
            raise JudgeError(f"Anthropic API rejected the judge request: {exc.message}") from exc
        except anthropic.APIConnectionError as exc:
            raise JudgeError(f"could not reach the Anthropic API: {exc}") from exc

        if response.stop_reason == "refusal":
            raise JudgeError(f"the judge declined ({getattr(response, 'stop_details', None)})")
        if response.stop_reason == "max_tokens":
            raise JudgeError("the judge's response hit max_tokens")
        text = next((b.text for b in response.content if b.type == "text"), None)
        if text is None:
            raise JudgeError("the judge returned no verdict")
        graded = {c["id"]: c for c in json.loads(text)["criteria"]}
        criteria = [
            CriterionGrade.model_validate(graded[key])
            if key in graded
            else CriterionGrade(id=key, passed=False, rationale="not graded by the judge")
            for key in RUBRIC
        ]
        price_in, price_out = _PRICES.get(response.model, (0.0, 0.0))
        usage = response.usage
        cost = (usage.input_tokens * price_in + usage.output_tokens * price_out) / 1_000_000
        return Verdict(model=response.model, criteria=criteria, cost_usd=round(cost, 4))
