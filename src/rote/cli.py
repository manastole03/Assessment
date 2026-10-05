"""`rote` — discover, review, replay and operate computer-use capabilities."""

from __future__ import annotations

import asyncio
import json
import os
import sys
from datetime import UTC, datetime
from pathlib import Path
from typing import Annotated, Any

import httpx
import typer
import yaml
from rich.console import Console
from rich.table import Table

from .artifact.resolve import resolve
from .artifact.schema import Capability, ExtractAction, NavigateAction, Review
from .artifact.store import Library, export_json_schemas, to_yaml
from .catalog import catalog as build_catalog
from .policy.policy import Policy
from .policy.redaction import Redactor
from .runtime import Settings, open_session

app = typer.Typer(
    add_completion=False,
    no_args_is_help=True,
    rich_markup_mode="rich",
    help="Record-once, replay-many computer use for legacy back-office apps.",
)
operator_app = typer.Typer(no_args_is_help=True, help="Act as the human operator for a live intervention.")
app.add_typer(operator_app, name="operator")
eval_app = typer.Typer(
    no_args_is_help=True,
    help="Measure the replay engine, probe classification and the discovery agent against versioned datasets.",
)
app.add_typer(eval_app, name="eval")
console = Console(highlight=False)

InputOpt = Annotated[list[str] | None, typer.Option("--input", "-i", help="name=value (repeatable).")]


def _inputs(pairs: list[str] | None) -> dict[str, str]:
    values: dict[str, str] = {}
    for pair in pairs or []:
        name, sep, value = pair.partition("=")
        if not sep:
            raise typer.BadParameter(f"expected name=value, got {pair!r}")
        values[name.strip()] = value
    return values


def _settings() -> Settings:
    return Settings.load()


# ============================================================================================ discover


@app.command()
def discover(
    goal: Annotated[str, typer.Argument(help="What to accomplish, in plain language.")],
    tenant: Annotated[str, typer.Option(help="Tenant (institution) to run against.")] = "acme",
    app_id: Annotated[str, typer.Option("--app", help="Application profile.")] = "legacycore",
    inputs: InputOpt = None,
    kind: Annotated[str, typer.Option(help="'task', or 'session' to record the sign-on capability.")] = "task",
    capability_id: Annotated[str | None, typer.Option("--id", help="Force the capability id.")] = None,
    headed: Annotated[bool, typer.Option(help="Show the browser window.")] = False,
    max_turns: Annotated[int, typer.Option(help="Stop after this many model turns.")] = 30,
    model: Annotated[str | None, typer.Option(help="Model id (default: ROTE_MODEL or claude-opus-5-5).")] = None,
    effort: Annotated[str | None, typer.Option(help="low | medium | high | xhigh | max.")] = None,
    save: Annotated[bool, typer.Option(help="Save the artifact into the capability library.")] = True,
    no_console: Annotated[bool, typer.Option("--no-console", help="Don't start the operator console.")] = False,
) -> None:
    """Let the LLM accomplish GOAL on the live app and record the run as a draft capability."""
    from .discovery.agent import DiscoveryAgent, DiscoveryRequest
    from .discovery.decider import ClaudeDecider

    settings = _settings()
    if kind not in ("task", "session"):
        raise typer.BadParameter("--kind must be task or session")

    async def run() -> int:
        async with open_session(
            settings,
            kind="discovery",
            subject=goal,
            label=capability_id or f"{tenant}-{kind}",
            tenant_id=tenant,
            app_id=app_id,
            headless=not headed,
            console=not no_console,
        ) as session:
            decider = ClaudeDecider(
                model=model or settings.model,
                effort=effort or settings.effort,
                redactor=session.redactor,
                fallbacks=settings.fallbacks,
            )
            request = DiscoveryRequest(
                goal=goal,
                inputs=_inputs(inputs),
                kind=kind,  # type: ignore[arg-type]
                capability_id=capability_id,
                max_turns=max_turns,
                save=save,
            )
            result = await DiscoveryAgent(session, decider, request).run()
        console.print_json(result.model_dump_json())
        if result.status == "succeeded":
            console.print(f"\n[green]Recorded[/] [bold]{result.capability}[/] → {result.artifact_path}")
            console.print(
                f"Review it with [bold]rote show {result.capability}[/], then "
                f"[bold]rote approve {result.capability} --reviewer <you>[/]"
            )
        console.print(f"Evidence: {result.evidence_dir}/report.html")
        return {"succeeded": 0, "business_outcome": 2}.get(result.status, 1)

    raise typer.Exit(asyncio.run(run()))


