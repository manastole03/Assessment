"""Minimal operator console: see the intervention, take the live session, act, hand it back.

It runs inside the automation process, on the same event loop, so the operator drives *the same*
browser session the automation was using — not a fresh one. Two ways to act:

* **remote** — the live view streams screenshots; clicks and keystrokes are forwarded through the
  lease-checked surface API (works headless and over a network);
* **local** — with ``--headed`` the operator can use the Chromium window directly.

Either way, DOM-level listeners record what the operator did, and every forwarded command must carry
the lease epoch it was granted (fencing), so stale input after hand-back is rejected.
A production console would add authN/Z, a real co-browsing stream (CDP screencast/WebRTC) and
multi-session routing; this one is deliberately small but the control-transfer model is the real one.
"""

from __future__ import annotations

import asyncio
import contextlib
from collections.abc import Callable, Iterator
from pathlib import Path
from typing import TYPE_CHECKING, Any, Literal

import uvicorn
from fastapi import APIRouter, Depends, FastAPI, HTTPException
from fastapi.responses import FileResponse, HTMLResponse, Response
from pydantic import BaseModel

from .control import Actor, ControlError
from .interventions import Resolution

if TYPE_CHECKING:
    from ..runtime import LiveSession


class ClaimBody(BaseModel):
    operator: str


class InputBody(BaseModel):
    operator: str
    epoch: int
    kind: Literal["click", "type", "press", "dialog"]
    x: float | None = None
    y: float | None = None
    text: str | None = None
    key: str | None = None
    accept: bool | None = None


class ResolveBody(BaseModel):
    operator: str
    epoch: int
    resolution: Resolution
    note: str = ""


def operator_router(session_dependency: Callable[..., Any]) -> APIRouter:
    """The operator API for one live session, mountable anywhere.

    The standalone console mounts it at ``/api``; ``rote ui`` mounts it per run at
    ``/api/runs/{run_id}/operator``. ``session_dependency`` resolves the ``LiveSession``.
    """
    router = APIRouter()
    live_session = Depends(session_dependency)  # resolved per request: the LiveSession to act on

    @router.get("/state")
    async def state(session: Any = live_session) -> dict[str, Any]:
        broker, surface = session.broker, session.surface
        active = broker.active
        dialog = surface.dialog()
        return {
            "run": {
                "id": session.log.run_id,
                "kind": session.log.kind,
                "subject": session.redactor.text(session.subject),
                "tenant": session.tenant.id,
                "evidence": session.log.display_dir,
            },
            "control": session.control.snapshot(),
            "dialog": {"kind": dialog.kind, "message": session.redactor.text(dialog.message)} if dialog else None,
            "active": active.model_dump(mode="json", exclude={"screenshot"}) if active else None,
            "history": [
                i.model_dump(
                    mode="json", include={"id", "reason_code", "status", "resolution", "note", "claimed_by", "step_id"}
                )
                for i in broker.items.values()
                if i is not active
            ],
        }

    @router.get("/interventions/{intervention_id}")
    async def get_intervention(intervention_id: str, session: Any = live_session) -> dict[str, Any]:
        try:
            return dict(session.broker.get(intervention_id).model_dump(mode="json", exclude={"screenshot"}))
        except KeyError as exc:
            raise HTTPException(404, str(exc)) from exc

    @router.get("/interventions/{intervention_id}/screenshot")
    async def intervention_screenshot(intervention_id: str, session: Any = live_session) -> FileResponse:
        try:
            item = session.broker.get(intervention_id)
        except KeyError as exc:
            raise HTTPException(404, str(exc)) from exc
        if not item.screenshot or not await asyncio.to_thread(Path(item.screenshot).exists):
            raise HTTPException(404, "no screenshot")
        return FileResponse(item.screenshot, media_type="image/jpeg")

    @router.get("/live.jpg")
    async def live(mask: bool = False, session: Any = live_session) -> Response:
        # An operator in control is an entitled user of the app, so their view is not masked.
        # Observers (``mask=true``) and everything *persisted* are masked/redacted.
        shot = await session.surface.screenshot(mask=mask)
        if shot is None:
            return Response(status_code=204)
        return Response(shot, media_type="image/jpeg", headers={"Cache-Control": "no-store"})

    @router.get("/screen")
    async def screen(session: Any = live_session) -> dict[str, Any]:
        """What is on screen and where (redacted), for CLI operators and tooling that can't see pixels."""
        observation = await session.surface.observe(screenshot=False)
        redactor = session.redactor
        return {
            "dialog": {"kind": observation.dialog.kind, "message": redactor.text(observation.dialog.message)}
            if observation.dialog
            else None,
            "elements": [
                {
                    "ref": e.ref,
                    "frame": e.frame,
                    "role": e.role,
                    "name": redactor.field(e.label, e.name),
                    "label": e.label,
                    "text": redactor.field(e.label, e.text)[:80],
                    "x": e.bbox[0] + e.bbox[2] / 2 if e.bbox else None,
                    "y": e.bbox[1] + e.bbox[3] / 2 if e.bbox else None,
                }
                for e in observation.elements
            ],
        }

    @router.post("/interventions/{intervention_id}/claim")
    async def claim(intervention_id: str, body: ClaimBody, session: Any = live_session) -> dict[str, Any]:
        try:
            epoch = session.broker.claim(intervention_id, body.operator)
        except KeyError as exc:
            raise HTTPException(404, str(exc)) from exc
        except (ValueError, ControlError) as exc:
            raise HTTPException(409, str(exc)) from exc
        return {"epoch": epoch, "control": session.control.snapshot()}

    @router.post("/input")
    async def forward_input(body: InputBody, session: Any = live_session) -> dict[str, Any]:
        surface = session.surface
        actor = Actor.human(body.operator, body.epoch)
        try:
            if body.kind == "click" and body.x is not None and body.y is not None:
                await surface.human_click(body.x, body.y, actor=actor)
            elif body.kind == "type" and body.text is not None:
                await surface.human_type(body.text, actor=actor)
            elif body.kind == "press" and body.key:
                await surface.human_press(body.key, actor=actor)
            elif body.kind == "dialog" and body.accept is not None:
                await surface.answer_dialog(body.accept, actor=actor)
            else:
                raise HTTPException(422, "incomplete input command")
        except ControlError as exc:
            raise HTTPException(409, str(exc)) from exc
        await asyncio.sleep(0.2)
        return {"ok": True}

    @router.post("/interventions/{intervention_id}/resolve")
    async def resolve(intervention_id: str, body: ResolveBody, session: Any = live_session) -> dict[str, Any]:
        try:
            session.broker.resolve(intervention_id, body.operator, body.epoch, body.resolution, body.note)
        except KeyError as exc:
            raise HTTPException(404, str(exc)) from exc
        except (ValueError, ControlError) as exc:
            raise HTTPException(409, str(exc)) from exc
        return {"ok": True, "control": session.control.snapshot()}

    return router


