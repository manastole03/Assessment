"""The agent-facing surface: call an approved capability and get its result contract back.

Two front doors, one path:

* **REST** — ``POST /api/capabilities/{id}/invoke`` holds the request open until the replay finishes
  (200 with the result contract) or ``wait_s`` runs out (202 with the run to poll).
* **MCP** — ``/mcp`` (Streamable HTTP) lists every approved task capability as a tool, generated from the
  same catalog ``rote catalog`` prints, and a tool call is the same invocation.

Every call is checked before a browser starts (unknown capability or tenant → 404, nothing approved →
409, bad inputs → 422 listing every problem), then runs through the UI's run manager: it appears live
in the web UI with full evidence, and if it was started with ``escalation: wait`` an operator can take
over the very session the agent is waiting on.
"""

from __future__ import annotations

import asyncio
import json
from typing import Any

import mcp_types as types
from fastapi import APIRouter, HTTPException
from fastapi.responses import JSONResponse
from mcp.server.context import ServerRequestContext
from mcp.server.lowlevel import Server
from mcp.server.streamable_http_manager import StreamableHTTPASGIApp, StreamableHTTPSessionManager
from mcp.server.transport_security import TransportSecuritySettings

from .. import __version__
from ..artifact.schema import Capability
from ..artifact.store import Library, version_key
from ..catalog import capability_id as capability_from_tool
from ..catalog import to_tool
from ..replay.values import check_inputs
from ..runtime import Settings
from .models import ApiError, InputProblems, Invocation, InvokeRequest, Links
from .runs import RunManager, StartRun

MCP_INSTRUCTIONS = """\
Each tool is an approved back-office capability, replayed deterministically on a legacy core-banking \
application with no model in the loop. A call returns status 'succeeded' with typed outputs, \
'business_outcome' with a code (a legitimate answer such as MEMBER_NOT_FOUND, not an error), or \
'failed' with a failure code and whether retrying can help. Pass `tenant` to choose the institution."""


class InvocationError(Exception):
    def __init__(self, status_code: int, detail: str, problems: list[str] | None = None):
        super().__init__(detail)
        self.status_code = status_code
        self.detail = detail
        self.problems = problems or []


