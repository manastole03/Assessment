import { Injectable, Logger } from '@nestjs/common';

import type { AuthenticatedUser } from '../../common/interfaces/authenticated-user.interface.js';
import type { JsonObject } from '../../common/interfaces/json.interface.js';
import { PaginatedResult } from '../../common/utils/pagination.util.js';
import { currentRequestContext } from '../../common/utils/request-context.js';
import { ActorType, AuditOutcome } from '../../generated/prisma/enums.js';
import type { AuditAction } from './audit.constants.js';
import { AuditRepository } from './audit.repository.js';
import type { AuditLogDto, ListAuditLogsQueryDto } from './dto/audit-log.dto.js';

/** An actor known only by email (e.g. a failed login for an unknown address). */
export interface AnonymousActor {
  email: string;
}

export interface AuditEntry {
  actor: AuthenticatedUser | AnonymousActor | null;
  action: AuditAction;
  resourceType?: string;
  resourceId?: string;
  outcome?: AuditOutcome;
  /** Identifiers and codes only: never secrets, tokens, passwords or capability input values. */
  metadata?: JsonObject;
}

function isAuthenticated(actor: AuditEntry['actor']): actor is AuthenticatedUser {
  return actor !== null && 'id' in actor;
}

@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(private readonly audits: AuditRepository) {}

  /**
   * Append an audit record with the request's id, IP and the acting user or API key.
   * Recording never fails the action it describes: a write error is logged loudly instead.
   */
  async record(entry: AuditEntry): Promise<void> {
    const context = currentRequestContext();
    const actor = entry.actor;
    const viaKey = isAuthenticated(actor) && actor.authMethod === 'api_key';
    try {
      await this.audits.create({
        actorType: actor === null ? ActorType.SYSTEM : viaKey ? ActorType.API_KEY : ActorType.USER,
        actorId: isAuthenticated(actor) ? actor.id : null,
        actorEmail: actor?.email ?? null,
        apiKeyId: viaKey ? (actor.apiKeyId ?? null) : null,
        action: entry.action,
        resourceType: entry.resourceType ?? null,
        resourceId: entry.resourceId ?? null,
        outcome: entry.outcome ?? AuditOutcome.SUCCESS,
        metadata: entry.metadata,
        ipAddress: context?.ip ?? null,
        requestId: context?.requestId ?? null,
      });
    } catch (error) {
      this.logger.error({ err: error, action: entry.action }, 'Failed to write audit log');
    }
  }

  async list(query: ListAuditLogsQueryDto): Promise<PaginatedResult<AuditLogDto>> {
    const page = { page: query.page, limit: query.limit };
    const [rows, total] = await this.audits.findPage(
      {
        action: query.action,
        actorId: query.actorId,
        resourceType: query.resourceType,
        resourceId: query.resourceId,
        outcome: query.outcome,
        from: query.from,
        to: query.to,
      },
      page,
      query.sortOrder,
    );
    return new PaginatedResult(rows, total, page);
  }
}
