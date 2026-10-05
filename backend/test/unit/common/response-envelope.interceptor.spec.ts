import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { firstValueFrom, of } from 'rxjs';

import {
  RAW_RESPONSE_KEY,
  RESPONSE_MESSAGE_KEY,
} from '../../../src/common/decorators/metadata.decorators.js';
import { ResponseEnvelopeInterceptor } from '../../../src/common/interceptors/response-envelope.interceptor.js';
import { PaginatedResult } from '../../../src/common/utils/pagination.util.js';

function handler(metadata: Record<string, unknown> = {}) {
  const fn = () => undefined;
  for (const [key, value] of Object.entries(metadata)) Reflect.defineMetadata(key, value, fn);
  return fn;
}

async function intercept(body: unknown, { metadata = {}, statusCode = 200 } = {}) {
  const context = {
    getType: () => 'http',
    getHandler: () => handler(metadata),
    getClass: () => class {},
    switchToHttp: () => ({ getResponse: () => ({ statusCode }) }),
  } as unknown as ExecutionContext;
  const next: CallHandler = { handle: () => of(body) };
  return firstValueFrom(new ResponseEnvelopeInterceptor(new Reflector()).intercept(context, next));
}

describe('ResponseEnvelopeInterceptor', () => {
  it('wraps data with a default message', async () => {
    expect(await intercept({ id: 1 })).toEqual({
      success: true,
      data: { id: 1 },
      message: 'Request successful',
    });
  });

  it('uses the handler’s message and turns undefined into null', async () => {
    expect(
      await intercept(undefined, { metadata: { [RESPONSE_MESSAGE_KEY]: 'Signed in' } }),
    ).toEqual({
      success: true,
      data: null,
      message: 'Signed in',
    });
  });

  it('puts paginated items in data and the page in meta', async () => {
    const page = new PaginatedResult([{ id: 1 }], 21, { page: 2, limit: 1 });
    expect(await intercept(page)).toEqual({
      success: true,
      data: [{ id: 1 }],
      meta: { page: 2, limit: 1, total: 21, totalPages: 21 },
    });
  });

  it('leaves raw responses and 204s alone', async () => {
    expect(await intercept('event: end', { metadata: { [RAW_RESPONSE_KEY]: true } })).toBe(
      'event: end',
    );
    expect(await intercept(undefined, { statusCode: 204 })).toBeUndefined();
  });
});
