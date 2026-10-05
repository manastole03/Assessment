import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { ErrorCode } from '../constants/error-codes.js';
import { hasRole, type Role } from '../constants/roles.js';
import { IS_PUBLIC_KEY, MIN_ROLE_KEY } from '../decorators/metadata.decorators.js';
import { AppException } from '../exceptions/app.exception.js';
import type { AppRequest } from '../interfaces/authenticated-user.interface.js';

/**
 * Enforces `@MinRole(...)` against the role the auth guard loaded from the database. Rules that
 * depend on the request body (e.g. running a draft needs REVIEWER) live in the services.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const targets = [context.getHandler(), context.getClass()];
    const required = this.reflector.getAllAndOverride<Role | undefined>(MIN_ROLE_KEY, targets);
    if (!required) return true;
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, targets)) return true;

    const user = context.switchToHttp().getRequest<AppRequest>().user;
    if (!user) throw AppException.unauthorized();
    if (!hasRole(user.role, required)) {
      throw AppException.forbidden(
        `This requires the ${required} role or higher`,
        ErrorCode.INSUFFICIENT_ROLE,
      );
    }
    return true;
  }
}
