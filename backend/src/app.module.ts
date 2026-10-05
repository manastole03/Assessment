import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { Logger, Module } from '@nestjs/common';
import { ConfigModule, type ConfigType } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';
import { ServeStaticModule } from '@nestjs/serve-static';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { LoggerModule } from 'nestjs-pino';

import { CsrfGuard } from './common/guards/csrf.guard.js';
import { RolesGuard } from './common/guards/roles.guard.js';
import { appConfig } from './config/configuration.js';
import { databaseConfig } from './config/database.config.js';
import { loggerOptions } from './config/logger.config.js';
import { validateEnv } from './config/validation.js';
import { PrismaModule } from './database/prisma.module.js';
import { EngineModule } from './engine/engine.module.js';
import { HealthModule } from './health/health.module.js';
import { AgentsModule } from './modules/agents/agents.module.js';
import { ApiKeysModule } from './modules/api-keys/api-keys.module.js';
import { AuditModule } from './modules/audit/audit.module.js';
import { AuthModule } from './modules/auth/auth.module.js';
import { AUTH_RATE_LIMIT_KEY } from './modules/auth/guards/auth-rate-limit.decorator.js';
import { JwtAuthGuard } from './modules/auth/guards/jwt-auth.guard.js';
import { CapabilitiesModule } from './modules/capabilities/capabilities.module.js';
import { EvalsModule } from './modules/evals/evals.module.js';
import { InterventionsModule } from './modules/interventions/interventions.module.js';
import { PlatformModule } from './modules/platform/platform.module.js';
import { RunsModule } from './modules/runs/runs.module.js';
import { UsersModule } from './modules/users/users.module.js';

const NOT_UI = /^\/(api|health)(\/|$)/;

@Module({
  imports: [
    // Fails fast at startup if any variable is missing or invalid (config/validation.ts).
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      envFilePath: ['.env'],
      // Production and tests take configuration from the real environment only.
      ignoreEnvFile: ['production', 'test'].includes(process.env['NODE_ENV'] ?? ''),
      validate: validateEnv,
      load: [appConfig, databaseConfig],
    }),
    LoggerModule.forRootAsync({ inject: [appConfig.KEY], useFactory: loggerOptions }),
    ThrottlerModule.forRootAsync({
      inject: [appConfig.KEY],
      useFactory: (config: ConfigType<typeof appConfig>) => ({
        throttlers: [
          { name: 'default', ttl: config.rateLimit.ttlMs, limit: config.rateLimit.max },
          {
            // Only routes marked @AuthRateLimit(): sign-in, sign-up, password change.
            name: 'auth',
            ttl: config.rateLimit.ttlMs,
            limit: config.rateLimit.authMax,
            skipIf: (context) =>
              Reflect.getMetadata(AUTH_RATE_LIMIT_KEY, context.getHandler()) !== true,
          },
        ],
      }),
    }),
    ScheduleModule.forRoot(),
    ServeStaticModule.forRootAsync({
      inject: [appConfig.KEY],
      useFactory: (config: ConfigType<typeof appConfig>) => {
        const root = config.ui.distPath ? resolve(config.ui.distPath) : null;
        if (!root || !existsSync(resolve(root, 'index.html'))) {
          if (root)
            new Logger('UI').warn(
              `No built UI at ${root}; serving the API only (build it with \`npm run build\` in ui/)`,
            );
          return [];
        }
        return [
          {
            rootPath: root,
            exclude: NOT_UI,
            serveStaticOptions: {
              index: false,
              setHeaders: (
                res: { setHeader: (name: string, value: string) => void },
                path: string,
              ) =>
                res.setHeader(
                  'cache-control',
                  path.includes('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
                ),
            },
          },
        ];
      },
    }),

    PrismaModule,
    EngineModule,
    AuditModule,
    AuthModule,
    UsersModule,
    ApiKeysModule,
    RunsModule,
    InterventionsModule,
    CapabilitiesModule,
    AgentsModule,
    EvalsModule,
    PlatformModule,
    HealthModule,
  ],
  providers: [
    // Order is the order they run: throttle, then CSRF, then who (authentication), then what (roles).
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: CsrfGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
})
export class AppModule {}
