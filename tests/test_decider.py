"""The Claude decider without network access: request shape and append-only history."""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

from rote.discovery.decider import SYSTEM_PROMPT, ClaudeDecider, ToolResult
from rote.discovery.tools import TOOLS
from rote.policy.redaction import Redactor
from rote.surface.base import ElementInfo, FrameInfo, Observation


def _observation(text: str) -> Observation:
    return Observation(
        url="http://bank/acme/default.asp",
        title="t",
        frames=[FrameInfo("main", "u", "mbrinq.asp")],
        elements=[ElementInfo(ref="e1", frame="main", role="textbox", label="Member Number", value="12345")],
        screenshot=b"\xff\xd8jpeg-bytes" if text else None,
    )


class FakeMessages:
    def __init__(self) -> None:
        self.requests: list[dict[str, Any]] = []

    async def create(self, **kwargs: Any) -> Any:
        self.requests.append({**kwargs, "messages": list(kwargs["messages"])})
        block = SimpleNamespace(
            type="tool_use", id=f"tu_{len(self.requests)}", name="click", input={"ref": "e1", "rationale": "open it"}
        )
        thinking = SimpleNamespace(type="thinking", thinking="the field is visible")
        usage = SimpleNamespace(
            input_tokens=10, output_tokens=5, cache_read_input_tokens=3, cache_creation_input_tokens=7
        )
        return SimpleNamespace(content=[thinking, block], stop_reason="tool_use", usage=usage)


async def test_requests_are_append_only_and_values_are_redacted() -> None:
    redactor = Redactor()
    redactor.register("inputs.member_id", "12345")
    decider = ClaudeDecider(model="claude-opus-5-5", effort="high", redactor=redactor, fallbacks=True)
    fake = FakeMessages()
    decider.client = SimpleNamespace(beta=SimpleNamespace(messages=fake), messages=fake)  # type: ignore[assignment]

    await decider.start("GOAL: look up {{inputs.member_id}}", _observation("first"))
    turn = await decider.next_turn()
    assert turn.calls[0].name == "click"
    assert turn.reasoning == "the field is visible"
    await decider.feed([ToolResult(turn.calls[0].id, True, "clicked")], _observation("second"))
    await decider.next_turn()

    first, second = fake.requests
    assert second["messages"][: len(first["messages"])] == first["messages"], "history must be append-only"
    assert first["system"][0]["text"] == SYSTEM_PROMPT
    assert first["system"][0]["cache_control"]
    assert first["tools"] == TOOLS
    assert first["tool_choice"] == {"type": "auto", "disable_parallel_tool_use": True}
    assert first["thinking"]["type"] == "adaptive"
    assert first["output_config"] == {"effort": "high"}
    assert first["fallbacks"] == "default"
    tool_turn = second["messages"][-1]["content"]
    assert tool_turn[0]["type"] == "tool_result"
    assert tool_turn[-1]["type"] == "image"
    rendered = str(second["messages"])
    assert "12345" not in rendered
    assert "{{inputs.member_id}}" in rendered
