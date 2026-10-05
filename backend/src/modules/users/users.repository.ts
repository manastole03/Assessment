import { Injectable } from '@nestjs/common';

import type { SortOrder } from '../../common/dto/pagination-query.dto.js';
import { type PageRequest, toSkipTake } from '../../common/utils/pagination.util.js';
import { PrismaService } from '../../database/prisma.service.js';
import type { TransactionClient } from '../../database/prisma.types.js';
import { type Prisma, type User } from '../../generated/prisma/client.js';
import { Role, UserStatus } from '../../generated/prisma/enums.js';
import type { UserSortField } from './dto/user.dto.js';

export interface UserFilter {
  search?: string;
  role?: Role;
  status?: UserStatus;
}

/** Sortable columns, mapped explicitly: a client string never becomes an `orderBy` key by itself. */
const ORDER_BY: Record<UserSortField, (order: SortOrder) => Prisma.UserOrderByWithRelationInput> = {
  createdAt: (order) => ({ createdAt: order }),
  email: (order) => ({ email: order }),
  name: (order) => ({ name: order }),
  role: (order) => ({ role: order }),
  lastLoginAt: (order) => ({ lastLoginAt: { sort: order, nulls: 'last' } }),
};

@Injectable()
export class UsersRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** Run `work` in one serializable transaction (used where a check and a write must not interleave). */
  transaction<T>(work: (tx: TransactionClient) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(work, { isolationLevel: 'Serializable' });
  }

  create(data: Prisma.UserCreateInput): Promise<User> {
    return this.prisma.user.create({ data });
  }

  findById(id: string, tx: TransactionClient = this.prisma): Promise<User | null> {
    return tx.user.findUnique({ where: { id } });
  }

  findByEmail(email: string): Promise<User | null> {
    return this.prisma.user.findUnique({ where: { email } });
  }

  async findPage(
    filter: UserFilter,
    page: PageRequest,
    sortBy: UserSortField,
    order: SortOrder,
  ): Promise<[User[], number]> {
    const where: Prisma.UserWhereInput = {
      role: filter.role,
      status: filter.status,
      ...(filter.search
        ? {
            OR: [
              { email: { contains: filter.search, mode: 'insensitive' } },
              { name: { contains: filter.search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };
    return this.prisma.$transaction([
      this.prisma.user.findMany({
        where,
        orderBy: [ORDER_BY[sortBy](order), { id: 'asc' }],
        ...toSkipTake(page),
      }),
      this.prisma.user.count({ where }),
    ]);
  }

  update(
    id: string,
    data: Prisma.UserUpdateInput,
    tx: TransactionClient = this.prisma,
  ): Promise<User> {
    return tx.user.update({ where: { id }, data });
  }

  delete(id: string, tx: TransactionClient = this.prisma): Promise<User> {
    return tx.user.delete({ where: { id } });
  }

  countActiveAdmins(tx: TransactionClient = this.prisma, excludingId?: string): Promise<number> {
    return tx.user.count({
      where: {
        role: Role.ADMIN,
        status: UserStatus.ACTIVE,
        ...(excludingId ? { id: { not: excludingId } } : {}),
      },
    });
  }

  countAll(): Promise<number> {
    return this.prisma.user.count();
  }

  recordLoginSuccess(id: string, passwordHash?: string): Promise<User> {
    return this.prisma.user.update({
      where: { id },
      data: {
        failedLoginAttempts: 0,
        lockedUntil: null,
        lastLoginAt: new Date(),
        ...(passwordHash ? { passwordHash } : {}),
      },
    });
  }

  /** Count a failed attempt atomically; lock the account once it reaches `maxAttempts`. */
  async recordLoginFailure(id: string, maxAttempts: number, lockUntil: Date): Promise<User> {
    const user = await this.prisma.user.update({
      where: { id },
      data: { failedLoginAttempts: { increment: 1 } },
    });
    if (user.failedLoginAttempts >= maxAttempts) {
      return this.prisma.user.update({
        where: { id },
        data: { lockedUntil: lockUntil, failedLoginAttempts: 0 },
      });
    }
    return user;
  }
}