# ============================================================================================ replay


@app.command()
def replay(
    capability: Annotated[str, typer.Argument(help="Capability id, optionally id@version.")],
    tenant: Annotated[str, typer.Option(help="Tenant (institution) to run against.")] = "acme",
    inputs: InputOpt = None,
    escalation: Annotated[str, typer.Option(help="'fail' fast, or 'wait' for an operator on unknown states.")] = "fail",
    escalation_timeout: Annotated[float, typer.Option(help="Seconds to wait for an operator.")] = 600,
    allow_draft: Annotated[bool, typer.Option(help="Run a capability that is not approved yet.")] = False,
    headed: Annotated[bool, typer.Option(help="Show the browser window.")] = False,
    as_json: Annotated[bool, typer.Option("--json", help="Print only the caller-facing JSON result.")] = False,
    quiet: Annotated[bool, typer.Option(help="No live event output.")] = False,
) -> None:
    """Execute a capability deterministically — no model in the loop."""
    from .replay.engine import ReplayEngine, ReplayOptions

    if escalation not in ("fail", "wait"):
        raise typer.BadParameter("--escalation must be fail or wait")
    settings = _settings()
    library = Library(settings.root)
    cap = library.capability(capability)

    async def run() -> int:
        async with open_session(
            settings,
            kind="replay",
            subject=cap.ref,
            label=f"{cap.id}-{tenant}",
            tenant_id=tenant,
            app_id=cap.app.id,
            headless=not headed,
            console=escalation == "wait",
        ) as session:
            if quiet or as_json:
                session.log.echo = None
            rc = resolve(cap, session.app, session.tenant)
            engine = ReplayEngine(
                surface=session.surface,
                library=library,
                policy=session.policy,
                redactor=session.redactor,
                log=session.log,
                broker=session.broker,
                options=ReplayOptions(
                    escalation="wait" if escalation == "wait" else "fail",
                    escalation_timeout_s=escalation_timeout,
                    allow_draft=allow_draft,
                ),
            )
            result = await engine.run(rc, _inputs(inputs))
        if as_json:
            print(json.dumps(result.for_caller(), indent=2))
        else:
            _print_result(result)
        return {"succeeded": 0, "business_outcome": 2}.get(result.status.value, 1)

    raise typer.Exit(asyncio.run(run()))


def _print_result(result: Any) -> None:
    payload = result.for_caller()
    console.print_json(json.dumps(payload))
    if result.recoveries:
        console.print("[cyan]recoveries:[/] " + "; ".join(f"{r.handler} ({r.action})" for r in result.recoveries))
    if result.warnings:
        for warning in result.warnings:
            console.print(f"[yellow]warning {warning.code}[/] {warning.step_id or ''}: {warning.message}")
    if result.failure:
        f = result.failure
        console.print(f"[red]failed at[/] {f.capability} step {f.step_id}: {f.step_intent}")
        console.print(f"  [bold]expected:[/] {f.expected}\n  [bold]observed:[/] {f.observed}")
    console.print(f"Evidence: {result.evidence_dir}/report.html")


