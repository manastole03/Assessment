import type { PrismaService } from '../../../src/database/prisma.service.js';
import type { EngineClient } from '../../../src/engine/engine.client.js';
import { HealthService } from '../../../src/health/health.service.js';
import { mockOf } from '../../helpers/fixtures.js';

function setup(database: 'up' | 'down', engineUp: boolean) {
  const prisma = mockOf<PrismaService>();
  const engine = mockOf<EngineClient>();
  if (database === 'up') prisma.ping.mockResolvedValue(undefined);
  else prisma.ping.mockRejectedValue(new Error('ECONNREFUSED'));
  engine.isReachable.mockResolvedValue(engineUp);
  return new HealthService(prisma, engine);
}

describe('HealthService', () => {
  it('reports ok when everything is up', async () => {
    expect(await setup('up', true).health()).toMatchObject({
      status: 'ok',
      database: 'connected',
      engine: 'connected',
    });
    expect(await setup('up', true).readiness()).toMatchObject({
      status: 'ok',
      database: 'connected',
    });
  });

  it('stays ready but degraded without the engine', async () => {
    expect(await setup('up', false).health()).toMatchObject({
      status: 'degraded',
      engine: 'unreachable',
    });
    expect((await setup('up', false).readiness()).status).toBe('ok');
  });

  it('is not ready without the database', async () => {
    expect(await setup('down', true).health()).toMatchObject({
      status: 'error',
      database: 'disconnected',
    });
    expect(await setup('down', true).readiness()).toMatchObject({
      status: 'error',
      database: 'disconnected',
    });
  });

  it('answers liveness without touching dependencies', () => {
    expect(setup('down', false).liveness()).toMatchObject({
      status: 'ok',
      uptimeSeconds: expect.any(Number),
    });
  });
});