class AgentGateway:
    def __init__(
        self, settings: Settings, manager: RunManager, *, allowed_hosts: list[str], run_link_base: str = "/api/runs"
    ):
        self.settings = settings
        self.manager = manager
        self.run_link_base = run_link_base.rstrip("/")
        self.server = Server(
            "rote",
            version=__version__,
            title="rote capabilities",
            instructions=MCP_INSTRUCTIONS,
            on_list_tools=self._list_tools,
            on_call_tool=self._call_tool,
        )
        wildcard = "*" in allowed_hosts
        self.mcp_sessions = StreamableHTTPSessionManager(
            app=self.server,
            stateless=True,  # every tool call stands alone; nothing to resume
            json_response=True,
            security_settings=TransportSecuritySettings(
                enable_dns_rebinding_protection=not wildcard,
                allowed_hosts=[f"{h}:*" for h in allowed_hosts] + allowed_hosts,
                allowed_origins=[f"http://{h}:*" for h in allowed_hosts],
            ),
        )
        self.mcp_app = StreamableHTTPASGIApp(self.mcp_sessions)
        self.router = self._router()

    # ------------------------------------------------------------------ the one path

    def _library(self) -> Library:
        return Library(self.settings.root)

    def resolve(self, capability_id: str, tenant: str, inputs: dict[str, str]) -> Capability:
        """The latest approved version, after checking the tenant and every input. Raises InvocationError."""
        library = self._library()
        versions = library.versions(capability_id)
        if not versions:
            raise InvocationError(404, f"no capability named {capability_id!r}")
        approved = None
        for version in sorted(versions, key=version_key, reverse=True):
            candidate = library.capability(f"{capability_id}@{version}")
            if candidate.kind == "session":
                raise InvocationError(400, f"{capability_id} signs on for other capabilities; it is not invocable")
            if candidate.status == "approved":
                approved = candidate
                break
        if approved is None:
            raise InvocationError(409, f"{capability_id} has no approved version; review and approve it first")
        try:
            binding = library.tenant(tenant).apps.get(approved.app.id)
        except FileNotFoundError:
            raise InvocationError(404, f"unknown tenant {tenant!r}") from None
        if binding is None:
            raise InvocationError(400, f"tenant {tenant!r} has no {approved.app.id} binding")
        _, problems = check_inputs(approved.inputs, inputs)
        if problems:
            raise InvocationError(422, "the inputs do not match the capability's contract", problems)
        return approved

    def links(self, run_id: str) -> Links:
        return Links(run=f"{self.run_link_base}/{run_id}", ui=f"{self.manager.public_url}/runs/{run_id}")

    async def invoke(self, capability_id: str, request: InvokeRequest) -> Invocation:
        capability = self.resolve(capability_id, request.tenant, request.inputs)
        try:
            run = await self.manager.start(
                StartRun(
                    kind="replay",
                    tenant=request.tenant,
                    capability=capability.ref,
                    inputs=request.inputs,
                    escalation=request.escalation,
                )
            )
        except (ValueError, FileNotFoundError) as exc:
            raise InvocationError(503, f"the run could not start: {exc}") from exc
        assert run.id is not None
        try:
            await asyncio.wait_for(run.finished.wait(), timeout=request.wait_s)
        except TimeoutError:
            return Invocation(status="running", capability=capability.ref, run_id=run.id, links=self.links(run.id))
        if run.caller is None:
            raise InvocationError(502, run.error or "the run ended without a result")
        return Invocation.model_validate({**run.caller, "links": self.links(run.id)})

    # ------------------------------------------------------------------ REST

    def _router(self) -> APIRouter:
        router = APIRouter(tags=["agents"])
        errors: dict[int | str, dict[str, Any]] = {
            404: {"model": ApiError, "description": "Unknown capability or tenant"},
            409: {"model": ApiError, "description": "No approved version"},
            422: {"model": InputProblems, "description": "Inputs violate the contract (every problem listed)"},
        }

        @router.post(
            "/api/capabilities/{capability_id}/invoke",
            response_model=Invocation,
            response_model_exclude_none=True,
            responses={202: {"model": Invocation, "description": "Still running; poll links.run"}, **errors},
            summary="Invoke an approved capability and wait for its result",
        )
        async def invoke(capability_id: str, body: InvokeRequest) -> Any:
            try:
                result = await self.invoke(capability_id, body)
            except InvocationError as exc:
                if exc.problems:
                    return JSONResponse(
                        status_code=exc.status_code, content={"detail": exc.detail, "problems": exc.problems}
                    )
                raise HTTPException(exc.status_code, exc.detail) from exc
            if result.status == "running":
                return JSONResponse(
                    status_code=202,
                    content=result.model_dump(mode="json", exclude_none=True),
                    headers={"Location": result.links.run},
                )
            return result

        @router.get("/api/agents/tools", summary="The MCP tool list (approved task capabilities)")
        async def tools() -> list[dict[str, Any]]:
            return [t.model_dump(mode="json", by_alias=True, exclude_none=True) for t in self._tools()]

        return router

    # ------------------------------------------------------------------ MCP

    def _tools(self) -> list[types.Tool]:
        """Approved task capabilities (latest approved version of each), as MCP tools: the catalog's rule."""
        library = self._library()
        tenants = [t.id for t in library.tenants()]
        approved: dict[str, Capability] = {}
        for cap in library.capabilities():
            if cap.kind == "task" and cap.status == "approved":
                current = approved.get(cap.id)
                if current is None or version_key(cap.version) > version_key(current.version):
                    approved[cap.id] = cap
        tools = []
        for capability in sorted(approved.values(), key=lambda c: c.id):
            definition = to_tool(capability)
            schema = definition["input_schema"]
            if "tenant" not in schema["properties"]:
                schema["properties"]["tenant"] = {
                    "type": "string",
                    "enum": tenants,
                    "default": tenants[0] if tenants else "acme",
                    "description": "Institution to run against.",
                }
            tools.append(
                types.Tool(
                    name=definition["name"],
                    title=capability.title,
                    description=definition["description"],
                    input_schema=schema,
                    annotations=types.ToolAnnotations(
                        title=capability.title,
                        read_only_hint=capability.side_effects == "read_only",
                        destructive_hint=capability.side_effects == "irreversible",
                        idempotent_hint=capability.idempotent,
                        open_world_hint=False,
                    ),
                )
            )
        return tools

    async def _list_tools(
        self, ctx: ServerRequestContext[Any], params: types.PaginatedRequestParams | None
    ) -> types.ListToolsResult:
        return types.ListToolsResult(tools=self._tools())

    async def _call_tool(
        self, ctx: ServerRequestContext[Any], params: types.CallToolRequestParams
    ) -> types.CallToolResult:
        arguments = dict(params.arguments or {})
        tenant = str(arguments.pop("tenant", None) or "acme")
        inputs = {k: str(v) for k, v in arguments.items()}
        try:
            result = await self.invoke(
                capability_from_tool(params.name), InvokeRequest(tenant=tenant, inputs=inputs, wait_s=600)
            )
        except InvocationError as exc:
            text = exc.detail + ("".join(f"\n- {p}" for p in exc.problems) if exc.problems else "")
            return types.CallToolResult(content=[types.TextContent(type="text", text=text)], is_error=True)
        payload = result.model_dump(mode="json", exclude_none=True)
        return types.CallToolResult(
            content=[types.TextContent(type="text", text=json.dumps(payload, indent=2))],
            structured_content=payload,
            is_error=result.status == "failed",
        )
