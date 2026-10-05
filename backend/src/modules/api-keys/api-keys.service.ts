import { randomBytes } from 'node:crypto';

import { Injectable } from '@nestjs/common';

import { ErrorCode } from '../../common/constants/error-codes.js';
import { API_KEY_PREFIX } from '../../common/constants/http.js';
import { hasRole, minRole, Role } from '../../common/constants/roles.js';
import { AppException } from '../../common/exceptions/app.exception.js';
import type { AuthenticatedUser } from '../../common/interfaces/authenticated-user.interface.js';
import { randomToken, safeEqual, sha256Hex } from '../../common/utils/crypto.util.js';
import { PaginatedResult } from '../../common/utils/pagination.util.js';
import { UserStatus } from '../../generated/prisma/enums.js';
import { AuditAction } from '../audit/audit.constants.js';
import { AuditService } from '../audit/audit.service.js';
import { toUserRef } from '../users/entities/user.entity.js';
import { type ApiKeyWithOwner, ApiKeysRepository } from './api-keys.repository.js';
import type {
  ApiKeyDto,
  CreateApiKeyDto,
  CreatedApiKeyDto,
  ListApiKeysQueryDto,
} from './dto/api-key.dto.js';

/** `rote_<8 hex>_<43 chars>`: the first part is a public lookup id, the rest 256 bits of secret. */
const KEY_FORMAT = /^rote_([0-9a-f]{8})_([A-Za-z0-9_-]{43})$/;
const TOUCH_INTERVAL_MS = 5 * 60_000;

function toApiKeyDto(key: ApiKeyWithOwner): ApiKeyDto {
  return {
    id: key.id,
    name: key.name,
    prefix: key.prefix,
    role: key.role,
    owner: toUserRef(key.user),
    expiresAt: key.expiresAt,
    lastUsedAt: key.lastUsedAt,
    revokedAt: key.revokedAt,
    createdAt: key.createdAt,
  };
}

@Injectable()
export class ApiKeysService {
  constructor(
    private readonly keys: ApiKeysRepository,
    private readonly audit: AuditService,
  ) {}

  /** Issue a key for yourself. Its role can never exceed yours; only a hash of it is stored. */
  async create(actor: AuthenticatedUser, dto: CreateApiKeyDto): Promise<CreatedApiKeyDto> {
    if (actor.authMethod === 'api_key') {
      throw AppException.forbidden('API keys cannot create other API keys; sign in to do this');
    }
    if (!hasRole(actor.role, dto.role)) {
      throw AppException.forbidden(
        `A key cannot have more access than you (${actor.role})`,
        ErrorCode.ROLE_EXCEEDS_OWNER,
      );
    }
    const prefix = `${API_KEY_PREFIX}${randomBytes(4).toString('hex')}`;
    const secret = `${prefix}_${randomToken(32)}`;
    const key = await this.keys.create({
      userId: actor.id,
      name: dto.name,
      prefix,
      keyHash: sha256Hex(secret),
      role: dto.role,
      expiresAt: dto.expiresInDays ? new Date(Date.now() + dto.expiresInDays * 86_400_000) : null,
    });
    await this.audit.record({
      actor,
      action: AuditAction.API_KEY_CREATED,
      resourceType: 'api_key',
      resourceId: key.id,
      metadata: { prefix, role: key.role },
    });
    return { apiKey: toApiKeyDto(key), secret };
  }

  async list(
    actor: AuthenticatedUser,
    query: ListApiKeysQueryDto,
  ): Promise<PaginatedResult<ApiKeyDto>> {
    const isAdmin = hasRole(actor.role, Role.ADMIN);
    if ((query.userId && query.userId !== actor.id) || query.all) {
      if (!isAdmin)
        throw AppException.forbidden(
          'Only admins can list other users’ keys',
          ErrorCode.INSUFFICIENT_ROLE,
        );
    }
    const page = { page: query.page, limit: query.limit };
    const userId = query.all ? undefined : (query.userId ?? actor.id);
    const [rows, total] = await this.keys.findPage(
      { userId, includeRevoked: query.includeRevoked ?? false },
      page,
    );
    return new PaginatedResult(rows.map(toApiKeyDto), total, page);
  }

  /** Owners revoke their own keys; admins revoke anyone's. Revoking twice is a no-op. */
  async revoke(actor: AuthenticatedUser, id: string): Promise<void> {
    const key = await this.keys.findById(id);
    if (!key || (key.userId !== actor.id && !hasRole(actor.role, Role.ADMIN))) {
      throw AppException.notFound('API key not found', ErrorCode.API_KEY_NOT_FOUND);
    }
    if (key.revokedAt) return;
    await this.keys.revoke(id);
    await this.audit.record({
      actor,
      action: AuditAction.API_KEY_REVOKED,
      resourceType: 'api_key',
      resourceId: id,
      metadata: { prefix: key.prefix, ownerId: key.userId },
    });
  }

  /**
   * Resolve a presented key to its caller, or null. The effective role is the lower of the key's
   * role and the owner's *current* role, so demoting or disabling a user also limits their keys.
   */
  async authenticate(presented: string): Promise<AuthenticatedUser | null> {
    const match = KEY_FORMAT.exec(presented);
    if (!match) return null;
    const key = await this.keys.findByPrefix(`${API_KEY_PREFIX}${match[1]}`);
    if (!key || !safeEqual(key.keyHash, sha256Hex(presented))) return null;
    if (key.revokedAt || (key.expiresAt && key.expiresAt <= new Date())) return null;
    if (key.user.status !== UserStatus.ACTIVE) return null;

    await this.keys.touch(key.id, TOUCH_INTERVAL_MS);
    return {
      id: key.user.id,
      email: key.user.email,
      name: key.user.name,
      role: minRole(key.role, key.user.role),
      authMethod: 'api_key',
      apiKeyId: key.id,
    };
  }
}
