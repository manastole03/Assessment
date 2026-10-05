import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';

import { ErrorCode } from '../../common/constants/error-codes.js';
import { AppException } from '../../common/exceptions/app.exception.js';
import type { AuthenticatedUser } from '../../common/interfaces/authenticated-user.interface.js';
import { fromParsedJsonObject, type JsonObject } from '../../common/interfaces/json.interface.js';
import {
  type PageRequest,
  paginateArray,
  type PaginatedResult,
} from '../../common/utils/pagination.util.js';
import { appConfig } from '../../config/configuration.js';
import { EngineClient } from '../../engine/engine.client.js';
import { engineStatus, jsonDocument, jsonDocumentList } from '../../engine/engine.types.js';
import { AuditAction } from '../audit/audit.constants.js';
import { AuditService } from '../audit/audit.service.js';

export const API_VERSION = '0.1.0';

/** Environment, policy and evidence views from the engine, plus the demo controls. */
@Injectable()
export class PlatformService {
  constructor(
    private readonly engine: EngineClient,
    private readonly audit: AuditService,
    @Inject(appConfig.KEY) private readonly config: ConfigType<typeof appConfig>,
  ) {}

  /** The engine's environment (model, tenants and their reachability, live runs) plus this API's. */
  async status(): Promise<JsonObject> {
    const status = await this.engine.get('/api/status', { schema: engineStatus });
    return {
      ...fromParsedJsonObject(status),
      control_plane: { version: API_VERSION, demo_enabled: this.config.features.demoEnabled },
    };
  }

  policy(): Promise<JsonObject> {
    return this.engine.get('/api/policy', { schema: jsonDocument });
  }

  evidence(): Promise<JsonObject> {
    return this.engine.get('/api/evidence', { schema: jsonDocument });
  }

  async demoMembers(page: PageRequest): Promise<PaginatedResult<JsonObject>> {
    this.assertDemo();
    return paginateArray(
      await this.engine.get('/api/demo/members', { schema: jsonDocumentList }),
      page,
    );
  }

  getFaults(tenant: string): Promise<JsonObject> {
    this.assertDemo();
    return this.engine.get(`/api/demo/faults/${encodeURIComponent(tenant)}`, {
      schema: jsonDocument,
      errors: { 404: ErrorCode.TENANT_NOT_FOUND },
    });
  }

  async setFaults(
    actor: AuthenticatedUser,
    tenant: string,
    faults: Record<string, boolean | number | string>,
  ): Promise<JsonObject> {
    this.assertDemo();
    const result = await this.engine.put(`/api/demo/faults/${encodeURIComponent(tenant)}`, {
      schema: jsonDocument,
      body: faults,
      errors: { 404: ErrorCode.TENANT_NOT_FOUND },
    });
    await this.audit.record({
      actor,
      action: AuditAction.DEMO_FAULTS_SET,
      resourceType: 'tenant',
      resourceId: tenant,
      metadata: { faults: Object.keys(faults) },
    });
    return result;
  }

  private assertDemo(): void {
    if (!this.config.features.demoEnabled) {
      throw AppException.featureDisabled('Demo controls are disabled on this deployment');
    }
  }
}
