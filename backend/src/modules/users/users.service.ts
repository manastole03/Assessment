import { Injectable } from '@nestjs/common';

import { ErrorCode } from '../../common/constants/error-codes.js';
import { hasRole } from '../../common/constants/roles.js';
import { AppException } from '../../common/exceptions/app.exception.js';
import type { AuthenticatedUser } from '../../common/interfaces/authenticated-user.interface.js';
import { PaginatedResult } from '../../common/utils/pagination.util.js';
import { normalizeEmail, searchTerm } from '../../common/utils/strings.util.js';
import { isUniqueViolation } from '../../database/prisma.types.js';
import type { User } from '../../generated/prisma/client.js';
import { Role, UserStatus } from '../../generated/prisma/enums.js';
import { AuditAction } from '../audit/audit.constants.js';
import { AuditService } from '../audit/audit.service.js';
import type {
  CreateUserDto,
  ListUsersQueryDto,
  UpdateProfileDto,
  UpdateUserDto,
} from './dto/user.dto.js';
import { toUserEntity, type UserEntity } from './entities/user.entity.js';
import { PasswordService } from './password.service.js';
import { UsersRepository } from './users.repository.js';

export interface NewUser {
  email: string;
  name: string;
  password: string;
  role: Role;
}

@Injectable()
export class UsersService {
  constructor(
    private readonly users: UsersRepository,
    private readonly passwords: PasswordService,
    private readonly audit: AuditService,
  ) {}

  /** Used by admins (any role) and by self-registration (VIEWER); emails are unique case-insensitively. */
  async createUser(input: NewUser): Promise<User> {
    const passwordHash = await this.passwords.hash(input.password);
    try {
      return await this.users.create({
        email: normalizeEmail(input.email),
        name: input.name.trim(),
        role: input.role,
        passwordHash,
      });
    } catch (error) {
      if (isUniqueViolation(error, 'email')) {
        throw AppException.conflict(
          'A user with this email already exists',
          ErrorCode.EMAIL_ALREADY_EXISTS,
        );
      }
      throw error;
    }
  }

  async create(actor: AuthenticatedUser, dto: CreateUserDto): Promise<UserEntity> {
    const user = await this.createUser(dto);
    await this.audit.record({
      actor,
      action: AuditAction.USER_CREATED,
      resourceType: 'user',
      resourceId: user.id,
      metadata: { role: user.role },
    });
    return toUserEntity(user);
  }

  async list(query: ListUsersQueryDto): Promise<PaginatedResult<UserEntity>> {
    const page = { page: query.page, limit: query.limit };
    const [rows, total] = await this.users.findPage(
      { search: searchTerm(query.search), role: query.role, status: query.status },
      page,
      query.sortBy,
      query.sortOrder,
    );
    return new PaginatedResult(rows.map(toUserEntity), total, page);
  }

  /** Admins can read anyone; everyone else only themselves (and gets 404, not 403, for others). */
  async getById(actor: AuthenticatedUser, id: string): Promise<UserEntity> {
    if (actor.id !== id && !hasRole(actor.role, Role.ADMIN)) throw this.notFound();
    const user = await this.users.findById(id);
    if (!user) throw this.notFound();
    return toUserEntity(user);
  }

  /** The record behind an authenticated identity (fresh from the database). */
  async getSelf(actor: AuthenticatedUser): Promise<UserEntity> {
    return this.getById(actor, actor.id);
  }

  /**
   * Admin changes to role, status or name. Two invariants, checked and written in one serializable
   * transaction so concurrent edits cannot break them: admins cannot demote or disable themselves,
   * and the last active admin cannot be demoted or disabled by anyone.
   */
  async update(actor: AuthenticatedUser, id: string, dto: UpdateUserDto): Promise<UserEntity> {
    const changesAccess = dto.role !== undefined || dto.status !== undefined;
    if (changesAccess && actor.id === id) {
      throw AppException.forbidden(
        'You cannot change your own role or status',
        ErrorCode.SELF_MODIFICATION_FORBIDDEN,
      );
    }
    const { before, after } = await this.users.transaction(async (tx) => {
      const existing = await this.users.findById(id, tx);
      if (!existing) throw this.notFound();
      const losesAdmin =
        existing.role === Role.ADMIN &&
        existing.status === UserStatus.ACTIVE &&
        ((dto.role !== undefined && dto.role !== Role.ADMIN) || dto.status === UserStatus.DISABLED);
      if (losesAdmin && (await this.users.countActiveAdmins(tx, id)) === 0) {
        throw AppException.conflict(
          'There must always be at least one active admin',
          ErrorCode.LAST_ADMIN,
        );
      }
      const updated = await this.users.update(
        id,
        { name: dto.name, role: dto.role, status: dto.status },
        tx,
      );
      return { before: existing, after: updated };
    });
    await this.audit.record({
      actor,
      action: AuditAction.USER_UPDATED,
      resourceType: 'user',
      resourceId: id,
      metadata: {
        ...(before.role !== after.role ? { role: { from: before.role, to: after.role } } : {}),
        ...(before.status !== after.status
          ? { status: { from: before.status, to: after.status } }
          : {}),
        ...(before.name !== after.name ? { nameChanged: true } : {}),
      },
    });
    return toUserEntity(after);
  }

  async updateProfile(actor: AuthenticatedUser, dto: UpdateProfileDto): Promise<UserEntity> {
    const user = await this.users.update(actor.id, { name: dto.name });
    return toUserEntity(user);
  }

  /** Delete a user. Their sessions and API keys go with them; runs, approvals and audit keep a snapshot. */
  async delete(actor: AuthenticatedUser, id: string): Promise<void> {
    if (actor.id === id) {
      throw AppException.forbidden(
        'You cannot delete your own account',
        ErrorCode.SELF_MODIFICATION_FORBIDDEN,
      );
    }
    await this.users.transaction(async (tx) => {
      const existing = await this.users.findById(id, tx);
      if (!existing) throw this.notFound();
      if (existing.role === Role.ADMIN && (await this.users.countActiveAdmins(tx, id)) === 0) {
        throw AppException.conflict(
          'There must always be at least one active admin',
          ErrorCode.LAST_ADMIN,
        );
      }
      await this.users.delete(id, tx);
    });
    await this.audit.record({
      actor,
      action: AuditAction.USER_DELETED,
      resourceType: 'user',
      resourceId: id,
    });
  }

  private notFound(): AppException {
    return AppException.notFound('User not found', ErrorCode.USER_NOT_FOUND);
  }
}
