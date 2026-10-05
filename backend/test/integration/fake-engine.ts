/**
 * A stand-in for the Python engine that speaks its HTTP contract (src/rote/web on the Python side),
 * so integration tests exercise the whole control plane — HTTP, guards, services, repositories,
 * PostgreSQL — without a browser. Every call is recorded for assertions.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface RecordedCall {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: IncomingMessage['headers'];
  body: unknown;
}

interface FakeIntervention {
  id: string;
  reason_code: string;
  status: 'open' | 'claimed' | 'resolved';
  step_id: string;
  claimed_by: string | null;
  resolution: string | null;
  note: string | null;
}

export interface FakeRun {
  id: string;
  source: 'active' | 'runs' | 'evidence';
  kind: 'replay' | 'discovery' | 'probe';
  subject: string;
  tenant: string;
  status: string;
  started_at: string;
  duration_ms: number | null;
  active: boolean;
  result: Record<string, unknown> | null;
  intervention: FakeIntervention | null;
  holder: string;
  epoch: number;
}

export interface FakeCapability {
  id: string;
  version: string;
  status: 'draft' | 'approved' | 'deprecated';
  kind: 'task' | 'session';
  sourceRun: string | null;
}

export const ENGINE_TOKEN = 'test-engine-token-0123456789';

export class FakeEngine {
  readonly calls: RecordedCall[] = [];
  readonly runs = new Map<string, FakeRun>();
  readonly capabilities = new Map<string, FakeCapability>();
  evalRunning = false;
  private server: Server | null = null;
  private counter = 0;

  constructor() {
    this.reset();
  }

  reset(): void {
    this.calls.length = 0;
    this.runs.clear();
    this.capabilities.clear();
    this.evalRunning = false;
    this.capabilities.set('legacycore.member.get_savings_balance', {
      id: 'legacycore.member.get_savings_balance',
      version: '1.0.3',
      status: 'approved',
      kind: 'task',
      sourceRun: null,
    });
    this.capabilities.set('legacycore.session.sign_on', {
      id: 'legacycore.session.sign_on',
      version: '1.0.0',
      status: 'approved',
      kind: 'session',
      sourceRun: null,
    });
  }

  async start(): Promise<string> {
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve) => this.server?.listen(0, '127.0.0.1', resolve));
    const { port } = this.server.address() as AddressInfo;
    return `http://127.0.0.1:${port}`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) =>
      this.server ? this.server.close(() => resolve()) : resolve(),
    );
  }

  /** Add a run as if the CLI or an earlier session had produced it. */
  addRun(partial: Partial<FakeRun> & { id: string }): FakeRun {
    const run: FakeRun = {
      source: 'runs',
      kind: 'replay',
      subject: 'legacycore.member.get_savings_balance@1.0.3',
      tenant: 'acme',
      status: 'succeeded',
      started_at: new Date().toISOString(),
      duration_ms: 1200,
      active: false,
      result: { status: 'succeeded', outputs: { savings_balance: '2418.07' } },
      intervention: null,
      holder: 'automation',
      epoch: 0,
      ...partial,
    };
    this.runs.set(run.id, run);
    return run;
  }

  callsTo(method: string, path: string | RegExp): RecordedCall[] {
    return this.calls.filter(
      (call) =>
        call.method === method &&
        (typeof path === 'string' ? call.path === path : path.test(call.path)),
    );
  }

  private nextRunId(kind: string): string {
    this.counter += 1;
    return `20261004T1200${String(this.counter).padStart(2, '0')}Z-${kind}-fake-${this.counter}`;
  }

  private summary(run: FakeRun) {
    return {
      id: run.id,
      source: run.source,
      kind: run.kind,
      subject: run.subject,
      tenant: run.tenant,
      status: run.status,
      started_at: run.started_at,
      duration_ms: run.duration_ms,
      active: run.active,
    };
  }

  private capabilitySummary(cap: FakeCapability) {
    return {
      id: cap.id,
      version: cap.version,
      title: cap.id.split('.').pop() ?? cap.id,
      description: `Fake ${cap.id}`,
      status: cap.status,
      kind: cap.kind,
      side_effects: 'read_only',
      idempotent: true,
      requires_session: null,
      inputs:
        cap.kind === 'task'
          ? { member_id: { type: 'string', description: 'Member number', sensitivity: 'pii' } }
          : {},
      outputs: {},
      outcomes: [],
      steps: 5,
      versions: [{ version: cap.version, status: cap.status }],
      provenance: {
        method: 'discovery',
        recorded_at: '2026-10-01T00:00:00Z',
        goal: 'x',
        tenant: 'acme',
        source_run: cap.sourceRun,
      },
    };
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://engine');
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks).toString('utf8');
    let body: unknown;
    try {
      body = raw ? JSON.parse(raw) : null;
    } catch {
      body = raw;
    }
    const method = req.method ?? 'GET';
    this.calls.push({
      method,
      path: url.pathname,
      query: url.searchParams,
      headers: req.headers,
      body,
    });

    const send = (status: number, payload: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { 'content-type': 'application/json', ...headers });
      res.end(JSON.stringify(payload));
    };
    if (url.pathname !== '/api/health' && req.headers['x-engine-token'] !== ENGINE_TOKEN) {
      send(401, { detail: 'a valid engine token is required' });
      return;
    }
    const segments = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    const input = (body ?? {}) as Record<string, unknown>;

    // ---------------------------------------------------------------- status & library
    if (method === 'GET' && url.pathname === '/api/health')
      return send(200, { status: 'ok', version: 'fake' });
    if (method === 'GET' && url.pathname === '/api/status') {
      return send(200, {
        version: 'fake',
        model: 'claude-test',
        effort: 'high',
        has_api_key: false,
        tenants: [
          {
            id: 'acme',
            name: 'Acme',
            app: 'legacycore',
            base_url: 'http://bank/acme',
            product_version: '4.2.1',
            overrides: 0,
            reachable: true,
          },
        ],
        active_runs: [...this.runs.values()].filter((r) => r.active).length,
      });
    }
    if (method === 'GET' && url.pathname === '/api/policy')
      return send(200, { policy: { id: 'default' }, apps: [], tenants: [] });
    if (method === 'GET' && url.pathname === '/api/evidence')
      return send(200, { mode: 'offline', runs: [] });
    if (method === 'GET' && url.pathname === '/api/demo/members') {
      return send(200, [{ member_id: '12345', label: 'Happy path', expect: 'succeeded' }]);
    }
    if (segments[1] === 'demo' && segments[2] === 'faults') {
      if (segments[3] !== 'acme') return send(404, { detail: `unknown tenant ${segments[3]}` });
      return send(200, method === 'PUT' ? input : {});
    }
    if (method === 'GET' && url.pathname === '/api/capabilities') {
      return send(
        200,
        [...this.capabilities.values()].map((cap) => this.capabilitySummary(cap)),
      );
    }
    if (segments[1] === 'capabilities' && segments.length === 3 && method === 'GET') {
      const cap = this.capabilities.get(segments[2] ?? '');
      if (!cap) return send(404, { detail: `no capability ${segments[2]}` });
      return send(200, {
        summary: this.capabilitySummary(cap),
        capability: { steps: [] },
        yaml: 'id: x',
        tenant: url.searchParams.get('tenant'),
        layers: [],
        effective_hash: null,
        overridden: {},
        handlers: [],
        expect_text: {},
        success_text: [],
        tool: null,
      });
    }
    if (segments[1] === 'capabilities' && segments[3] === 'approve' && method === 'POST') {
      const [id] = (segments[2] ?? '').split('@');
      const cap = this.capabilities.get(id ?? '');
      if (!cap) return send(404, { detail: 'no such capability' });
      cap.status = 'approved';
      return send(200, { ok: true, ref: `${cap.id}@${cap.version}` });
    }
    if (segments[1] === 'capabilities' && segments[3] === 'invoke' && method === 'POST') {
      const cap = this.capabilities.get(segments[2] ?? '');
      if (!cap) return send(404, { detail: `no capability named '${segments[2]}'` });
      const inputs = (input['inputs'] ?? {}) as Record<string, string>;
      if (!inputs['member_id']) {
        return send(422, {
          detail: "the inputs do not match the capability's contract",
          problems: ['member_id: required'],
        });
      }
      const run = this.addRun({
        id: this.nextRunId('replay'),
        source: 'runs',
        tenant: String(input['tenant']),
      });
      const running = Number(input['wait_s']) < 2;
      if (running) Object.assign(run, { active: true, status: 'running', source: 'active' });
      return send(running ? 202 : 200, {
        status: running ? 'running' : 'succeeded',
        capability: `${cap.id}@${cap.version}`,
        run_id: run.id,
        ...(running ? {} : { outputs: { savings_balance: '2418.07' } }),
        links: { run: `/api/runs/${run.id}`, ui: `http://localhost:3000/runs/${run.id}` },
      });
    }
    if (method === 'GET' && url.pathname === '/api/agents/tools') {
      return send(200, [
        {
          name: 'legacycore__member__get_savings_balance',
          description: 'Get balance',
          inputSchema: { type: 'object', properties: {} },
        },
      ]);
    }
    if (method === 'GET' && url.pathname === '/api/catalog')
      return send(200, [{ name: 'legacycore__member__get_savings_balance' }]);

    // ---------------------------------------------------------------- runs
    if (method === 'GET' && url.pathname === '/api/runs')
      return send(
        200,
        [...this.runs.values()].map((r) => this.summary(r)),
      );
    if (method === 'POST' && url.pathname === '/api/runs') {
      const capability = typeof input['capability'] === 'string' ? input['capability'] : null;
      if (
        input['kind'] !== 'discovery' &&
        !this.capabilities.has((capability ?? '').split('@')[0] ?? '')
      ) {
        return send(404, { detail: `no capability ${capability}` });
      }
      const kind = input['kind'] as FakeRun['kind'];
      const run = this.addRun({
        id: this.nextRunId(kind),
        kind,
        source: 'active',
        active: true,
        status: 'running',
        // Like the engine: a live run's subject is the raw request.
        subject: kind === 'discovery' ? String(input['goal']) : String(capability),
        tenant: String(input['tenant']),
        duration_ms: null,
        result: null,
        intervention: {
          id: 'iv_0001',
          reason_code: 'UNEXPECTED_STATE',
          status: 'open',
          step_id: 's02',
          claimed_by: null,
          resolution: null,
          note: null,
        },
        holder: '',
      });
      return send(201, { id: run.id });
    }
    if (segments[1] === 'runs' && segments[2]) {
      const run = this.runs.get(segments[2]);
      if (!run) return send(404, { detail: `no run ${segments[2]}` });
      const rest = segments.slice(3);
      if (rest.length === 0 && method === 'GET') {
        return send(200, {
          ...this.summary(run),
          result: run.result,
          caller: null,
          error: null,
          files: {},
          interventions: run.intervention ? [run.intervention] : [],
          has_report: true,
        });
      }
      if (rest[0] === 'stream') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
        res.write('retry: 3000\n\n');
        res.write(
          `event: run\ndata: ${JSON.stringify({ seq: 1, type: 'run.started', run_id: run.id })}\n\n`,
        );
        res.write(
          `event: run\ndata: ${JSON.stringify({ seq: 2, type: 'run.finished', status: run.status })}\n\n`,
        );
        res.end('event: end\ndata: {}\n\n');
        return;
      }
      if (rest[0] === 'files') {
        const path = rest.slice(1).join('/');
        if (path === 'report.html') {
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
          res.end('<html><body><img src="screens/a.jpg"><script>alert(1)</script></body></html>');
          return;
        }
        if (path === 'screens/a.jpg') {
          res.writeHead(200, { 'content-type': 'image/jpeg' });
          res.end(Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
          return;
        }
        return send(404, { detail: 'no such file' });
      }
      if (rest[0] === 'operator') {
        if (!run.active)
          return send(409, { detail: 'this run is not live; its session has closed' });
        const control = {
          state: run.holder ? 'human' : 'awaiting_human',
          holder: run.holder,
          epoch: run.epoch,
          since: run.started_at,
        };
        if (rest[1] === 'state')
          return send(200, {
            run: { id: run.id },
            control,
            dialog: null,
            active: run.intervention?.status === 'resolved' ? null : run.intervention,
            history: [],
          });
        if (rest[1] === 'screen') return send(200, { dialog: null, elements: [] });
        if (rest[1] === 'live.jpg') {
          res.writeHead(200, {
            'content-type': 'image/jpeg',
            'x-masked': url.searchParams.get('mask') ?? 'absent',
          });
          res.end(Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
          return;
        }
        const intervention = run.intervention;
        if (rest[1] === 'interventions' && intervention && rest[2] === intervention.id) {
          if (rest[3] === 'claim') {
            if (run.holder)
              return send(409, { detail: `intervention ${intervention.id} is claimed` });
            run.holder = String(input['operator']);
            run.epoch += 1;
            intervention.status = 'claimed';
            intervention.claimed_by = run.holder;
            return send(200, {
              epoch: run.epoch,
              control: { state: 'human', holder: run.holder, epoch: run.epoch },
            });
          }
          if (rest[3] === 'resolve') {
            if (input['operator'] !== run.holder || input['epoch'] !== run.epoch)
              return send(409, { detail: 'stale lease' });
            Object.assign(intervention, {
              status: 'resolved',
              resolution: input['resolution'],
              note: input['note'],
            });
            run.holder = '';
            return send(200, { ok: true, control: { state: 'automated' } });
          }
          if (!rest[3]) return send(200, intervention);
        }
        if (rest[1] === 'input') {
          if (input['operator'] !== run.holder)
            return send(409, {
              detail: `${String(input['operator'])} does not hold this session (holder: ${run.holder})`,
            });
          return send(200, { ok: true });
        }
        return send(404, { detail: 'no such intervention' });
      }
    }

    // ---------------------------------------------------------------- evals
    if (method === 'GET' && url.pathname === '/api/evals/datasets') {
      return send(200, [
        {
          id: 'replay',
          title: 'Replay',
          description: '',
          kind: 'replay',
          uses_model: false,
          threshold: 1,
          cases: 13,
          tags: [],
          latest: null,
        },
        {
          id: 'probe',
          title: 'Probe',
          description: '',
          kind: 'probe',
          uses_model: true,
          threshold: 0.8,
          cases: 5,
          tags: [],
          latest: null,
        },
      ]);
    }
    if (method === 'GET' && url.pathname === '/api/evals/results') {
      return send(200, [
        {
          id: 'e1',
          dataset: 'replay',
          dataset_title: 'Replay',
          status: 'completed',
          started_at: '2026-10-01T00:00:00Z',
        },
      ]);
    }
    if (method === 'POST' && url.pathname === '/api/evals/runs') {
      if (this.evalRunning)
        return send(409, { detail: 'eval e2 is still running; one eval runs at a time' });
      if (input['dataset'] !== 'replay' && input['dataset'] !== 'probe')
        return send(404, { detail: 'no dataset' });
      this.evalRunning = true;
      return send(202, { id: 'e2' });
    }

    // ---------------------------------------------------------------- MCP (stateless JSON)
    if (url.pathname === '/mcp' && method === 'POST') {
      const rpc = input as { id?: number; method?: string; params?: { name?: string } };
      if (rpc.method === 'tools/call') {
        const run = this.addRun({ id: this.nextRunId('replay') });
        return send(200, {
          jsonrpc: '2.0',
          id: rpc.id,
          result: {
            content: [{ type: 'text', text: '{}' }],
            structuredContent: {
              status: 'succeeded',
              capability: 'legacycore.member.get_savings_balance@1.0.3',
              run_id: run.id,
            },
            isError: false,
          },
        });
      }
      return send(200, {
        jsonrpc: '2.0',
        id: rpc.id,
        result: { tools: [{ name: 'legacycore__member__get_savings_balance' }] },
      });
    }

    return send(404, { detail: 'Not Found' });
  }
}
