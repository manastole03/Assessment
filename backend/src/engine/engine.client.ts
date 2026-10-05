import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import type { z } from 'zod';

import { ErrorCode } from '../common/constants/error-codes.js';
import { REQUEST_ID_HEADER } from '../common/constants/http.js';
import { AppException } from '../common/exceptions/app.exception.js';
import { currentRequestId } from '../common/utils/request-context.js';
import { appConfig } from '../config/configuration.js';

export const ENGINE_TOKEN_HEADER = 'x-engine-token';

function errorName(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'name' in error
    ? String(error.name)
    : undefined;
}

type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';
type Query = Record<string, string | number | boolean | undefined>;

export interface EngineRequestOptions<S extends z.ZodType> {
  /** Validates (and types) the response body. */
  schema: S;
  query?: Query;
  body?: unknown;
  timeoutMs?: number;
  /** Error codes for engine statuses in this call's context, e.g. `{ 404: RUN_NOT_FOUND }`. */
  errors?: Partial<Record<number, ErrorCode>>;
}

export interface EngineRawOptions {
  query?: Query;
  headers?: Record<string, string>;
  body?: string;
  /** Aborts the upstream request (the client disconnected). No timeout when omitted: streams. */
  signal?: AbortSignal;
  timeoutMs?: number;
}

/**
 * The data-access gateway to the Python engine. Services use it the way they use repositories:
 * it hides HTTP, authenticates with the shared engine token, propagates the request id, applies
 * timeouts, validates what comes back, and turns every failure into a stable AppException.
 */
@Injectable()
export class EngineClient {
  private readonly logger = new Logger(EngineClient.name);
  private readonly baseUrl: string;
  private readonly token: string | null;
  private readonly timeoutMs: number;

  constructor(@Inject(appConfig.KEY) config: ConfigType<typeof appConfig>) {
    this.baseUrl = config.engine.url;
    this.token = config.engine.token;
    this.timeoutMs = config.engine.timeoutMs;
  }

  get<S extends z.ZodType>(path: string, options: EngineRequestOptions<S>): Promise<z.infer<S>> {
    return this.request('GET', path, options);
  }

  post<S extends z.ZodType>(path: string, options: EngineRequestOptions<S>): Promise<z.infer<S>> {
    return this.request('POST', path, options);
  }

  put<S extends z.ZodType>(path: string, options: EngineRequestOptions<S>): Promise<z.infer<S>> {
    return this.request('PUT', path, options);
  }

  /** A JSON call that also returns the engine's status (e.g. 200 vs 202 for invoke). */
  async request<S extends z.ZodType>(
    method: Method,
    path: string,
    options: EngineRequestOptions<S>,
  ): Promise<z.infer<S>> {
    return (await this.requestWithStatus(method, path, options)).data;
  }

  async requestWithStatus<S extends z.ZodType>(
    method: Method,
    path: string,
    options: EngineRequestOptions<S>,
  ): Promise<{ status: number; data: z.infer<S> }> {
    const response = await this.send(method, path, {
      query: options.query,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      headers: options.body === undefined ? {} : { 'content-type': 'application/json' },
      timeoutMs: options.timeoutMs ?? this.timeoutMs,
    });
    if (!response.ok) throw await this.toException(response, options.errors);

    const payload: unknown =
      response.status === 204 ? null : await response.json().catch(() => undefined);
    const parsed = options.schema.safeParse(payload);
    if (!parsed.success) {
      this.logger.error(
        { path, issues: parsed.error.issues.slice(0, 5) },
        'Engine response did not match its contract',
      );
      throw new AppException(
        ErrorCode.ENGINE_ERROR,
        'The engine returned an unexpected response',
        HttpStatus.BAD_GATEWAY,
      );
    }
    return { status: response.status, data: parsed.data };
  }

  /**
   * The raw upstream response, for streaming proxies (SSE, evidence files, live screen, MCP).
   * Non-2xx responses are converted to an AppException unless `passErrors` is set.
   */
  async raw(
    method: Method,
    path: string,
    options: EngineRawOptions & {
      errors?: Partial<Record<number, ErrorCode>>;
      passErrors?: boolean;
    } = {},
  ): Promise<Response> {
    const response = await this.send(method, path, options);
    if (!response.ok && !options.passErrors) throw await this.toException(response, options.errors);
    return response;
  }

  /** Liveness of the engine, for health checks: never throws. */
  async isReachable(timeoutMs = 2000): Promise<boolean> {
    try {
      const response = await this.send('GET', '/api/health', { timeoutMs });
      return response.ok;
    } catch {
      return false;
    }
  }

