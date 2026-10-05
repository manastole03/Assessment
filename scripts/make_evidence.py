"""Regenerate /evidence end to end.

    uv run python scripts/make_evidence.py            # real LLM discovery + probe (needs ANTHROPIC_API_KEY)
    uv run python scripts/make_evidence.py --offline  # scripted stand-in for the model (no key needed)

The thread: discover sign-on → discover the task → review/approve → probe off-happy-path inputs into
reviewed handlers → replay: success, another member, business outcomes, invalid input, recoveries,
a hard failure, a human handoff, and the same artifact on a second tenant with and without an override.
Every run directory (events, masked screenshots, redacted DOM, result, report.html) is copied into
evidence/<name>/ and indexed in evidence/README.md.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import shutil
import socket
import sys
import threading
import time
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import Any

import httpx
import uvicorn
import yaml

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO / "scripts"))

from operator_bot import complete_attestation  # noqa: E402

from mockbank.app import app as bank_app  # noqa: E402
from rote.artifact.resolve import resolve  # noqa: E402
from rote.artifact.schema import Review  # noqa: E402
from rote.artifact.store import Library  # noqa: E402
from rote.catalog import catalog  # noqa: E402
from rote.discovery.agent import DiscoveryAgent, DiscoveryRequest  # noqa: E402
from rote.discovery.decider import ClaudeDecider, ScriptedDecider  # noqa: E402
from rote.discovery.probe import claude_classifier, probe  # noqa: E402
from rote.evals.standins import SESSION_SCRIPT, balance_script, rule_classifier  # noqa: E402
from rote.replay.engine import ReplayEngine, ReplayOptions  # noqa: E402
from rote.replay.result import RunResult  # noqa: E402
from rote.runtime import Settings, open_session  # noqa: E402

BANK = "http://127.0.0.1:8600"
EVIDENCE = REPO / "evidence"
BALANCE = "legacycore.member.get_savings_balance"
SESSION = "legacycore.session.sign_on"
SESSION_GOAL = "Sign on to LegacyCore with the operator's service account"
BALANCE_GOAL = "Look up member 12345 and read their current share savings balance and the member's name"
INDEX: list[dict[str, Any]] = []


# ============================================================================================ bank


def ensure_bank() -> None:
    with socket.socket() as sock:
        if sock.connect_ex(("127.0.0.1", 8600)) == 0:
            print("using the LegacyCore mock already running on :8600")
            return
    server = uvicorn.Server(uvicorn.Config(bank_app, host="127.0.0.1", port=8600, log_level="error"))
    threading.Thread(target=server.run, daemon=True).start()
    for _ in range(100):
        try:
            httpx.get(BANK + "/", timeout=0.5)
            return
        except httpx.HTTPError:
            time.sleep(0.05)
    raise RuntimeError("could not start the mock bank on :8600")


def reset_bank(tenant: str | None = None, **faults: Any) -> None:
    httpx.post(f"{BANK}/__admin/reset").raise_for_status()
    if tenant and faults:
        httpx.put(f"{BANK}/__admin/faults/{tenant}", json=faults).raise_for_status()


# ============================================================================================ helpers


def keep(name: str, run_dir: str | Path, summary: dict[str, Any], shows: str) -> None:
    target = EVIDENCE / name
    shutil.rmtree(target, ignore_errors=True)
    shutil.copytree(run_dir, target)
    INDEX.append({"name": name, "shows": shows, **summary})
    print(f"  → evidence/{name}: {summary.get('result')}")


def approve(settings: Settings, ref: str, notes: str) -> str:
    library = Library(settings.root)
    cap = library.capability(ref)
    cap.status = "approved"
    cap.provenance.review = Review(
        reviewed_by="evidence-script (stand-in reviewer)",
        reviewed_at=__import__("datetime").datetime.now(__import__("datetime").UTC),
        notes=notes,
    )
    library.save(cap)
    return cap.ref


def summarize(result: RunResult) -> dict[str, Any]:
    out: dict[str, Any] = {
        "result": result.status.value,
        "capability": f"{result.capability.id}@{result.capability.version}",
    }
    if result.outputs:
        out["outputs"] = {
            k: (v if k != "member_name" else "{{outputs.member_name}}") for k, v in result.outputs.items()
        }
    if result.outcome:
        out["outcome"] = result.outcome.code
    if result.failure:
        at = f" at {result.failure.step_id}" if result.failure.step_id else " (before any UI step)"
        out["failure"] = f"{result.failure.code.value}{at}"
    if result.recoveries:
        out["recoveries"] = [f"{r.handler}: {r.action}" for r in result.recoveries]
    if result.warnings:
        out["warnings"] = sorted({f"{w.code} ({w.step_id})" for w in result.warnings})
    if result.interventions:
        out["interventions"] = result.interventions
    return out


async def replay(
    settings: Settings,
    name: str,
    shows: str,
    inputs: dict[str, str],
    *,
    tenant: str = "acme",
    faults: dict[str, Any] | None = None,
    escalation: str = "fail",
    operator: Callable[[str], Awaitable[dict[str, Any]]] | None = None,
) -> RunResult:
    reset_bank(tenant, **(faults or {}))
    library = Library(settings.root)
    cap = library.capability(BALANCE)
    print(f"\n▶ {name}")
    async with open_session(
        settings,
        kind="replay",
        subject=cap.ref,
        label=f"{cap.id}-{tenant}",
        tenant_id=tenant,
        app_id=cap.app.id,
        console=escalation == "wait",
    ) as session:
        engine = ReplayEngine(
            surface=session.surface,
            library=library,
            policy=session.policy,
            redactor=session.redactor,
            log=session.log,
            broker=session.broker,
            options=ReplayOptions(escalation=escalation, escalation_timeout_s=120),
        )  # type: ignore[arg-type]
        task = asyncio.create_task(engine.run(resolve(cap, session.app, session.tenant), inputs))
        extra: dict[str, Any] = {}
        if operator is not None:
            assert session.console_url
            handled = await operator(session.console_url)
            extra["late_input_after_handback"] = handled.get("late_input_status")
        result = await task
    keep(name, result.evidence_dir or "", {**summarize(result), **extra}, shows)
    return result


# ============================================================================================ steps


async def discover(
    settings: Settings,
    name: str,
    goal: str,
    kind: str,
    inputs: dict[str, str],
    capability_id: str | None,
    script: list[Any],
    offline: bool,
) -> None:
    reset_bank()
    print(f"\n▶ {name}")
    async with open_session(
        settings,
        kind="discovery",
        subject=goal,
        label=capability_id or kind,
        tenant_id="acme",
        app_id="legacycore",
        console=True,
    ) as session:
        decider = (
            ScriptedDecider(script)
            if offline
            else ClaudeDecider(
                model=settings.model, effort=settings.effort, redactor=session.redactor, fallbacks=settings.fallbacks
            )
        )
        request = DiscoveryRequest(goal=goal, inputs=inputs, kind=kind, capability_id=capability_id)  # type: ignore[arg-type]
        result = await DiscoveryAgent(session, decider, request).run()
    if result.status != "succeeded":
        raise SystemExit(f"discovery failed: {result.failure}")
    summary = {
        "result": result.status,
        "capability": result.capability,
        "model": result.model,
        "turns": result.turns,
        "actions": result.actions,
        "estimated_cost_usd": result.estimated_cost_usd,
        "tokens": result.usage,
    }
    keep(
        name,
        result.evidence_dir,
        summary,
        f"LLM-driven discovery: “{goal}” → {result.capability}"
        if not offline
        else f"Scripted stand-in for discovery: “{goal}” → {result.capability}",
    )


async def probe_step(settings: Settings, name: str, shows: str, member: str, offline: bool) -> None:
    reset_bank()
    library = Library(settings.root)
    cap = library.capability(BALANCE)
    print(f"\n▶ {name}")
    async with open_session(
        settings,
        kind="probe",
        subject=cap.ref,
        label=f"{cap.id}-probe",
        tenant_id="acme",
        app_id=cap.app.id,
        console=False,
    ) as session:
        classifier = rule_classifier if offline else claude_classifier(settings.model, settings.effort)
        outcome = await probe(
            session, resolve(cap, session.app, session.tenant), {"member_id": member}, classifier=classifier, save=True
        )
    if outcome.capability is None:
        raise SystemExit(f"probe produced no handler: {outcome.note}")
    ref = approve(settings, outcome.capability.ref, f"reviewed handler {outcome.handler.id if outcome.handler else ''}")
    keep(
        name,
        outcome.replay.evidence_dir or "",
        {
            "result": f"replay {outcome.replay.failure.code.value if outcome.replay.failure else '?'} → handler "
            f"{outcome.handler.id if outcome.handler else '-'} ({outcome.classification.kind if outcome.classification else '-'})",
            "capability": ref,
            "classified_by": "model" if not offline else "offline rule (stand-in)",
        },
        shows,
    )


def write_bayview_override(settings: Settings) -> str:
    cap = Library(settings.root).capability(BALANCE)
    step = next(s.id for s in cap.steps if s.action.type == "extract" and s.action.output == "savings_balance")
    path = settings.root / "config" / "tenants" / "bayview.yaml"
    text = path.read_text().split("schema:", 1)
    tenant = yaml.safe_load("schema:" + text[1])
    tenant["apps"]["legacycore"]["overrides"] = [
        {
            "capability": BALANCE,
            "versions": ">=1.0.0,<2.0.0",
            "reason": "Bayview names the savings product REGULAR SAVINGS and its balance column Ledger Balance",
            "steps": {
                step: {"prepend_locators": [{"by": "table_cell", "row": "REGULAR SAVINGS", "column": "Ledger Balance"}]}
            },
        }
    ]
    path.write_text(text[0] + yaml.safe_dump(tenant, sort_keys=False))
    return step


def clear_bayview_override(settings: Settings) -> None:
    path = settings.root / "config" / "tenants" / "bayview.yaml"
    text = path.read_text().split("schema:", 1)
    tenant = yaml.safe_load("schema:" + text[1])
    tenant["apps"]["legacycore"]["overrides"] = []
    path.write_text(text[0] + yaml.safe_dump(tenant, sort_keys=False))


# ============================================================================================ index

SECTIONS = [  # (title, run-name prefixes)
    ("Discovery: the model accomplishes the goal and the run becomes an artifact", ("01", "02")),
    ("Probing: off-happy-path inputs become reviewed business-outcome handlers", ("03", "04", "05")),
    ("Deterministic replay: no model in the loop", ("1",)),
    ("Same artifact, another institution on the same vendor product", ("2",)),
]


def _fmt(run: dict[str, Any]) -> str:
    bits = []
    for key in (
        "outputs",
        "outcome",
        "failure",
        "recoveries",
        "warnings",
        "interventions",
        "late_input_after_handback",
        "model",
        "turns",
        "estimated_cost_usd",
        "classified_by",
    ):
        if key not in run:
            continue
        value = run[key]
        if isinstance(value, dict):
            value = ", ".join(f"`{k}={v}`" for k, v in value.items())
        elif isinstance(value, list):
            value = "; ".join(str(v) for v in value)
        elif key in ("outcome", "failure"):
            value = f"`{value}`"
        label = {"late_input_after_handback": "late operator input after hand-back"}.get(key, key.replace("_", " "))
        bits.append(f"{label}: {value}")
    return "<br>".join(bits) or "—"


def write_readme(offline: bool) -> None:
    banner = (
        "> **Mode: offline.** Discovery and probing in this folder were driven by a *scripted stand-in* for the "
        "model (`model: scripted` in each artifact's provenance), because no API key was available when it was "
        "generated. Everything downstream — recording, review, replay, recovery, handoff, multi-tenant — is the "
        "real system. Run `make evidence` with `ANTHROPIC_API_KEY` set to regenerate this folder from a live "
        "LLM-driven discovery run.\n"
        if offline
        else "> **Mode: live.** Discovery (`01`, `02`) and screen classification during probing (`03` to `05`) were "
        "performed by the model named in each run. Everything after that ran with no model in the loop.\n"
    )
    lines = [
        "# Evidence",
        "",
        "Generated by `scripts/make_evidence.py` (`make evidence`). Each folder is a complete run directory:",
        "`report.html` (open it in a browser: summary, timeline, screenshots), `events.jsonl` (structured log),",
        "`result.json` (the contract returned to the caller), `screens/` (masked screenshots + redacted screen text),",
        "`dom/` (redacted DOM on failure/escalation) and `interventions/` (handoff records).",
        "",
        banner,
        (
            "Artifacts: [`artifact-as-discovered.yaml`](artifact-as-discovered.yaml) (straight out of discovery) and "
            "[`artifact-final.yaml`](artifact-final.yaml) (after probing and review). "
            "[`catalog.json`](catalog.json) is what a calling agent sees."
        ),
        "",
    ]
    for title, prefixes in SECTIONS:
        runs = [r for r in INDEX if r["name"].startswith(prefixes)]
        if not runs:
            continue
        lines += [f"## {title}", "", "| run | what it shows | result | details |", "|---|---|---|---|"]
        for run in runs:
            lines.append(
                f"| [{run['name']}]({run['name']}/report.html) | {run['shows']} | **{run['result']}** | {_fmt(run)} |"
            )
        lines.append("")
    lines += [
        "## Privacy check",
        "",
        "Nothing in this folder contains the member number, member name, SSN, date of birth, phone, e-mail or the",
        "service-account credentials: values appear as references (`{{inputs.member_id}}`, `{{outputs.member_name}}`,",
        "`{{secrets.password}}`) or pattern masks (`[SSN ***-**-6789]`), and screenshots are masked before capture.",
        "`tests/test_end_to_end.py::test_evidence_is_redacted` enforces this on every test run.",
        "",
    ]
    (EVIDENCE / "README.md").write_text("\n".join(lines))


# ============================================================================================ main


async def main(offline: bool) -> None:
    os.environ.setdefault("ROTE_RUNS_DIR", str(REPO / "runs"))
    settings = Settings.load(REPO)
    if not offline and not os.environ.get("ANTHROPIC_API_KEY"):
        raise SystemExit("ANTHROPIC_API_KEY is not set (add it to .env), or run with --offline")
    ensure_bank()
    for path in (settings.root / "capabilities" / "legacycore").glob("legacycore.*@*.yaml"):
        path.unlink()
    clear_bayview_override(settings)
    for child in EVIDENCE.glob("*"):
        if child.is_dir():
            shutil.rmtree(child)

    # 1. discovery (the model) → artifacts, then review/approval
    await discover(settings, "01-discovery-sign-on", SESSION_GOAL, "session", {}, SESSION, SESSION_SCRIPT, offline)
    approve(settings, SESSION, "Locators verified; credentials are secret references only.")
    await discover(
        settings,
        "02-discovery-savings-balance",
        BALANCE_GOAL,
        "task",
        {"member_id": "12345"},
        BALANCE,
        balance_script("12345"),
        offline,
    )
    approve(settings, BALANCE, "Reads only; balance extracted by row/column meaning, not position.")
    shutil.copy(Library(settings.root).capability_path(BALANCE, "1.0.0"), EVIDENCE / "artifact-as-discovered.yaml")

    # 2. probing off-happy-path inputs → reviewed business-outcome handlers (new patch versions)
    await probe_step(
        settings,
        "03-probe-member-not-found",
        "Unknown screen after search → model classifies it → MEMBER_NOT_FOUND handler",
        "99999",
        offline,
    )
    await probe_step(
        settings, "04-probe-restricted-account", "ACCESS DENIED screen → ACCESS_RESTRICTED handler", "40404", offline
    )
    await probe_step(
        settings,
        "05-probe-no-savings-share",
        "Member without a savings share → NO_SAVINGS_ACCOUNT handler (guarded so it can never fire on the happy path)",
        "31008",
        offline,
    )
    final = Library(settings.root).capability(BALANCE)
    shutil.copy(Library(settings.root).capability_path(BALANCE, final.version), EVIDENCE / "artifact-final.yaml")

    # 3. deterministic replays
    await replay(
        settings,
        "10-replay-success",
        "Deterministic replay, no model: outputs + verified checkpoint",
        {"member_id": "12345"},
    )
    await replay(
        settings,
        "11-replay-other-member",
        "Same artifact, member whose share rows are re-ordered",
        {"member_id": "20417"},
    )
    await replay(settings, "12-replay-member-not-found", "Business outcome, not a failure", {"member_id": "99999"})
    await replay(
        settings, "13-replay-restricted-account", "Business outcome (permission denial in-flow)", {"member_id": "40404"}
    )
    await replay(
        settings, "14-replay-invalid-input", "Caller error rejected before touching the UI", {"member_id": "12-AB"}
    )
    await replay(
        settings,
        "15-replay-recoveries",
        "Interstitial, native dialog, HTTP 503 and session expiry — all recognised and recovered",
        {"member_id": "12345"},
        faults={
            "maintenance_notice": True,
            "session_warning_dialog": True,
            "transient_errors": 1,
            "session_expire_after": 4,
        },
    )
    await replay(
        settings,
        "16-replay-hard-failure",
        "Unannounced vendor redesign → TARGET_NOT_FOUND with screenshot + DOM + expected/observed",
        {"member_id": "12345"},
        faults={"vendor_upgrade": True},
    )
    await replay(
        settings,
        "17-replay-human-handoff",
        "Unknown attestation screen → operator takes the live session via the console → hands back → run completes",
        {"member_id": "12345"},
        faults={"compliance_popup": True},
        escalation="wait",
        operator=complete_attestation,
    )

    # 4. multi-tenant: same artifact on Bayview (same vendor product, configured differently)
    await replay(
        settings,
        "20-tenant-bayview-no-override",
        "Shared artifact on a variant tenant: drift reported; the "
        "read it can't do safely fails loudly instead of guessing (or claiming 'no savings')",
        {"member_id": "20417"},
        tenant="bayview",
    )
    step = write_bayview_override(settings)
    await replay(
        settings,
        "21-tenant-bayview-with-override",
        f"One reviewed override (step {step}) → success",
        {"member_id": "20417"},
        tenant="bayview",
    )
    await replay(
        settings,
        "22-tenant-bayview-no-savings",
        "The override propagates into the probed handler: a "
        "Bayview member without savings gets the right business outcome",
        {"member_id": "31008"},
        tenant="bayview",
    )

    (EVIDENCE / "catalog.json").write_text(json.dumps(catalog(Library(settings.root).capabilities()), indent=2) + "\n")
    (EVIDENCE / "index.json").write_text(
        json.dumps({"mode": "offline" if offline else "live", "runs": INDEX}, indent=2) + "\n"
    )
    write_readme(offline)
    print("\nwrote evidence/README.md and evidence/index.json")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--offline", action="store_true", help="use the scripted stand-in instead of the model")
    asyncio.run(main(parser.parse_args().offline))
