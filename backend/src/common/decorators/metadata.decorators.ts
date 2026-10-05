import { SetMetadata } from '@nestjs/common';

import type { Role } from '../constants/roles.js';

export const IS_PUBLIC_KEY = 'rote:isPublic';
export const OPTIONAL_AUTH_KEY = 'rote:optionalAuth';
export const MIN_ROLE_KEY = 'rote:minRole';
export const RAW_RESPONSE_KEY = 'rote:rawResponse';
export const RESPONSE_MESSAGE_KEY = 'rote:responseMessage';
export const SKIP_CSRF_KEY = 'rote:skipCsrf';

/** No authentication required (login, health, ...). Every other route requires it. */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

/**
 * Anonymous callers are allowed, but a caller who presents credentials is identified (`req.user`).
 * Invalid or expired credentials are treated as anonymous rather than rejected (e.g. logout).
 */
export const OptionalAuth = () => SetMetadata(OPTIONAL_AUTH_KEY, true);

/** The lowest role allowed; higher roles pass too (see constants/roles.ts). */
export const MinRole = (role: Role) => SetMetadata(MIN_ROLE_KEY, role);

/** Skip the response envelope: streams, files, protocol endpoints (SSE, images, MCP) and probes. */
export const RawResponse = () => SetMetadata(RAW_RESPONSE_KEY, true);

/** The `message` of the success envelope. */
export const ResponseMessage = (message: string) => SetMetadata(RESPONSE_MESSAGE_KEY, message);

/** Endpoints that establish a session (login, register) cannot carry a CSRF token yet. */
export const SkipCsrf = () => SetMetadata(SKIP_CSRF_KEY, true);
