import { PrismaService } from '../../src/database/prisma.service.js';
import { Role } from '../../src/generated/prisma/enums.js';
import { createTestApp, createUser, login, resetDatabase, type TestContext } from './test-app.js';

describe('Health, platform views and failure modes', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestApp();
    await resetDatabase(ctx.prisma);
    await createUser(ctx.prisma, 'dana@example.com', Role.OPERATOR);
    await createUser(ctx.prisma, 'vic@example.com', Role.VIEWER);
  });
  afterAll(() => ctx.close());

  it('exposes unversioned, unauthenticated probes in their own format', async () => {
    const health = await ctx.http().get('/health').expect(200);
    expect(health.body).toMatchObject({
      status: 'ok',
      database: 'connected',
      engine: 'connected',
      timestamp: expect.any(String),
    });
    expect(health.body).not.toHaveProperty('success');
    await ctx.http().get('/health/liveness').expect(200);
    expect((await ctx.http().get('/health/readiness').expect(200)).body).toMatchObject({
      status: 'ok',
      database: 'connected',
    });
    await ctx.http().get('/api/v1/health').expect(404);
  });

  it('sets security headers and a request id on every response', async () => {
    const response = await ctx
      .http()
      .get('/health/liveness')
      .set('x-request-id', 'trace-from-the-caller-1')
      .expect(200);
    expect(response.headers['x-request-id']).toBe('trace-from-the-caller-1');
    expect(response.headers['content-security-policy']).toContain("default-src 'self'");
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['x-frame-options']).toBe('SAMEORIGIN');
    expect(response.headers).not.toHaveProperty('x-powered-by');
    const generated = await ctx
      .http()
      .get('/health/liveness')
      .set('x-request-id', 'bad id with spaces')
      .expect(200);
    expect(generated.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('answers unknown routes, malformed JSON and oversized bodies in the error envelope', async () => {
    const { agent } = await login(ctx, 'dana@example.com');
    expect((await agent.get('/api/v1/nope').expect(404)).body.error.code).toBe('ROUTE_NOT_FOUND');
    const malformed = await ctx
      .http()
      .post('/api/v1/auth/login')
      .set('content-type', 'application/json')
      .send('{"email":')
      .expect(400);
    expect(malformed.body.error.code).toBe('MALFORMED_JSON');
    const huge = await ctx
      .http()
      .post('/api/v1/auth/login')
      .set('content-type', 'application/json')
      .send(JSON.stringify({ email: 'x'.repeat(300_000) }))
      .expect(413);
    expect(huge.body.error.code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('serves engine views and gates demo controls by role', async () => {
    const viewer = await login(ctx, 'vic@example.com');
    const status = await viewer.agent.get('/api/v1/status').expect(200);
    expect(status.body.data).toMatchObject({
      tenants: [{ id: 'acme', reachable: true }],
      control_plane: { demo_enabled: true },
    });
    await viewer.agent.get('/api/v1/policy').expect(200);
    expect((await viewer.agent.get('/api/v1/demo/members').expect(200)).body.meta.total).toBe(1);
    await viewer.agent
      .put('/api/v1/demo/faults/acme')
      .set('x-csrf-token', viewer.csrf)
      .send({ faults: { maintenance_notice: true } })
      .expect(403);

    const operator = await login(ctx, 'dana@example.com');
    await operator.agent
      .put('/api/v1/demo/faults/acme')
      .set('x-csrf-token', operator.csrf)
      .send({ faults: { maintenance_notice: true } })
      .expect(200);
    expect(ctx.engine.callsTo('PUT', '/api/demo/faults/acme')[0]?.body).toEqual({
      maintenance_notice: true,
    });
    await operator.agent
      .put('/api/v1/demo/faults/acme')
      .set('x-csrf-token', operator.csrf)
      .send({ faults: { 'bad key': { nested: true } } })
      .expect(400);
    expect(
      (await operator.agent.get('/api/v1/demo/faults/nowhere').expect(404)).body.error.code,
    ).toBe('TENANT_NOT_FOUND');
  });

  it('keeps serving identity and lists when the engine is down, and says so', async () => {
    await ctx.engine.stop();
    try {
      const { agent } = await login(ctx, 'vic@example.com');
      const health = await ctx.http().get('/health').expect(200);
      expect(health.body).toMatchObject({ status: 'degraded', engine: 'unreachable' });
      await ctx.http().get('/health/readiness').expect(200);
      await agent.get('/api/v1/runs').expect(200);
      const capabilities = await agent.get('/api/v1/capabilities').expect(503);
      expect(capabilities.body).toMatchObject({
        success: false,
        error: { code: 'ENGINE_UNAVAILABLE' },
      });
    } finally {
      // Restart on a new port is not needed: this is the file's last engine-dependent test.
    }
  });
});

describe('Database failure', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestApp();
  });
  afterAll(() => ctx.close());

  it('reports the database as unavailable instead of leaking driver errors', async () => {
    const prisma = ctx.app.get(PrismaService);
    const down = Object.assign(new Error("Can't reach database server at db:5432"), {
      name: 'PrismaClientInitializationError',
    });
    const findUnique = prisma.user.findUnique.bind(prisma.user);
    const ping = prisma.ping.bind(prisma);
    prisma.user.findUnique = (() =>
      Promise.reject(down)) as unknown as typeof prisma.user.findUnique;
    prisma.ping = () => Promise.reject(down);
    try {
      const login = await ctx
        .http()
        .post('/api/v1/auth/login')
        .send({ email: 'dana@example.com', password: 'whatever it is' })
        .expect(503);
      expect(login.body).toMatchObject({
        success: false,
        error: { code: 'DATABASE_UNAVAILABLE' },
        message: 'The database is temporarily unavailable',
      });
      expect(JSON.stringify(login.body)).not.toContain('db:5432');
      expect((await ctx.http().get('/health/readiness').expect(503)).body).toMatchObject({
        status: 'error',
        database: 'disconnected',
      });
      await ctx.http().get('/health/liveness').expect(200);
    } finally {
      prisma.user.findUnique = findUnique;
      prisma.ping = ping;
    }
  });
});
