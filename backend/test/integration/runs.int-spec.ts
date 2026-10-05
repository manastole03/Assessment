import { Role } from '../../src/generated/prisma/enums.js';
import { RunSyncService } from '../../src/modules/runs/run-sync.service.js';
import { ENGINE_TOKEN } from './fake-engine.js';
import {
  createTestApp,
  createUser,
  login,
  resetDatabase,
  type Session,
  type TestContext,
} from './test-app.js';

const REPLAY = {
  kind: 'replay',
  tenant: 'acme',
  capability: 'legacycore.member.get_savings_balance',
  inputs: { member_id: '12345' },
};

describe('Runs and human handoff', () => {
  let ctx: TestContext;
  let operator: Session;
  let viewer: Session;
  let reviewer: Session;

  beforeAll(async () => {
    ctx = await createTestApp();
    await resetDatabase(ctx.prisma);
    await createUser(ctx.prisma, 'dana@example.com', Role.OPERATOR, 'Dana');
    await createUser(ctx.prisma, 'vic@example.com', Role.VIEWER, 'Vic');
    await createUser(ctx.prisma, 'riley@example.com', Role.REVIEWER, 'Riley');
    await createUser(ctx.prisma, 'olive@example.com', Role.OPERATOR, 'Olive');
    operator = await login(ctx, 'dana@example.com');
    viewer = await login(ctx, 'vic@example.com');
    reviewer = await login(ctx, 'riley@example.com');
  });
  afterAll(() => ctx.close());

  it('starts a replay through the engine and records who asked for it', async () => {
    const response = await operator.agent
      .post('/api/v1/runs')
      .set('x-csrf-token', operator.csrf)
      .send(REPLAY)
      .expect(201);
    expect(response.body).toMatchObject({
      success: true,
      message: 'Run started',
      data: {
        run: {
          kind: 'replay',
          status: 'running',
          origin: 'control_plane',
          requestedBy: { email: 'dana@example.com' },
        },
      },
    });

    const [call] = ctx.engine.callsTo('POST', '/api/runs');
    expect(call?.headers['x-engine-token']).toBe(ENGINE_TOKEN);
    expect(call?.headers['x-request-id']).toEqual(response.headers['x-request-id']);
    expect(call?.body).toMatchObject({
      kind: 'replay',
      tenant: 'acme',
      allow_draft: false,
      escalation: 'wait',
      inputs: { member_id: '12345' },
    });

    const row = await ctx.prisma.run.findUniqueOrThrow({
      where: { id: response.body.data.id },
      include: { requestedBy: true },
    });
    expect(row.requestedBy?.email).toBe('dana@example.com');
    const audit = await ctx.prisma.auditLog.findFirstOrThrow({
      where: { action: 'run.started', resourceId: row.id },
    });
    expect(JSON.stringify(audit.metadata)).not.toContain('12345');
  });

  it('enforces who may start what', async () => {
    const asViewer = await viewer.agent
      .post('/api/v1/runs')
      .set('x-csrf-token', viewer.csrf)
      .send(REPLAY)
      .expect(403);
    expect(asViewer.body.error.code).toBe('INSUFFICIENT_ROLE');
    const discovery = {
      kind: 'discovery',
      tenant: 'acme',
      goal: 'Sign on to LegacyCore with the service account',
    };
    await operator.agent
      .post('/api/v1/runs')
      .set('x-csrf-token', operator.csrf)
      .send(discovery)
      .expect(403);
    await operator.agent
      .post('/api/v1/runs')
      .set('x-csrf-token', operator.csrf)
      .send({ ...REPLAY, allowDraft: true })
      .expect(403);
    const started = await reviewer.agent
      .post('/api/v1/runs')
      .set('x-csrf-token', reviewer.csrf)
      .send(discovery)
      .expect(201);
    // The goal can name a member, so it is never stored as the subject.
    expect(started.body.data.run.subject).toBe('task discovery');
    const missing = await operator.agent
      .post('/api/v1/runs')
      .set('x-csrf-token', operator.csrf)
      .send({ ...REPLAY, capability: 'nope.missing' })
      .expect(404);
    expect(missing.body.error.code).toBe('CAPABILITY_NOT_FOUND');
    await operator.agent
      .post('/api/v1/runs')
      .set('x-csrf-token', operator.csrf)
      .send({ kind: 'teleport', tenant: 'acme' })
      .expect(400);
  });

  it('indexes runs it did not start (CLI, evidence) and keeps them in step with the engine', async () => {
    ctx.engine.addRun({
      id: '20261001T000000Z-replay-cli-1',
      status: 'business_outcome',
      result: { outcome: { code: 'MEMBER_NOT_FOUND', message: 'x' } },
    });
    ctx.engine.addRun({
      id: '12-replay-member-not-found',
      source: 'evidence',
      status: 'failed',
      result: { failure: { code: 'TARGET_NOT_FOUND', message: 'x' } },
    });
    await ctx.app.get(RunSyncService).tick();

    const cli = await ctx.prisma.run.findUniqueOrThrow({
      where: { id: '20261001T000000Z-replay-cli-1' },
    });
    expect(cli).toMatchObject({
      origin: 'ENGINE',
      status: 'BUSINESS_OUTCOME',
      resultCode: 'MEMBER_NOT_FOUND',
      requestedById: null,
    });
    expect(
      (await ctx.prisma.run.findUniqueOrThrow({ where: { id: '12-replay-member-not-found' } }))
        .origin,
    ).toBe('EVIDENCE');

    ctx.engine.runs.get('20261001T000000Z-replay-cli-1')!.status = 'failed';
    await ctx.app.get(RunSyncService).tick();
    expect(
      (await ctx.prisma.run.findUniqueOrThrow({ where: { id: '20261001T000000Z-replay-cli-1' } }))
        .status,
    ).toBe('FAILED');
  });

  it('lists runs with pagination, filters, search and whitelisted sorting', async () => {
    const all = await viewer.agent.get('/api/v1/runs?limit=2').expect(200);
    expect(all.body.meta).toMatchObject({ page: 1, limit: 2, total: 4, totalPages: 2 });
    const mine = await operator.agent.get('/api/v1/runs?requestedBy=me').expect(200);
    expect(
      mine.body.data.every(
        (run: { requestedBy: { email: string } }) => run.requestedBy.email === 'dana@example.com',
      ),
    ).toBe(true);
    const evidence = await viewer.agent.get('/api/v1/runs?origin=evidence').expect(200);
    expect(evidence.body.data.map((run: { id: string }) => run.id)).toEqual([
      '12-replay-member-not-found',
    ]);
    const search = await viewer.agent.get('/api/v1/runs?search=member_not').expect(200);
    expect(search.body.data).toHaveLength(1);
    await viewer.agent.get('/api/v1/runs?sortBy=requestedById').expect(400);
    await viewer.agent.get('/api/v1/runs?status=exploded').expect(400);
  });

  it('returns a run with its evidence, and 404 for unknown runs', async () => {
    const detail = await viewer.agent.get('/api/v1/runs/20261001T000000Z-replay-cli-1').expect(200);
    expect(detail.body.data).toMatchObject({
      id: '20261001T000000Z-replay-cli-1',
      hasReport: true,
      result: { outcome: { code: 'MEMBER_NOT_FOUND' } },
    });
    const missing = await viewer.agent.get('/api/v1/runs/does-not-exist').expect(404);
    expect(missing.body.error.code).toBe('RUN_NOT_FOUND');
    await viewer.agent.get('/api/v1/runs/..%2F..%2Fetc').expect(400);
  });

  it('returns the unmasked caller payload only to the user who started the run', async () => {
    const started = await operator.agent
      .post('/api/v1/runs')
      .set('x-csrf-token', operator.csrf)
      .send(REPLAY)
      .expect(201);
    const id = started.body.data.id as string;

    const own = await operator.agent.get(`/api/v1/runs/${id}`).expect(200);
    expect(own.body.data.caller).toMatchObject({ outputs: { member_name: 'Alex Member' } });

    // Others see the run and its (masked) evidence, never the personal data returned to the requester.
    for (const other of [viewer, reviewer]) {
      const seen = await other.agent.get(`/api/v1/runs/${id}`).expect(200);
      expect(seen.body.data.id).toBe(id);
      expect(seen.body.data.caller).toBeNull();
    }
  });

  it('streams run events over Server-Sent Events', async () => {
    const response = await viewer.agent
      .get('/api/v1/runs/20261001T000000Z-replay-cli-1/stream')
      .buffer(true)
      .parse((res, done) => {
        let text = '';
        res.on('data', (chunk: Buffer) => (text += chunk.toString()));
        res.on('end', () => done(null, text));
      });
    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toMatch(/text\/event-stream/);
    expect(response.body as string).toMatch(/event: run[\s\S]*event: end/);
  });

  it('serves evidence files, with a sandboxing CSP on HTML and no path traversal', async () => {
    const report = await viewer.agent
      .get('/api/v1/runs/20261001T000000Z-replay-cli-1/files/report.html')
      .expect(200);
    expect(report.headers['content-security-policy']).toMatch(/^sandbox allow-same-origin/);
    expect(report.headers['content-security-policy']).not.toMatch(/allow-scripts/);
    const image = await viewer.agent
      .get('/api/v1/runs/20261001T000000Z-replay-cli-1/files/screens/a.jpg')
      .expect(200);
    expect(image.headers['content-type']).toBe('image/jpeg');
    // Any evidence that a browser could render as a document (SVG, XML) is sandboxed too.
    const svg = await viewer.agent
      .get('/api/v1/runs/20261001T000000Z-replay-cli-1/files/screens/b.svg')
      .expect(200);
    expect(svg.headers['content-security-policy']).toMatch(/^sandbox /);
    expect(svg.headers['content-security-policy']).not.toMatch(/allow-scripts/);
    expect(svg.headers['x-content-type-options']).toBe('nosniff');
    await viewer.agent
      .get('/api/v1/runs/20261001T000000Z-replay-cli-1/files/..%2F..%2Fsecrets')
      .expect(404);
    await ctx
      .http()
      .get('/api/v1/runs/20261001T000000Z-replay-cli-1/files/report.html')
      .expect(401);
  });

  describe('handoff', () => {
    let runId: string;

    beforeAll(async () => {
      const started = await operator.agent
        .post('/api/v1/runs')
        .set('x-csrf-token', operator.csrf)
        .send(REPLAY)
        .expect(201);
      runId = started.body.data.id as string;
    });

    it('lets anyone watch, but only masked unless they are an operator', async () => {
      await viewer.agent.get(`/api/v1/runs/${runId}/operator/state`).expect(200);
      const maskSent = () =>
        ctx.engine
          .callsTo('GET', /\/live\.jpg$/)
          .at(-1)
          ?.query.get('mask');
      await viewer.agent.get(`/api/v1/runs/${runId}/operator/live.jpg?mask=false`).expect(200);
      expect(maskSent()).toBe('true');
      await operator.agent.get(`/api/v1/runs/${runId}/operator/live.jpg?mask=false`).expect(200);
      expect(maskSent()).toBe('false');
    });

    it('claims the lease in the caller’s own name, whatever the body says', async () => {
      await viewer.agent
        .post(`/api/v1/runs/${runId}/operator/interventions/iv_0001/claim`)
        .set('x-csrf-token', viewer.csrf)
        .send({})
        .expect(403);
      const claim = await operator.agent
        .post(`/api/v1/runs/${runId}/operator/interventions/iv_0001/claim`)
        .set('x-csrf-token', operator.csrf)
        .send({})
        .expect(200);
      expect(claim.body.data).toMatchObject({ epoch: 1, operator: 'dana@example.com' });
      expect(ctx.engine.callsTo('POST', /\/claim$/).at(-1)?.body).toEqual({
        operator: 'dana@example.com',
      });

      const intervention = await ctx.prisma.intervention.findFirstOrThrow({
        where: { runId },
        include: { claimedByUser: true },
      });
      expect(intervention).toMatchObject({ status: 'CLAIMED', claimedBy: 'dana@example.com' });
      expect(intervention.claimedByUser?.email).toBe('dana@example.com');

      const queue = await viewer.agent.get('/api/v1/interventions?status=claimed').expect(200);
      expect(queue.body.data[0]).toMatchObject({
        engineId: 'iv_0001',
        run: { id: runId },
        claimedByUser: { email: 'dana@example.com' },
      });
    });

    it('only the lease holder can act; another operator gets LEASE_CONFLICT', async () => {
      const olive = await login(ctx, 'olive@example.com');
      const intruder = await olive.agent
        .post(`/api/v1/runs/${runId}/operator/input`)
        .set('x-csrf-token', olive.csrf)
        .send({ epoch: 1, kind: 'press', key: 'Enter' })
        .expect(409);
      expect(intruder.body.error.code).toBe('LEASE_CONFLICT');
      await operator.agent
        .post(`/api/v1/runs/${runId}/operator/input`)
        .set('x-csrf-token', operator.csrf)
        .send({ epoch: 1, kind: 'click', x: 10, y: 20 })
        .expect(204);
      await operator.agent
        .post(`/api/v1/runs/${runId}/operator/input`)
        .set('x-csrf-token', operator.csrf)
        .send({ epoch: 1, kind: 'click', x: 10 })
        .expect(400);
    });

    it('hands back with a resolution, and records it', async () => {
      await operator.agent
        .post(`/api/v1/runs/${runId}/operator/interventions/iv_0001/resolve`)
        .set('x-csrf-token', operator.csrf)
        .send({ epoch: 1, resolution: 'step_completed', note: 'Completed the attestation' })
        .expect(200);
      const audit = await ctx.prisma.auditLog.findMany({
        where: { resourceId: `${runId}/iv_0001` },
        orderBy: { createdAt: 'asc' },
      });
      expect(audit.map((entry) => entry.action)).toEqual([
        'intervention.claimed',
        'intervention.resolved',
      ]);
      expect((await ctx.prisma.intervention.findFirstOrThrow({ where: { runId } })).status).toBe(
        'RESOLVED',
      );
    });

    it('answers RUN_NOT_LIVE once the session has closed', async () => {
      ctx.engine.runs.get(runId)!.active = false;
      const closed = await operator.agent.get(`/api/v1/runs/${runId}/operator/state`).expect(409);
      expect(closed.body.error.code).toBe('RUN_NOT_LIVE');
    });
  });
});
