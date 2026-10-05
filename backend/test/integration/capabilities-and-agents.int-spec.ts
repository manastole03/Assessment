import { Role } from '../../src/generated/prisma/enums.js';
import {
  createTestApp,
  createUser,
  login,
  resetDatabase,
  type Session,
  type TestContext,
} from './test-app.js';

const BALANCE = 'legacycore.member.get_savings_balance';

describe('Capabilities, approvals and the agent surface', () => {
  let ctx: TestContext;
  let riley: Session;
  let sam: Session;
  let operator: Session;
  let agentKey: string;

  beforeAll(async () => {
    ctx = await createTestApp();
    await resetDatabase(ctx.prisma);
    await createUser(ctx.prisma, 'riley@example.com', Role.REVIEWER, 'Riley');
    await createUser(ctx.prisma, 'sam@example.com', Role.REVIEWER, 'Sam');
    await createUser(ctx.prisma, 'dana@example.com', Role.OPERATOR, 'Dana');
    riley = await login(ctx, 'riley@example.com');
    sam = await login(ctx, 'sam@example.com');
    operator = await login(ctx, 'dana@example.com');
    const key = await operator.agent
      .post('/api/v1/api-keys')
      .set('x-csrf-token', operator.csrf)
      .send({ name: 'mcp', role: 'OPERATOR' })
      .expect(201);
    agentKey = key.body.data.secret as string;
  });
  afterAll(() => ctx.close());

  it('lists the library with filters and pagination, passing engine documents through', async () => {
    const page = await operator.agent.get('/api/v1/capabilities?kind=task').expect(200);
    expect(page.body.meta.total).toBe(1);
    expect(page.body.data[0]).toMatchObject({
      id: BALANCE,
      requires_session: null,
      side_effects: 'read_only',
    });
    const detail = await operator.agent
      .get(`/api/v1/capabilities/${BALANCE}?tenant=acme`)
      .expect(200);
    expect(
      ctx.engine.callsTo('GET', `/api/capabilities/${BALANCE}`).at(-1)?.query.get('tenant'),
    ).toBe('acme');
    expect(detail.body.data.summary.id).toBe(BALANCE);
    await operator.agent.get('/api/v1/capabilities/nope.missing').expect(404);
  });

  describe('approval', () => {
    beforeAll(async () => {
      // A draft recorded by a discovery that Riley started.
      const started = await riley.agent
        .post('/api/v1/runs')
        .set('x-csrf-token', riley.csrf)
        .send({ kind: 'discovery', tenant: 'acme', goal: 'Open a new share for a member' })
        .expect(201);
      ctx.engine.capabilities.set('legacycore.share.open', {
        id: 'legacycore.share.open',
        version: '0.1.0',
        status: 'draft',
        kind: 'task',
        sourceRun: started.body.data.id as string,
      });
    });

    it('is for reviewers only', async () => {
      const denied = await operator.agent
        .post('/api/v1/capabilities/legacycore.share.open/approve')
        .set('x-csrf-token', operator.csrf)
        .send({})
        .expect(403);
      expect(denied.body.error.code).toBe('INSUFFICIENT_ROLE');
    });

    it('needs a second pair of eyes: the reviewer who recorded the draft cannot approve it', async () => {
      const self = await riley.agent
        .post('/api/v1/capabilities/legacycore.share.open/approve')
        .set('x-csrf-token', riley.csrf)
        .send({ notes: 'mine' })
        .expect(403);
      expect(self.body.error.code).toBe('SELF_APPROVAL_FORBIDDEN');
      expect(ctx.engine.callsTo('POST', /\/approve$/)).toHaveLength(0);
    });

    it('records the approval against the signed-in reviewer', async () => {
      const approved = await sam.agent
        .post('/api/v1/capabilities/legacycore.share.open/approve')
        .set('x-csrf-token', sam.csrf)
        .send({ notes: 'checked every step' })
        .expect(200);
      expect(approved.body.data).toMatchObject({
        ref: 'legacycore.share.open@0.1.0',
        approvedBy: { email: 'sam@example.com' },
        notes: 'checked every step',
      });
      expect(ctx.engine.callsTo('POST', /\/approve$/)[0]?.body).toEqual({
        reviewer: 'Sam <sam@example.com>',
        notes: 'checked every step',
      });
      const history = await operator.agent
        .get('/api/v1/capabilities/legacycore.share.open/approvals')
        .expect(200);
      expect(history.body.data).toHaveLength(1);
    });

    it('cannot approve the same version twice', async () => {
      const again = await sam.agent
        .post('/api/v1/capabilities/legacycore.share.open/approve')
        .set('x-csrf-token', sam.csrf)
        .send({})
        .expect(409);
      expect(again.body.error.code).toBe('CAPABILITY_NOT_APPROVABLE');
    });
  });

  describe('invocation', () => {
    it('returns the result contract with control-plane links, and attributes the run', async () => {
      const response = await ctx
        .http()
        .post(`/api/v1/capabilities/${BALANCE}/invoke`)
        .set('authorization', `Bearer ${agentKey}`)
        .send({ tenant: 'acme', inputs: { member_id: '12345' } })
        .expect(200);
      const invocation = response.body.data as {
        run_id: string;
        links: { run: string; ui: string };
        outputs: unknown;
      };
      expect(invocation.outputs).toEqual({ savings_balance: '2418.07' });
      expect(invocation.links.run).toBe(`/api/v1/runs/${invocation.run_id}`);
      expect(
        ctx.engine.callsTo('POST', `/api/capabilities/${BALANCE}/invoke`)[0]?.body,
      ).toMatchObject({ escalation: 'fail', wait_s: 120 });
      const run = await ctx.prisma.run.findUniqueOrThrow({
        where: { id: invocation.run_id },
        include: { requestedBy: true, apiKey: true },
      });
      expect(run.requestedBy?.email).toBe('dana@example.com');
      expect(run.apiKey?.name).toBe('mcp');
    });

    it('answers 202 with a Location when the run outlives the wait', async () => {
      const response = await ctx
        .http()
        .post(`/api/v1/capabilities/${BALANCE}/invoke`)
        .set('x-api-key', agentKey)
        .send({ tenant: 'acme', inputs: { member_id: '12345' }, waitSeconds: 1 })
        .expect(202);
      expect(response.headers['location']).toBe(`/api/v1/runs/${response.body.data.run_id}`);
    });

    it('reports every contract problem as 422', async () => {
      const response = await ctx
        .http()
        .post(`/api/v1/capabilities/${BALANCE}/invoke`)
        .set('x-api-key', agentKey)
        .send({ tenant: 'acme', inputs: {} })
        .expect(422);
      expect(response.body.error).toEqual({
        code: 'INPUT_CONTRACT_VIOLATION',
        details: { problems: ['member_id: required'] },
      });
    });

    it('relays MCP and attributes tool calls to the key’s owner', async () => {
      const list = await ctx
        .http()
        .post('/api/v1/mcp')
        .set('authorization', `Bearer ${agentKey}`)
        .set('accept', 'application/json, text/event-stream')
        .send({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
        .expect(200);
      expect(list.body).toMatchObject({
        jsonrpc: '2.0',
        result: { tools: [{ name: 'legacycore__member__get_savings_balance' }] },
      });
      expect(list.body).not.toHaveProperty('success');

      const call = await ctx
        .http()
        .post('/api/v1/mcp')
        .set('authorization', `Bearer ${agentKey}`)
        .send({
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: {
            name: 'legacycore__member__get_savings_balance',
            arguments: { member_id: '12345' },
          },
        })
        .expect(200);
      const runId = call.body.result.structuredContent.run_id as string;
      expect(
        (
          await ctx.prisma.run.findUniqueOrThrow({
            where: { id: runId },
            include: { requestedBy: true },
          })
        ).requestedBy?.email,
      ).toBe('dana@example.com');
      expect(
        await ctx.prisma.auditLog.count({
          where: { action: 'mcp.tool_called', resourceId: runId },
        }),
      ).toBe(1);

      await ctx
        .http()
        .post('/api/v1/mcp')
        .send({ jsonrpc: '2.0', id: 3, method: 'tools/list' })
        .expect(401);
    });

    it('keeps viewers to read-only agent endpoints', async () => {
      await createUser(ctx.prisma, 'vic@example.com', Role.VIEWER);
      const viewer = await login(ctx, 'vic@example.com');
      await viewer.agent.get('/api/v1/agents/tools').expect(200);
      await viewer.agent
        .post(`/api/v1/capabilities/${BALANCE}/invoke`)
        .set('x-csrf-token', viewer.csrf)
        .send({ tenant: 'acme', inputs: { member_id: '1' } })
        .expect(403);
      await viewer.agent
        .post('/api/v1/mcp')
        .set('x-csrf-token', viewer.csrf)
        .send({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
        .expect(403);
    });

    it('serves only the MCP transport methods (GET, POST, DELETE)', async () => {
      for (const method of ['put', 'patch'] as const) {
        const response = await ctx
          .http()
          [method]('/api/v1/mcp')
          .set('authorization', `Bearer ${agentKey}`)
          .send({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
          .expect(404);
        expect(response.body.error.code).toBe('ROUTE_NOT_FOUND');
      }
    });
  });

  it('runs evals for reviewers, one at a time', async () => {
    await operator.agent
      .post('/api/v1/evals/runs')
      .set('x-csrf-token', operator.csrf)
      .send({ dataset: 'replay' })
      .expect(403);
    const started = await sam.agent
      .post('/api/v1/evals/runs')
      .set('x-csrf-token', sam.csrf)
      .send({ dataset: 'replay', trials: 3 })
      .expect(202);
    expect(started.body.data).toEqual({ id: 'e2' });
    const busy = await sam.agent
      .post('/api/v1/evals/runs')
      .set('x-csrf-token', sam.csrf)
      .send({ dataset: 'replay' })
      .expect(409);
    expect(busy.body.error.code).toBe('EVAL_ALREADY_RUNNING');
    const datasets = await operator.agent.get('/api/v1/evals/datasets').expect(200);
    expect(datasets.body.meta.total).toBe(2);
  });
});
