import { Role } from '../../src/generated/prisma/enums.js';
import {
  createTestApp,
  createUser,
  login,
  PASSWORD,
  resetDatabase,
  type Session,
  type TestContext,
} from './test-app.js';

describe('Users and API keys', () => {
  let ctx: TestContext;
  let admin: Session;
  let viewer: Session;

  beforeAll(async () => {
    ctx = await createTestApp();
    await resetDatabase(ctx.prisma);
    await createUser(ctx.prisma, 'admin@example.com', Role.ADMIN, 'Admin');
    await createUser(ctx.prisma, 'viewer@example.com', Role.VIEWER, 'Viewer');
    await createUser(ctx.prisma, 'reviewer@example.com', Role.REVIEWER, 'Reviewer');
    admin = await login(ctx, 'admin@example.com');
    viewer = await login(ctx, 'viewer@example.com');
  });
  afterAll(() => ctx.close());

  it('lets admins create users and rejects duplicates', async () => {
    const created = await admin.agent
      .post('/api/v1/users')
      .set('x-csrf-token', admin.csrf)
      .send({ email: 'ops@example.com', name: 'Ops', password: PASSWORD, role: 'OPERATOR' })
      .expect(201);
    expect(created.body).toMatchObject({
      success: true,
      message: 'User created',
      data: { email: 'ops@example.com', role: 'OPERATOR' },
    });
    expect(created.body.data).not.toHaveProperty('passwordHash');

    const duplicate = await admin.agent
      .post('/api/v1/users')
      .set('x-csrf-token', admin.csrf)
      .send({ email: 'OPS@example.com', name: 'Again', password: PASSWORD })
      .expect(409);
    expect(duplicate.body.error.code).toBe('EMAIL_ALREADY_EXISTS');
  });

  it('pages, searches, filters and sorts users', async () => {
    const page = await admin.agent
      .get('/api/v1/users?limit=2&sortBy=email&sortOrder=asc')
      .expect(200);
    expect(page.body.meta).toEqual({ page: 1, limit: 2, total: 4, totalPages: 2 });
    expect(page.body.data.map((u: { email: string }) => u.email)).toEqual([
      'admin@example.com',
      'ops@example.com',
    ]);
    const search = await admin.agent.get('/api/v1/users?search=REVIEW').expect(200);
    expect(search.body.data).toHaveLength(1);
    const filtered = await admin.agent.get('/api/v1/users?role=VIEWER').expect(200);
    expect(filtered.body.data.map((u: { role: string }) => u.role)).toEqual(['VIEWER']);
    await admin.agent.get('/api/v1/users?sortBy=passwordHash').expect(400);
    const unknown = await admin.agent.get('/api/v1/users?passwordHash=x').expect(400);
    expect(unknown.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('forbids non-admins from user management and hides other users', async () => {
    const forbidden = await viewer.agent.get('/api/v1/users').expect(403);
    expect(forbidden.body.error.code).toBe('INSUFFICIENT_ROLE');
    const other = await ctx.prisma.user.findUniqueOrThrow({
      where: { email: 'reviewer@example.com' },
    });
    await viewer.agent.get(`/api/v1/users/${other.id}`).expect(404);
    await viewer.agent.get('/api/v1/users/me').expect(200);
    await admin.agent.get('/api/v1/users/not-a-uuid').expect(400);
  });

  it('keeps at least one active admin', async () => {
    const me = await ctx.prisma.user.findUniqueOrThrow({ where: { email: 'admin@example.com' } });
    const self = await admin.agent
      .patch(`/api/v1/users/${me.id}`)
      .set('x-csrf-token', admin.csrf)
      .send({ role: 'VIEWER' })
      .expect(403);
    expect(self.body.error.code).toBe('SELF_MODIFICATION_FORBIDDEN');
    await admin.agent.delete(`/api/v1/users/${me.id}`).set('x-csrf-token', admin.csrf).expect(403);
  });

  it('applies role changes to existing sessions at once', async () => {
    const target = await ctx.prisma.user.findUniqueOrThrow({
      where: { email: 'reviewer@example.com' },
    });
    const reviewer = await login(ctx, 'reviewer@example.com');
    expect((await reviewer.agent.get('/api/v1/auth/me').expect(200)).body.data.effectiveRole).toBe(
      'REVIEWER',
    );
    await admin.agent
      .patch(`/api/v1/users/${target.id}`)
      .set('x-csrf-token', admin.csrf)
      .send({ role: 'VIEWER' })
      .expect(200);
    expect((await reviewer.agent.get('/api/v1/auth/me').expect(200)).body.data.effectiveRole).toBe(
      'VIEWER',
    );
    const audit = await admin.agent
      .get(`/api/v1/audit-logs?action=user.updated&resourceId=${target.id}`)
      .expect(200);
    expect(audit.body.data[0]).toMatchObject({
      actorEmail: 'admin@example.com',
      metadata: { role: { from: 'REVIEWER', to: 'VIEWER' } },
    });
    await admin.agent
      .patch(`/api/v1/users/${target.id}`)
      .set('x-csrf-token', admin.csrf)
      .send({ role: 'REVIEWER' })
      .expect(200);
  });

  it('issues API keys capped at the creator’s role, usable as Bearer or X-API-Key, and revocable', async () => {
    const tooStrong = await viewer.agent
      .post('/api/v1/api-keys')
      .set('x-csrf-token', viewer.csrf)
      .send({ name: 'agent', role: 'ADMIN' })
      .expect(403);
    expect(tooStrong.body.error.code).toBe('ROLE_EXCEEDS_OWNER');

    const created = await admin.agent
      .post('/api/v1/api-keys')
      .set('x-csrf-token', admin.csrf)
      .send({ name: 'claude code', role: 'OPERATOR', expiresInDays: 30 })
      .expect(201);
    const { secret, apiKey } = created.body.data as {
      secret: string;
      apiKey: { id: string; prefix: string };
    };
    expect(secret.startsWith(apiKey.prefix)).toBe(true);
    const stored = await ctx.prisma.apiKey.findUniqueOrThrow({ where: { id: apiKey.id } });
    expect(stored.keyHash).not.toContain(secret);

    const asBearer = await ctx
      .http()
      .get('/api/v1/auth/me')
      .set('authorization', `Bearer ${secret}`)
      .expect(200);
    expect(asBearer.body.data).toMatchObject({
      authMethod: 'api_key',
      effectiveRole: 'OPERATOR',
      user: { role: 'ADMIN' },
    });
    await ctx.http().get('/api/v1/users').set('x-api-key', secret).expect(403);
    // An API key is not an ambient credential, so writes need no CSRF token.
    await ctx
      .http()
      .patch('/api/v1/users/me')
      .set('x-api-key', secret)
      .send({ name: 'Admin' })
      .expect(200);

    const listing = await admin.agent.get('/api/v1/api-keys').expect(200);
    expect(listing.body.data[0]).not.toHaveProperty('keyHash');
    await admin.agent
      .delete(`/api/v1/api-keys/${apiKey.id}`)
      .set('x-csrf-token', admin.csrf)
      .expect(204);
    const revoked = await ctx
      .http()
      .get('/api/v1/auth/me')
      .set('authorization', `Bearer ${secret}`)
      .expect(401);
    expect(revoked.body.error.code).toBe('INVALID_API_KEY');
  });

  it('records security events in the audit log, readable by admins only', async () => {
    const audit = await admin.agent.get('/api/v1/audit-logs?limit=100').expect(200);
    const actions = new Set(audit.body.data.map((entry: { action: string }) => entry.action));
    for (const action of [
      'auth.login',
      'user.created',
      'user.updated',
      'api_key.created',
      'api_key.revoked',
    ])
      expect(actions).toContain(action);
    expect(JSON.stringify(audit.body)).not.toContain(PASSWORD);
    await viewer.agent.get('/api/v1/audit-logs').expect(403);
  });
});
