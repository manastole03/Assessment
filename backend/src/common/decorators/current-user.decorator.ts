import { createParamDecorator, type ExecutionContext } from '@nestjs/common';

import { AppException } from '../exceptions/app.exception.js';
import type { AppRequest, AuthenticatedUser } from '../interfaces/authenticated-user.interface.js';

/** The caller the auth guard established. Only valid on authenticated routes. */
export const CurrentUser = createParamDecorator(
  (_: unknown, context: ExecutionContext): AuthenticatedUser => {
    const request = context.switchToHttp().getRequest<AppRequest>();
    if (!request.user) throw AppException.unauthorized();
    return request.user;
  },
);
