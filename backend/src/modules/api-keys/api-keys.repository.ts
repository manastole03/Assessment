import { Injectable } from '@nestjs/common';

import { type PageRequest, toSkipTake } from '../../common/utils/pagination.util.js';
import { PrismaService } from '../../database/prisma.service.js';
import type { ApiKey, Prisma, User } from '../../generated/prisma/client.js';

export type ApiKeyWithOwner = ApiKey & {
  user: Pick<User, 'id' | 'email' | 'name' | 'role' | 'status'>;
};

const OWNER = { select: { id: true, email: true, name: true, role: true, status: true } } as const;

@Injectable()
export class ApiKeysRepository {
  constructor(private readonly prisma: PrismaService) {}

  create(data: Prisma.ApiKeyUncheckedCreateInput): Promise<ApiKeyWithOwner> {
    return this.prisma.apiKey.create({ data, include: { user: OWNER } });
  }

  findByPrefix(prefix: string): Promise<ApiKeyWithOwner | null> {
    return this.prisma.apiKey.findUnique({ where: { prefix }, include: { user: OWNER } });
  }

  findById(id: string): Promise<ApiKeyWithOwner | null> {
    return this.prisma.apiKey.findUnique({ where: { id }, include: { user: OWNER } });
  }

  async findPage(
    filter: { userId?: string; includeRevoked: boolean },
    page: PageRequest,
  ): Promise<[ApiKeyWithOwner[], number]> {
    const where: Prisma.ApiKeyWhereInput = {
      userId: filter.userId,
      ...(filter.includeRevoked ? {} : { revokedAt: null }),
    };
    return this.prisma.$transaction([
      this.prisma.apiKey.findMany({
        where,
        include: { user: OWNER },
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        ...toSkipTake(page),
      }),
      this.prisma.apiKey.count({ where }),
    ]);
  }

  revoke(id: string): Promise<ApiKeyWithOwner> {
    return this.prisma.apiKey.update({
      where: { id },
      data: { revokedAt: new Date() },
      include: { user: OWNER },
    });
  }

  /** Record use, at most once per `minIntervalMs`, so authentication does not write on every request. */
  async touch(id: string, minIntervalMs: number): Promise<void> {
    const threshold = new Date(Date.now() - minIntervalMs);
    await this.prisma.apiKey.updateMany({
      where: { id, OR: [{ lastUsedAt: null }, { lastUsedAt: { lt: threshold } }] },
      data: { lastUsedAt: new Date() },
    });
  }
}
