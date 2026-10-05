import { jest } from '@jest/globals';
import {
  BadRequestException,
  type ArgumentsHost,
  HttpStatus,
  NotFoundException,
} from '@nestjs/common';
import { ThrottlerException } from '@nestjs/throttler';

import { ErrorCode } from '../../../src/common/constants/error-codes.js';
import { AppException } from '../../../src/common/exceptions/app.exception.js';
import { AllExceptionsFilter } from '../../../src/common/filters/all-exceptions.filter.js';
import type { ApiFailure } from '../../../src/common/interfaces/api-response.interface.js';

function run(exception: unknown, { exposeInternals = false, headersSent = false } = {}) {
  const json = jest.fn();
  const end = jest.fn();
  const response = { headersSent, status: jest.fn(() => response), json, end };
  const request = {
    id: 'req-123',
    method: 'GET',
    url: '/api/v1/users/9?search=jo',
    originalUrl: '/api/v1/users/9?search=jo',
  };
  const host = {
    switchToHttp: () => ({ getRequest: () => request, getResponse: () => response }),
  } as unknown as ArgumentsHost;
  new AllExceptionsFilter(exposeInternals).catch(exception, host);
  const status = (response.status.mock.calls[0] as [number] | undefined)?.[0];
  return { status, body: json.mock.calls[0]?.[0] as ApiFailure | undefined, end };
}

describe('AllExceptionsFilter', () => {
  it('renders an AppException in the standard envelope', () => {
    const { status, body } = run(AppException.notFound('User not found', ErrorCode.USER_NOT_FOUND));
    expect(status).toBe(404);
    expect(body).toMatchObject({
      success: false,
      message: 'User not found',
      error: { code: 'USER_NOT_FOUND' },
      path: '/api/v1/users/9',
      requestId: 'req-123',
    });
    expect(body?.timestamp).toEqual(expect.any(String));
  });

  it('keeps validation details', () => {
    const details = [{ field: 'email', messages: ['email must be an email'] }];
    expect(run(AppException.validation('Validation failed', details)).body?.error).toEqual({
      code: 'VALIDATION_ERROR',
      details,
    });
  });

  it('maps unknown routes, malformed JSON and rate limits', () => {
    expect(run(new NotFoundException('Cannot GET /api/v1/nope')).body?.error.code).toBe(
      ErrorCode.ROUTE_NOT_FOUND,
    );
    const malformed = run(new BadRequestException('Unexpected token } in JSON at position 4'));
    expect(malformed.body).toMatchObject({
      message: 'The request body is not valid JSON',
      error: { code: 'MALFORMED_JSON' },
    });
    expect(run(new ThrottlerException()).status).toBe(429);
  });

  it('maps prototype-poisoning keys rejected by the JSON parser to FORBIDDEN_JSON_KEY', () => {
    for (const exception of [
      new BadRequestException('forbidden JSON key: "constructor"'),
      Object.assign(new SyntaxError('forbidden JSON key: "__proto__"'), {
        type: 'entity.parse.failed',
      }),
    ]) {
      const { status, body } = run(exception);
      expect(status).toBe(400);
      expect(body?.error.code).toBe(ErrorCode.FORBIDDEN_JSON_KEY);
    }
  });

  it('maps database errors without exposing them', () => {
    const unique = Object.assign(new Error('Unique constraint failed on the fields: (`email`)'), {
      name: 'PrismaClientKnownRequestError',
      code: 'P2002',
    });
    const conflict = run(unique);
    expect(conflict.status).toBe(409);
    expect(conflict.body?.message).not.toContain('email');

    const down = Object.assign(new Error("Can't reach database server"), {
      name: 'PrismaClientInitializationError',
    });
    expect(run(down)).toMatchObject({
      status: HttpStatus.SERVICE_UNAVAILABLE,
      body: { error: { code: 'DATABASE_UNAVAILABLE' } },
    });
  });

  it('hides unexpected errors in production and explains them in development', () => {
    const secret = new Error('connect to postgres://admin:hunter2@db failed');
    const production = run(secret);
    expect(production.status).toBe(500);
    expect(JSON.stringify(production.body)).not.toContain('hunter2');
    expect(production.body?.error).toEqual({ code: 'INTERNAL_SERVER_ERROR' });

    const development = run(secret, { exposeInternals: true });
    expect(development.body?.error.details).toEqual({
      debug: { name: 'Error', message: secret.message },
    });
  });

  it('ends a response whose stream already started instead of writing JSON', () => {
    const { status, body, end } = run(new Error('stream broke'), { headersSent: true });
    expect(status).toBeUndefined();
    expect(body).toBeUndefined();
    expect(end).toHaveBeenCalled();
  });
});
