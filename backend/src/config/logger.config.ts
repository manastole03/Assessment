import type { IncomingMessage, ServerResponse } from 'node:http';

import type { Params } from 'nestjs-pino';
import { stdTimeFunctions } from 'pino';

import type { AppRequest } from '../common/interfaces/authenticated-user.interface.js';
import type { AppConfig } from './configuration.js';

/** Never logged, wherever they appear: credentials, tokens, cookies, passwords. */
export const REDACTED_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  'req.headers["x-csrf-token"]',
  'req.headers["x-engine-token"]',
  'res.headers["set-cookie"]',
  '*.password',
  '*.currentPassword',
  '*.newPassword',
  '*.passwordHash',
  '*.accessToken',
  '*.refreshToken',
  '*.secret',
  '*.token',
];

function pathOf(url: string | undefined): string {
  // Query strings can carry search terms; the path is enough to identify the endpoint.
  return (url ?? '/').split('?')[0] ?? '/';
}

/**
 * Structured request logging (pino): one JSON line per request in production with timestamp, level,
 * request id, method, path, status and response time; pretty, single-line output in development.
 */
export function loggerOptions(config: AppConfig): Params {
  return {
    pinoHttp: {
      level: config.log.level,
      timestamp: stdTimeFunctions.isoTime,
      formatters: { level: (label: string) => ({ level: label }) },
      redact: { paths: REDACTED_PATHS, censor: '[REDACTED]' },
      transport: config.log.pretty
        ? {
            target: 'pino-pretty',
            options: {
              singleLine: true,
              translateTime: 'SYS:HH:MM:ss.l',
              ignore: 'pid,hostname,req,res',
            },
          }
        : undefined,
      // The request id middleware has already assigned one.
      genReqId: (req: IncomingMessage) => (req as AppRequest).id,
      customProps: (req: IncomingMessage) => ({
        requestId: (req as AppRequest).id,
        userId: (req as AppRequest).user?.id,
      }),
      serializers: {
        req: (req: { id: string; method: string; url: string; remoteAddress?: string }) => ({
          id: req.id,
          method: req.method,
          path: pathOf(req.url),
          remoteAddress: req.remoteAddress,
        }),
        res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
      },
      customLogLevel: (_req: IncomingMessage, res: ServerResponse, error?: Error) =>
        error || res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info',
      customSuccessMessage: (req: IncomingMessage, res: ServerResponse, responseTime: number) =>
        `${req.method ?? ''} ${pathOf(req.url)} ${res.statusCode} ${Math.round(responseTime)}ms`,
      customErrorMessage: (req: IncomingMessage, res: ServerResponse) =>
        `${req.method ?? ''} ${pathOf(req.url)} ${res.statusCode}`,
      autoLogging: {
        // Probes and the 1 Hz live-screen poll would drown everything else.
        ignore: (req: IncomingMessage) => {
          const path = pathOf(req.url);
          return (
            path.startsWith('/health') ||
            path.endsWith('/operator/live.jpg') ||
            path.endsWith('/operator/state')
          );
        },
      },
      quietReqLogger: true,
    },
  };
}