  private async send(method: Method, path: string, options: EngineRawOptions): Promise<Response> {
    const url = new URL(path, `${this.baseUrl}/`);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    const headers: Record<string, string> = { accept: 'application/json', ...options.headers };
    if (this.token) headers[ENGINE_TOKEN_HEADER] = this.token;
    const requestId = currentRequestId();
    if (requestId) headers[REQUEST_ID_HEADER] = requestId;

    const signals = [
      options.signal,
      options.timeoutMs ? AbortSignal.timeout(options.timeoutMs) : undefined,
    ].filter((signal): signal is AbortSignal => signal !== undefined);
    try {
      return await fetch(url, {
        method,
        headers,
        body: options.body,
        signal: signals.length ? AbortSignal.any(signals) : undefined,
        redirect: 'manual',
      });
    } catch (error) {
      throw this.networkException(error, path);
    }
  }

  private networkException(error: unknown, path: string): AppException {
    // Fetch rejects with DOMExceptions (AbortSignal) and TypeErrors whose cause holds the reason;
    // match by name, which also works across realms where `instanceof Error` does not.
    const name = errorName(error);
    const cause =
      typeof error === 'object' && error !== null
        ? (error as { cause?: unknown }).cause
        : undefined;
    if (name === 'TimeoutError' || errorName(cause) === 'TimeoutError') {
      this.logger.warn({ path }, 'Engine request timed out');
      return new AppException(
        ErrorCode.ENGINE_TIMEOUT,
        'The engine did not respond in time',
        HttpStatus.GATEWAY_TIMEOUT,
      );
    }
    if (name === 'AbortError') {
      // The client went away; nothing to answer, but keep the error typed.
      return new AppException(
        ErrorCode.ENGINE_UNAVAILABLE,
        'The request was cancelled',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    // Debug only: callers decide how loudly an outage is reported (the run sync logs it once).
    this.logger.debug({ path, reason: String(cause ?? error) }, 'Engine unreachable');
    return new AppException(
      ErrorCode.ENGINE_UNAVAILABLE,
      'The engine is unavailable; try again shortly',
      HttpStatus.SERVICE_UNAVAILABLE,
    );
  }

  /** Map an engine error response (`{ detail, problems? }`, already free of internal paths). */
  async toException(
    response: Response,
    overrides: Partial<Record<number, ErrorCode>> = {},
  ): Promise<AppException> {
    const body = (await response.json().catch(() => null)) as {
      detail?: unknown;
      problems?: unknown;
    } | null;
    const detail = typeof body?.detail === 'string' ? body.detail : null;
    const problems = Array.isArray(body?.problems) ? body.problems.map(String) : null;
    const status = response.status;
    const override = overrides[status];

    if (status === 401) {
      this.logger.error(
        'The engine rejected the control plane credentials (ENGINE_TOKEN mismatch?)',
      );
      return new AppException(
        ErrorCode.ENGINE_ERROR,
        'The engine is misconfigured',
        HttpStatus.BAD_GATEWAY,
      );
    }
    if (status === 422 && problems) {
      return AppException.unprocessable(
        detail ?? 'The inputs do not match the contract',
        ErrorCode.INPUT_CONTRACT_VIOLATION,
        { problems },
      );
    }
    if (status === 422) {
      // Our DTOs should have caught this; report it as a validation error without engine internals.
      return AppException.validation('The engine rejected the request as invalid');
    }
    if (status >= 400 && status < 500) {
      const fallback: Record<number, ErrorCode> = {
        400: ErrorCode.BAD_REQUEST,
        403: ErrorCode.FORBIDDEN,
        404: ErrorCode.NOT_FOUND,
        409: ErrorCode.CONFLICT,
      };
      return new AppException(
        override ?? fallback[status] ?? ErrorCode.BAD_REQUEST,
        detail ?? response.statusText,
        status,
      );
    }
    if (status === 503) {
      // The engine is up but its own dependency (e.g. the target app) is not.
      return new AppException(
        override ?? ErrorCode.UPSTREAM_UNAVAILABLE,
        detail ?? 'A dependency of the engine is unavailable',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    this.logger.error({ status, detail }, 'Engine error');
    return new AppException(
      ErrorCode.ENGINE_ERROR,
      'The engine failed to handle the request',
      HttpStatus.BAD_GATEWAY,
    );
  }
}
