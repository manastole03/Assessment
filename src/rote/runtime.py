"""Assembles one live session: policy, redaction, evidence, control lease, browser, operator console.

Discovery and replay both run inside a ``LiveSession``; the only difference is who decides the next
action (the model, or the artifact).
"""

from __future__ import annotations

import os
from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from dotenv import load_dotenv
from playwright.async_api import async_playwright
from rich.console import Console

from .artifact.schema import AppProfile, Tenant, TenantApp
from .artifact.store import Library
from .evidence.console import ConsoleReporter
from .evidence.runlog import RunLog
from .handoff.console import ConsoleServer, build_console
from .handoff.control import SessionControl
from .handoff.interventions import HumanAction, Intervention, InterventionBroker, Notifier, WebhookNotifier
from .policy.policy import Policy, PolicyEngine
from .policy.redaction import Redactor
from .surface.base import ElementInfo
from .surface.web import WebSurface

_console = Console(highlight=False)


@dataclass(frozen=True)
class Settings:
    root: Path
    runs_dir: Path
    policy_path: Path
    model: str
    effort: str
    console_host: str
    console_port: int
    webhook_url: str | None
    fallbacks: bool

    @classmethod
    def load(cls, root: Path | None = None) -> Settings:
        root = (root or Path(os.environ.get("ROTE_HOME", Path.cwd()))).resolve()
        load_dotenv(root / ".env", override=False)
        return cls(
            root=root,
            runs_dir=Path(os.environ.get("ROTE_RUNS_DIR", root / "runs")),
            policy_path=Path(os.environ.get("ROTE_POLICY", root / "config" / "policy.yaml")),
            model=os.environ.get("ROTE_MODEL", "claude-opus-5-5"),
            effort=os.environ.get("ROTE_EFFORT", "high"),
            console_host=os.environ.get("ROTE_CONSOLE_HOST", "127.0.0.1"),
            console_port=int(os.environ.get("ROTE_CONSOLE_PORT", "8765")),
            webhook_url=os.environ.get("ROTE_WEBHOOK_URL") or None,
            fallbacks=os.environ.get("ROTE_FALLBACKS", "1") != "0",
        )


class TerminalNotifier:
    """Routes an intervention to whoever is watching the terminal."""

    async def notify(self, intervention: Intervention, console_url: str | None) -> None:
        print("\a", end="", flush=True)
        where = f"open [bold]{console_url}[/]" if console_url else "no console running"
        _console.print(f"[yellow]   → {where}  ·  or: [bold]rote operator claim {intervention.id}[/][/]")


@dataclass
class LiveSession:
    settings: Settings
    library: Library
    policy: PolicyEngine
    redactor: Redactor
    log: RunLog
    control: SessionControl
    broker: InterventionBroker
    surface: WebSurface
    tenant: Tenant
    app: AppProfile
    binding: TenantApp
    subject: str
    console_url: str | None


def human_action(payload: dict[str, Any], frame: str | None, redactor: Redactor) -> HumanAction:
    """Turn a DOM event captured while a human held the lease into an audit record."""
    element = payload.get("element") or {}
    info = ElementInfo.from_js({**element, "ref": None}, frame, (0, 0))
    kind = payload.get("kind", "event")
    value = payload.get("value")
    if payload.get("secret"):
        value = "[secret]"
    elif value is not None:
        value = redactor.field(info.label, str(value))
    verb = {"click": "clicked", "change": "set", "enter": "pressed Enter in"}.get(kind, kind)
    description = f"{verb} {info.describe()}"
    if kind == "change" and value is not None:
        description += f" to {value!r}"
    return HumanAction(
        at=datetime.now(UTC),
        kind=kind,
        description=redactor.text(description),
        frame=frame,
        value=value,
        locators=redactor.data(payload.get("locators") or []),
        element=redactor.data({k: element.get(k) for k in ("role", "name", "label", "tag", "attrs")}),
        url=redactor.text(payload.get("url") or ""),
    )


@asynccontextmanager
async def open_session(
    settings: Settings,
    *,
    kind: str,
    subject: str,
    label: str,
    tenant_id: str,
    app_id: str,
    headless: bool = True,
    console: bool = True,
    verbose: bool = False,
    on_event: Callable[[dict[str, Any]], object] | None = None,
    quiet: bool = False,
) -> AsyncIterator[LiveSession]:
    library = Library(settings.root)
    policy = PolicyEngine(Policy.load(settings.policy_path))
    tenant = library.tenant(tenant_id)
    app = library.app(app_id)
    binding = tenant.apps.get(app_id)
    if binding is None:
        raise ValueError(f"tenant {tenant_id} has no binding for app {app_id}")
    if not policy.url_allowed(binding.base_url):
        raise PermissionError(f"{binding.base_url} is outside the policy allowlist ({settings.policy_path})")

    redactor = Redactor(policy.policy.sensitive_labels)
    reporter = None if quiet else ConsoleReporter(verbose)

    def echo(event: dict[str, Any]) -> None:
        if reporter is not None:
            reporter(event)
        if on_event is not None:
            on_event(event)

    log = RunLog(settings.runs_dir, kind=kind, label=label, redactor=redactor, echo=echo)
    control = SessionControl(log.run_id, on_change=lambda change: log.event("control.changed", **change))
    console_url = f"http://{settings.console_host}:{settings.console_port}" if console else None
    notifiers: list[Notifier] = [TerminalNotifier()]
    if settings.webhook_url:
        notifiers.append(WebhookNotifier(settings.webhook_url))
    broker = InterventionBroker(
        control,
        record_dir=log.dir / "interventions",
        notifiers=notifiers,
        console_url=console_url,
        on_event=lambda t, d: log.event(t, **d),
    )

    async with async_playwright() as playwright:
        surface = await WebSurface.launch(
            playwright,
            headless=headless,
            base_url=binding.base_url,
            control=control,
            policy=policy,
            redactor=redactor,
            volatile_params=app.volatile_query_params,
            on_event=lambda t, d: log.event(t, **d),
        )
        surface.human_listener = lambda payload, frame: broker.record_action(human_action(payload, frame, redactor))
        session = LiveSession(
            settings=settings,
            library=library,
            policy=policy,
            redactor=redactor,
            log=log,
            control=control,
            broker=broker,
            surface=surface,
            tenant=tenant,
            app=app,
            binding=binding,
            subject=subject,
            console_url=console_url,
        )
        server = None
        if console:
            server = ConsoleServer(build_console(session), settings.console_host, settings.console_port)
            await server.start()
            log.event("console.started", url=console_url)
        try:
            yield session
        finally:
            if server is not None:
                await server.stop()
            await surface.close()
            log.close()
