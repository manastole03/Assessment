import { Injectable } from '@nestjs/common';

import { PrismaService } from './prisma.service.js';
import { isUniqueViolation } from './prisma.types.js';

/**
 * Leader election for background jobs across API replicas, on the database they already share.
 * A lease is held until it expires; the holder renews it on every run, so a crashed holder is
 * replaced within one TTL.
 */
@Injectable()
export class JobLeaseRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** Take or renew the lease. True when `holder` now holds it until `ttlMs` from now. */
  async tryAcquire(name: string, holder: string, ttlMs: number): Promise<boolean> {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + ttlMs);
    const { count } = await this.prisma.jobLease.updateMany({
      where: { name, OR: [{ holder }, { expiresAt: { lt: now } }] },
      data: { holder, expiresAt },
    });
    if (count === 1) return true;
    try {
      await this.prisma.jobLease.create({ data: { name, holder, expiresAt } });
      return true;
    } catch (error) {
      if (isUniqueViolation(error)) return false; // someone else holds a live lease
      throw error;
    }
  }

  async release(name: string, holder: string): Promise<void> {
    await this.prisma.jobLease.deleteMany({ where: { name, holder } });
  }
}
