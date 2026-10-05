"""Background runs for the web UI: start replays, discoveries and probes, and stream their events.

Each run executes inside its own ``LiveSession`` on the UI server's event loop, so the operator
endpoints can reach the *same* live browser session when a run escalates. Events are the already-
redacted records the ``RunLog`` writes, so nothing streamed to the browser is more sensitive than
what is persisted as evidence.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import os
from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Literal
from urllib.parse import urlsplit

import httpx
from pydantic import BaseModel, Field

from ..artifact.resolve import resolve
from ..artifact.store import Library
from ..replay.engine import ReplayEngine, ReplayOptions
from ..runtime import LiveSession, Settings, open_session

RunKind = Literal["replay", "discovery", "probe"]


class StartRun(BaseModel):
    kind: RunKind
    tenant: str = "acme"
    app: str = "legacycore"
    capability: str | None = Field(None, description="Capability id or id@version (replay, probe).")
    inputs: dict[str, str] = Field(default_factory=dict)
    escalation: Literal["fail", "wait"] = "wait"
    allow_draft: bool = False
    faults: dict[str, Any] | None = Field(
        None, description="Demo only: faults injected into the mock target app first."
    )
    headed: bool = False
    goal: str | None = None
    discovery_kind: Literal["task", "session"] = "task"
    capability_id: str | None = None
    model: str | None = None
    effort: str | None = None
    max_turns: int = Field(30, ge=3, le=80)


@dataclass
class ActiveRun:
    kind: RunKind
    tenant: str
    subject: str
    started_at: datetime = field(default_factory=lambda: datetime.now(UTC))
    id: str | None = None
    dir: Path | None = None
    status: str = "running"
    error: str | None = None
    caller: dict[str, Any] | None = None
    events: list[dict[str, Any]] = field(default_factory=list)
    subscribers: set[asyncio.Queue[dict[str, Any] | None]] = field(default_factory=set)
    session: LiveSession | None = None
    ready: asyncio.Event = field(default_factory=asyncio.Event)
    finished: asyncio.Event = field(default_factory=asyncio.Event)
    task: asyncio.Task[None] | None = None

    def push(self, event: dict[str, Any]) -> None:
        self.events.append(event)
        for queue in self.subscribers:
            queue.put_nowait(event)

    def close_streams(self) -> None:
        for queue in self.subscribers:
            queue.put_nowait(None)


class RunManager:
    def __init__(self, settings: Settings, public_url: str):
        self.settings = settings
        self.public_url = public_url.rstrip("/")
        self.active: dict[str, ActiveRun] = {}

    # ------------------------------------------------------------------ lifecycle

    async def start(self, request: StartRun) -> ActiveRun:
        subject = request.goal or request.capability or request.kind
        run = ActiveRun(kind=request.kind, tenant=request.tenant, subject=subject)
        run.task = asyncio.create_task(self._execute(run, request))
        await run.ready.wait()
        if run.id is None:
            raise ValueError(run.error or "the run could not be started")
        return run

    async def _execute(self, run: ActiveRun, request: StartRun) -> None:
        try:
            library = Library(self.settings.root)
            needs_model = request.kind in ("discovery", "probe")
            if needs_model and not os.environ.get("ANTHROPIC_API_KEY"):
                raise ValueError("ANTHROPIC_API_KEY is not set; add it to .env and restart `rote ui`")
            if request.kind == "discovery":
                if not request.goal:
                    raise ValueError("a goal is required for discovery")
                app_id, label = request.app, request.capability_id or f"{request.tenant}-{request.discovery_kind}"
                capability = None
            else:
                if not request.capability:
                    raise ValueError("choose a capability")
                capability = library.capability(request.capability)
                app_id, label = capability.app.id, f"{capability.id}-{request.tenant}"
                run.subject = capability.ref
            if request.faults is not None:
                await self.set_faults(request.tenant, request.faults)

            async with open_session(
                self.settings,
                kind=request.kind,
                subject=run.subject,
                label=label,
                tenant_id=request.tenant,
                app_id=app_id,
                headless=not request.headed,
                console=False,
                quiet=True,
                on_event=run.push,
            ) as session:
                run.session, run.id, run.dir = session, session.log.run_id, session.log.dir
                session.broker.console_url = f"{self.public_url}/runs/{run.id}"
                self.active[run.id] = run
                run.ready.set()
                if request.kind == "replay":
                    assert capability is not None
                    engine = ReplayEngine(
                        surface=session.surface,
                        library=library,
                        policy=session.policy,
                        redactor=session.redactor,
                        log=session.log,
                        broker=session.broker,
                        options=ReplayOptions(
                            escalation=request.escalation, escalation_timeout_s=1800, allow_draft=request.allow_draft
                        ),
                    )
                    result = await engine.run(resolve(capability, session.app, session.tenant), request.inputs)
                    run.caller, run.status = result.for_caller(), result.status.value
                elif request.kind == "probe":
                    from ..discovery.probe import claude_classifier, probe

                    assert capability is not None
                    outcome = await probe(
                        session,
                        resolve(capability, session.app, session.tenant),
                        request.inputs,
                        classifier=claude_classifier(request.model or self.settings.model, self.settings.effort),
                        save=True,
                    )
                    run.status = "succeeded" if outcome.capability else "failed"
                    run.caller = {
                        "proposed": outcome.capability.ref if outcome.capability else None,
                        "note": outcome.note,
                        "replay": outcome.replay.for_caller(),
                    }
                else:
                    from ..discovery.agent import DiscoveryAgent, DiscoveryRequest
                    from ..discovery.decider import ClaudeDecider

                    decider = ClaudeDecider(
                        model=request.model or self.settings.model,
                        effort=request.effort or self.settings.effort,
                        redactor=session.redactor,
                        fallbacks=self.settings.fallbacks,
                    )
                    discovery = await DiscoveryAgent(
                        session,
                        decider,
                        DiscoveryRequest(
                            goal=request.goal or "",
                            inputs=request.inputs,
                            kind=request.discovery_kind,
                            capability_id=request.capability_id,
                            max_turns=request.max_turns,
                        ),
                    ).run()
                    run.status = discovery.status
                    run.caller = {
                        "capability": discovery.capability,
                        "failure": discovery.failure,
                        "outcome": discovery.outcome,
                        "estimated_cost_usd": discovery.estimated_cost_usd,
                    }
        except Exception as exc:  # surfaced to the UI as a run error, never swallowed silently
            run.status, run.error = "error", f"{type(exc).__name__}: {exc}"
            run.push(
                {
                    "seq": len(run.events) + 1,
                    "type": "run.error",
                    "message": run.error,
                    "ts": datetime.now(UTC).isoformat(),
                    "t_ms": 0,
                }
            )
        finally:
            run.session = None
            run.ready.set()
            run.finished.set()
            run.close_streams()

    async def stream(self, run: ActiveRun) -> AsyncIterator[dict[str, Any] | None]:
        """Replay buffered events, then follow live ones; yields None when the run ends."""
        queue: asyncio.Queue[dict[str, Any] | None] = asyncio.Queue()
        run.subscribers.add(queue)
        try:
            snapshot = list(run.events)
            last = snapshot[-1]["seq"] if snapshot else 0
            for event in snapshot:
                yield event
            if run.finished.is_set():
                yield None
                return
            while True:
                live = await queue.get()
                if live is None:
                    yield None
                    return
                if live.get("seq", 0) > last:
                    yield live
        finally:
            run.subscribers.discard(queue)

    # ------------------------------------------------------------------ demo controls

    def bank_admin(self, tenant: str) -> str:
        binding = Library(self.settings.root).tenant(tenant).apps["legacycore"]
        parts = urlsplit(binding.base_url)
        return f"{parts.scheme}://{parts.netloc}/__admin/faults/{tenant}"

    async def set_faults(self, tenant: str, faults: dict[str, Any]) -> dict[str, Any]:
        async with httpx.AsyncClient(timeout=5) as client:
            await client.delete(self.bank_admin(tenant))
            response = (
                await client.put(self.bank_admin(tenant), json=faults)
                if faults
                else await client.get(self.bank_admin(tenant))
            )
            response.raise_for_status()
            return dict(response.json())

    async def get_faults(self, tenant: str) -> dict[str, Any]:
        async with httpx.AsyncClient(timeout=5) as client:
            response = await client.get(self.bank_admin(tenant))
            response.raise_for_status()
            return dict(response.json())

    async def shutdown(self) -> None:
        for run in list(self.active.values()):
            if run.task is not None and not run.task.done():
                run.task.cancel()
                with contextlib.suppress(asyncio.CancelledError, Exception):
                    await run.task


# ============================================================================================ on-disk runs


def read_events(run_dir: Path) -> list[dict[str, Any]]:
    path = run_dir / "events.jsonl"
    if not path.exists():
        return []
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]


def summarize_dir(run_dir: Path, source: str) -> dict[str, Any] | None:
    events_path = run_dir / "events.jsonl"
    if not events_path.exists():
        return None
    started: dict[str, Any] = {}
    first_ts = None
    with events_path.open() as fh:
        for index, line in enumerate(fh):
            event = json.loads(line)
            first_ts = first_ts or event.get("ts")
            if event.get("type") == "run.started":
                started = event
                break
            if index > 40:
                break
    result_path = run_dir / "result.json"
    result = json.loads(result_path.read_text()) if result_path.exists() else {}
    run_id = str(started.get("run_id") or run_dir.name)
    parts = run_id.split("-")
    kind = parts[1] if len(parts) > 2 and parts[0].endswith("Z") else str(started.get("kind", "replay"))
    if "probe" in run_dir.name:
        kind = "probe"
    return {
        "id": run_dir.name,
        "source": source,
        "kind": kind,
        "subject": started.get("subject", run_dir.name),
        "tenant": started.get("tenant") or result.get("tenant"),
        "status": result.get("status", "interrupted"),
        "started_at": first_ts,
        "duration_ms": result.get("duration_ms"),
        "active": False,
    }
