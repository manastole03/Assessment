"""Typed parsing of inputs and extracted outputs.

Typing outputs is a safety net, not a nicety: if a locator ever lands on the wrong cell, the value
usually fails to parse as the declared type and the run fails loudly instead of returning garbage.
"""

from __future__ import annotations

import re
from collections.abc import Mapping
from datetime import date, datetime
from decimal import Decimal, InvalidOperation

from ..artifact.schema import InputSpec, OutputSpec, ValueType


class ValueError_(ValueError):
    pass


_MONEY_RE = re.compile(r"^\(?\s*(-)?\s*\$?\s*(-)?\s*([\d,]+(?:\.\d{1,2})?)\s*\)?\s*(CR|DR)?$", re.IGNORECASE)


def parse(raw: str, kind: ValueType) -> str | int | bool:
    """Parse ``raw`` into a JSON-safe typed value (money/decimals stay strings to keep precision)."""
    text = (raw or "").strip()
    if kind == "string":
        if not text:
            raise ValueError_("empty string")
        return text
    if kind == "money":
        match = _MONEY_RE.match(text)
        if not match:
            raise ValueError_(f"{text!r} is not a money amount")
        negative = bool(
            match.group(1) or match.group(2) or text.startswith("(") or (match.group(4) or "").upper() == "DR"
        )
        amount = Decimal(match.group(3).replace(",", "")).quantize(Decimal("0.01"))
        return str(-amount if negative else amount)
    if kind == "decimal":
        try:
            return str(Decimal(text.replace(",", "")))
        except InvalidOperation as exc:
            raise ValueError_(f"{text!r} is not a decimal") from exc
    if kind == "integer":
        if not re.fullmatch(r"-?\d+", text.replace(",", "")):
            raise ValueError_(f"{text!r} is not an integer")
        return int(text.replace(",", ""))
    if kind == "date":
        for fmt in ("%m/%d/%Y", "%Y-%m-%d", "%m/%d/%y", "%d-%b-%Y"):
            try:
                return datetime.strptime(text, fmt).date().isoformat()  # noqa: DTZ007 (a calendar date, not an instant)
            except ValueError:
                continue
        raise ValueError_(f"{text!r} is not a date")
    if kind == "boolean":
        lowered = text.lower()
        if lowered in ("y", "yes", "true", "1", "checked", "on"):
            return True
        if lowered in ("n", "no", "false", "0", "unchecked", "off"):
            return False
        raise ValueError_(f"{text!r} is not a boolean")
    raise ValueError_(f"unknown type {kind}")


def validate_input(name: str, spec: InputSpec, value: object) -> str:
    """Check a caller-supplied input against its spec; return the string form the UI will receive."""
    if value is None or value == "":
        raise ValueError_(f"input {name!r} is required")
    text = value.isoformat() if isinstance(value, date) else str(value).strip()
    if spec.enum is not None and text not in spec.enum:
        raise ValueError_(f"input {name!r} must be one of {spec.enum}")
    if spec.pattern is not None and not re.fullmatch(spec.pattern, text):
        raise ValueError_(f"input {name!r} does not match the required pattern {spec.pattern}")
    if spec.type != "string":
        parse(text, spec.type)
    return text


def check_inputs(specs: Mapping[str, InputSpec], inputs: Mapping[str, object]) -> tuple[dict[str, str], list[str]]:
    """Validate a whole call: unknown names, missing required inputs, and every value against its spec.

    Returns the cleaned values and every problem found (not just the first), so an API caller can fix
    them all at once. The replay engine runs the same check before touching the UI.
    """
    problems = [f"unknown input {name!r}" for name in sorted(set(inputs) - set(specs))]
    clean: dict[str, str] = {}
    for name, spec in specs.items():
        if name not in inputs:
            if spec.required:
                problems.append(f"missing required input {name!r}")
            continue
        try:
            clean[name] = validate_input(name, spec, inputs[name])
        except ValueError_ as exc:
            problems.append(str(exc))
    return clean, problems


def coerce_output(name: str, spec: OutputSpec, raw: str) -> str | int | bool:
    try:
        return parse(raw, spec.type)
    except ValueError_ as exc:
        raise ValueError_(f"output {name!r}: {exc}") from exc
