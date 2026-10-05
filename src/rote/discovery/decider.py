"""Who decides the next action during discovery.

``Decider`` is the seam between the agent loop and a model provider. ``ClaudeDecider`` is the real
one; ``ScriptedDecider`` replays a fixed plan so the loop, recorder and artifact builder can be
tested deterministically without network access.

The Claude conversation is strictly append-only (full assistant content, including thinking
blocks, is echoed back unchanged). That keeps the prompt cache warm across turns and satisfies
preserved-thinking checks on current models; old screenshots are therefore kept rather than pruned —
a discovery run is short enough (tens of turns) that this is cheap.
"""

from __future__ import annotations

import base64
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any, Protocol

import anthropic

from ..policy.redaction import Redactor
from ..surface.base import Observation
from .tools import TOOLS

SYSTEM_PROMPT = """\
You are the discovery agent of "rote", a system that turns one successful run of a back-office task into a \
deterministic, replayable automation (a "capability"). You operate a legacy core-banking web application for \
an operator at a US credit union.

How this works
- Each turn you receive the current screen as (1) a text list of visible elements — each with a ref like e12, \
a role, a name or visual label, and the frame it lives in — and (2) a screenshot. Act by calling exactly one \
tool. The next screen arrives with the tool result.
- Everything you do is recorded and later replayed WITHOUT you, for many different inputs. Take the direct \
path a trained operator would take, use the application's own menus and buttons (navigate by URL only to an \
entry page), avoid exploratory or unnecessary actions, and never depend on values that change between runs.
- Refs are only valid for the screen they came from.

Data handling
- Input values and credentials are hidden from you. Wherever one would be shown it appears as \
{{inputs.<name>}} or {{secrets.<name>}}. Enter them with fill(ref, input=...) or fill(ref, secret=...); \
never type them as text.
- Some fields (SSN, date of birth, contact details) are redacted. You never need them.

Rules
1. First call define_capability to declare the contract: a stable dotted id, a description a calling agent \
can rely on, typed inputs (every provided input must be declared, with sensitivity) and the typed outputs the \
goal asks for.
2. Read each declared output with extract(ref, output), choosing the element that shows the value itself.
3. Never perform an irreversible action (posting, submitting a payment or transfer, deleting, approving) unless \
the goal explicitly requires it. Policy may block it or ask a human to approve; if blocked, take another path \
or stop.
4. If the application gives a legitimate business answer that prevents the goal (no matching record, access \
restricted, ...), call report_outcome with a short UPPER_SNAKE code. That is a valid result, not a failure.
5. If you are stuck — no progress after a couple of attempts, a screen you cannot handle safely, missing \
information — call request_human with a clear reason. A human will take over this same live session and \
hand it back to you.
6. When the goal is achieved and all outputs are extracted, call finish. success_text is a short, stable \
screen title on the final screen, never data.
Keep each rationale to one sentence."""


@dataclass
class ToolCall:
    id: str
    name: str
    input: dict[str, Any]


@dataclass
class ToolResult:
    call_id: str
    ok: bool
    message: str


@dataclass
class Turn:
    calls: list[ToolCall]
    text: str = ""
    reasoning: str = ""
    stop_reason: str = ""
    usage: dict[str, int] = field(default_factory=dict)


class DeciderError(RuntimeError):
    pass


class Decider(Protocol):
    model: str

    async def start(self, brief: str, observation: Observation) -> None: ...
    async def next_turn(self) -> Turn: ...
    async def feed(
        self, results: list[ToolResult], observation: Observation | None, note: str | None = None
    ) -> None: ...


def _observation_blocks(observation: Observation, redactor: Redactor) -> list[dict[str, Any]]:
    blocks: list[dict[str, Any]] = [{"type": "text", "text": "Current screen:\n" + observation.render(redactor)}]
    if observation.screenshot:
        blocks.append(
            {
                "type": "image",
                "source": {
                    "type": "base64",
                    "media_type": "image/jpeg",
                    "data": base64.standard_b64encode(observation.screenshot).decode(),
                },
            }
        )
    return blocks


