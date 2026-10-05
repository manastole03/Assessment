import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import type { Request } from 'express';
import { Strategy } from 'passport-custom';

import { ErrorCode } from '../../../common/constants/error-codes.js';
import { API_KEY_HEADER, API_KEY_PREFIX } from '../../../common/constants/http.js';
import { AppException } from '../../../common/exceptions/app.exception.js';
import type { AuthenticatedUser } from '../../../common/interfaces/authenticated-user.interface.js';
import { ApiKeysService } from '../../api-keys/api-keys.service.js';

/** An API key from `X-API-Key`, or `Authorization: Bearer rote_...` (what MCP clients send). */
export function extractApiKey(req: Request): string | null {
  const header = req.header(API_KEY_HEADER);
  if (header) return header.trim();
  const authorization = req.header('authorization');
  const bearer = authorization?.match(/^Bearer\s+(\S+)$/i)?.[1];
  return bearer?.startsWith(API_KEY_PREFIX) ? bearer : null;
}

@Injectable()
export class ApiKeyStrategy extends PassportStrategy(Strategy, 'api-key') {
  constructor(private readonly apiKeys: ApiKeysService) {
    super();
  }

  /**
   * No key: decline, so the JWT strategy runs next. A key that does not authenticate is an error,
   * not a fall-through: a bad explicit credential must never be rescued by an ambient cookie.
   */
  async validate(req: Request): Promise<AuthenticatedUser | null> {
    const presented = extractApiKey(req);
    if (!presented) return null;
    const user = await this.apiKeys.authenticate(presented);
    if (!user)
      throw AppException.unauthorized(
        'Invalid, expired or revoked API key',
        ErrorCode.INVALID_API_KEY,
      );
    return user;
  }
}
