import { type ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';

import { ErrorCode } from '../../../common/constants/error-codes.js';
import {
  IS_PUBLIC_KEY,
  OPTIONAL_AUTH_KEY,
} from '../../../common/decorators/metadata.decorators.js';
import { AppException } from '../../../common/exceptions/app.exception.js';

function isExpired(info: unknown): boolean {
  const items = Array.isArray(info) ? info : [info];
  return items.some((item) => item instanceof Error && item.name === 'TokenExpiredError');
}

/**
 * The global authentication guard: every route needs a valid API key, bearer token or session
 * cookie unless it is marked @Public() (no authentication) or @OptionalAuth() (identify the caller
 * if they can be, never reject). It only establishes *who* is calling; RolesGuard decides what
 * they may do.
 */
@Injectable()
export class JwtAuthGuard extends AuthGuard(['api-key', 'jwt']) {
  constructor(private readonly reflector: Reflector) {
    super();
  }

  override canActivate(context: ExecutionContext) {
    if (this.flag(OPTIONAL_AUTH_KEY, context)) return super.canActivate(context);
    if (this.flag(IS_PUBLIC_KEY, context)) return true;
    return super.canActivate(context);
  }

  override handleRequest<TUser>(
    error: unknown,
    user: TUser | false | null,
    info: unknown,
    context: ExecutionContext,
  ): TUser {
    if (this.flag(OPTIONAL_AUTH_KEY, context)) {
      // Anonymous is acceptable here (passport reports "no user" as false): leave `req.user` unset.
      if (!user) return undefined as TUser;
      return user;
    }
    if (error instanceof AppException) throw error;
    if (error || !user) {
      throw isExpired(info)
        ? AppException.unauthorized('Your session has expired', ErrorCode.SESSION_EXPIRED)
        : AppException.unauthorized();
    }
    return user;
  }

  private flag(key: string, context: ExecutionContext): boolean {
    return (
      this.reflector.getAllAndOverride<boolean>(key, [context.getHandler(), context.getClass()]) ===
      true
    );
  }
}
