import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { ThrottlerException } from '@nestjs/throttler';
import type { Response } from 'express';

import { ErrorCode } from '../constants/error-codes.js';
import { AppException, type ErrorDetails } from '../exceptions/app.exception.js';
import type { ApiFailure } from '../interfaces/api-response.interface.js';
import type { AppRequest } from '../interfaces/authenticated-user.interface.js';

interface NormalizedError {
  status: number;
  code: ErrorCode;
  message: string;
  details?: ErrorDetails;
  /** Unexpected: logged with its stack, hidden from the client. */
  unexpected: boolean;
}

const STATUS_CODES: Partial<Record<number, ErrorCode>> = {
  400: ErrorCode.BAD_REQUEST,
  401: ErrorCode.UNAUTHORIZED,
  403: ErrorCode.FORBIDDEN,
  404: ErrorCode.NOT_FOUND,
  405: ErrorCode.METHOD_NOT_ALLOWED,
  409: ErrorCode.CONFLICT,
  413: ErrorCode.PAYLOAD_TOO_LARGE,
  415: ErrorCode.UNSUPPORTED_MEDIA_TYPE,
  429: ErrorCode.RATE_LIMITED,
};

/** Prisma errors, recognised by shape so this layer does not depend on the generated client. */
interface PrismaLikeError {
  name: string;
  code?: string;
  message: string;
}

function isPrismaError(error: unknown): error is PrismaLikeError {
  return error instanceof Error && error.name.startsWith('PrismaClient');
}

/** Connection-level failures: the database is down, unreachable, or the pool is exhausted. */
const DB_UNAVAILABLE_CODES = new Set(['P1001', 'P1002', 'P1008', 'P1017', 'P2024']);
const NETWORK_ERRNO =
  /ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|Connection terminated|connect ETIMEDOUT/i;

export function isDatabaseUnavailable(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === 'PrismaClientInitializationError') return true;
  const code = (error as { code?: unknown }).code;
  if (typeof code === 'string' && DB_UNAVAILABLE_CODES.has(code)) return true;
  const cause = (error as { cause?: unknown }).cause;
  const fromDatabase = error.name.startsWith('PrismaClient') || error.name === 'DriverAdapterError';
  return fromDatabase && NETWORK_ERRNO.test(`${error.message} ${String(cause)}`);
}

/** Body-parser failures arrive as plain errors with a `type`. */
function bodyParserError(error: unknown): NormalizedError | null {
  if (!(error instanceof Error)) return null;
  const type = (error as { type?: unknown }).type;
  if (type === 'entity.parse.failed') {
    return {
      status: 400,
      code: ErrorCode.MALFORMED_JSON,
      message: 'The request body is not valid JSON',
      unexpected: false,
    };
  }
  if (type === 'entity.too.large') {
    return {
      status: 413,
      code: ErrorCode.PAYLOAD_TOO_LARGE,
      message: 'The request body is too large',
      unexpected: false,
    };
  }
  return null;
}

function messageOf(response: string | object, fallback: string): string {
  if (typeof response === 'string') return response;
  const message = (response as { message?: unknown }).message;
  if (Array.isArray(message)) return message.map(String).join('; ');
  return typeof message === 'string' ? message : fallback;
}

/**
 * The single place errors become HTTP responses. Every error has the same envelope; expected
 * errors keep their message, unexpected ones are logged in full and answered with a generic
 * message and the request id, so nothing internal (stack, SQL, paths, secrets) reaches a client.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('ExceptionFilter');

  constructor(private readonly exposeInternals: boolean) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<AppRequest>();
    const response = http.getResponse<Response>();
    const error = this.normalize(exception);
    const path = (request.originalUrl || request.url).split('?')[0] ?? '/';

    if (error.unexpected) {
      this.logger.error(
        { err: exception, requestId: request.id, method: request.method, path },
        'Unhandled error',
      );
    } else if (error.status >= 500) {
      this.logger.warn(
        { requestId: request.id, code: error.code, path, message: error.message },
        'Dependency error',
      );
    }

    // A stream (SSE, file) already started: the status is sent, so end it rather than write JSON.
    if (response.headersSent) {
      response.end();
      return;
    }

    const details =
      error.unexpected && this.exposeInternals && exception instanceof Error
        ? { debug: { name: exception.name, message: exception.message } }
        : error.details;

    const body: ApiFailure = {
      success: false,
      message: error.message,
      error: { code: error.code, ...(details === undefined ? {} : { details }) },
      timestamp: new Date().toISOString(),
      path,
      requestId: request.id,
    };
    response.status(error.status).json(body);
  }

  private normalize(exception: unknown): NormalizedError {
    if (exception instanceof AppException) {
      return {
        status: exception.getStatus(),
        code: exception.code,
        message: exception.message,
        details: exception.details,
        unexpected: false,
      };
    }
    if (exception instanceof ThrottlerException) {
      return {
        status: 429,
        code: ErrorCode.RATE_LIMITED,
        message: 'Too many requests; slow down and retry shortly',
        unexpected: false,
      };
    }
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const message = messageOf(exception.getResponse(), exception.message);
      // Nest wraps body-parser's SyntaxError in a plain BadRequestException with the parser's text.
      if (status === 400 && !(exception instanceof AppException) && /JSON/.test(message)) {
        return {
          status: 400,
          code: ErrorCode.MALFORMED_JSON,
          message: 'The request body is not valid JSON',
          unexpected: false,
        };
      }
      const routeMissing =
        status === 404 && /^Cannot (GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS) /.test(message);
      return {
        status,
        code: routeMissing
          ? ErrorCode.ROUTE_NOT_FOUND
          : (STATUS_CODES[status] ?? ErrorCode.INTERNAL_SERVER_ERROR),
        message: routeMissing ? 'No such API route' : message,
        unexpected: status >= 500,
      };
    }
    const parserError = bodyParserError(exception);
    if (parserError) return parserError;

    if (isDatabaseUnavailable(exception)) {
      return {
        status: HttpStatus.SERVICE_UNAVAILABLE,
        code: ErrorCode.DATABASE_UNAVAILABLE,
        message: 'The database is temporarily unavailable',
        unexpected: false,
      };
    }
    if (isPrismaError(exception)) {
      if (exception.code === 'P2002') {
        return {
          status: 409,
          code: ErrorCode.CONFLICT,
          message: 'A record with these values already exists',
          unexpected: false,
        };
      }
      if (exception.code === 'P2034') {
        // A serializable transaction lost a race with a concurrent change; retrying is safe.
        return {
          status: 409,
          code: ErrorCode.CONFLICT,
          message: 'The record changed while you were updating it; retry',
          unexpected: false,
        };
      }
      if (exception.code === 'P2025') {
        return {
          status: 404,
          code: ErrorCode.NOT_FOUND,
          message: 'The record does not exist',
          unexpected: false,
        };
      }
    }
    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      code: ErrorCode.INTERNAL_SERVER_ERROR,
      message: 'Something went wrong. Quote the request id if you report this.',
      unexpected: true,
    };
  }
}
