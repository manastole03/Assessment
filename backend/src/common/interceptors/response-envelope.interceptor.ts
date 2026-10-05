import {
  type CallHandler,
  type ExecutionContext,
  HttpStatus,
  Injectable,
  type NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Response } from 'express';
import { map, type Observable } from 'rxjs';

import { RAW_RESPONSE_KEY, RESPONSE_MESSAGE_KEY } from '../decorators/metadata.decorators.js';
import type { ApiSuccess } from '../interfaces/api-response.interface.js';
import { PaginatedResult } from '../utils/pagination.util.js';

const DEFAULT_MESSAGE = 'Request successful';

/**
 * Wraps every JSON result in the success envelope, so controllers return plain data:
 * `{ success, data, message }`, or `{ success, data, meta }` for a `PaginatedResult`.
 */
@Injectable()
export class ResponseEnvelopeInterceptor implements NestInterceptor {
  constructor(private readonly reflector: Reflector) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(RAW_RESPONSE_KEY, targets)) return next.handle();

    const message = this.reflector.get<string | undefined>(
      RESPONSE_MESSAGE_KEY,
      context.getHandler(),
    );
    const response = context.switchToHttp().getResponse<Response>();

    return next.handle().pipe(
      map((body: unknown): ApiSuccess<unknown> | undefined => {
        if (response.statusCode === Number(HttpStatus.NO_CONTENT)) return undefined;
        if (body instanceof PaginatedResult) {
          return {
            success: true,
            data: body.items,
            meta: body.meta,
            ...(message ? { message } : {}),
          };
        }
        return { success: true, data: body ?? null, message: message ?? DEFAULT_MESSAGE };
      }),
    );
  }
}
