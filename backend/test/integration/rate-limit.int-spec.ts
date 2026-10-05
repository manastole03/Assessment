import { createTestApp, resetDatabase, type TestContext } from './test-app.js';

describe('Rate limiting (ThrottlerGuard → error envelope)', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestApp({ AUTH_RATE_LIMIT_MAX: '3' });
    await resetDatabase(ctx.prisma);
  });
  afterAll(() => ctx.close());

  it('throttles credential endpoints per client, answers 429 RATE_LIMITED, and spares the rest', async () => {
    const attempt = () =>
      ctx
        .http()
        .post('/api/v1/auth/login')
        .send({ email: 'nobody@example.com', password: 'guess' });
    for (let i = 0; i < 3; i += 1) await attempt().expect(401);

    const limited = await attempt().expect(429);
    expect(limited.body).toMatchObject({
      success: false,
      error: { code: 'RATE_LIMITED' },
      path: '/api/v1/auth/login',
    });

    // Only routes marked @AuthRateLimit() share that bucket; probes are never throttled.
    await ctx.http().get('/api/v1/auth/options').expect(200);
    await ctx.http().get('/health/liveness').expect(200);
  });
});
