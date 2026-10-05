import { jest } from '@jest/globals';
import { z } from 'zod';

import { ErrorCode } from '../../../src/common/constants/error-codes.js';
import { runWithRequestContext } from '../../../src/common/utils/request-context.js';
import { EngineClient } from '../../../src/engine/engine.client.js';
import { testConfig } from '../../helpers/fixtures.js';

const schema = z.object({ id: z.string() });
const fetchMock = jest.fn<typeof fetch>();

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

async function failure(
  work: Promise<unknown>,
): Promise<{ code?: string; status?: number; message?: string; details?: unknown }> {
  try {
    await work;
  } catch (error) {
    const e = error as {
      code?: string;
      getStatus?: () => number;
      message?: string;
      details?: unknown;
    };
    return { code: e.code, status: e.getStatus?.(), message: e.message, details: e.details };
  }
  throw new Error('expected a failure');
}

describe('EngineClient', () => {
  const client = new EngineClient(
    testConfig({
      engine: { url: 'http://engine:8700', token: 'engine-secret-123456', timeoutMs: 1000 },
    }),
  );
  const original = globalThis.fetch;

  beforeAll(() => {
    globalThis.fetch = fetchMock;
  });
  afterAll(() => {
    globalThis.fetch = original;
  });
  beforeEach(() => fetchMock.mockReset());

  it('authenticates, propagates the request id and validates the response', async () => {
    fetchMock.mockResolvedValue(json(200, { id: 'run-1', extra: true }));
    const data = await runWithRequestContext({ requestId: 'req-42' }, () =>
      client.post('/api/runs', {
        schema,
        body: { kind: 'replay' },
        query: { tenant: 'acme', skip: undefined },
      }),
    );
    expect(data).toEqual({ id: 'run-1' });
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toEqual(new URL('http://engine:8700/api/runs?tenant=acme'));
    expect(init?.headers).toMatchObject({
      'x-engine-token': 'engine-secret-123456',
      'x-request-id': 'req-42',
      'content-type': 'application/json',
    });
    expect(init?.body).toBe('{"kind":"replay"}');
  });

  it('treats a response that breaks the contract as an engine error', async () => {
    fetchMock.mockResolvedValue(json(200, { unexpected: 1 }));
    expect(await failure(client.get('/api/x', { schema }))).toMatchObject({
      code: ErrorCode.ENGINE_ERROR,
      status: 502,
    });
  });

  it('maps engine statuses to stable error codes', async () => {
    fetchMock.mockResolvedValueOnce(json(404, { detail: 'no run 9' }));
    expect(
      await failure(
        client.get('/api/runs/9', { schema, errors: { 404: ErrorCode.RUN_NOT_FOUND } }),
      ),
    ).toMatchObject({
      code: ErrorCode.RUN_NOT_FOUND,
      status: 404,
      message: 'no run 9',
    });

    fetchMock.mockResolvedValueOnce(
      json(422, { detail: 'the inputs do not match', problems: ['member_id: required'] }),
    );
    expect(await failure(client.post('/api/x', { schema }))).toMatchObject({
      code: ErrorCode.INPUT_CONTRACT_VIOLATION,
      status: 422,
      details: { problems: ['member_id: required'] },
    });

    fetchMock.mockResolvedValueOnce(json(503, { detail: 'the LegacyCore mock is unreachable' }));
    expect(await failure(client.get('/api/x', { schema }))).toMatchObject({
      code: ErrorCode.UPSTREAM_UNAVAILABLE,
      status: 503,
    });

    fetchMock.mockResolvedValueOnce(json(500, { detail: 'Traceback (most recent call last)…' }));
    const crash = await failure(client.get('/api/x', { schema }));
    expect(crash).toMatchObject({ code: ErrorCode.ENGINE_ERROR, status: 502 });
    expect(crash.message).not.toContain('Traceback');

    fetchMock.mockResolvedValueOnce(json(401, { detail: 'a valid engine token is required' }));
    expect(await failure(client.get('/api/x', { schema }))).toMatchObject({
      code: ErrorCode.ENGINE_ERROR,
      status: 502,
    });
  });

  it('reports an unreachable or slow engine', async () => {
    fetchMock.mockRejectedValueOnce(
      Object.assign(new TypeError('fetch failed'), { cause: new Error('ECONNREFUSED') }),
    );
    expect(await failure(client.get('/api/x', { schema }))).toMatchObject({
      code: ErrorCode.ENGINE_UNAVAILABLE,
      status: 503,
    });

    fetchMock.mockRejectedValueOnce(new DOMException('The operation timed out.', 'TimeoutError'));
    expect(await failure(client.get('/api/x', { schema }))).toMatchObject({
      code: ErrorCode.ENGINE_TIMEOUT,
      status: 504,
    });
  });

  it('answers health probes without throwing', async () => {
    fetchMock.mockResolvedValueOnce(json(200, { status: 'ok' }));
    expect(await client.isReachable()).toBe(true);
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));
    expect(await client.isReachable()).toBe(false);
  });
});