def build_console(session: LiveSession) -> FastAPI:
    """The standalone console for one session (``rote replay --escalation wait``)."""
    app = FastAPI(title="rote operator console", docs_url="/api/docs", redoc_url=None)

    @app.get("/", response_class=HTMLResponse)
    async def index() -> str:
        return CONSOLE_HTML

    app.include_router(operator_router(lambda: session), prefix="/api")
    return app


class _EmbeddedServer(uvicorn.Server):
    """uvicorn without signal handling, so Ctrl+C still reaches the CLI."""

    @contextlib.contextmanager
    def capture_signals(self) -> Iterator[None]:
        yield


class ConsoleServer:
    def __init__(self, app: FastAPI, host: str, port: int):
        self.server = _EmbeddedServer(uvicorn.Config(app, host=host, port=port, log_level="warning", lifespan="off"))
        self.task: asyncio.Task[None] | None = None

    async def start(self) -> None:
        self.task = asyncio.create_task(self.server.serve())
        for _ in range(100):
            if self.server.started:
                return
            if self.task.done():
                self.task.result()
            await asyncio.sleep(0.05)

    async def stop(self) -> None:
        self.server.should_exit = True
        if self.task is not None:
            with contextlib.suppress(Exception):
                await asyncio.wait_for(self.task, 5)


