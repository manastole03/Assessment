import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { ErrorCode } from '../../../src/common/constants/error-codes.js';
import { Role } from '../../../src/common/constants/roles.js';
import {
  IS_PUBLIC_KEY,
  MIN_ROLE_KEY,
  SKIP_CSRF_KEY,
} from '../../../src/common/decorators/metadata.decorators.js';
import { CsrfGuard } from '../../../src/common/guards/csrf.guard.js';
import { RolesGuard } from '../../../src/common/guards/roles.guard.js';
import type { AuthenticatedUser } from '../../../src/common/interfaces/authenticated-user.interface.js';
import { actor } from '../../helpers/fixtures.js';

interface FakeRequest {
  method?: string;
  headers?: Record<string, string>;
  cookies?: Record<string, string>;
  user?: AuthenticatedUser;
}

function context(request: FakeRequest, metadata: Record<string, unknown> = {}): ExecutionContext {
  const handler = () => undefined;
  for (const [key, value] of Object.entries(metadata)) Reflect.defineMetadata(key, value, handler);
  const headers = request.headers ?? {};
  return {
    getType: () => 'http',
    getHandler: () => handler,
    getClass: () => class {},
    switchToHttp: () => ({
      getRequest: () => ({
        method: request.method ?? 'GET',
        headers,
        cookies: request.cookies ?? {},
        user: request.user,
        header: (name: string) => headers[name.toLowerCase()],
      }),
    }),
  } as unknown as ExecutionContext;
}

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    return (error as { code?: string }).code;
  }
  return undefined;
}

describe('RolesGuard', () => {
  const guard = new RolesGuard(new Reflector());

  it('lets anyone authenticated through when no role is required', () => {
    expect(guard.canActivate(context({ user: actor(Role.VIEWER) }))).toBe(true);
  });

  it('accepts the required role and every role above it', () => {
    const route = { [MIN_ROLE_KEY]: Role.OPERATOR };
    expect(guard.canActivate(context({ user: actor(Role.OPERATOR) }, route))).toBe(true);
    expect(guard.canActivate(context({ user: actor(Role.ADMIN) }, route))).toBe(true);
    expect(codeOf(() => guard.canActivate(context({ user: actor(Role.VIEWER) }, route)))).toBe(
      ErrorCode.INSUFFICIENT_ROLE,
    );
  });

  it('ignores public routes and rejects anonymous calls to protected ones', () => {
    expect(
      guard.canActivate(context({}, { [MIN_ROLE_KEY]: Role.ADMIN, [IS_PUBLIC_KEY]: true })),
    ).toBe(true);
    expect(codeOf(() => guard.canActivate(context({}, { [MIN_ROLE_KEY]: Role.VIEWER })))).toBe(
      ErrorCode.UNAUTHORIZED,
    );
  });
});

describe('CsrfGuard', () => {
  const guard = new CsrfGuard(new Reflector());
  const session = { rote_at: 'access', rote_csrf: 'token-123' };

  it('never checks safe methods', () => {
    expect(guard.canActivate(context({ method: 'GET', cookies: session }))).toBe(true);
  });

  it('requires the double-submit token on cookie-authenticated writes', () => {
    expect(codeOf(() => guard.canActivate(context({ method: 'POST', cookies: session })))).toBe(
      ErrorCode.CSRF_TOKEN_INVALID,
    );
    const wrong = context({
      method: 'POST',
      cookies: session,
      headers: { 'x-csrf-token': 'other' },
    });
    expect(codeOf(() => guard.canActivate(wrong))).toBe(ErrorCode.CSRF_TOKEN_INVALID);
    const right = context({
      method: 'POST',
      cookies: session,
      headers: { 'x-csrf-token': 'token-123' },
    });
    expect(guard.canActivate(right)).toBe(true);
  });

  it('skips requests that carry no ambient credentials', () => {
    expect(guard.canActivate(context({ method: 'POST' }))).toBe(true);
    const bearer = context({
      method: 'POST',
      cookies: session,
      headers: { authorization: 'Bearer x' },
    });
    expect(guard.canActivate(bearer)).toBe(true);
    const apiKey = context({
      method: 'DELETE',
      cookies: session,
      headers: { 'x-api-key': 'rote_x' },
    });
    expect(guard.canActivate(apiKey)).toBe(true);
  });

  it('still checks cookie writes whose Authorization header is not a bearer credential', () => {
    // The JWT strategy only reads `Bearer`; any other scheme falls through to the session cookie.
    const basic = context({
      method: 'POST',
      cookies: session,
      headers: { authorization: 'Basic dXNlcjpwYXNz' },
    });
    expect(codeOf(() => guard.canActivate(basic))).toBe(ErrorCode.CSRF_TOKEN_INVALID);
  });

  it('lets sign-in endpoints through (no session yet to carry a token)', () => {
    expect(
      guard.canActivate(context({ method: 'POST', cookies: session }, { [SKIP_CSRF_KEY]: true })),
    ).toBe(true);
  });
});