@app.command()
def probe(
    capability: Annotated[str, typer.Argument(help="Capability id, optionally id@version.")],
    tenant: Annotated[str, typer.Option(help="Tenant (institution) to run against.")] = "acme",
    inputs: InputOpt = None,
    model: Annotated[str | None, typer.Option(help="Model id for the one classification call.")] = None,
    save: Annotated[bool, typer.Option(help="Save the result as a new draft patch version.")] = True,
    headed: Annotated[bool, typer.Option(help="Show the browser window.")] = False,
) -> None:
    """Replay with an off-happy-path input; if it stops on an unknown screen, have the model classify it
    once and propose a verified handler (saved as a new draft version for review)."""
    from .discovery.probe import claude_classifier
    from .discovery.probe import probe as run_probe

    settings = _settings()
    library = Library(settings.root)
    cap = library.capability(capability)

    async def run() -> int:
        async with open_session(
            settings,
            kind="probe",
            subject=cap.ref,
            label=f"{cap.id}-{tenant}",
            tenant_id=tenant,
            app_id=cap.app.id,
            headless=not headed,
            console=False,
        ) as session:
            classifier = claude_classifier(model or settings.model, settings.effort)
            outcome = await run_probe(
                session, resolve(cap, session.app, session.tenant), _inputs(inputs), classifier=classifier, save=save
            )
        if outcome.handler is not None:
            console.rule("proposed handler")
            print(to_yaml(outcome.handler))
        if outcome.classification is not None:
            console.print(f"[dim]model rationale: {outcome.classification.rationale}[/]")
        if outcome.capability is not None:
            console.print(
                f"[green]saved[/] {outcome.capability.ref} (draft) → {outcome.path}\n"
                f"Review with `rote show {outcome.capability.ref}`, then approve it."
            )
        else:
            console.print(f"[yellow]{outcome.note}[/]")
        console.print(f"Evidence: {outcome.replay.evidence_dir}/report.html")
        return 0 if outcome.capability is not None else 1

    raise typer.Exit(asyncio.run(run()))


# ============================================================================================ library


@app.command("list")
def list_capabilities() -> None:
    """List the capability library."""
    library = Library(_settings().root)
    table = Table("capability", "status", "kind", "side effects", "inputs → outputs", "business outcomes")
    for cap in library.capabilities():
        table.add_row(
            cap.ref,
            cap.status,
            cap.kind,
            cap.side_effects,
            f"{', '.join(cap.inputs) or '-'} → {', '.join(cap.outputs) or '-'}",
            ", ".join(cap.outcome_codes()) or "-",
        )
    console.print(table)


@app.command()
def show(
    capability: Annotated[str, typer.Argument(help="Capability id, optionally id@version.")],
    tenant: Annotated[str | None, typer.Option(help="Show the effective artifact for this tenant.")] = None,
    raw: Annotated[bool, typer.Option(help="Print the YAML instead of the review sheet.")] = False,
) -> None:
    """Review sheet: what the capability does, needs, returns, and how each control is found."""
    from .replay.engine import describe_condition

    library = Library(_settings().root)
    cap = library.capability(capability)
    layers: list[str] = []
    handlers = [("capability", h) for h in cap.handlers]
    if tenant:
        app_profile = library.app(cap.app.id)
        rc = resolve(cap, app_profile, library.tenant(tenant))
        cap, layers = rc.capability, rc.layers
        handlers = [(b.source, b.handler) for b in rc.handlers]
    if raw:
        print(to_yaml(cap))
        return
    console.rule(f"[bold]{cap.ref}[/] · {cap.status} · {cap.side_effects}")
    console.print(f"[bold]{cap.title}[/]\n{cap.description}")
    for layer in layers:
        console.print(f"[dim]layer: {layer}[/]")
    console.print(
        "\n[bold]Inputs[/]: " + (", ".join(f"{n}: {s.type} ({s.sensitivity})" for n, s in cap.inputs.items()) or "none")
    )
    console.print(
        "[bold]Outputs[/]: " + (", ".join(f"{n}: {s.type} ({s.sensitivity})" for n, s in cap.outputs.items()) or "none")
    )
    console.print("[bold]Secrets[/]: " + (", ".join(cap.secrets) or "none"))
    console.print(f"[bold]Session[/]: {cap.requires_session or '-'}   [bold]Idempotent[/]: {cap.idempotent}")
    steps = Table("step", "action", "risk", "target / locators (in order)", "expect", show_lines=True)
    for step in cap.steps:
        action = step.action
        target = getattr(action, "target", None)
        if target is not None:
            where = (
                target.description
                + "\n"
                + "\n".join(
                    f"  {i + 1}. " + ", ".join(f"{k}={v}" for k, v in loc.model_dump(exclude_none=True).items())
                    for i, loc in enumerate(target.locators)
                )
            )
        elif isinstance(action, NavigateAction):
            where = action.url
        else:
            where = "-"
        detail = action.type + (f" → {action.output}" if isinstance(action, ExtractAction) else "")
        expect = "\n".join(describe_condition(c) for c in step.expect) or "-"
        steps.add_row(f"{step.id}\n[dim]{step.intent}[/]", detail, step.risk, where, expect)
    console.print(steps)
    table = Table("handler", "source", "kind", "when", "then")
    for source, handler in handlers:
        then = handler.outcome.code if handler.outcome else (handler.recovery.do if handler.recovery else "-")
        when = "; ".join(describe_condition(c) for c in handler.when)
        if handler.unless:
            when += " — unless " + "; ".join(describe_condition(c) for c in handler.unless)
        table.add_row(handler.id, source, handler.kind, when, then)
    console.print(table)
    console.print(f"[bold]Success[/]: {cap.success.description}")
    console.print(
        f"[dim]provenance: {cap.provenance.method} on {cap.provenance.tenant} "
        f"({cap.provenance.source_run}); model {cap.provenance.model}[/]"
    )


