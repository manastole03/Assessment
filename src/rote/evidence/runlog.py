"""Per-run evidence: a structured event log plus screenshots and DOM snapshots.

Everything written here passes through the ``Redactor`` first — evidence is persisted, and
persisted data must never contain secrets or raw PII. Layout of a run directory::

    runs/<run-id>/
      events.jsonl          one JSON object per event (what happened, and why)
      screens/NNNN-*.jpg    masked screenshots          screens/NNNN-*.txt  redacted observations
      dom/NNNN-*/…html      redacted per-frame DOM (captured on failure / escalation)
      interventions/*.json  escalation requests with the operator's recorded actions
      result.json | artifact.yaml | report.html
"""

from __future__ import annotations

import json
import re
import time
import uuid
from collections.abc import Callable
from datetime import UTC, datetime
from pathlib import Path
from typing import TYPE_CHECKING, Any

from ..policy.redaction import Redactor

if TYPE_CHECKING:
    from ..surface.base import Observation
    from ..surface.web import WebSurface


def _slug(text: str, limit: int = 40) -> str:
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")[:limit] or "run"


class RunLog:
    def __init__(
        self,
        root: Path,
        *,
        kind: str,
        label: str,
        redactor: Redactor,
        echo: Callable[[dict[str, Any]], None] | None = None,
    ):
        # The id ends up in artifacts and file names, so it is built from a non-sensitive label
        # (capability id or run kind) — never from the goal text, which can contain input values.
        stamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
        self.run_id = f"{stamp}-{kind}-{_slug(label)}-{uuid.uuid4().hex[:4]}"
        self.kind = kind
        self.dir = root / self.run_id
        (self.dir / "screens").mkdir(parents=True, exist_ok=True)
        self.redactor = redactor
        self.echo = echo
        self._events = (self.dir / "events.jsonl").open("a", encoding="utf-8")
        self._seq = 0
        self._t0 = time.monotonic()

    @property
    def display_dir(self) -> str:
        """Run directory relative to the working directory when possible (no absolute paths in evidence)."""
        try:
            return str(self.dir.resolve().relative_to(Path.cwd().resolve()))
        except ValueError:
            return str(self.dir)

    def event(self, event_type: str, /, **data: Any) -> dict[str, Any]:
        self._seq += 1
        record = {
            "seq": self._seq,
            "ts": datetime.now(UTC).isoformat(timespec="milliseconds"),
            "t_ms": int((time.monotonic() - self._t0) * 1000),
            **self.redactor.data(data),
            "type": event_type,
        }
        self._events.write(json.dumps(record, default=str) + "\n")
        self._events.flush()
        if self.echo:
            self.echo(record)
        return record

    async def capture(
        self,
        surface: WebSurface,
        label: str,
        *,
        dom: bool = False,
        observation: Observation | None = None,
    ) -> dict[str, str]:
        """Save a masked screenshot, the redacted observation and (optionally) the DOM."""
        name = f"{self._seq + 1:04d}-{_slug(label)}"
        paths: dict[str, str] = {}
        try:
            shot = observation.screenshot if observation and observation.screenshot else await surface.screenshot()
            if shot:
                (self.dir / "screens" / f"{name}.jpg").write_bytes(shot)
                paths["screenshot"] = f"screens/{name}.jpg"
            obs = observation or await surface.observe(screenshot=False)
            (self.dir / "screens" / f"{name}.txt").write_text(obs.render(self.redactor))
            paths["observation"] = f"screens/{name}.txt"
            if dom:
                target = self.dir / "dom" / name
                target.mkdir(parents=True, exist_ok=True)
                for frame, html in (await surface.dom_snapshot()).items():
                    (target / f"{frame}.html").write_text(html)
                paths["dom"] = f"dom/{name}/"
        except Exception as exc:  # evidence capture must never mask the real outcome
            paths["capture_error"] = f"{type(exc).__name__}: {exc}"
        self.event("evidence.captured", label=label, **paths)
        return paths

    def _final_redaction_pass(self) -> None:
        """Re-redact every text artifact with everything the redactor learned during the run.

        Some sensitive values (e.g. a pii output) are only identified after they were first shown; this
        pass makes sure nothing captured before that moment is persisted in the clear."""
        for path in self.dir.rglob("*"):
            if path.is_file() and path.suffix in (".jsonl", ".json", ".txt", ".html", ".yaml"):
                text = path.read_text(errors="ignore")
                redacted = self.redactor.text(text)
                if redacted != text:
                    path.write_text(redacted)

    def write_json(self, name: str, data: Any) -> Path:
        path = self.dir / name
        path.write_text(json.dumps(self.redactor.data(data), indent=2, default=str) + "\n")
        return path

    def write_text(self, name: str, text: str) -> Path:
        path = self.dir / name
        path.write_text(text)
        return path

    def close(self) -> None:
        if not self._events.closed:
            self._events.close()
        self._final_redaction_pass()
        from .report import write_report

        try:
            write_report(self.dir)
        except Exception as exc:
            (self.dir / "report-error.txt").write_text(f"{type(exc).__name__}: {exc}")
