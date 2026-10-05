import type { JobLeaseRepository } from '../../../src/database/job-lease.repository.js';
import {
  SESSION_RETENTION_DAYS,
  SessionCleanupService,
} from '../../../src/modules/auth/session-cleanup.service.js';
import type { SessionsRepository } from '../../../src/modules/auth/sessions.repository.js';
import { mockOf } from '../../helpers/fixtures.js';

const NOW = new Date('2026-10-04T03:00:00Z');

function setup(leaseHeld: boolean) {
  const sessions = mockOf<SessionsRepository>();
  const leases = mockOf<JobLeaseRepository>();
  leases.tryAcquire.mockResolvedValue(leaseHeld);
  sessions.deleteEndedBefore.mockResolvedValue(7);
  return { service: new SessionCleanupService(sessions, leases), sessions };
}

describe('SessionCleanupService', () => {
  it('deletes sessions that ended before the retention window', async () => {
    const { service, sessions } = setup(true);
    expect(await service.purgeEndedSessions(NOW)).toBe(7);
    const cutoff = sessions.deleteEndedBefore.mock.calls[0]?.[0];
    expect(cutoff).toEqual(new Date(NOW.getTime() - SESSION_RETENTION_DAYS * 86_400_000));
  });

  it('leaves the work to the replica holding the lease', async () => {
    const { service, sessions } = setup(false);
    expect(await service.purgeEndedSessions(NOW)).toBe(0);
    expect(sessions.deleteEndedBefore).not.toHaveBeenCalled();
  });

  it('never throws out of the scheduler', async () => {
    const { service, sessions } = setup(true);
    sessions.deleteEndedBefore.mockRejectedValue(new Error('connection terminated'));
    await expect(service.purgeEndedSessions(NOW)).resolves.toBe(0);
  });
});
