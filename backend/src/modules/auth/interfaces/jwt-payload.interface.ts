/**
 * Claims in an access token. Deliberately minimal: identity comes from the database on every request
 * (via `sid`), so a role change, a disabled account or a sign-out takes effect immediately.
 */
export interface JwtPayload {
  /** User id. */
  sub: string;
  /** Session id: revoking the session invalidates this token before it expires. */
  sid: string;
  typ: 'access';
  iat?: number;
  exp?: number;
  iss?: string;
  aud?: string | string[];
}

/** Everything a sign-in or refresh produces; the controller turns it into cookies and a body. */
export interface IssuedSession {
  accessToken: string;
  accessTokenExpiresAt: Date;
  refreshToken: string;
  refreshTokenExpiresAt: Date;
  csrfToken: string;
}
