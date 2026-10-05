import { RequestMethod, VersioningType } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import type { NextFunction, Request, Response } from 'express';
import helmet from 'helmet';

import { AllExceptionsFilter } from './common/filters/all-exceptions.filter.js';
import { ResponseEnvelopeInterceptor } from './common/interceptors/response-envelope.interceptor.js';
import { requestIdMiddleware } from './common/middleware/request-id.middleware.js';
import { createValidationPipe } from './common/pipes/validation.pipe.js';
import type { AppConfig } from './config/configuration.js';
import { setupSwagger } from './config/swagger.config.js';

/** Security headers for the UI and API. The UI is self-contained, so 'self' covers everything it loads. */
function appHelmet(config: AppConfig) {
  const https = config.http.publicUrl.startsWith('https://');
  return helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        // Radix/Sonner set inline style attributes at runtime.
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'blob:'],
        fontSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        frameSrc: ["'self'"],
        frameAncestors: ["'none'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        ...(https ? { upgradeInsecureRequests: [] } : {}),
      },
    },
    strictTransportSecurity: https ? { maxAge: 31_536_000, includeSubDomains: true } : false,
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  });
}

/** Swagger UI needs inline script and style; it gets its own (looser) policy on /api/docs only. */
function docsHelmet() {
  return helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        frameAncestors: ["'none'"],
        objectSrc: ["'none'"],
      },
    },
    strictTransportSecurity: false,
  });
}

/**
 * Everything about the HTTP pipeline, in one place so the server (main.ts) and the integration
 * tests run exactly the same stack. Order matters: request id → security headers → cookies →
 * body parsing → (Nest) guards → pipes → handler → interceptor → filter.
 */
export function configureApp(app: NestExpressApplication, config: AppConfig): void {
  app.set('trust proxy', config.http.trustProxy);
  app.disable('x-powered-by');

  app.use(requestIdMiddleware);
  const api = appHelmet(config);
  const docs = docsHelmet();
  app.use((req: Request, res: Response, next: NextFunction) =>
    req.path.startsWith('/api/docs') ? docs(req, res, next) : api(req, res, next),
  );
  app.use(cookieParser());
  app.useBodyParser('json', { limit: config.http.bodyLimit });
  app.useBodyParser('urlencoded', { limit: config.http.bodyLimit, extended: false });

  app.enableCors({
    origin: config.http.corsOrigins.length > 0 ? config.http.corsOrigins : false,
    credentials: true,
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'],
    allowedHeaders: [
      'content-type',
      'authorization',
      'x-api-key',
      'x-csrf-token',
      'x-request-id',
      'mcp-session-id',
      'mcp-protocol-version',
    ],
    exposedHeaders: ['x-request-id', 'location', 'mcp-session-id'],
    maxAge: 600,
  });

  // /api/v1/... for the API; /health stays unversioned and unprefixed for probes.
  app.setGlobalPrefix('api', {
    exclude: [
      { path: 'health', method: RequestMethod.ALL },
      { path: 'health/{*rest}', method: RequestMethod.ALL },
    ],
  });
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });

  app.useGlobalPipes(createValidationPipe());
  app.useGlobalInterceptors(new ResponseEnvelopeInterceptor(app.get(Reflector)));
  app.useGlobalFilters(new AllExceptionsFilter(!config.isProduction));
  app.enableShutdownHooks();

  if (config.features.swaggerEnabled) setupSwagger(app);
}