class ClaudeDecider:
    def __init__(
        self, *, model: str, effort: str, redactor: Redactor, fallbacks: bool = True, max_tokens: int = 16_000
    ):
        self.model = model
        self.effort = effort
        self.redactor = redactor
        self.fallbacks = fallbacks
        self.max_tokens = max_tokens
        self.client = anthropic.AsyncAnthropic(max_retries=4)
        self.messages: list[dict[str, Any]] = []

    async def start(self, brief: str, observation: Observation) -> None:
        self.messages.append(
            {
                "role": "user",
                "content": [{"type": "text", "text": brief}, *_observation_blocks(observation, self.redactor)],
            }
        )

    async def next_turn(self) -> Turn:
        request: dict[str, Any] = {
            "model": self.model,
            "max_tokens": self.max_tokens,
            "system": [{"type": "text", "text": SYSTEM_PROMPT, "cache_control": {"type": "ephemeral"}}],
            "tools": TOOLS,
            "tool_choice": {"type": "auto", "disable_parallel_tool_use": True},
            "thinking": {"type": "adaptive", "display": "summarized"},
            "output_config": {"effort": self.effort},
            "cache_control": {"type": "ephemeral"},
            "messages": self.messages,
        }
        try:
            if self.fallbacks:
                response = await self.client.beta.messages.create(
                    **request, betas=["server-side-fallback-2026-07-01"], fallbacks="default"
                )
            else:
                response = await self.client.messages.create(**request)
        except anthropic.AuthenticationError as exc:
            raise DeciderError("Anthropic API rejected the credentials (set ANTHROPIC_API_KEY in .env)") from exc
        except anthropic.BadRequestError as exc:
            raise DeciderError(f"Anthropic API rejected the request: {exc.message}") from exc
        except anthropic.APIConnectionError as exc:
            raise DeciderError(f"could not reach the Anthropic API: {exc}") from exc

        # Append-only history: echo the full content (thinking blocks included) back unchanged.
        self.messages.append({"role": "assistant", "content": response.content})
        if response.stop_reason == "refusal":
            raise DeciderError(f"model declined the request ({getattr(response, 'stop_details', None)})")
        if response.stop_reason == "max_tokens":
            raise DeciderError("model response hit max_tokens; tool input may be truncated")

        calls = [ToolCall(b.id, b.name, dict(b.input)) for b in response.content if b.type == "tool_use"]
        reasoning = "\n".join(b.thinking for b in response.content if b.type == "thinking" and b.thinking)
        text = "\n".join(b.text for b in response.content if b.type == "text")
        usage = response.usage
        return Turn(
            calls=calls,
            text=text,
            reasoning=reasoning,
            stop_reason=response.stop_reason or "",
            usage={
                "input_tokens": usage.input_tokens or 0,
                "output_tokens": usage.output_tokens or 0,
                "cache_read_input_tokens": getattr(usage, "cache_read_input_tokens", 0) or 0,
                "cache_creation_input_tokens": getattr(usage, "cache_creation_input_tokens", 0) or 0,
            },
        )

    async def feed(self, results: list[ToolResult], observation: Observation | None, note: str | None = None) -> None:
        content: list[dict[str, Any]] = [
            {"type": "tool_result", "tool_use_id": r.call_id, "content": r.message, "is_error": not r.ok}
            for r in results
        ]
        if note:
            content.append({"type": "text", "text": note})
        if observation is not None:
            content.extend(_observation_blocks(observation, self.redactor))
        if not content:
            content.append({"type": "text", "text": "Continue by calling exactly one tool."})
        self.messages.append({"role": "user", "content": content})


ScriptStep = Callable[[Observation], tuple[str, dict[str, Any]]]


class ScriptedDecider:
    """Deterministic stand-in for tests: each script step maps the current observation to a tool call."""

    model = "scripted"

    def __init__(self, script: list[ScriptStep]):
        self.script = script
        self.index = 0
        self.observation: Observation | None = None
        self.transcript: list[tuple[str, dict[str, Any], ToolResult | None]] = []

    async def start(self, brief: str, observation: Observation) -> None:
        self.observation = observation

    async def next_turn(self) -> Turn:
        if self.index >= len(self.script) or self.observation is None:
            raise DeciderError("script exhausted")
        name, args = self.script[self.index](self.observation)
        self.index += 1
        args.setdefault("rationale", "scripted")
        return Turn(calls=[ToolCall(f"call_{self.index}", name, args)], stop_reason="tool_use")

    async def feed(self, results: list[ToolResult], observation: Observation | None, note: str | None = None) -> None:
        for result in results:
            if not result.ok:
                raise DeciderError(f"scripted step {self.index} failed: {result.message}")
        if observation is not None:
            self.observation = observation
