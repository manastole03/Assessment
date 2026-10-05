import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { ErrorCode } from '../constants/error-codes.js';
import {
  ACCESS_TOKEN_COOKIE,
  API_KEY_HEADER,
  CSRF_COOKIE,
  CSRF_HEADER,
  REFRESH_TOKEN_COOKIE,
  SAFE_METHODS,
} from '../constants/http.js';
import { SKIP_CSRF_KEY } from '../decorators/metadata.decorators.js';
import { AppException } from '../exceptions/app.exception.js';
import type { AppRequest } from '../interfaces/authenticated-user.interface.js';
import { safeEqual } from '../utils/crypto.util.js';

/** Only these header credentials replace the cookie; other Authorization schemes fall back to it. */
const BEARER = /^Bearer\s+\S+$/i;

/**
 * Double-submit CSRF protection for cookie sessions. A state-changing request that relies on the
 * session cookies must echo the readable `rote_csrf` cookie in `X-CSRF-Token`, which a cross-site page
 * cannot read. Requests authenticated by a bearer token or API key carry no ambient credentials, so
 * they are not at risk and skip the check. (Cookies are also SameSite=Strict.)
 */
@Injectable()
export class CsrfGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    if (context.getType() !== 'http') return true;
    const request = context.switchToHttp().getRequest<AppRequest>();
    if (SAFE_METHODS.has(request.method)) return true;
    if (BEARER.test(request.headers.authorization ?? '') || request.headers[API_KEY_HEADER]) {
      return true;
    }

    const cookies = (request.cookies ?? {}) as Record<string, string | undefined>;
    const hasSession = Boolean(cookies[ACCESS_TOKEN_COOKIE] ?? cookies[REFRESH_TOKEN_COOKIE]);
    if (!hasSession) return true;

    const skip = this.reflector.getAllAndOverride<boolean>(SKIP_CSRF_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (skip) return true;

    const header = request.header(CSRF_HEADER);
    const cookie = cookies[CSRF_COOKIE];
    if (!header || !cookie || !safeEqual(header, cookie)) {
      throw AppException.forbidden('Missing or invalid CSRF token', ErrorCode.CSRF_TOKEN_INVALID);
    }
    return true;
  }
}
