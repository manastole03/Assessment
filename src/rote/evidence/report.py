"""Render a run directory into a single static ``report.html``: summary, timeline with screenshots, raw data."""

from __future__ import annotations

import html
import json
from pathlib import Path
from typing import Any

_CSS = """
:root{--bg:#fbfbf9;--fg:#1d1d1b;--muted:#6b6b66;--line:#e4e3dc;--card:#fff;--ok:#1f7a4d;--warn:#a86a00;
--bad:#b3261e;--biz:#7a3fa0;--info:#1f5fa8}
@media (prefers-color-scheme:dark){:root{--bg:#161614;--fg:#ecebe6;--muted:#9c9b94;--line:#2e2d29;--card:#1e1e1b}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 ui-sans-serif,system-ui,-apple-system,Segoe UI,sans-serif}
main{max-width:1100px;margin:0 auto;padding:24px 16px 64px}h1{font-size:20px;margin:0 0 4px}h2{font-size:15px;margin:28px 0 8px}
.meta{color:var(--muted);font-size:13px}.pill{display:inline-block;padding:1px 8px;border-radius:999px;font-size:12px;font-weight:600;color:#fff}
.succeeded{background:var(--ok)}.failed{background:var(--bad)}.business_outcome{background:var(--biz)}.unknown{background:var(--muted)}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px 16px;margin-top:14px}
dl{display:grid;grid-template-columns:max-content 1fr;gap:6px 16px;margin:0}dt{color:var(--muted)}dd{margin:0;word-break:break-word}
table{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--line);border-radius:8px;overflow:hidden}
td{padding:6px 10px;border-top:1px solid var(--line);vertical-align:top}td.t{color:var(--muted);white-space:nowrap;width:70px;font-variant-numeric:tabular-nums}
td.k{white-space:nowrap;width:190px;font-family:ui-monospace,Menlo,monospace;font-size:12px}
.k.step{color:var(--info)}.k.handler,.k.recovery{color:var(--warn)}.k.intervention,.k.human,.k.control{color:var(--biz)}.k.run,.k.discovery{font-weight:700}
.k.policy,.k.failure{color:var(--bad)}.k.agent{color:var(--info)}.k.locator{color:var(--warn)}
pre{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:12px;overflow:auto;font-size:12px;white-space:pre-wrap}
img.shot{max-width:320px;border:1px solid var(--line);border-radius:4px;display:block;margin-top:6px;cursor:zoom-in}
img.shot.big{max-width:100%}.detail{color:var(--muted);font-size:12px;word-break:break-word}.detail b{color:var(--fg)}
ul{margin:4px 0;padding-left:18px}code{font-family:ui-monospace,Menlo,monospace;font-size:12px}
"""

_SKIP = {"seq", "ts", "t_ms", "type"}
_KEYS = {
    "step.started": ["step", "intent"],
    "step.completed": ["step", "duration_ms", "locator"],
    "agent.action": ["tool", "summary", "rationale"],
    "agent.action_result": ["ok", "message"],
    "agent.turn": ["reasoning", "usage"],
    "handler.fired": ["handler", "kind", "source", "description"],
    "recovery.performed": ["handler", "action", "attempt"],
    "intervention.raised": ["id", "reason_code", "reason"],
    "intervention.claimed": ["operator", "epoch"],
    "human.action": ["description"],
    "intervention.resolved": ["resolution", "note", "human_actions"],
    "control.changed": ["reason"],
    "locator.warning": ["code", "message"],
    "output.extracted": ["output", "value"],
    "policy.decision": ["verdict", "risk", "reason"],
}


def _esc(value: Any) -> str:
    return html.escape(str(value))


def _summary(event: dict[str, Any]) -> str:
    data = {k: v for k, v in event.items() if k not in _SKIP}
    keys = _KEYS.get(event["type"])
    if keys:
        data = {k: data[k] for k in keys if k in data}
    if event["type"] == "control.changed":
        data = {"lease": f"{event['from']['state']} → {event['to']['state']} ({event['to']['holder']})", **data}
    parts = []
    for key, value in data.items():
        if isinstance(value, (dict, list)):
            value = json.dumps(value)[:400]
        parts.append(f"<b>{_esc(key)}</b>: {_esc(value)[:700]}")
    return " · ".join(parts)


def _list(items: list[str]) -> str:
    return "<ul>" + "".join(f"<li>{_esc(i)}</li>" for i in items) + "</ul>" if items else "—"


