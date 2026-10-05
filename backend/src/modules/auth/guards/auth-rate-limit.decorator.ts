import { SetMetadata } from '@nestjs/common';

export const AUTH_RATE_LIMIT_KEY = 'rote:authRateLimit';

/**
 * Opt a route into the strict `auth` throttler (AUTH_RATE_LIMIT_MAX per window per client IP), on top
 * of the global one: credential endpoints are what brute-force attacks target.
 */
export const AuthRateLimit = () => SetMetadata(AUTH_RATE_LIMIT_KEY, true);