CONSOLE_HTML = """<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Operator Console</title>
<style>
:root{--bg:#f6f5f1;--card:#fff;--fg:#1c1c1a;--muted:#6d6c66;--line:#e2e0d8;--accent:#1f5fa8;--ok:#1f7a4d;--warn:#a86a00;--bad:#b3261e}
@media (prefers-color-scheme:dark){:root{--bg:#141413;--card:#1d1d1b;--fg:#ecebe5;--muted:#9d9c95;--line:#2f2e2a;--accent:#6aa5ec}}
*{box-sizing:border-box}[hidden]{display:none!important}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 ui-sans-serif,system-ui,-apple-system,Segoe UI,sans-serif}
header{display:flex;gap:12px;align-items:center;flex-wrap:wrap;padding:12px 16px;border-bottom:1px solid var(--line);background:var(--card)}
header h1{font-size:16px;margin:0}header .sub{color:var(--muted);font-size:13px}.badge{margin-left:auto;padding:3px 10px;border-radius:999px;font-weight:600;font-size:12px;color:#fff}
.automated{background:var(--ok)}.awaiting_human{background:var(--warn)}.human{background:var(--accent)}
main{display:grid;grid-template-columns:minmax(0,1fr) 360px;gap:16px;padding:16px;max-width:1500px;margin:0 auto}
@media (max-width:900px){main{grid-template-columns:1fr}}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px}.card h2{font-size:14px;margin:0 0 8px}
#live{width:100%;border:1px solid var(--line);border-radius:6px;display:block;background:#000}#live.interactive{cursor:crosshair;outline:2px solid var(--accent)}
.muted{color:var(--muted)}.chip{display:inline-block;font-family:ui-monospace,Menlo,monospace;font-size:12px;padding:1px 6px;border-radius:4px;background:var(--bg);border:1px solid var(--line)}
button{font:inherit;padding:6px 12px;border-radius:6px;border:1px solid var(--line);background:var(--bg);color:var(--fg);cursor:pointer}
button.primary{background:var(--accent);border-color:var(--accent);color:#fff}button:disabled{opacity:.5;cursor:not-allowed}
input,select,textarea{font:inherit;padding:6px 8px;border-radius:6px;border:1px solid var(--line);background:var(--bg);color:var(--fg);width:100%}
.row{display:flex;gap:6px;margin:6px 0;flex-wrap:wrap}.row>*{flex:1}.stack>*+*{margin-top:10px}
ol{padding-left:18px;margin:6px 0}li{margin:2px 0;font-size:13px}details pre{white-space:pre-wrap;font-size:11px;max-height:260px;overflow:auto}
.dialog{border:1px solid var(--warn);border-radius:8px;padding:8px;margin-top:8px}
</style></head><body>
<header><h1>rote · operator console</h1><span class="sub" id="run"></span><span class="badge" id="lease">…</span></header>
<main>
 <section class="card"><h2>Live session <span class="muted" id="livehint">(read-only until you take control)</span></h2>
  <img id="live" alt="Live view of the automated browser session">
  <div id="dialog"></div>
  <div class="row" id="inputs" hidden><input id="text" placeholder="Text to type into the focused field">
   <button onclick="send({kind:'type',text:val('text')})">Type</button>
   <button onclick="send({kind:'press',key:'Tab'})">Tab</button><button onclick="send({kind:'press',key:'Enter'})">Enter</button>
   <button onclick="send({kind:'press',key:'Escape'})">Esc</button></div>
 </section>
 <aside class="stack">
  <div class="card" id="intervention"><h2>Intervention</h2><p class="muted">None. Automation is in control.</p></div>
  <div class="card"><h2>History</h2><ol id="history"></ol></div>
 </aside>
</main>
<script>
let state=null, me=localStorage.getItem('rote.operator')||'operator', epoch=null;
const val=id=>document.getElementById(id).value;
const esc=s=>String(s??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
async function api(path,body){const r=await fetch(path,body?{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}:{});
 if(!r.ok){const t=await r.text();alert(t);throw new Error(t)} return r.status===204?null:r.json()}
function mine(){return state&&state.control.state==='human'&&state.control.holder===me&&epoch===state.control.epoch}
async function claim(id){me=val('opname')||me;localStorage.setItem('rote.operator',me);const r=await api(`/api/interventions/${id}/claim`,{operator:me});epoch=r.epoch;refresh()}
async function resolve(id){const res=document.querySelector('input[name=res]:checked');if(!res)return alert('Choose how to hand back');
 await api(`/api/interventions/${id}/resolve`,{operator:me,epoch,resolution:res.value,note:val('note')});epoch=null;refresh()}
async function send(cmd){if(!mine())return;await api('/api/input',{operator:me,epoch,...cmd});document.getElementById('text').value='';tick()}
document.getElementById('live').addEventListener('click',e=>{if(!mine())return;const img=e.target;
 send({kind:'click',x:e.offsetX*img.naturalWidth/img.clientWidth,y:e.offsetY*img.naturalHeight/img.clientHeight})});
let lastSig='';
function keepInputs(){const note=document.getElementById('note'),op=document.getElementById('opname'),res=document.querySelector('input[name=res]:checked');
 return {note:note&&note.value,op:op&&op.value,res:res&&res.value,focus:document.activeElement&&document.activeElement.id}}
function restoreInputs(k){if(k.note!=null&&document.getElementById('note'))document.getElementById('note').value=k.note;
 if(k.op!=null&&document.getElementById('opname'))document.getElementById('opname').value=k.op;
 if(k.res){const r=document.querySelector(`input[name=res][value="${k.res}"]`);if(r)r.checked=true}
 if(k.focus&&document.getElementById(k.focus))document.getElementById(k.focus).focus()}
function render(){const s=state,c=s.control;document.getElementById('run').textContent=`${s.run.kind} · ${s.run.subject} · tenant ${s.run.tenant}`;
 const lease=document.getElementById('lease');lease.className='badge '+c.state;lease.textContent=c.state==='human'?`human: ${c.holder} (epoch ${c.epoch})`:c.state.replace('_',' ');
 const live=document.getElementById('live');live.classList.toggle('interactive',mine());document.getElementById('inputs').hidden=!mine();
 document.getElementById('livehint').textContent=mine()?'(you are in control — click the screen to interact)':'(read-only until you take control)';
 // Only rebuild panels when something changed, and keep whatever the operator is typing.
 const sig=JSON.stringify([s.active,s.history,s.dialog,mine()]);if(sig===lastSig)return;lastSig=sig;const kept=keepInputs();
 const d=s.dialog;document.getElementById('dialog').innerHTML=d?`<div class="dialog"><b>Native ${esc(d.kind)} dialog:</b> ${esc(d.message)}
  ${mine()?'<div class="row"><button onclick="send({kind:\\'dialog\\',accept:true})">Accept</button><button onclick="send({kind:\\'dialog\\',accept:false})">Dismiss</button></div>':''}</div>`:'';
 const a=s.active,box=document.getElementById('intervention');
 if(!a){box.innerHTML='<h2>Intervention</h2><p class="muted">None. Automation is in control.</p>'}else{
  const actions=(a.human_actions||[]).map(h=>`<li>${esc(h.description)}</li>`).join('')||'<li class="muted">none yet</li>';
  const res=a.allowed_resolutions.map(r=>`<label><input type="radio" name="res" value="${r}" style="width:auto"> ${r.replace('_',' ')}</label>`).join('<br>');
  box.innerHTML=`<h2>Intervention <span class="chip">${esc(a.id)}</span></h2>
   <div><span class="chip">${esc(a.reason_code)}</span> <span class="muted">${esc(a.status)}</span></div>
   <p>${esc(a.reason)}</p><p class="muted">${esc(a.run_kind)} · ${esc(a.subject)}${a.step_id?` · step <b>${esc(a.step_id)}</b>: ${esc(a.step_intent)}`:''}</p>
   <img src="/api/interventions/${a.id}/screenshot" style="width:100%;border-radius:6px;border:1px solid var(--line)" alt="Screen at escalation (masked)">
   <details><summary>Screen text at escalation</summary><pre>${esc(a.observation)}</pre></details>
   ${a.status==='open'?`<div class="row"><input id="opname" value="${esc(me)}" aria-label="Operator name"><button class="primary" id="claim" onclick="claim('${a.id}')">Take control</button></div>`:''}
   ${a.status==='claimed'?`<h2>Your actions (recorded)</h2><ol>${actions}</ol>
     ${mine()?`<div class="stack"><div>${res}</div><textarea id="note" rows="2" placeholder="Note for the audit log"></textarea>
     <button class="primary" id="handback" onclick="resolve('${a.id}')">Hand control back</button></div>`:'<p class="muted">Claimed by another operator.</p>'}`:''}`}
 document.getElementById('history').innerHTML=s.history.map(h=>`<li><span class="chip">${esc(h.reason_code)}</span> ${esc(h.status)} ${h.resolution?'→ '+esc(h.resolution):''} ${h.claimed_by?'by '+esc(h.claimed_by):''}</li>`).join('')||'<li class="muted">none</li>';
 restoreInputs(kept)}
async function refresh(){state=await api('/api/state');if(state.control.state!=='human')epoch=null;render()}
async function tick(){const img=document.getElementById('live');const r=await fetch('/api/live.jpg?'+Date.now());if(r.status===200){img.src=URL.createObjectURL(await r.blob())}}
setInterval(async()=>{await refresh().catch(()=>{});},1000);setInterval(()=>tick().catch(()=>{}),900);refresh();tick();
</script></body></html>
"""
