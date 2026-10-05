import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import type { Request } from 'express';
import { ExtractJwt, Strategy } from 'passport-jwt';

import { ACCESS_TOKEN_COOKIE, API_KEY_PREFIX } from '../../../common/constants/http.js';
import type { AuthenticatedUser } from '../../../common/interfaces/authenticated-user.interface.js';
import { appConfig } from '../../../config/configuration.js';
import { AuthService } from '../auth.service.js';
import type { JwtPayload } from '../interfaces/jwt-payload.interface.js';

/** `Authorization: Bearer <jwt>` first (API clients), then the session cookie (browsers). */
function fromBearer(req: Request): string | null {
  const token = ExtractJwt.fromAuthHeaderAsBearerToken()(req);
  return token && !token.startsWith(API_KEY_PREFIX) ? token : null;
}

function fromCookie(req: Request): string | null {
  const cookies = req.cookies as Record<string, string | undefined> | undefined;
  return cookies?.[ACCESS_TOKEN_COOKIE] ?? null;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor(
    @Inject(appConfig.KEY) config: ConfigType<typeof appConfig>,
    private readonly auth: AuthService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromExtractors([fromBearer, fromCookie]),
      secretOrKey: config.auth.jwtSecret,
      issuer: config.auth.jwtIssuer,
      audience: config.auth.jwtAudience,
      algorithms: ['HS256'],
      ignoreExpiration: false,
      passReqToCallback: true,
    });
  }

  /** Signature and expiry are already verified; now check the session and user in the database. */
  async validate(req: Request, payload: JwtPayload): Promise<AuthenticatedUser | null> {
    return this.auth.authenticateAccessToken(payload, fromBearer(req) ? 'bearer' : 'session');
  }
}
