import { HttpException, HttpStatus } from '@nestjs/common';

import { ErrorCode } from '../constants/error-codes.js';

export type ErrorDetails = Record<string, unknown> | unknown[];

/**
 * The one exception type business code throws. It carries a stable `code`, a client-safe `message`
 * and optional `details`; the global filter turns it into the standard error envelope.
 */
export class AppException extends HttpException {
  constructor(
    readonly code: ErrorCode,
    message: string,
    status: HttpStatus,
    readonly details?: ErrorDetails,
  ) {
    super({ code, message, details }, status);
  }

  static badRequest(
    message: string,
    code: ErrorCode = ErrorCode.BAD_REQUEST,
    details?: ErrorDetails,
  ) {
    return new AppException(code, message, HttpStatus.BAD_REQUEST, details);
  }

  static validation(message: string, details?: ErrorDetails) {
    return new AppException(ErrorCode.VALIDATION_ERROR, message, HttpStatus.BAD_REQUEST, details);
  }

  static unauthorized(
    message = 'Authentication required',
    code: ErrorCode = ErrorCode.UNAUTHORIZED,
  ) {
    return new AppException(code, message, HttpStatus.UNAUTHORIZED);
  }

  static forbidden(
    message = 'You do not have permission to do this',
    code: ErrorCode = ErrorCode.FORBIDDEN,
  ) {
    return new AppException(code, message, HttpStatus.FORBIDDEN);
  }

  static notFound(message: string, code: ErrorCode = ErrorCode.NOT_FOUND) {
    return new AppException(code, message, HttpStatus.NOT_FOUND);
  }

  static conflict(message: string, code: ErrorCode = ErrorCode.CONFLICT, details?: ErrorDetails) {
    return new AppException(code, message, HttpStatus.CONFLICT, details);
  }

  static unprocessable(message: string, code: ErrorCode, details?: ErrorDetails) {
    return new AppException(code, message, HttpStatus.UNPROCESSABLE_ENTITY, details);
  }

  static featureDisabled(message: string) {
    return new AppException(ErrorCode.FEATURE_DISABLED, message, HttpStatus.NOT_FOUND);
  }
}
