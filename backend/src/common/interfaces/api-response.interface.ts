import type { ErrorCode } from '../constants/error-codes.js';

export interface PaginationMeta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

/** Every successful JSON response. Collections add `meta`. */
export interface ApiSuccess<T> {
  success: true;
  data: T;
  message?: string;
  meta?: PaginationMeta;
}

/** Every error response, whatever raised it. */
export interface ApiFailure {
  success: false;
  message: string;
  error: { code: ErrorCode; details?: unknown };
  timestamp: string;
  path: string;
  requestId?: string;
}
