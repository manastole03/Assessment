"""`mockbank` — run the LegacyCore mock and inject faults into it."""

from __future__ import annotations

import json
from typing import Annotated

import httpx
import typer
import uvicorn

from .faults import Faults

app = typer.Typer(add_completion=False, no_args_is_help=True, help="LegacyCore mock target application.")

DEFAULT_URL = "http://127.0.0.1:8600"


@app.command()
def serve(
    host: str = "127.0.0.1",
    port: Annotated[int, typer.Option(help="Port to listen on.")] = 8600,
) -> None:
    """Serve both tenants: /acme/ (reference) and /bayview/ (variant)."""
    typer.echo(f"LegacyCore mock on http://{host}:{port}/  (tenants: /acme/, /bayview/)")
    uvicorn.run("mockbank.app:app", host=host, port=port, log_level="warning")


@app.command()
def fault(
    tenant: Annotated[str, typer.Argument(help="acme | bayview")],
    settings: Annotated[list[str] | None, typer.Argument(help="name=value pairs, e.g. maintenance_notice=true")] = None,
    clear: Annotated[bool, typer.Option("--clear", help="Reset all faults for the tenant.")] = False,
    url: str = DEFAULT_URL,
) -> None:
    """Inject (or clear) runtime faults. Run with no settings to show the current state."""
    if clear:
        response = httpx.delete(f"{url}/__admin/faults/{tenant}")
    elif settings:
        update: dict[str, object] = {}
        for pair in settings:
            name, _, raw = pair.partition("=")
            if name not in Faults.model_fields:
                raise typer.BadParameter(f"unknown fault {name!r}; known: {', '.join(Faults.model_fields)}")
            update[name] = json.loads(raw) if raw else True
        response = httpx.put(f"{url}/__admin/faults/{tenant}", json=update)
    else:
        response = httpx.get(f"{url}/__admin/faults/{tenant}")
    response.raise_for_status()
    typer.echo(json.dumps(response.json(), indent=2))


@app.command()
def ledger(tenant: str, url: str = DEFAULT_URL) -> None:
    """Show irreversible postings (should stay empty unless a human approved one)."""
    response = httpx.get(f"{url}/__admin/ledger/{tenant}")
    response.raise_for_status()
    typer.echo(json.dumps(response.json(), indent=2))


@app.command()
def reset(url: str = DEFAULT_URL) -> None:
    """Drop all sessions, faults and ledger entries."""
    httpx.post(f"{url}/__admin/reset").raise_for_status()
    typer.echo("reset")