@app.command()
def approve(
    capability: Annotated[str, typer.Argument(help="Capability id@version to approve.")],
    reviewer: Annotated[str, typer.Option(help="Who reviewed it.")],
    notes: Annotated[str | None, typer.Option(help="Review notes.")] = None,
) -> None:
    """Mark a reviewed draft as approved for unattended replay."""
    library = Library(_settings().root)
    cap = library.capability(capability)
    cap.status = "approved"
    cap.provenance.review = Review(reviewed_by=reviewer, reviewed_at=datetime.now(UTC), notes=notes)
    path = library.save(Capability.model_validate(cap.model_dump(by_alias=True)))
    console.print(f"[green]approved[/] {cap.ref} → {path}")


@app.command()
def validate() -> None:
    """Validate every artifact, app profile and tenant against the schema, the policy and the PII lint."""
    settings = _settings()
    library = Library(settings.root)
    policy = Policy.load(settings.policy_path)
    redactor = Redactor(policy.sensitive_labels)
    problems: list[str] = []
    for path in sorted(library.capabilities_dir.glob("*/*.yaml")) + sorted(library.tenants_dir.glob("*.yaml")):
        text = path.read_text()
        if redactor.text(text) != text:
            problems.append(f"{path}: contains data that looks sensitive (PII/credential pattern)")
    try:
        capabilities = library.capabilities()
    except Exception as exc:
        problems.append(f"schema: {exc}")
        capabilities = []
    for cap in capabilities:
        for step in cap.steps:
            if step.action.type not in policy.replay.allowed_actions:
                problems.append(f"{cap.ref}: step {step.id} uses disallowed action {step.action.type}")
            if isinstance(step.action, NavigateAction) and not step.action.url.startswith("{{app.base_url}}"):
                problems.append(f"{cap.ref}: step {step.id} navigates outside the tenant base URL")
        for tenant in library.tenants():
            if cap.app.id in tenant.apps:
                try:
                    resolve(cap, library.app(cap.app.id), tenant)
                except Exception as exc:
                    problems.append(f"{cap.ref} on {tenant.id}: {exc}")
    if problems:
        for problem in problems:
            console.print(f"[red]✗[/] {problem}")
        raise typer.Exit(1)
    console.print(f"[green]✓[/] {len(capabilities)} capabilities, {len(library.tenants())} tenants valid")


@app.command()
def schema(out: Annotated[Path, typer.Option(help="Directory for the JSON Schemas.")] = Path("schemas")) -> None:
    """Export JSON Schemas for capabilities, app profiles, tenants and eval datasets."""
    from .evals.dataset import dataset_json_schema

    for path in export_json_schemas(out):
        console.print(f"wrote {path}")
    path = out / "eval-dataset.schema.json"
    path.write_text(json.dumps(dataset_json_schema(), indent=2) + "\n")
    console.print(f"wrote {path}")


@app.command()
def catalog(
    include_drafts: Annotated[bool, typer.Option(help="Include draft capabilities.")] = False,
) -> None:
    """Print approved capabilities as tool definitions an AI agent can call."""
    print(json.dumps(build_catalog(Library(_settings().root).capabilities(), include_drafts=include_drafts), indent=2))


@app.command()
def report(run_dir: Annotated[Path, typer.Argument(help="A run directory under runs/.")]) -> None:
    """(Re)generate report.html for a run."""
    from .evidence.report import write_report

    console.print(f"wrote {write_report(run_dir)}")


