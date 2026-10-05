"""Expose capabilities to calling agents as typed tools (Anthropic tool-definition format).

The contract half of the artifact maps directly onto a tool definition: inputs become the JSON
Schema, and the description tells the agent what comes back — outputs *and* the business outcomes
it must be ready to handle. Only approved capabilities are listed unless asked otherwise.
"""

from __future__ import annotations

from typing import Any

from .artifact.schema import Capability, ValueType

_JSON_TYPES: dict[ValueType, dict[str, Any]] = {
    "string": {"type": "string"},
    "integer": {"type": "integer"},
    "decimal": {"type": "string", "description": "decimal number as a string"},
    "money": {"type": "string", "description": "decimal amount as a string, e.g. '1234.56'"},
    "date": {"type": "string", "format": "date"},
    "boolean": {"type": "boolean"},
}


def tool_name(capability_id: str) -> str:
    return capability_id.replace(".", "__")


def capability_id(tool: str) -> str:
    return tool.replace("__", ".")


def to_tool(capability: Capability) -> dict[str, Any]:
    properties: dict[str, Any] = {}
    for name, spec in capability.inputs.items():
        schema = dict(_JSON_TYPES[spec.type])
        schema["description"] = spec.description
        if spec.pattern:
            schema["pattern"] = spec.pattern
        if spec.enum:
            schema["enum"] = spec.enum
        properties[name] = schema
    outputs = ", ".join(f"{n} ({s.type})" for n, s in capability.outputs.items()) or "none"
    outcomes = ", ".join(capability.outcome_codes()) or "none declared"
    description = (
        f"{capability.title}. {capability.description} "
        f"Returns status 'succeeded' with outputs: {outputs}; or status 'business_outcome' with one of: {outcomes}; "
        f"or status 'failed' with a failure code and whether retrying can help. "
        f"Side effects: {capability.side_effects.replace('_', ' ')}. Version {capability.version}."
    )
    return {
        "name": tool_name(capability.id),
        "description": description,
        "input_schema": {
            "type": "object",
            "properties": properties,
            "required": [n for n, s in capability.inputs.items() if s.required],
            "additionalProperties": False,
        },
    }


def catalog(capabilities: list[Capability], *, include_drafts: bool = False) -> list[dict[str, Any]]:
    latest: dict[str, Capability] = {}
    for cap in capabilities:
        if cap.kind != "task" or cap.status == "deprecated":
            continue
        if cap.status != "approved" and not include_drafts:
            continue
        current = latest.get(cap.id)
        if current is None or tuple(map(int, cap.version.split("."))) > tuple(map(int, current.version.split("."))):
            latest[cap.id] = cap
    return [to_tool(cap) for cap in sorted(latest.values(), key=lambda c: c.id)]
