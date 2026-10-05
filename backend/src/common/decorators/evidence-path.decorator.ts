import { createParamDecorator, type ExecutionContext } from '@nestjs/common';

import { ErrorCode } from '../constants/error-codes.js';
import { AppException } from '../exceptions/app.exception.js';

const SEGMENT = /^[\w][\w.@-]*$/;

/** A relative evidence path (`screens/0010-step.jpg`, `report.html`): no traversal, no absolute paths. */
export function toEvidencePath(value: unknown): string {
  const segments = Array.isArray(value)
    ? value.map(String)
    : typeof value === 'string'
      ? value.split('/')
      : [];
  const path = segments.join('/');
  const valid =
    segments.length > 0 &&
    path.length <= 400 &&
    segments.every((segment) => SEGMENT.test(segment) && segment !== '..');
  if (!valid) throw AppException.notFound('No such file', ErrorCode.FILE_NOT_FOUND);
  return path;
}

/**
 * The `*path` wildcard of a route, validated and joined. A param decorator rather than a pipe:
 * Express hands wildcards over as segment arrays, which the global ValidationPipe would stringify.
 */
export const EvidencePath = createParamDecorator(
  (_: unknown, context: ExecutionContext): string => {
    const params = context.switchToHttp().getRequest<{ params: Record<string, unknown> }>().params;
    return toEvidencePath(params['path']);
  },
);