# ============================================================================================ operator


_OPERATOR_STATE = Path(".rote") / "operator.json"


def _console_url(url: str | None) -> str:
    settings = _settings()
    return url or f"http://{settings.console_host}:{settings.console_port}"


def _op_state() -> dict[str, Any]:
    if not _OPERATOR_STATE.exists():
        raise typer.BadParameter("no claimed intervention; run `rote operator claim` first")
    state: dict[str, Any] = json.loads(_OPERATOR_STATE.read_text())
    return state


def _call(method: str, url: str, **kwargs: Any) -> Any:
    response = httpx.request(method, url, timeout=30, **kwargs)
    if response.status_code >= 400:
        console.print(f"[red]{response.status_code}[/] {response.text}")
        raise typer.Exit(1)
    return response.json() if response.content else None


@operator_app.command("status")
def op_status(url: Annotated[str | None, typer.Option(help="Console URL.")] = None) -> None:
    """Show who controls the session and the active intervention."""
    state = _call("GET", f"{_console_url(url)}/api/state")
    console.print_json(
        json.dumps(
            {
                "control": state["control"],
                "dialog": state["dialog"],
                "active": state["active"]
                and {
                    k: state["active"][k]
                    for k in ("id", "reason_code", "reason", "step_id", "step_intent", "status", "allowed_resolutions")
                },
            }
        )
    )


@operator_app.command("claim")
def op_claim(
    intervention: Annotated[str | None, typer.Argument(help="Intervention id (default: the active one).")] = None,
    operator: Annotated[str, typer.Option("--as", help="Your operator name.")] = "operator",
    url: Annotated[str | None, typer.Option(help="Console URL.")] = None,
) -> None:
    """Take control of the live session."""
    base = _console_url(url)
    if intervention is None:
        active = _call("GET", f"{base}/api/state")["active"]
        if not active:
            console.print("no active intervention")
            raise typer.Exit(1)
        intervention = active["id"]
    claimed = _call("POST", f"{base}/api/interventions/{intervention}/claim", json={"operator": operator})
    _OPERATOR_STATE.parent.mkdir(exist_ok=True)
    _OPERATOR_STATE.write_text(
        json.dumps({"url": base, "intervention": intervention, "operator": operator, "epoch": claimed["epoch"]})
    )
    console.print(
        f"[green]you control the session[/] (lease epoch {claimed['epoch']}). "
        f"Use `rote operator click/type/press/dialog`, then `rote operator resolve`."
    )


def _send(command: dict[str, Any]) -> None:
    state = _op_state()
    _call("POST", f"{state['url']}/api/input", json={"operator": state["operator"], "epoch": state["epoch"], **command})
    console.print("[green]ok[/]")


@operator_app.command("click")
def op_click(x: float, y: float) -> None:
    """Click at screenshot coordinates in the live session."""
    _send({"kind": "click", "x": x, "y": y})


@operator_app.command("type")
def op_type(text: str) -> None:
    """Type text into the focused field."""
    _send({"kind": "type", "text": text})


@operator_app.command("press")
def op_press(key: str) -> None:
    """Press a key (Enter, Tab, Escape, ...)."""
    _send({"kind": "press", "key": key})


@operator_app.command("dialog")
def op_dialog(answer: Annotated[str, typer.Argument(help="accept | dismiss")]) -> None:
    """Answer the open native dialog."""
    _send({"kind": "dialog", "accept": answer == "accept"})


@operator_app.command("resolve")
def op_resolve(
    resolution: Annotated[
        str, typer.Argument(help="retry_step | step_completed | continue | approve | reject | abort")
    ],
    note: Annotated[str, typer.Option(help="Note for the audit log.")] = "",
) -> None:
    """Hand control back to automation."""
    state = _op_state()
    _call(
        "POST",
        f"{state['url']}/api/interventions/{state['intervention']}/resolve",
        json={"operator": state["operator"], "epoch": state["epoch"], "resolution": resolution, "note": note},
    )
    _OPERATOR_STATE.unlink(missing_ok=True)
    console.print(f"[green]control handed back[/] ({resolution})")


# ============================================================================================ evals


