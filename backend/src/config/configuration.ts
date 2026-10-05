import { registerAs } from '@nestjs/config';

import { type Env, parseEnv } from './validation.js';

export type NodeEnv = Env['NODE_ENV'];

export interface AppConfig {
  env: NodeEnv;
  isProduction: boolean;
  http: {
    host: string;
    port: number;
    publicUrl: string;
    corsOrigins: string[];
    trustProxy: number;
    bodyLimit: string;
  };
  log: { level: Env['LOG_LEVEL']; pretty: boolean };
  auth: {
    jwtSecret: string;
    jwtIssuer: string;
    jwtAudience: string;
    accessTokenTtlSeconds: number;
    refreshTokenTtlDays: number;
    cookieSecure: boolean;
    allowSignup: boolean;
    maxFailedLogins: number;
    lockoutMinutes: number;
    requireSeparateReviewer: boolean;
  };
  engine: {
    url: string;
    token: string | null;
    timeoutMs: number;
    allowHeaded: boolean;
    runSyncEnabled: boolean;
    runSyncIntervalMs: number;
  };
  features: { demoEnabled: boolean; swaggerEnabled: boolean };
  rateLimit: { ttlMs: number; max: number; authMax: number };
  ui: { distPath: string | null };
}

/** The typed application configuration, derived from the validated environment. */
export function toAppConfig(env: Env): AppConfig {
  const isProduction = env.NODE_ENV === 'production';
  return {
    env: env.NODE_ENV,
    isProduction,
    http: {
      host: env.HOST,
      port: env.PORT,
      publicUrl: env.PUBLIC_URL.replace(/\/+$/, ''),
      corsOrigins: env.CORS_ORIGIN,
      trustProxy: env.TRUST_PROXY,
      bodyLimit: '256kb',
    },
    log: { level: env.LOG_LEVEL, pretty: env.NODE_ENV === 'development' },
    auth: {
      jwtSecret: env.JWT_SECRET,
      jwtIssuer: env.JWT_ISSUER,
      jwtAudience: env.JWT_AUDIENCE,
      accessTokenTtlSeconds: env.JWT_EXPIRES_IN,
      refreshTokenTtlDays: env.REFRESH_TOKEN_TTL_DAYS,
      // Secure cookies unless explicitly disabled (plain-http localhost); always on by default in production.
      cookieSecure: env.COOKIE_SECURE ?? isProduction,
      allowSignup: env.AUTH_ALLOW_SIGNUP,
      maxFailedLogins: env.AUTH_MAX_FAILED_LOGINS,
      lockoutMinutes: env.AUTH_LOCKOUT_MINUTES,
      requireSeparateReviewer: env.APPROVAL_REQUIRE_SEPARATE_REVIEWER,
    },
    engine: {
      url: env.ENGINE_URL.replace(/\/+$/, ''),
      token: env.ENGINE_TOKEN ?? null,
      timeoutMs: env.ENGINE_TIMEOUT_MS,
      allowHeaded: env.ENGINE_ALLOW_HEADED,
      runSyncEnabled: env.RUN_SYNC_ENABLED,
      runSyncIntervalMs: env.RUN_SYNC_INTERVAL_MS,
    },
    features: { demoEnabled: env.DEMO_ENABLED, swaggerEnabled: env.SWAGGER_ENABLED },
    rateLimit: {
      ttlMs: env.RATE_LIMIT_TTL_MS,
      max: env.RATE_LIMIT_MAX,
      authMax: env.AUTH_RATE_LIMIT_MAX,
    },
    ui: { distPath: env.UI_DIST_PATH.trim() || null },
  };
}

/** Inject with `@Inject(appConfig.KEY) config: ConfigType<typeof appConfig>`. */
export const appConfig = registerAs('app', () => toAppConfig(parseEnv(process.env)));
