/** Header and cookie names shared by middleware, guards and the auth module. */
export const REQUEST_ID_HEADER = 'x-request-id';
export const CSRF_HEADER = 'x-csrf-token';
export const API_KEY_HEADER = 'x-api-key';

export const ACCESS_TOKEN_COOKIE = 'rote_at';
export const REFRESH_TOKEN_COOKIE = 'rote_rt';
/** Readable by the UI's JavaScript (double-submit CSRF token); the other two are httpOnly. */
export const CSRF_COOKIE = 'rote_csrf';
/** The refresh cookie is only ever sent to the auth endpoints. */
export const REFRESH_COOKIE_PATH = '/api/v1/auth';

export const SAFE_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS']);

export const API_KEY_PREFIX = 'rote_';
