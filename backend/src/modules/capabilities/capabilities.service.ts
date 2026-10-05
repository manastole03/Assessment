import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';

import { ErrorCode } from '../../common/constants/error-codes.js';
import { AppException } from '../../common/exceptions/app.exception.js';
import type { AuthenticatedUser } from '../../common/interfaces/authenticated-user.interface.js';
import { fromParsedJson, type JsonObject } from '../../common/interfaces/json.interface.js';
import {
  compareBy,
  paginateArray,
  type PaginatedResult,
} from '../../common/utils/pagination.util.js';
import { cleanSearch } from '../../common/utils/strings.util.js';
import { appConfig } from '../../config/configuration.js';
import { EngineClient } from '../../engine/engine.client.js';
import {
  engineApproved,
  engineCapabilityDetail,
  engineCapabilityList,
  type EngineCapabilitySummary,
  jsonDocument,
} from '../../engine/engine.types.js';
import type { CapabilityApproval } from '../../generated/prisma/client.js';
import { AuditAction } from '../audit/audit.constants.js';
import { AuditService } from '../audit/audit.service.js';
import { RunsRepository } from '../runs/runs.repository.js';
import { CapabilityApprovalsRepository } from './capability-approvals.repository.js';
import type {
  ApprovalEntity,
  CapabilityQueryDto,
  ListCapabilitiesQueryDto,
} from './dto/capability.dto.js';

function toApprovalEntity(row: CapabilityApproval): ApprovalEntity {
  return {
    id: row.id,
    capabilityId: row.capabilityId,
    version: row.version,
    ref: `${row.capabilityId}@${row.version}`,
    approvedBy: { id: row.approvedById ?? '', email: row.reviewerEmail, name: row.reviewerName },
    notes: row.notes,
    approvedAt: row.createdAt,
  };
}

/** `id` or `id@1.2.3` → its parts. */
export function parseRef(ref: string): { id: string; version: string | undefined } {
  const at = ref.lastIndexOf('@');
  return at === -1
    ? { id: ref, version: undefined }
    : { id: ref.slice(0, at), version: ref.slice(at + 1) };
}

/**
 * The capability library lives in the engine (reviewed YAML in git); this service adds querying,
 * the approval workflow's rules, and the identity-backed record of who approved what.
 */
@Injectable()
export class CapabilitiesService {
  constructor(
    private readonly engine: EngineClient,
    private readonly approvals: CapabilityApprovalsRepository,
    private readonly runs: RunsRepository,
    private readonly audit: AuditService,
    @Inject(appConfig.KEY) private readonly config: ConfigType<typeof appConfig>,
  ) {}

  async list(query: ListCapabilitiesQueryDto): Promise<PaginatedResult<JsonObject>> {
    const all = await this.engine.get('/api/capabilities', { schema: engineCapabilityList });
    const search = cleanSearch(query.search)?.toLowerCase();
    const matches = all.filter(
      (cap) =>
        (!query.status || cap.status === query.status) &&
        (!query.kind || cap.kind === query.kind) &&
        (!search ||
          [cap.id, cap.title, cap.description].some((text) => text.toLowerCase().includes(search))),
    );
    if (query.sortBy) {
      const sortBy = query.sortBy;
      matches.sort(compareBy((cap: EngineCapabilitySummary) => cap[sortBy], query.sortOrder));
    }
    return paginateArray(fromParsedJson(matches), query);
  }

  get(id: string, query: CapabilityQueryDto): Promise<JsonObject> {
    return this.engine.get(`/api/capabilities/${encodeURIComponent(id)}`, {
      schema: jsonDocument,
      query: { version: query.version, tenant: query.tenant },
      errors: { 404: ErrorCode.CAPABILITY_NOT_FOUND },
    });
  }

  /**
   * Approve a reviewed draft (draft → approved). Rules: deprecated and already-approved versions
   * cannot be approved; and (four-eyes, on by default) whoever started the discovery or probe that
   * recorded the version cannot approve it.
   */
  async approve(
    actor: AuthenticatedUser,
    ref: string,
    notes: string | undefined,
  ): Promise<ApprovalEntity> {
    const { id, version } = parseRef(ref);
    const detail = await this.engine.get(`/api/capabilities/${encodeURIComponent(id)}`, {
      schema: engineCapabilityDetail,
      query: { version },
      errors: { 404: ErrorCode.CAPABILITY_NOT_FOUND },
    });
    const capability = detail.summary;
    const exactRef = `${capability.id}@${capability.version}`;

    if (capability.status === 'deprecated') {
      throw AppException.conflict(
        `${exactRef} is deprecated and cannot be approved`,
        ErrorCode.CAPABILITY_NOT_APPROVABLE,
      );
    }
    if (capability.status === 'approved') {
      throw AppException.conflict(
        `${exactRef} is already approved`,
        ErrorCode.CAPABILITY_NOT_APPROVABLE,
      );
    }
    const sourceRun = capability.provenance.source_run;
    if (this.config.auth.requireSeparateReviewer && sourceRun) {
      const run = await this.runs.findById(sourceRun);
      if (run?.requestedById === actor.id) {
        throw AppException.forbidden(
          'You started the run that recorded this version; another reviewer must approve it',
          ErrorCode.SELF_APPROVAL_FORBIDDEN,
        );
      }
    }

    await this.engine.post(`/api/capabilities/${encodeURIComponent(exactRef)}/approve`, {
      schema: engineApproved,
      body: { reviewer: `${actor.name} <${actor.email}>`, notes: notes ?? null },
      errors: { 404: ErrorCode.CAPABILITY_NOT_FOUND, 409: ErrorCode.CAPABILITY_NOT_APPROVABLE },
    });
    const approval = await this.approvals.upsert({
      capabilityId: capability.id,
      version: capability.version,
      approvedById: actor.id,
      reviewerEmail: actor.email,
      reviewerName: actor.name,
      notes: notes ?? null,
    });
    await this.audit.record({
      actor,
      action: AuditAction.CAPABILITY_APPROVED,
      resourceType: 'capability',
      resourceId: exactRef,
      metadata: { sourceRun: sourceRun ?? null },
    });
    return toApprovalEntity(approval);
  }

  async approvalsFor(id: string): Promise<ApprovalEntity[]> {
    return (await this.approvals.findForCapability(id)).map(toApprovalEntity);
  }
}
