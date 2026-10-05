import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';

import { ErrorCode } from '../../common/constants/error-codes.js';
import type { AuthenticatedUser } from '../../common/interfaces/authenticated-user.interface.js';
import {
  fromParsedJsonObject,
  isJsonObject,
  type JsonObject,
} from '../../common/interfaces/json.interface.js';
import {
  type PageRequest,
  paginateArray,
  type PaginatedResult,
} from '../../common/utils/pagination.util.js';
import { appConfig } from '../../config/configuration.js';
import { EngineClient } from '../../engine/engine.client.js';
import { engineInvocation, jsonDocumentList } from '../../engine/engine.types.js';
import { AuditAction } from '../audit/audit.constants.js';
import { AuditService } from '../audit/audit.service.js';
import { RunsService } from '../runs/runs.service.js';
import type { InvokeCapabilityDto } from './dto/invoke.dto.js';

/** Grace on top of the caller's wait, for the engine to start the browser and answer. */
const INVOKE_GRACE_MS = 30_000;

export interface InvocationResult {
  /** 200 with the result, or 202 while the run continues. */
  status: 200 | 202;
  body: JsonObject;
}

/**
 * The agent-facing surface: approved capabilities as tools, invoked with the caller's identity.
 * The engine resolves the latest approved version and checks inputs against its contract.
 */
@Injectable()
export class AgentsService {
  private readonly logger = new Logger(AgentsService.name);

  constructor(
    private readonly engine: EngineClient,
    private readonly runs: RunsService,
    private readonly audit: AuditService,
    @Inject(appConfig.KEY) private readonly config: ConfigType<typeof appConfig>,
  ) {}

  async tools(page: PageRequest): Promise<PaginatedResult<JsonObject>> {
    return paginateArray(
      await this.engine.get('/api/agents/tools', { schema: jsonDocumentList }),
      page,
    );
  }

  async catalog(page: PageRequest): Promise<PaginatedResult<JsonObject>> {
    return paginateArray(await this.engine.get('/api/catalog', { schema: jsonDocumentList }), page);
  }

  async invoke(
    actor: AuthenticatedUser,
    capabilityId: string,
    dto: InvokeCapabilityDto,
  ): Promise<InvocationResult> {
    const { status, data } = await this.engine.requestWithStatus(
      'POST',
      `/api/capabilities/${encodeURIComponent(capabilityId)}/invoke`,
      {
        schema: engineInvocation,
        body: {
          tenant: dto.tenant,
          inputs: dto.inputs,
          escalation: dto.escalation,
          wait_s: dto.waitSeconds,
        },
        timeoutMs: dto.waitSeconds * 1000 + INVOKE_GRACE_MS,
        errors: { 404: ErrorCode.CAPABILITY_NOT_FOUND, 409: ErrorCode.CAPABILITY_NOT_APPROVED },
      },
    );
    await this.attribute(actor, data.run_id, data.capability, dto.escalation);
    await this.audit.record({
      actor,
      action: AuditAction.CAPABILITY_INVOKED,
      resourceType: 'run',
      resourceId: data.run_id,
      metadata: {
        capability: data.capability,
        tenant: dto.tenant,
        status: data.status,
        inputs: Object.keys(dto.inputs),
      },
    });
    return {
      status: status === 202 ? 202 : 200,
      body: { ...fromParsedJsonObject(data), links: this.links(data.run_id) },
    };
  }

  /** Relay one MCP request to the engine (the protocol passes through unchanged). */
  forwardMcp(
    method: 'GET' | 'POST' | 'DELETE',
    headers: Record<string, string>,
    body: string | undefined,
    signal: AbortSignal,
  ): Promise<Response> {
    // Tool calls replay a capability end to end, which can take minutes.
    return this.engine.raw(method, '/mcp', {
      headers,
      body,
      signal,
      timeoutMs: 15 * 60_000,
      passErrors: true,
    });
  }

  /**
   * After an MCP exchange: if it was a tool call that started a run, record who made it. The MCP
   * payloads themselves pass through untouched.
   */
  async recordMcpCall(
    actor: AuthenticatedUser,
    request: unknown,
    response: unknown,
  ): Promise<void> {
    if (!isJsonObject(request) || request['method'] !== 'tools/call') return;
    const params = request['params'];
    const tool =
      isJsonObject(params) && typeof params['name'] === 'string' ? params['name'] : 'unknown';
    const result = isJsonObject(response) ? response['result'] : undefined;
    const structured = isJsonObject(result) ? result['structuredContent'] : undefined;
    const runId =
      isJsonObject(structured) && typeof structured['run_id'] === 'string'
        ? structured['run_id']
        : null;
    const capability =
      isJsonObject(structured) && typeof structured['capability'] === 'string'
        ? structured['capability']
        : null;
    if (runId) await this.attribute(actor, runId, capability, 'fail');
    await this.audit.record({
      actor,
      action: AuditAction.MCP_TOOL_CALLED,
      resourceType: runId ? 'run' : 'tool',
      resourceId: runId ?? tool,
      metadata: { tool },
    });
  }

  private links(runId: string): JsonObject {
    return { run: `/api/v1/runs/${runId}`, ui: `${this.config.http.publicUrl}/runs/${runId}` };
  }

  /** Attribution is best effort: the caller already has their result. */
  private async attribute(
    actor: AuthenticatedUser,
    runId: string,
    capability: string | null,
    escalation: string,
  ): Promise<void> {
    try {
      await this.runs.attribute(actor, runId, { capabilityRef: capability, escalation });
    } catch (error) {
      this.logger.warn({ err: error, runId }, 'Could not attribute run');
    }
  }
}
