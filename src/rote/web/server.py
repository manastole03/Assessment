"""`rote engine`: the engine's internal API, called by the control plane (backend/).

The control plane owns users, roles, sessions and audit, and serves the web UI; this service owns
execution: the capability library, replays, discoveries, probes, live sessions and their evidence.
It is not exposed to browsers. Two layers keep it that way:

* **Engine token.** When ``ROTE_ENGINE_TOKEN`` is set, every request except ``/api/health`` must carry
  it in ``X-Engine-Token`` (constant-time compare). ``rote engine`` refuses to listen beyond loopback
  without one.
* **Host check.** Requests must name the host the engine is bound to (DNS-rebinding protection); binding
  0.0.0.0 inside a private network opts out, and the token then does the work.

No error ever echoes a filesystem path back to the caller. The typed contract is at /api/docs
(OpenAPI at /api/openapi.json). Agents reach capabilities through the control plane, which relays
POST /api/capabilities/{id}/invoke and the MCP endpoint at /mcp (see web/agents.py).
"""

from __future__ import annotations

import asyncio
import contextlib
import hmac
import json
import logging
import os
import re
import uuid
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

import httpx
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from starlette.middleware.trustedhost import TrustedHostMiddleware
from starlette.routing import Route
from starlette.types import ASGIApp, Receive, Scope, Send

from .. import __version__
from ..artifact.resolve import resolve
from ..artifact.schema import Capability, Handler, Review
from ..artifact.store import Library, to_yaml, version_key
from ..catalog import catalog, to_tool
from ..handoff.console import operator_router
from ..policy.policy import Policy
from ..replay.engine import describe_condition
from ..runtime import LiveSession, Settings
from .agents import AgentGateway
from .evals import EvalService
from .models import (
    ApiError,
    Approved,
    ApproveRequest,
    CapabilityDetail,
    CapabilitySummary,
    DemoMember,
    EvidenceIndex,
    Health,
    PolicyView,
    RunDetail,
    RunStarted,
    RunSummary,
    Status,
)
from .runs import ActiveRun, RunManager, StartRun, read_events, summarize_dir

log = logging.getLogger("rote.web")

ENGINE_TOKEN_HEADER = b"x-engine-token"
TOKEN_EXEMPT_PATHS = frozenset({"/api/health"})

# Synthetic members of the bundled LegacyCore mock, offered as one-click inputs in the UI.
DEMO_MEMBERS = [
    {"member_id": "12345", "label": "Happy path", "expect": "succeeded"},
    {"member_id": "20417", "label": "Share rows re-ordered", "expect": "succeeded"},
    {"member_id": "31008", "label": "No savings share", "expect": "NO_SAVINGS_ACCOUNT"},
    {"member_id": "40404", "label": "Restricted account", "expect": "ACCESS_RESTRICTED"},
    {"member_id": "99999", "label": "No such member", "expect": "MEMBER_NOT_FOUND"},
    {"member_id": "12-AB", "label": "Malformed input", "expect": "INVALID_INPUT"},
]

TAGS = [
    {"name": "status", "description": "Liveness, environment and reachability of each tenant's target app."},
    {"name": "capabilities", "description": "The library: review sheets, tenant-effective artifacts, approval."},
    {"name": "agents", "description": "Call an approved capability and get its result contract (also over MCP)."},
    {"name": "runs", "description": "Start replays, discoveries and probes; follow their events; read evidence."},
    {"name": "operator", "description": "Human handoff on a live run: claim the lease, act, hand back."},
    {"name": "evals", "description": "Eval datasets, results, and eval runs."},
    {"name": "demo", "description": "Fault injection and sample members for the bundled LegacyCore mock."},
]

NOT_FOUND: dict[int | str, dict[str, Any]] = {404: {"model": ApiError, "description": "Not found"}}


def allowed_hosts_for(bind_url: str) -> list[str]:
    """Hosts a request may name: loopback always, plus the bound host. Binding 0.0.0.0 opts out."""
    host = urlsplit(bind_url).hostname or "127.0.0.1"
    if host in ("0.0.0.0", "::"):
        return ["*"]
    return sorted({"127.0.0.1", "localhost", "::1", host})


