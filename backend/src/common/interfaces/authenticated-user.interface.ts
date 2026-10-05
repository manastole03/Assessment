import type { Request } from 'express';

import type { Role } from '../constants/roles.js';

export type AuthMethod = 'session' | 'bearer' | 'api_key';

/**
 * Who is calling, as established by the auth guard from the database (never from client claims):
 * the role is the user's *current* role, capped by the API key's role when one is used.
 */
export interface AuthenticatedUser {
  id: string;
  email: string;
  name: string;
  role: Role;
  authMethod: AuthMethod;
  sessionId?: string;
  apiKeyId?: string;
}

/** The Express request as this app sees it once middleware and guards have run. */
export interface AppRequest extends Request {
  id: string;
  user?: AuthenticatedUser;
}
