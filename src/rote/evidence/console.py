"""Human-friendly live rendering of run events in the terminal."""

from __future__ import annotations

from typing import Any

from rich.console import Console
from rich.markup import escape
from rich.panel import Panel

console = Console(highlight=False)


def _s(value: Any) -> str:
    return escape(str(value))


class ConsoleReporter:
    """Maps structured events to one readable line each. The JSONL log stays the source of truth."""

    def __init__(self, verbose: bool = False):
        self.verbose = verbose

    def __call__(self, e: dict[str, Any]) -> None:
        t = e["type"]
        if t == "run.started":
            console.rule(f"[bold]{_s(e.get('kind', ''))}[/] · {_s(e.get('subject', ''))}")
            console.print(f"[dim]run {_s(e.get('run_id'))} · evidence → {_s(e.get('evidence_dir'))}[/]")
            for layer in e.get("layers", []) or []:
                console.print(f"[dim]  layer: {_s(layer)}[/]")
        elif t == "session.establishing":
            console.print(f"[cyan]⇢ establishing session via {_s(e['capability'])}[/]")
        elif t == "step.started":
            indent = "  " if e.get("nested") else ""
            console.print(f"{indent}[bold]▶ {_s(e['step'])}[/] {_s(e.get('intent', ''))}")
        elif t == "step.completed":
            indent = "  " if e.get("nested") else ""
            via = f" via [italic]{_s(e['locator'])}[/]" if e.get("locator") else ""
            console.print(f"{indent}  [green]✓[/] [dim]{e.get('duration_ms', 0)} ms{via}[/]")
        elif t == "output.extracted":
            console.print(f"  [green]⇐ {_s(e['output'])}[/] = {_s(e.get('value'))}")
        elif t == "locator.warning":
            console.print(f"  [yellow]⚠ {_s(e['code'])}[/] {_s(e['message'])}")
        elif t == "handler.fired":
            color = {"business_outcome": "magenta", "recoverable": "cyan", "failure": "red"}.get(e["kind"], "white")
            console.print(
                f"  [{color}]↯ {_s(e['handler'])}[/] ({_s(e['kind'])}, {_s(e['source'])}) {_s(e.get('description', ''))}"
            )
        elif t == "recovery.performed":
            console.print(f"  [cyan]↻ recovered[/] {_s(e['handler'])}: {_s(e['action'])} (attempt {e['attempt']})")
        elif t == "policy.decision" and e.get("verdict") != "allow":
            console.print(f"  [red]⛔ policy {_s(e['verdict'])}[/]: {_s(e['reason'])}")
        elif t == "policy.network_blocked":
            console.print(f"  [red]⛔ blocked request[/] {_s(e['url'])}")
        elif t == "agent.turn":
            if e.get("reasoning"):
                console.print(f"[dim italic]  thinking: {_s(str(e['reasoning'])[:300])}[/]")
        elif t == "agent.action":
            console.print(f"[bold blue]🤖 {_s(e['tool'])}[/] {_s(e.get('summary', ''))}")
            if e.get("rationale"):
                console.print(f"[blue]   why: {_s(e['rationale'])}[/]")
        elif t == "agent.action_result":
            mark = "[green]ok[/]" if e.get("ok") else "[red]error[/]"
            console.print(f"   → {mark} {_s(e.get('message', ''))[:200]}")
        elif t == "intervention.raised":
            console.print(
                Panel(
                    f"[bold]{_s(e['reason_code'])}[/]: {_s(e['reason'])}\n"
                    f"step: {_s(e.get('step'))}   allowed: {', '.join(e.get('allowed_resolutions', []))}",
                    title=f"🙋 human intervention {_s(e['id'])}",
                    border_style="yellow",
                )
            )
        elif t == "intervention.claimed":
            console.print(f"[yellow]🧑 {_s(e['operator'])} took control (lease epoch {e['epoch']})[/]")
        elif t == "human.action":
            console.print(f"[yellow]   🧑 {_s(e.get('description', ''))}[/]")
        elif t == "intervention.resolved":
            console.print(f"[yellow]🔁 control handed back: {_s(e['resolution'])} — {_s(e.get('note', ''))}[/]")
        elif t == "intervention.expired":
            console.print("[red]⌛ no operator responded; automation reclaimed the session[/]")
        elif t == "control.unsolicited_input":
            console.print(f"[red]⚠ input detected while {_s(e['lease'])} — ignored and logged[/]")
        elif t in ("run.finished", "discovery.finished"):
            status = e.get("status", "")
            color = {"succeeded": "green", "business_outcome": "magenta", "failed": "red"}.get(status, "white")
            console.rule(f"[bold {color}]{_s(status)}[/]")
        elif self.verbose:
            console.print(f"[dim]{_s(t)} {_s({k: v for k, v in e.items() if k not in ('seq', 'ts', 'type')})}[/]")
