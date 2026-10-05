import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';

import { randomToken } from '../../common/utils/crypto.util.js';
import { appConfig } from '../../config/configuration.js';
import type { JwtPayload } from './interfaces/jwt-payload.interface.js';

@Injectable()
export class TokenService {
  constructor(
    private readonly jwt: JwtService,
    @Inject(appConfig.KEY) private readonly config: ConfigType<typeof appConfig>,
  ) {}

  /** A short-lived HS256 access token bound to a session. */
  async signAccessToken(
    userId: string,
    sessionId: string,
  ): Promise<{ token: string; expiresAt: Date }> {
    const ttl = this.config.auth.accessTokenTtlSeconds;
    const payload: JwtPayload = { sub: userId, sid: sessionId, typ: 'access' };
    const token = await this.jwt.signAsync(payload, { expiresIn: ttl });
    return { token, expiresAt: new Date(Date.now() + ttl * 1000) };
  }

  /** An opaque refresh token (256 bits); only its SHA-256 is stored. */
  newRefreshToken(): string {
    return randomToken(32);
  }

  newCsrfToken(): string {
    return randomToken(24);
  }

  refreshExpiry(): Date {
    return new Date(Date.now() + this.config.auth.refreshTokenTtlDays * 86_400_000);
  }
}
