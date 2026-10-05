import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';

import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';

import { JobLeaseRepository } from '../../database/job-lease.repository.js';
import { SessionsRepository } from './sessions.repository.js';

const JOB = 'session-cleanup';
/** Ended sessions are kept this long for investigation; the audit log keeps the sign-in events. */
export const SESSION_RETENTION_DAYS = 30;
const LEASE_TTL_MS = 10 * 60_000;

/**
 * Housekeeping: every sign-in creates a session row, so ended ones (expired or revoked) are
 * deleted once they are older than the retention window. One replica does it (a database lease).
 */
@Injectable()
export class SessionCleanupService {
  private readonly logger = new Logger(SessionCleanupService.name);
  private readonly holder = `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;

  constructor(
    private readonly sessions: SessionsRepository,
    private readonly leases: JobLeaseRepository,
  ) {}

  /** Returns how many sessions were deleted (0 when another replica holds the lease). */
  @Cron(CronExpression.EVERY_DAY_AT_3AM, { name: JOB })
  async purgeEndedSessions(now = new Date()): Promise<number> {
    try {
      if (!(await this.leases.tryAcquire(JOB, this.holder, LEASE_TTL_MS))) return 0;
      const cutoff = new Date(now.getTime() - SESSION_RETENTION_DAYS * 86_400_000);
      const removed = await this.sessions.deleteEndedBefore(cutoff);
      if (removed) this.logger.log({ removed }, 'Ended sessions purged');
      return removed;
    } catch (error) {
      this.logger.error({ err: error }, 'Session cleanup failed');
      return 0;
    }
  }
}
