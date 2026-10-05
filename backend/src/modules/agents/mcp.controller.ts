import { Controller, Delete, Get, HttpStatus, Post, Req, Res } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';

import { Role } from '../../common/constants/roles.js';
import { ApiAuth, ApiErrors } from '../../common/decorators/api-docs.decorators.js';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { MinRole, RawResponse } from '../../common/decorators/metadata.decorators.js';
import type {
  AppRequest,
  AuthenticatedUser,
} from '../../common/interfaces/authenticated-user.interface.js';
import { EngineProxyService } from '../../engine/engine-proxy.service.js';
import { AgentsService } from './agents.service.js';

function parseJson(text: string): unknown {
  try {
    return text ? (JSON.parse(text) as unknown) : null;
  } catch {
    return null;
  }
}

/** MCP transport headers worth forwarding; everything else (cookies, auth) stops here. */
const FORWARDED = [
  'content-type',
  'accept',
  'mcp-session-id',
  'mcp-protocol-version',
  'last-event-id',
];

const NOT_ENVELOPED =
  'JSON-RPC 2.0 per the MCP specification; not enveloped. Requires OPERATOR (an API key for MCP clients).';

/**
 * MCP over Streamable HTTP, authenticated. The engine speaks MCP; this endpoint adds identity
 * (an API key: `Authorization: Bearer rote_...`), OPERATOR authorization, rate limits and audit,
 * then relays the protocol unchanged. Connect with
 * `claude mcp add --transport http rote <origin>/api/v1/mcp --header "Authorization: Bearer <key>"`.
 */
@ApiTags('agents')
@ApiAuth()
@RawResponse()
@MinRole(Role.OPERATOR)
@Controller('mcp')
export class McpController {
  constructor(
    private readonly proxy: EngineProxyService,
    private readonly agents: AgentsService,
  ) {}

  @Post()
  @ApiOperation({
    summary: 'MCP: send a JSON-RPC request (Streamable HTTP)',
    description: NOT_ENVELOPED,
  })
  @ApiErrors(HttpStatus.UNAUTHORIZED, HttpStatus.FORBIDDEN)
  post(
    @CurrentUser() actor: AuthenticatedUser,
    @Req() req: AppRequest,
    @Res() res: Response,
  ): Promise<void> {
    return this.relay('POST', actor, req, res);
  }

  @Get()
  @ApiOperation({
    summary: 'MCP: open the server-to-client event stream',
    description: NOT_ENVELOPED,
  })
  @ApiErrors(HttpStatus.UNAUTHORIZED, HttpStatus.FORBIDDEN)
  get(
    @CurrentUser() actor: AuthenticatedUser,
    @Req() req: AppRequest,
    @Res() res: Response,
  ): Promise<void> {
    return this.relay('GET', actor, req, res);
  }

  @Delete()
  @ApiOperation({ summary: 'MCP: end the session', description: NOT_ENVELOPED })
  @ApiErrors(HttpStatus.UNAUTHORIZED, HttpStatus.FORBIDDEN)
  delete(
    @CurrentUser() actor: AuthenticatedUser,
    @Req() req: AppRequest,
    @Res() res: Response,
  ): Promise<void> {
    return this.relay('DELETE', actor, req, res);
  }

  private async relay(
    method: 'GET' | 'POST' | 'DELETE',
    actor: AuthenticatedUser,
    req: AppRequest,
    res: Response,
  ): Promise<void> {
    const headers: Record<string, string> = {};
    for (const name of FORWARDED) {
      const value = req.header(name);
      if (value) headers[name] = value;
    }
    const body = method === 'POST' ? JSON.stringify(req.body ?? {}) : undefined;
    const upstream = this.proxy.abortOnClose(req, res);
    const response = await this.agents.forwardMcp(method, headers, body, upstream.signal);

    // The engine answers tool calls as plain JSON (stateless, json_response): read it to attribute runs.
    if (response.headers.get('content-type')?.startsWith('application/json')) {
      const text = await response.text();
      // Record before answering, so whoever reads the run next sees who started it.
      await this.agents.recordMcpCall(actor, req.body, parseJson(text));
      res.status(response.status).type('application/json');
      const session = response.headers.get('mcp-session-id');
      if (session) res.setHeader('mcp-session-id', session);
      res.send(text);
      return;
    }
    await this.proxy.pipe(response, res, { upstream });
  }
}