def _pct(value: float) -> str:
    return f"{value:.0%}"


def _print_eval(run: Any) -> None:
    from .evals.runner import EvalRun

    assert isinstance(run, EvalRun)
    for case in run.cases:
        for trial in case.trials:
            mark = "[green]✓[/]" if trial.passed else "[red]✗[/]"
            label = case.id + (f" #{trial.trial}" if run.trials > 1 else "")
            console.print(f"{mark} {label:<38} {trial.observed or trial.error or ''}  [dim]{trial.duration_ms} ms[/]")
            for item in trial.checks:
                if item.passed is False:
                    console.print(f"    [red]{item.name}[/]: expected {item.expected}, got {item.observed}")
    summary = run.summary
    if summary is None:
        return
    gate = "[green]PASS[/]" if summary.gate else "[red]FAIL[/]"
    console.print(
        f"\n{gate} [bold]{run.dataset}[/] ({run.mode}): {summary.passed}/{summary.cases} cases "
        f"({_pct(summary.pass_rate)}, gate {_pct(run.threshold)}) · checks {summary.checks_passed}/{summary.checks}"
        + (
            f" · pass@{run.trials} {_pct(summary.pass_at_k)} · pass^{run.trials} {_pct(summary.pass_hat_k)}"
            if run.trials > 1
            else ""
        )
        + f" · p50 {summary.p50_ms} ms · p95 {summary.p95_ms} ms"
        + (f" · ${summary.cost_usd:.2f}" if summary.cost_usd else "")
    )


@eval_app.command("list")
def eval_list() -> None:
    """List eval datasets and their latest score."""
    from .evals.dataset import load_datasets
    from .evals.runner import list_results

    settings = _settings()
    latest: dict[str, Any] = {}
    for result in list_results(settings):
        latest.setdefault(result.dataset, result)
    table = Table("dataset", "kind", "cases", "model", "gate", "latest")
    for dataset in load_datasets(settings.root):
        last = latest.get(dataset.id)
        score = f"{_pct(last.summary.pass_rate)} ({last.mode}, {last.id})" if last is not None and last.summary else "—"
        table.add_row(
            dataset.id,
            dataset.kind,
            str(len(dataset.cases)),
            "live or stand-in" if dataset.uses_model else "none",
            _pct(dataset.threshold),
            score,
        )
    console.print(table)


@eval_app.command("run")
def eval_run(
    dataset: Annotated[str, typer.Argument(help="Dataset id (see `rote eval list`).")],
    live: Annotated[
        bool, typer.Option(help="Use the model (probe, discovery); default is the offline stand-in.")
    ] = False,
    trials: Annotated[int, typer.Option(min=1, max=10, help="Run every case N times (pass@k / pass^k).")] = 1,
    case: Annotated[list[str] | None, typer.Option("--case", "-c", help="Only these case ids (repeatable).")] = None,
    as_json: Annotated[bool, typer.Option("--json", help="Print the full result as JSON.")] = False,
) -> None:
    """Run DATASET hermetically (private mock bank, throwaway library). Exits 1 if the gate fails."""
    from .evals.runner import EvalRunner

    def progress(run: Any) -> None:
        if not as_json and run.cases and run.cases[-1].trials:
            current = run.cases[-1]
            trial = current.trials[-1]
            mark = "[green]✓[/]" if trial.passed else "[red]✗[/]"
            console.print(f"  {mark} {current.id} #{trial.trial} [dim]{trial.duration_ms} ms[/]", highlight=False)

    try:
        runner = EvalRunner(
            _settings(), dataset, mode="live" if live else "offline", trials=trials, case_ids=case, on_progress=progress
        )
    except ValueError as exc:
        raise typer.BadParameter(str(exc)) from exc
    if not as_json:
        console.print(
            f"[bold]{runner.dataset.title}[/] · {len(runner.cases)} cases x {trials} trial{'s' if trials != 1 else ''} · {runner.mode}"
        )
    result = asyncio.run(runner.execute())
    if as_json:
        print(result.model_dump_json(indent=2))
    else:
        console.print()
        _print_eval(result)
        console.print(f"Result: {runner.dir}/result.json")
    raise typer.Exit(0 if result.summary and result.summary.gate else 1)


