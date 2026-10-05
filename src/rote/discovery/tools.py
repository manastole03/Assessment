"""The discovery agent's tool surface, as Anthropic tool definitions plus Pydantic validators.

Tools are deliberately element-centric (``ref`` from the latest observation) with a coordinate
fallback (``click_at``). Acting on refs lets the recorder turn every action into verified,
multi-strategy locators; ``click_at`` covers surfaces where perception missed a control (the hit
point is mapped back to an element, so it is still recorded semantically).
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from ..artifact.schema import OutcomeCode, Sensitivity, Slug, ValueType


class _In(BaseModel):
    model_config = ConfigDict(extra="forbid")
    rationale: str = Field(min_length=1, max_length=600)


class ParamDecl(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: Slug
    type: ValueType
    description: str
    sensitivity: Sensitivity = "internal"
    pattern: str | None = None


class DefineCapability(_In):
    id: str = Field(pattern=r"^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$")
    title: str
    description: str
    inputs: list[ParamDecl] = Field(default_factory=list)
    outputs: list[ParamDecl] = Field(default_factory=list)


class Click(_In):
    ref: str


class ClickAt(_In):
    x: float
    y: float


class Fill(_In):
    ref: str
    input: str | None = None
    secret: str | None = None
    text: str | None = None

    @model_validator(mode="after")
    def _one_source(self) -> Fill:
        if sum(v is not None for v in (self.input, self.secret, self.text)) != 1:
            raise ValueError("provide exactly one of input, secret or text")
        return self


class SelectOption(_In):
    ref: str
    option: str | None = None
    input: str | None = None

    @model_validator(mode="after")
    def _one_source(self) -> SelectOption:
        if (self.option is None) == (self.input is None):
            raise ValueError("provide exactly one of option or input")
        return self


class PressKey(_In):
    key: Literal["Enter", "Tab", "Escape"]
    ref: str | None = None


class Navigate(_In):
    path: str = Field(description="Path relative to the application base URL.")


class Extract(_In):
    ref: str
    output: str


class AnswerDialog(_In):
    accept: bool


class Wait(_In):
    seconds: float = Field(ge=0.5, le=10)


class ReportOutcome(_In):
    code: OutcomeCode
    message: str
    evidence_ref: str | None = None


class RequestHuman(_In):
    reason: str


class Finish(_In):
    summary: str
    success_text: str = Field(min_length=3, max_length=80)


TOOL_MODELS: dict[str, type[_In]] = {
    "define_capability": DefineCapability,
    "click": Click,
    "click_at": ClickAt,
    "fill": Fill,
    "select_option": SelectOption,
    "press_key": PressKey,
    "navigate": Navigate,
    "extract": Extract,
    "answer_dialog": AnswerDialog,
    "wait": Wait,
    "report_outcome": ReportOutcome,
    "request_human": RequestHuman,
    "finish": Finish,
}

_RATIONALE = {"type": "string", "description": "One sentence: why this action, now."}
_REF = {"type": "string", "description": "Element ref from the latest screen, e.g. 'e12'."}
_PARAM = {
    "type": "object",
    "properties": {
        "name": {"type": "string", "description": "snake_case"},
        "type": {"type": "string", "enum": ["string", "integer", "decimal", "money", "date", "boolean"]},
        "description": {"type": "string"},
        "sensitivity": {
            "type": "string",
            "enum": ["public", "internal", "pii", "secret"],
            "description": "pii for anything identifying a person or account.",
        },
        "pattern": {"type": "string", "description": "Optional regex the value must fully match."},
    },
    "required": ["name", "type", "description", "sensitivity"],
    "additionalProperties": False,
}


def _tool(name: str, description: str, properties: dict[str, Any], required: list[str]) -> dict[str, Any]:
    return {
        "name": name,
        "description": description,
        "input_schema": {
            "type": "object",
            "properties": {**properties, "rationale": _RATIONALE},
            "required": [*required, "rationale"],
            "additionalProperties": False,
        },
    }


TOOLS: list[dict[str, Any]] = [
    _tool(
        "define_capability",
        "Declare the reusable capability you are about to demonstrate: a stable dotted id "
        "(<app>.<area>.<verb_object>), what it does for a calling agent, every input it takes (all provided "
        "inputs must be declared) and every output the goal asks for. Call this first, before acting.",
        {
            "id": {"type": "string"},
            "title": {"type": "string"},
            "description": {"type": "string"},
            "inputs": {"type": "array", "items": _PARAM},
            "outputs": {"type": "array", "items": _PARAM},
        },
        ["id", "title", "description", "inputs", "outputs"],
    ),
    _tool("click", "Click a link, button, checkbox or other control by ref.", {"ref": _REF}, ["ref"]),
    _tool(
        "click_at",
        "Click at screenshot pixel coordinates. Only use this when the control you need has no ref in the "
        "element list.",
        {"x": {"type": "number"}, "y": {"type": "number"}},
        ["x", "y"],
    ),
    _tool(
        "fill",
        "Type into a text field (replacing its content). Provide exactly one source: input (name of a declared "
        "input), secret (name of an available credential) or text (a constant that is the same for every run).",
        {"ref": _REF, "input": {"type": "string"}, "secret": {"type": "string"}, "text": {"type": "string"}},
        ["ref"],
    ),
    _tool(
        "select_option",
        "Choose an option in a dropdown, by visible option text or from a declared input.",
        {"ref": _REF, "option": {"type": "string"}, "input": {"type": "string"}},
        ["ref"],
    ),
    _tool(
        "press_key",
        "Press a key, optionally in a specific field.",
        {"key": {"type": "string", "enum": ["Enter", "Tab", "Escape"]}, "ref": _REF},
        ["key"],
    ),
    _tool(
        "navigate",
        "Load a page by path relative to the application base URL. Only for the entry page; use the "
        "application's own menus and links for everything else.",
        {"path": {"type": "string"}},
        ["path"],
    ),
    _tool(
        "extract",
        "Read the value shown by an element into a declared output. Choose the element that displays the value "
        "itself (e.g. the balance cell), not its label.",
        {"ref": _REF, "output": {"type": "string"}},
        ["ref", "output"],
    ),
    _tool(
        "answer_dialog",
        "Accept (OK) or dismiss (Cancel) the native browser dialog that is currently open.",
        {"accept": {"type": "boolean"}},
        ["accept"],
    ),
    _tool("wait", "Wait for a slow screen to finish loading.", {"seconds": {"type": "number"}}, ["seconds"]),
    _tool(
        "report_outcome",
        "End the run with a legitimate business result that prevents the goal (e.g. NO_MATCHING_MEMBER, "
        "ACCESS_RESTRICTED). evidence_ref is the element showing the application's message.",
        {
            "code": {"type": "string", "description": "UPPER_SNAKE_CASE"},
            "message": {"type": "string"},
            "evidence_ref": _REF,
        },
        ["code", "message"],
    ),
    _tool(
        "request_human",
        "Ask a human operator to take over the live session (stuck, unknown screen, missing information). "
        "They will act and hand control back to you.",
        {"reason": {"type": "string"}},
        ["reason"],
    ),
    _tool(
        "finish",
        "Declare the goal achieved. success_text must be short, stable text on the final screen that proves "
        "you are in the right place (a screen title), never data such as names or amounts.",
        {"summary": {"type": "string"}, "success_text": {"type": "string"}},
        ["summary", "success_text"],
    ),
]


def parse_call(name: str, raw: dict[str, Any]) -> _In:
    model = TOOL_MODELS.get(name)
    if model is None:
        raise ValueError(f"unknown tool {name!r}")
    return model.model_validate(raw)
