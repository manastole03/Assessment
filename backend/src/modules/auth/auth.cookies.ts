import type { CookieOptions, Response } from 'express';

import {
  ACCESS_TOKEN_COOKIE,
  CSRF_COOKIE,
  REFRESH_COOKIE_PATH,
  REFRESH_TOKEN_COOKIE,
} from '../../common/constants/http.js';
import type { IssuedSession } from './interfaces/jwt-payload.interface.js';

/**
 * Browser sessions live in cookies so that EventSource streams and <img> evidence (which cannot set
 * headers) are authenticated too. Access and refresh cookies are httpOnly and SameSite=Strict; the
 * refresh cookie is only sent to /api/v1/auth. The CSRF cookie is readable by design (double submit).
 */
export function setSessionCookies(res: Response, session: IssuedSession, secure: boolean): void {
  const base: CookieOptions = { secure, sameSite: 'strict' };
  res.cookie(ACCESS_TOKEN_COOKIE, session.accessToken, {
    ...base,
    httpOnly: true,
    path: '/',
    expires: session.accessTokenExpiresAt,
  });
  res.cookie(REFRESH_TOKEN_COOKIE, session.refreshToken, {
    ...base,
    httpOnly: true,
    path: REFRESH_COOKIE_PATH,
    expires: session.refreshTokenExpiresAt,
  });
  res.cookie(CSRF_COOKIE, session.csrfToken, {
    ...base,
    httpOnly: false,
    path: '/',
    expires: session.refreshTokenExpiresAt,
  });
}

export function clearSessionCookies(res: Response, secure: boolean): void {
  const base: CookieOptions = { secure, sameSite: 'strict' };
  res.clearCookie(ACCESS_TOKEN_COOKIE, { ...base, httpOnly: true, path: '/' });
  res.clearCookie(REFRESH_TOKEN_COOKIE, { ...base, httpOnly: true, path: REFRESH_COOKIE_PATH });
  res.clearCookie(CSRF_COOKIE, { ...base, path: '/' });
}
