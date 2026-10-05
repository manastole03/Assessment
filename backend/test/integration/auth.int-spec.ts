import { Role } from '../../src/generated/prisma/enums.js';
import { SessionCleanupService } from '../../src/modules/auth/session-cleanup.service.js';
import {
  cookieValue,
  createTestApp,
  createUser,
  login,
  PASSWORD,
  resetDatabase,
  type TestContext,
} from './test-app.js';

describe('Authentication (HTTP → guards → service → repository → PostgreSQL)', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestApp({ AUTH_MAX_FAILED_LOGINS: '3' });
    await resetDatabase(ctx.prisma);
    await createUser(ctx.prisma, 'dana@example.com', Role.OPERATOR, 'Dana');
    await createUser(ctx.prisma, 'locked@example.com', Role.VIEWER);
  });
  afterAll(() => ctx.close());

  it('signs in with httpOnly SameSite=Strict cookies and returns the user without secrets', async () => {
    const response = await ctx
      .http()
      .post('/api/v1/auth/login')
      .send({ email: 'DANA@example.com', password: PASSWORD })
      .expect(200);
    expect(response.body).toMatchObject({
      success: true,
      message: 'Signed in',
      data: { user: { email: 'dana@example.com', role: 'OPERATOR' } },
    });
    expect(JSON.stringify(response.body)).not.toMatch(/passwordHash|argon2/);
    const cookies = response.headers['set-cookie'] as unknown as string[];
    expect(cookies.find((c) => c.startsWith('rote_at='))).toMatch(/HttpOnly; SameSite=Strict/);
    expect(cookies.find((c) => c.startsWith('rote_rt='))).toMatch(
      /Path=\/api\/v1\/auth; .*HttpOnly/,
    );
    expect(cookies.find((c) => c.startsWith('rote_csrf='))).not.toMatch(/HttpOnly/);
  });

  it('rejects bad credentials and invalid bodies', async () => {
    const wrong = await ctx
      .http()
      .post('/api/v1/auth/login')
      .send({ email: 'dana@example.com', password: 'nope' })
      .expect(401);
    expect(wrong.body.error.code).toBe('INVALID_CREDENTIALS');
    const unknown = await ctx
      .http()
      .post('/api/v1/auth/login')
      .send({ email: 'ghost@example.com', password: 'nope' })
      .expect(401);
    expect(unknown.body.message).toBe(wrong.body.message);
    const invalid = await ctx
      .http()
      .post('/api/v1/auth/login')
      .send({ email: 'not-an-email', role: 'ADMIN' })
      .expect(400);
    expect(invalid.body.error.code).toBe('VALIDATION_ERROR');
    expect(invalid.body.error.details.map((d: { field: string }) => d.field)).toEqual(
      expect.arrayContaining(['email', 'password', 'role']),
    );
  });

  it('locks an account after repeated failures, even for the right password', async () => {
    for (let i = 0; i < 3; i += 1) {
      await ctx
        .http()
        .post('/api/v1/auth/login')
        .send({ email: 'locked@example.com', password: 'wrong' })
        .expect(401);
    }
    await ctx
      .http()
      .post('/api/v1/auth/login')
      .send({ email: 'locked@example.com', password: PASSWORD })
      .expect(401);
    const user = await ctx.prisma.user.findUniqueOrThrow({
      where: { email: 'locked@example.com' },
    });
    expect(user.lockedUntil?.getTime()).toBeGreaterThan(Date.now());
    const failures = await ctx.prisma.auditLog.count({
      where: { action: 'auth.login_failed', actorEmail: 'locked@example.com' },
    });
    expect(failures).toBe(4);
  });

  it('authenticates by cookie or bearer token, and refuses anonymous calls', async () => {
    const { agent, accessToken } = await login(ctx, 'dana@example.com');
    const me = await agent.get('/api/v1/auth/me').expect(200);
    expect(me.body.data).toMatchObject({ effectiveRole: 'OPERATOR', authMethod: 'session' });
    const bearer = await ctx
      .http()
      .get('/api/v1/auth/me')
      .set('authorization', `Bearer ${accessToken}`)
      .expect(200);
    expect(bearer.body.data.authMethod).toBe('bearer');
    const anonymous = await ctx.http().get('/api/v1/auth/me').expect(401);
    expect(anonymous.body).toMatchObject({
      success: false,
      error: { code: 'UNAUTHORIZED' },
      path: '/api/v1/auth/me',
    });
    await ctx.http().get('/api/v1/auth/me').set('authorization', 'Bearer not.a.jwt').expect(401);
  });

  it('requires the CSRF token on cookie-authenticated writes', async () => {
    const { agent, csrf } = await login(ctx, 'dana@example.com');
    const blocked = await agent.patch('/api/v1/users/me').send({ name: 'Dana' }).expect(403);
    expect(blocked.body.error.code).toBe('CSRF_TOKEN_INVALID');
    await agent
      .patch('/api/v1/users/me')
      .set('x-csrf-token', csrf)
      .send({ name: 'Dana O.' })
      .expect(200);
  });

  it('rotates the refresh token on every refresh', async () => {
    const signIn = await ctx
      .http()
      .post('/api/v1/auth/login')
      .send({ email: 'dana@example.com', password: PASSWORD })
      .expect(200);
    const original = cookieValue(signIn.headers['set-cookie'], 'rote_rt');
    const csrf = cookieValue(signIn.headers['set-cookie'], 'rote_csrf');
    const refreshed = await ctx
      .http()
      .post('/api/v1/auth/refresh')
      .set('cookie', `rote_rt=${original}; rote_csrf=${csrf}`)
      .set('x-csrf-token', csrf)
      .expect(200);
    const rotated = cookieValue(refreshed.headers['set-cookie'], 'rote_rt');
    expect(rotated).not.toBe(original);
    expect(refreshed.body.data.accessToken).toEqual(expect.any(String));
    const nextCsrf = cookieValue(refreshed.headers['set-cookie'], 'rote_csrf');
    await ctx
      .http()
      .post('/api/v1/auth/refresh')
      .set('cookie', `rote_rt=${rotated}; rote_csrf=${nextCsrf}`)
      .set('x-csrf-token', nextCsrf)
      .expect(200);
    const missing = await ctx.http().post('/api/v1/auth/refresh').expect(401);
    expect(missing.body.error.code).toBe('INVALID_REFRESH_TOKEN');
  });

  it('detects refresh-token reuse and ends the session for everyone holding it', async () => {
    const victim = ctx.http();
    const signIn = await victim
      .post('/api/v1/auth/login')
      .send({ email: 'dana@example.com', password: PASSWORD })
      .expect(200);
    const original = cookieValue(signIn.headers['set-cookie'], 'rote_rt');
    const csrf = cookieValue(signIn.headers['set-cookie'], 'rote_csrf');
    await victim.post('/api/v1/auth/refresh').set('x-csrf-token', csrf).expect(200);

    const reuse = await ctx
      .http()
      .post('/api/v1/auth/refresh')
      .set('cookie', `rote_rt=${original}; rote_csrf=${csrf}`)
      .set('x-csrf-token', csrf)
      .expect(401);
    expect(reuse.body.error.code).toBe('REFRESH_TOKEN_REUSED');
    // The legitimate holder's access token died with the session.
    await victim.get('/api/v1/auth/me').expect(401);
    expect(
      await ctx.prisma.auditLog.count({ where: { action: 'auth.refresh_token_reused' } }),
    ).toBe(1);
  });

  it('signs out: the session is revoked server-side, not just forgotten', async () => {
    const { agent, csrf, accessToken } = await login(ctx, 'dana@example.com');
    await agent.post('/api/v1/auth/logout').set('x-csrf-token', csrf).expect(204);
    await ctx
      .http()
      .get('/api/v1/auth/me')
      .set('authorization', `Bearer ${accessToken}`)
      .expect(401);
  });

  it('signs out a bearer-token client that has no session cookies', async () => {
    const { accessToken } = await login(ctx, 'dana@example.com');
    await ctx
      .http()
      .post('/api/v1/auth/logout')
      .set('authorization', `Bearer ${accessToken}`)
      .expect(204);
    await ctx
      .http()
      .get('/api/v1/auth/me')
      .set('authorization', `Bearer ${accessToken}`)
      .expect(401);
  });

  it('purges sessions that ended before the retention window, and only those', async () => {
    const user = await ctx.prisma.user.findUniqueOrThrow({ where: { email: 'dana@example.com' } });
    const day = 86_400_000;
    const now = Date.now();
    const make = (name: string, expiresIn: number, revokedAgo?: number) =>
      ctx.prisma.session.create({
        data: {
          userId: user.id,
          refreshTokenHash: name.padEnd(64, '0'),
          expiresAt: new Date(now + expiresIn),
          revokedAt: revokedAgo === undefined ? null : new Date(now - revokedAgo),
        },
      });
    const live = await make('live', 7 * day);
    const recentlyRevoked = await make('recent', 7 * day, 2 * day);
    await make('expired', -40 * day);
    await make('revoked', 7 * day, 40 * day);

    const removed = await ctx.app.get(SessionCleanupService).purgeEndedSessions();

    expect(removed).toBeGreaterThanOrEqual(2);
    const left = await ctx.prisma.session.findMany({
      where: { id: { in: [live.id, recentlyRevoked.id] } },
    });
    expect(left).toHaveLength(2);
    expect(
      await ctx.prisma.session.count({
        where: { refreshTokenHash: { in: ['expired'.padEnd(64, '0'), 'revoked'.padEnd(64, '0')] } },
      }),
    ).toBe(0);
  });

  it('takes a disabled account out immediately', async () => {
    const { agent, accessToken } = await login(ctx, 'dana@example.com');
    await ctx.prisma.user.update({
      where: { email: 'dana@example.com' },
      data: { status: 'DISABLED' },
    });
    await agent.get('/api/v1/auth/me').expect(401);
    await ctx
      .http()
      .get('/api/v1/auth/me')
      .set('authorization', `Bearer ${accessToken}`)
      .expect(401);
    await ctx.prisma.user.update({
      where: { email: 'dana@example.com' },
      data: { status: 'ACTIVE' },
    });
  });

  it('has sign-up off by default', async () => {
    const response = await ctx
      .http()
      .post('/api/v1/auth/register')
      .send({ email: 'new@example.com', name: 'New', password: PASSWORD })
      .expect(403);
    expect(response.body.error.code).toBe('SIGNUP_DISABLED');
    const options = await ctx.http().get('/api/v1/auth/options').expect(200);
    expect(options.body.data).toEqual({ signupEnabled: false, demoEnabled: true });
  });

  it('changes a password and signs out the other sessions', async () => {
    await createUser(ctx.prisma, 'pat@example.com', Role.VIEWER);
    const laptop = await login(ctx, 'pat@example.com');
    const phone = await login(ctx, 'pat@example.com');
    await laptop.agent
      .post('/api/v1/auth/password')
      .set('x-csrf-token', laptop.csrf)
      .send({ currentPassword: PASSWORD, newPassword: 'a whole new passphrase 2' })
      .expect(204);
    await laptop.agent.get('/api/v1/auth/me').expect(200);
    await phone.agent.get('/api/v1/auth/me').expect(401);
    await login(ctx, 'pat@example.com', 'a whole new passphrase 2');
  });
});