class EngineTokenMiddleware:
    """Service-to-service authentication: every request must carry the shared engine token.

    Pure ASGI (not BaseHTTPMiddleware), so Server-Sent Events and file responses stream untouched.
    """

    def __init__(self, app: ASGIApp, token: str) -> None:
        self.app = app
        self.token = token.encode()

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http" or scope["path"] in TOKEN_EXEMPT_PATHS:
            await self.app(scope, receive, send)
            return
        presented = dict(scope["headers"]).get(ENGINE_TOKEN_HEADER, b"")
        if hmac.compare_digest(presented, self.token):
            await self.app(scope, receive, send)
            return
        response = JSONResponse(status_code=401, content={"detail": "a valid engine token is required"})
        await response(scope, receive, send)


def create_app(
    settings: Settings,
    public_url: str,
    *,
    bind_url: str | None = None,
    engine_token: str | None = None,
    run_link_base: str = "/api/runs",
) -> FastAPI:
    """The engine API.

    ``public_url`` is where people reach the UI (links in notifications and agent results);
    ``bind_url`` is where this service listens (host checks; defaults to ``public_url``).
    """
    manager = RunManager(settings, public_url)
    evals = EvalService(settings)
    hosts = allowed_hosts_for(bind_url or public_url)
    agents = AgentGateway(settings, manager, allowed_hosts=hosts, run_link_base=run_link_base)
    root = str(settings.root.resolve())

    def public(message: str) -> str:
        """Error text for clients: no absolute paths, no OS error prefixes."""
        message = re.sub(r"^\[Errno \d+\] [^:]+: ", "", message)
        return message.replace(root + os.sep, "").replace(root, ".")

    @asynccontextmanager
    async def lifespan(_: FastAPI) -> AsyncIterator[None]:
        async with agents.mcp_sessions.run():
            yield
            await evals.shutdown()
            await manager.shutdown()

    app = FastAPI(
        title="rote",
        version=__version__,
        summary="Record once, replay by rote: author, review, run and operate computer-use capabilities.",
        docs_url="/api/docs",
        redoc_url=None,
        openapi_url="/api/openapi.json",
        openapi_tags=TAGS,
        lifespan=lifespan,
    )
    app.add_middleware(TrustedHostMiddleware, allowed_hosts=hosts)
    if engine_token:
        app.add_middleware(EngineTokenMiddleware, token=engine_token)
    app.state.manager = manager

    @app.exception_handler(FileNotFoundError)
    async def not_found(_: Request, exc: FileNotFoundError) -> JSONResponse:
        return JSONResponse(status_code=404, content={"detail": public(str(exc))})

    @app.exception_handler(PermissionError)
    async def forbidden(_: Request, exc: PermissionError) -> JSONResponse:
        return JSONResponse(status_code=403, content={"detail": public(str(exc))})

    @app.exception_handler(Exception)
    async def unexpected(request: Request, exc: Exception) -> JSONResponse:
        error_id = uuid.uuid4().hex[:12]
        log.error("unhandled error %s on %s %s", error_id, request.method, request.url.path, exc_info=exc)
        return JSONResponse(
            status_code=500, content={"detail": f"internal error {error_id}; see the server log", "error_id": error_id}
        )

    def library() -> Library:
        return Library(settings.root)

    # ======================================================================== status

    @app.get("/api/health", response_model=Health, tags=["status"], summary="Liveness (no network calls)")
    async def health() -> Health:
        return Health(version=__version__)

    @app.get("/api/status", response_model=Status, tags=["status"], summary="Environment and tenant reachability")
    async def status() -> dict[str, Any]:
        lib = library()

        async def reachable(url: str) -> bool:
            try:
                async with httpx.AsyncClient(timeout=1.5) as client:
                    return (await client.get(url)).status_code < 500
            except httpx.HTTPError:
                return False

        tenants: list[dict[str, Any]] = []
        for tenant_cfg in lib.tenants():
            for app_id, binding in tenant_cfg.apps.items():
                tenants.append(
                    {
                        "id": tenant_cfg.id,
                        "name": tenant_cfg.name,
                        "app": app_id,
                        "base_url": binding.base_url,
                        "product_version": binding.product_version,
                        "overrides": len(binding.overrides),
                    }
                )
        checks = await asyncio.gather(*(reachable(t["base_url"] + "/signon.asp") for t in tenants))
        for row, ok in zip(tenants, checks, strict=True):
            row["reachable"] = ok
        return {
            "version": __version__,
            "model": settings.model,
            "effort": settings.effort,
            "has_api_key": bool(os.environ.get("ANTHROPIC_API_KEY")),
            "tenants": tenants,
            "active_runs": sum(1 for r in manager.active.values() if not r.finished.is_set()),
        }

    # ======================================================================== capabilities

    def summary(cap: Capability, versions: list[dict[str, str]]) -> dict[str, Any]:
        return {
            "id": cap.id,
            "version": cap.version,
            "title": cap.title,
            "description": cap.description,
            "status": cap.status,
            "kind": cap.kind,
            "side_effects": cap.side_effects,
            "idempotent": cap.idempotent,
            "requires_session": cap.requires_session,
            "inputs": {k: v.model_dump(mode="json") for k, v in cap.inputs.items()},
            "outputs": {k: v.model_dump(mode="json") for k, v in cap.outputs.items()},
            "outcomes": cap.outcome_codes(),
            "steps": len(cap.steps),
            "versions": versions,
            "provenance": cap.provenance.model_dump(mode="json"),
        }

    @app.get("/api/capabilities", response_model=list[CapabilitySummary], tags=["capabilities"])
    async def list_capabilities() -> list[dict[str, Any]]:
        lib = library()
        by_id: dict[str, list[Capability]] = {}
        for cap in lib.capabilities():
            by_id.setdefault(cap.id, []).append(cap)
        out = []
        for caps in by_id.values():
            caps.sort(key=lambda c: version_key(c.version))
            versions = [{"version": c.version, "status": c.status} for c in reversed(caps)]
            out.append(summary(caps[-1], versions))
        return sorted(out, key=lambda c: (c["kind"] != "session", c["id"]))

    @app.get(
        "/api/capabilities/{capability_id}",
        response_model=CapabilityDetail,
        tags=["capabilities"],
        responses=NOT_FOUND,
        summary="Review sheet; with ?tenant, the effective artifact after overrides",
    )
    async def get_capability(
        capability_id: str, version: str | None = None, tenant: str | None = None
    ) -> dict[str, Any]:
        lib = library()
        known = lib.versions(capability_id)
        if version is not None and version not in known:
            raise HTTPException(404, f"{capability_id} has no version {version}")
        base = lib.capability(f"{capability_id}@{version}" if version else capability_id)
        versions = [{"version": v, "status": lib.capability(f"{capability_id}@{v}").status} for v in reversed(known)]
        effective, layers, effective_hash = base, [], None
        app_profile = lib.app(base.app.id)
        handlers: list[tuple[str, Handler]] = [("capability", h) for h in base.handlers]
        handlers += [("app", h) for h in app_profile.handlers]
        if tenant:
            rc = resolve(base, app_profile, lib.tenant(tenant))
            effective, layers, effective_hash = rc.capability, rc.layers, rc.effective_hash
            handlers = [(b.source, b.handler) for b in rc.handlers]
        overridden: dict[str, int] = {}
        for base_step, step in zip(base.steps, effective.steps, strict=True):
            base_target, target = getattr(base_step.action, "target", None), getattr(step.action, "target", None)
            if base_target is None or target is None or base_target == target:
                continue
            tail = target.locators[len(target.locators) - len(base_target.locators) :]
            overridden[step.id] = (
                len(target.locators) - len(base_target.locators)
                if tail == base_target.locators
                else len(target.locators)
            )
        return {
            "summary": summary(effective, versions),
            "capability": effective.model_dump(mode="json", by_alias=True, exclude_none=True),
            "yaml": to_yaml(effective),
            "tenant": tenant,
            "layers": layers,
            "effective_hash": effective_hash,
            "overridden": overridden,
            "handlers": [
                {
                    "source": source,
                    **handler.model_dump(mode="json", exclude_none=True),
                    "when_text": [describe_condition(c) for c in handler.when],
                    "unless_text": [describe_condition(c) for c in handler.unless],
                }
                for source, handler in handlers
            ],
            "expect_text": {s.id: [describe_condition(c) for c in s.expect] for s in effective.steps},
            "success_text": [describe_condition(c) for c in effective.success.all_of],
            "tool": to_tool(effective) if effective.kind == "task" else None,
        }

    @app.post(
        "/api/capabilities/{ref}/approve",
        response_model=Approved,
        tags=["capabilities"],
        responses=NOT_FOUND,
        summary="Approve a reviewed version (draft → approved)",
    )
    async def approve(ref: str, body: ApproveRequest) -> Approved:
        reviewer = body.reviewer.strip()
        if not reviewer:
            raise HTTPException(422, "reviewer is required")
        lib = library()
        cap = lib.capability(ref)
        if cap.status == "deprecated":
            raise HTTPException(409, f"{cap.ref} is deprecated and cannot be approved")
        cap.status = "approved"
        cap.provenance.review = Review(reviewed_by=reviewer, reviewed_at=datetime.now(UTC), notes=body.notes)
        lib.save(Capability.model_validate(cap.model_dump(by_alias=True)))
        return Approved(ok=True, ref=cap.ref)

    @app.get("/api/catalog", tags=["agents"], summary="Approved capabilities as tool definitions (Anthropic format)")
    async def get_catalog() -> list[dict[str, Any]]:
        return catalog(library().capabilities())

    @app.get(
        "/api/policy", response_model=PolicyView, tags=["capabilities"], summary="Guardrails, app profiles, tenants"
    )
    async def get_policy() -> dict[str, Any]:
        lib = library()
        apps = sorted({p.parent.name for p in lib.capabilities_dir.glob("*/app.yaml")})
        return {
            "policy": Policy.load(settings.policy_path).model_dump(mode="json", by_alias=True),
            "apps": [lib.app(a).model_dump(mode="json", by_alias=True, exclude_none=True) for a in apps],
            "tenants": [t.model_dump(mode="json", by_alias=True, exclude_none=True) for t in lib.tenants()],
        }

    app.include_router(agents.router)

    # ======================================================================== runs

    def run_dir(run_id: str) -> tuple[Path, str]:
        if "/" in run_id or ".." in run_id:
            raise HTTPException(400, "bad run id")
        active = manager.active.get(run_id)
        if active is not None and active.dir is not None:
            return active.dir, "active"
        for base, source in ((settings.runs_dir, "runs"), (settings.root / "evidence", "evidence")):
            if (base / run_id / "events.jsonl").exists():
                return base / run_id, source
        # Evidence folders have friendly names; artifacts' provenance cites the original run id.
        evidence = settings.root / "evidence"
        for result in evidence.glob("*/result.json") if evidence.exists() else []:
            if json.loads(result.read_text()).get("run_id") == run_id:
                return result.parent, "evidence"
        raise HTTPException(404, f"no run {run_id}")

    def active_summary(run: ActiveRun) -> dict[str, Any]:
        return {
            "id": run.id,
            "source": "active",
            "kind": run.kind,
            "subject": run.subject,
            "tenant": run.tenant,
            "status": run.status,
            "started_at": run.started_at.isoformat(),
            "duration_ms": None,
            "active": not run.finished.is_set(),
        }

    @app.get("/api/runs", response_model=list[RunSummary], tags=["runs"], summary="Live, recorded and evidence runs")
    async def list_runs() -> list[dict[str, Any]]:
        seen: set[str] = set()
        out = []
        for run in manager.active.values():
            if run.id:
                seen.add(run.id)
                out.append(active_summary(run))
        for base, source in ((settings.runs_dir, "runs"), (settings.root / "evidence", "evidence")):
            if not base.exists():
                continue
            for path in base.iterdir():
                if path.is_dir() and path.name not in seen:
                    item = summarize_dir(path, source)
                    if item:
                        out.append(item)
        out.sort(key=lambda r: r.get("started_at") or "", reverse=True)
        return out

    @app.post(
        "/api/runs",
        response_model=RunStarted,
        status_code=201,
        tags=["runs"],
        responses={400: {"model": ApiError}, **NOT_FOUND},
        summary="Start a replay, discovery or probe in the background",
    )
    async def start_run(body: StartRun) -> RunStarted:
        lib = library()
        lib.tenant(body.tenant)  # 404 before anything starts
        if body.kind != "discovery" and body.capability:
            lib.capability(body.capability)
        try:
            run = await manager.start(body)
        except (ValueError, KeyError) as exc:
            raise HTTPException(400, public(str(exc).strip("'\""))) from exc
        assert run.id is not None
        return RunStarted(id=run.id)

    @app.get("/api/runs/{run_id}", response_model=RunDetail, tags=["runs"], responses=NOT_FOUND)
    async def get_run(run_id: str) -> dict[str, Any]:
        directory, source = run_dir(run_id)
        active = manager.active.get(run_id)
        info = active_summary(active) if active else summarize_dir(directory, source) or {}
        result_path = directory / "result.json"
        texts = {
            name: (directory / name).read_text()
            for name in ("artifact.yaml", "probed-handler.yaml", "outcome-handler.yaml")
            if (directory / name).exists()
        }
        interventions = (
            [json.loads(p.read_text()) for p in sorted((directory / "interventions").glob("*.json"))]
            if (directory / "interventions").exists()
            else []
        )
        for item in interventions:
            item.pop("observation", None)
        return {
            **info,
            "result": json.loads(result_path.read_text()) if result_path.exists() else None,
            "caller": active.caller if active else None,
            "error": active.error if active else None,
            "files": texts,
            "interventions": interventions,
            "has_report": (directory / "report.html").exists(),
        }

    @app.get(
        "/api/runs/{run_id}/stream",
        tags=["runs"],
        responses=NOT_FOUND,
        summary="Server-Sent Events: buffered history, then live events, then `end`",
    )
    async def stream_run(run_id: str) -> StreamingResponse:
        directory, _ = run_dir(run_id)
        active = manager.active.get(run_id)

        async def historic() -> AsyncIterator[dict[str, Any] | None]:
            for event in read_events(directory):
                yield event
            yield None

        source = manager.stream(active) if active else historic()

        async def body() -> AsyncIterator[str]:
            yield "retry: 3000\n\n"
            async for event in source:
                if event is None:
                    yield "event: end\ndata: {}\n\n"
                    return
                yield f"event: run\ndata: {json.dumps(event, default=str)}\n\n"

        return StreamingResponse(
            body(), media_type="text/event-stream", headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"}
        )

    @app.get(
        "/api/runs/{run_id}/files/{path:path}", tags=["runs"], responses=NOT_FOUND, summary="A run's evidence file"
    )
    async def run_file(run_id: str, path: str) -> FileResponse:
        directory, _ = run_dir(run_id)
        target = (directory / path).resolve()
        if directory.resolve() not in target.parents or not target.is_file():
            raise HTTPException(404, "no such file")
        return FileResponse(target)

    def session_for(run_id: str) -> LiveSession:
        run = manager.active.get(run_id)
        if run is None or run.session is None:
            raise HTTPException(409, "this run is not live; its session has closed")
        return run.session

    app.include_router(operator_router(session_for), prefix="/api/runs/{run_id}/operator", tags=["operator"])

    # ======================================================================== evidence & demo

    @app.get("/api/evidence", response_model=EvidenceIndex, tags=["runs"], summary="The checked-in evidence index")
    async def evidence() -> dict[str, Any]:
        index = settings.root / "evidence" / "index.json"
        if not index.exists():
            return {"mode": None, "runs": []}
        return dict(json.loads(index.read_text()))

    @app.get("/api/demo/members", response_model=list[DemoMember], tags=["demo"])
    async def demo_members() -> list[dict[str, str]]:
        return DEMO_MEMBERS

    async def bank_call(tenant: str, faults: dict[str, Any] | None) -> dict[str, Any]:
        library().tenant(tenant)  # 404 for an unknown tenant, before touching the bank
        try:
            return await (manager.get_faults(tenant) if faults is None else manager.set_faults(tenant, faults))
        except httpx.HTTPStatusError as exc:
            # The bank answered: pass its verdict through (e.g. 422 for an invalid fault value).
            detail: Any = exc.response.text
            with contextlib.suppress(ValueError):
                detail = exc.response.json().get("detail", detail)
            raise HTTPException(exc.response.status_code, detail) from exc
        except httpx.HTTPError as exc:
            raise HTTPException(503, "the LegacyCore mock is unreachable; start it with `make bank`") from exc

    @app.get("/api/demo/faults/{tenant}", tags=["demo"], responses={503: {"model": ApiError}, **NOT_FOUND})
    async def get_faults(tenant: str) -> dict[str, Any]:
        return await bank_call(tenant, None)

    @app.put("/api/demo/faults/{tenant}", tags=["demo"], responses={503: {"model": ApiError}, **NOT_FOUND})
    async def put_faults(tenant: str, faults: dict[str, Any]) -> dict[str, Any]:
        return await bank_call(tenant, faults)

    app.include_router(evals.router)

    # ======================================================================== MCP

    # Streamable HTTP; mounted as a plain ASGI route so it shares this app's lifespan, host and token checks.
    app.router.routes.append(Route("/mcp", endpoint=agents.mcp_app, methods=["GET", "POST", "DELETE"]))

    return app