@eval_app.command("show")
def eval_show(eval_id: Annotated[str | None, typer.Argument(help="Eval id; default: the latest.")] = None) -> None:
    """Show an eval result."""
    from .evals.runner import list_results, load_result

    settings = _settings()
    if eval_id is None:
        results = list_results(settings)
        if not results:
            raise typer.BadParameter("no eval results yet; run `rote eval run replay`")
        run = results[0]
    else:
        run = load_result(settings, eval_id)
    console.print(f"[bold]{run.dataset_title}[/] · {run.id} · dataset sha {run.dataset_sha}")
    _print_eval(run)


@app.command("mcp")
def mcp_server(
    public_url: Annotated[
        str, typer.Option(envvar="ROTE_PUBLIC_URL", help="Where the web UI (control plane) is, for result links.")
    ] = "http://localhost:3000",
) -> None:
    """Serve approved capabilities as MCP tools over stdio (Claude Desktop, IDEs, other MCP hosts).

    A local, single-user path with no network listener. Shared and remote agents should use the
    control plane's authenticated endpoint (/api/v1/mcp) instead. Every call replays
    deterministically and writes its evidence to runs/, where the control plane indexes it.
    """
    from mcp.server.stdio import stdio_server

    from .web.agents import AgentGateway
    from .web.runs import RunManager

    settings = _settings()

    async def serve() -> None:
        manager = RunManager(settings, public_url.rstrip("/"))
        gateway = AgentGateway(
            settings, manager, allowed_hosts=["127.0.0.1", "localhost"], run_link_base="/api/v1/runs"
        )
        try:
            async with stdio_server() as (read_stream, write_stream):
                await gateway.server.run(read_stream, write_stream, gateway.server.create_initialization_options())
        finally:
            await manager.shutdown()

    asyncio.run(serve())


def main() -> None:  # pragma: no cover
    try:
        app()
    except (FileNotFoundError, PermissionError, KeyError, yaml.YAMLError) as exc:
        console.print(f"[red]error:[/] {exc}")
        sys.exit(1)


LOOPBACK = {"127.0.0.1", "localhost", "::1"}


@app.command()
def engine(
    port: Annotated[int, typer.Option(help="Port for the engine API.")] = 8700,
    host: Annotated[str, typer.Option(help="Interface to bind (loopback by default).")] = "127.0.0.1",
    public_url: Annotated[
        str | None,
        typer.Option(envvar="ROTE_PUBLIC_URL", help="Where people reach the UI (the control plane), for links."),
    ] = None,
) -> None:
    """Run the engine API: the internal service the control plane (backend/) calls to run capabilities.

    Every call must carry the shared token (ROTE_ENGINE_TOKEN, or ENGINE_TOKEN from .env); listening beyond loopback requires one. The web UI is served by the control plane, not here.
    """
    import uvicorn

    from .web.server import create_app

    settings = _settings()
    token = os.environ.get("ROTE_ENGINE_TOKEN") or os.environ.get("ENGINE_TOKEN") or None
    if host not in LOOPBACK and not token:
        raise typer.BadParameter("listening beyond loopback requires ROTE_ENGINE_TOKEN", param_hint="--host")
    bind_url = f"http://{host}:{port}"
    application = create_app(
        settings,
        public_url or "http://localhost:3000",
        bind_url=bind_url,
        engine_token=token,
        run_link_base=os.environ.get("ROTE_RUN_LINK_BASE", "/api/v1/runs"),
    )
    console.print(
        f"[bold]rote engine[/] → {bind_url}   (API docs: {bind_url}/api/docs · "
        f"token {'required' if token else 'off'} · Ctrl+C to stop)"
    )
    uvicorn.run(application, host=host, port=port, log_level="warning")


@app.command(hidden=True)
def ui(
    port: Annotated[int, typer.Option(help="Port for the engine API.")] = 8700,
    host: Annotated[str, typer.Option(help="Interface to bind.")] = "127.0.0.1",
) -> None:
    """Deprecated: the UI is served by the control plane now. Starts the engine instead."""
    console.print(
        "[yellow]`rote ui` is now `rote engine`; the web UI is served by the control plane "
        "(`make up`, or `make dev` for local development).[/]"
    )
    engine(port=port, host=host, public_url=None)