def _result_card(result: dict[str, Any]) -> str:
    if not result:
        return ""
    rows: list[tuple[str, str]] = []
    capability = result.get("capability")
    if isinstance(capability, dict):
        rows.append(
            (
                "capability",
                (
                    f"<code>{_esc(capability['id'])}@{_esc(capability['version'])}</code> · "
                    f"{_esc(capability['effective_hash'])}"
                ),
            )
        )
        rows.append(("layers", _list(capability.get("layers", []))))
        rows.append(("tenant", _esc(result.get("tenant"))))
    elif capability:
        rows.append(("capability", f"<code>{_esc(capability)}</code>"))
    if result.get("outputs"):
        rows.append(
            ("outputs", "<br>".join(f"<code>{_esc(k)}</code> = {_esc(v)}" for k, v in result["outputs"].items()))
        )
    outcome = result.get("outcome")
    if isinstance(outcome, dict):
        rows.append(("business outcome", f"<code>{_esc(outcome.get('code'))}</code> — {_esc(outcome.get('message'))}"))
    failure = result.get("failure")
    if isinstance(failure, dict):
        rows.append(("failure", f"<code>{_esc(failure['code'])}</code> {_esc(failure['message'])}"))
        if failure.get("step_id"):
            rows.append(("at step", f"<code>{_esc(failure['step_id'])}</code> — {_esc(failure.get('step_intent'))}"))
        rows.append(("expected", _esc(failure.get("expected") or "—")))
        rows.append(("observed", f"<pre>{_esc(failure.get('observed') or '—')}</pre>"))
        rows.append(("retryable", _esc(failure.get("retryable"))))
        shot = (failure.get("evidence") or {}).get("screenshot")
        if shot:
            rows.append(
                ("screenshot", f'<img class="shot" src="{_esc(shot)}" onclick="this.classList.toggle(\'big\')">')
            )
    elif failure:
        rows.append(("failure", _esc(failure)))
    for key, label in (("recoveries", "recoveries"), ("warnings", "warnings (drift)")):
        items = result.get(key) or []
        if items:
            rows.append((label, _list([" · ".join(f"{k}={v}" for k, v in i.items()) for i in items])))
    if result.get("interventions"):
        rows.append(("interventions", _list(result["interventions"])))
    rows.extend(
        (key, _esc(result[key])) for key in ("model", "turns", "actions", "estimated_cost_usd") if key in result
    )
    body = "".join(f"<dt>{label}</dt><dd>{value}</dd>" for label, value in rows)
    return f'<div class="card"><dl>{body}</dl></div>'


def write_report(run_dir: Path) -> Path:
    events = [json.loads(line) for line in (run_dir / "events.jsonl").read_text().splitlines() if line.strip()]
    result_path = run_dir / "result.json"
    result = json.loads(result_path.read_text()) if result_path.exists() else {}
    status = result.get("status", "unknown")
    started: dict[str, Any] = next((e for e in events if e["type"] == "run.started"), {})
    rows = []
    for event in events:
        if event["type"] == "agent.turn" and not event.get("reasoning"):
            continue
        body = _summary(event)
        shot = event.get("screenshot")
        if event["type"] == "evidence.captured" and shot:
            body = f"<b>{_esc(event.get('label'))}</b>"
            body += f'<img class="shot" loading="lazy" src="{_esc(shot)}" onclick="this.classList.toggle(\'big\')">'
        rows.append(
            f'<tr><td class="t">{event["t_ms"] / 1000:.1f}s</td><td class="k {event["type"].split(".")[0]}">'
            f'{_esc(event["type"])}</td><td class="detail">{body}</td></tr>'
        )
    extras = []
    for name in ("artifact.yaml", "outcome-handler.yaml", "probed-handler.yaml"):
        path = run_dir / name
        if path.exists():
            extras.append(f"<h2>{_esc(name)}</h2><pre>{_esc(path.read_text())}</pre>")
    folder = run_dir / "interventions"
    for path in sorted(folder.glob("*.json")) if folder.exists() else []:
        record = json.loads(path.read_text())
        record.pop("observation", None)
        extras.append(f"<h2>Intervention {_esc(path.stem)}</h2><pre>{_esc(json.dumps(record, indent=2))}</pre>")
    raw = (
        f"<details><summary>result.json</summary><pre>{_esc(json.dumps(result, indent=2))}</pre></details>"
        if result
        else ""
    )
    page = f"""<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Run report</title><style>{_CSS}</style></head>
<body><main><h1>{_esc(started.get("subject", run_dir.name))}</h1>
<div class="meta"><span class="pill {_esc(status)}">{_esc(status)}</span> · {_esc(started.get("kind", ""))}
 · run <code>{_esc(run_dir.name)}</code> · {len(events)} events</div>
{_result_card(result)}
<h2>Timeline</h2><table>{"".join(rows)}</table>{"".join(extras)}<h2>Raw</h2>{raw}</main></body></html>"""
    path = run_dir / "report.html"
    path.write_text(page)
    return path
