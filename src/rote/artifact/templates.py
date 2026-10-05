"""`{{inputs.x}}` / `{{secrets.y}}` / `{{app.base_url}}` templating.

Deliberately tiny: no expressions, no filters, no loops. An artifact is data a reviewer must be
able to read, so the only indirection allowed is naming a value that is supplied at runtime.
"""

from __future__ import annotations

import re
from collections.abc import Mapping
from dataclasses import dataclass, field

TEMPLATE_RE = re.compile(r"\{\{\s*(inputs|secrets|app)\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}")


class TemplateError(KeyError):
    pass


@dataclass
class TemplateContext:
    inputs: Mapping[str, str] = field(default_factory=dict)
    secrets: Mapping[str, str] = field(default_factory=dict)
    app: Mapping[str, str] = field(default_factory=dict)

    def render(self, text: str) -> str:
        def sub(match: re.Match[str]) -> str:
            scope, name = match.group(1), match.group(2)
            source: Mapping[str, str] = getattr(self, scope)
            if name not in source:
                raise TemplateError(f"no value for {{{{{scope}.{name}}}}}")
            return str(source[name])

        return TEMPLATE_RE.sub(sub, text)

    def uses_secret(self, text: str) -> bool:
        return any(m.group(1) == "secrets" for m in TEMPLATE_RE.finditer(text))


def parameterize(text: str, values: Mapping[str, str], scope: str = "inputs") -> str:
    """Replace concrete values with their template names (longest value first).

    Used when recording: a literal "12345" typed or seen during discovery becomes
    ``{{inputs.member_id}}`` so the artifact generalises and never stores the value itself.
    """
    for name, value in sorted(values.items(), key=lambda kv: -len(kv[1])):
        if value and len(value) >= 2:
            text = re.sub(rf"(?<![A-Za-z0-9]){re.escape(value)}(?![A-Za-z0-9])", f"{{{{{scope}.{name}}}}}", text)
    return text
