import { Injectable, type PipeTransform } from '@nestjs/common';

import { ErrorCode } from '../constants/error-codes.js';
import { toEvidencePath } from '../decorators/evidence-path.decorator.js';
import { AppException } from '../exceptions/app.exception.js';

/** Engine identifiers: run ids, capability ids/refs, dataset and eval ids, tenant ids. */
const ENGINE_ID = /^[A-Za-z0-9][\w.@-]{0,199}$/;

/**
 * Validates an engine resource id from the path before it goes anywhere near a URL or file path:
 * no slashes, no `..`, bounded length.
 */
@Injectable()
export class EngineIdPipe implements PipeTransform<string, string> {
  transform(value: string): string {
    if (!ENGINE_ID.test(value) || value.includes('..')) {
      throw AppException.badRequest(
        `"${value.slice(0, 60)}" is not a valid identifier`,
        ErrorCode.VALIDATION_ERROR,
      );
    }
    return value;
  }
}

/** Path-pipe form of the evidence path check (see decorators/evidence-path.decorator.ts). */
@Injectable()
export class EvidencePathPipe implements PipeTransform<string | string[], string> {
  transform(value: string | string[]): string {
    return toEvidencePath(value);
  }
}
