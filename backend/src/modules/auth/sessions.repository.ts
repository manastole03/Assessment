import { Injectable } from '@nestjs/common';

import { PrismaService } from '../../database/prisma.service.js';
import type { Prisma, Session, User } from '../../generated/prisma/client.js';

export type SessionWithUser = Session & { user: User };

@Injectable()
export class SessionsRepository {
  constructor(private readonly prisma: PrismaService) {}

  create(data: Prisma.SessionUncheckedCreateInput): Promise<Session> {
    return this.prisma.session.create({ data });
  }

  /** The session behind an access token, with its user: one indexed lookup per request. */
  findWithUser(id: string): Promise<SessionWithUser | null> {
    return this.prisma.session.findUnique({ where: { id }, include: { user: true } });
  }

  findByRefreshHash(refreshTokenHash: string): Promise<SessionWithUser | null> {
    return this.prisma.session.findUnique({ where: { refreshTokenHash }, include: { user: true } });
  }

  findByPreviousHash(previousTokenHash: string): Promise<Session | null> {
    return this.prisma.session.findUnique({ where: { previousTokenHash } });
  }

  /**
   * Swap the refresh token, but only if it is still the one presented and the session is live.
   * Two concurrent refreshes with the same token: exactly one wins (compare-and-set).
   */
  async rotate(
    id: string,
    presentedHash: string,
    nextHash: string,
    expiresAt: Date,
  ): Promise<boolean> {
    const { count } = await this.prisma.session.updateMany({
      where: { id, refreshTokenHash: presentedHash, revokedAt: null },
      data: {
        previousTokenHash: presentedHash,
        refreshTokenHash: nextHash,
        expiresAt,
        lastUsedAt: new Date(),
      },
    });
    return count === 1;
  }

  async revoke(id: string, reason: string): Promise<void> {
    await this.prisma.session.updateMany({
      where: { id, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: reason },
    });
  }

  async revokeAllForUser(
    userId: string,
    reason: string,
    exceptSessionId?: string,
  ): Promise<number> {
    const { count } = await this.prisma.session.updateMany({
      where: {
        userId,
        revokedAt: null,
        ...(exceptSessionId ? { id: { not: exceptSessionId } } : {}),
      },
      data: { revokedAt: new Date(), revokedReason: reason },
    });
    return count;
  }

  /** Housekeeping: drop sessions that ended more than `olderThan` ago. */
  async deleteEndedBefore(olderThan: Date): Promise<number> {
    const { count } = await this.prisma.session.deleteMany({
      where: { OR: [{ expiresAt: { lt: olderThan } }, { revokedAt: { lt: olderThan } }] },
    });
    return count;
  }
}
