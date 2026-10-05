"""Redaction for everything that leaves the live session: logs, evidence, artifacts and model input.

Three layers, strongest first:

1. **Known values.** Secrets, sensitive inputs and sensitive outputs are registered the moment they
   enter the run, and every occurrence is replaced by its *reference* (``{{secrets.password}}``,
   ``{{inputs.member_id}}``). This is exact and is also how the discovery model is kept from ever
   seeing an input value: it works with references, not data.
2. **Field-aware.** Values whose on-screen label names a sensitive field (SSN, date of birth, ...)
   are masked regardless of format — see ``Policy.sensitive_labels``.
3. **Patterns.** SSNs, card numbers (Luhn-checked), long account numbers, emails and phone numbers.

Free-text PII such as names can't be pattern-matched, which is why discovery runs against test
members and production replays never involve the model (see REPORT.md, Safety).
"""

from __future__ import annotations

import re
from collections.abc import Iterable
from typing import Any

SSN_RE = re.compile(r"\b\d{3}-\d{2}-(\d{4})\b")
CARD_RE = re.compile(r"\b(?:\d[ -]?){12,18}\d\b")
LONG_DIGITS_RE = re.compile(r"\b\d{9,17}\b")
EMAIL_RE = re.compile(r"\b[\w.+-]+@[A-Za-z][A-Za-z0-9-]*(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b")
PHONE_RE = re.compile(r"(?:\(\d{3}\)\s?|\b\d{3}[-.])\d{3}[-.]\d{4}\b")

# Sent to the browser to decide what to blank out before a screenshot.
SCREEN_PATTERNS = [SSN_RE.pattern, EMAIL_RE.pattern, PHONE_RE.pattern, LONG_DIGITS_RE.pattern]


def _luhn(digits: str) -> bool:
    total, parity = 0, len(digits) % 2
    for i, ch in enumerate(digits):
        d = int(ch)
        if i % 2 == parity:
            d = d * 2 - 9 if d > 4 else d * 2
        total += d
    return total % 10 == 0


class Redactor:
    def __init__(self, sensitive_labels: Iterable[str] = ()):
        self._known: dict[str, str] = {}
        self.sensitive_label_patterns = [re.compile(p, re.IGNORECASE) for p in sensitive_labels]

    # ------------------------------------------------------------------ registration

    def register(self, reference: str, value: str | None) -> None:
        """Replace every future occurrence of ``value`` with ``{{reference}}``."""
        if value is None:
            return
        value = str(value)
        if len(value.strip()) >= 3:
            self._known[value] = reference

    def known_values(self) -> list[str]:
        return list(self._known)

    def is_sensitive_label(self, label: str | None) -> bool:
        return bool(label) and any(p.search(label or "") for p in self.sensitive_label_patterns)

    # ------------------------------------------------------------------ redaction

    def text(self, value: str) -> str:
        if not value:
            return value
        for known, reference in sorted(self._known.items(), key=lambda kv: -len(kv[0])):
            if known.isalnum():
                value = re.sub(rf"(?<![A-Za-z0-9]){re.escape(known)}(?![A-Za-z0-9])", f"{{{{{reference}}}}}", value)
            else:
                value = value.replace(known, f"{{{{{reference}}}}}")
        value = SSN_RE.sub(lambda m: f"[SSN ***-**-{m.group(1)}]", value)
        value = CARD_RE.sub(self._card, value)
        value = LONG_DIGITS_RE.sub(lambda m: f"[ACCT ****{m.group(0)[-4:]}]", value)
        value = EMAIL_RE.sub("[EMAIL]", value)
        return PHONE_RE.sub("[PHONE]", value)

    def field(self, label: str | None, value: str) -> str:
        """Redact a value shown next to ``label``; sensitive labels hide the value entirely."""
        if self.is_sensitive_label(label):
            return f"[REDACTED {label}]" if value else value
        return self.text(value)

    def data(self, value: Any) -> Any:
        """Recursively redact every string in a JSON-like structure."""
        if isinstance(value, str):
            return self.text(value)
        if isinstance(value, dict):
            return {k: self.data(v) for k, v in value.items()}
        if isinstance(value, (list, tuple)):
            return [self.data(v) for v in value]
        return value

    @staticmethod
    def _card(match: re.Match[str]) -> str:
        digits = re.sub(r"\D", "", match.group(0))
        if 13 <= len(digits) <= 19 and _luhn(digits):
            return f"[CARD ****{digits[-4:]}]"
        return match.group(0)
