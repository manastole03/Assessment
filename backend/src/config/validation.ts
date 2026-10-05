import { z } from 'zod';

/** `15m`, `900s`, `2h`, `1d` → seconds. */
export function parseDurationSeconds(value: string): number {
  const match = /^(\d+)\s*(s|m|h|d)$/.exec(value.trim());
  if (!match) throw new Error(`invalid duration "${value}" (use e.g. 900s, 15m, 1h, 1d)`);
  const units = { s: 1, m: 60, h: 3600, d: 86400 } as const;
  return Number(match[1]) * units[match[2] as keyof typeof units];
}

const flag = (fallback: boolean) => z.stringbool().default(fallback);
const int = (fallback: number, min: number, max: number) =>
  z.coerce.number().int().min(min).max(max).default(fallback);

const duration = z
  .string()
  .regex(/^\d+\s*(s|m|h|d)$/, 'use a duration such as 900s, 15m or 1h')
  .transform(parseDurationSeconds);

const originList = z
  .string()
  .default('')
  .transform((raw) =>
    raw
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean),
  )
  .pipe(z.array(z.url({ protocol: /^https?$/ })));

/** Placeholder secrets that must never reach a real deployment. */
const WEAK_SECRETS = ['change-me', 'changeme', 'secret', 'password', 'jwt-secret'];

/**
 * Every environment variable the API reads. Parsing fails on the first start with a list of every
 * problem, so a misconfigured deployment never comes up half-working.
 */
export const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
    PORT: int(3000, 1, 65535),
    HOST: z.string().min(1).default('0.0.0.0'),
    LOG_LEVEL: z
      .enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent'])
      .default('info'),
    PUBLIC_URL: z.url({ protocol: /^https?$/ }).default('http://localhost:3000'),
    CORS_ORIGIN: originList,
    TRUST_PROXY: int(0, 0, 10),

    DATABASE_URL: z
      .string({ error: 'is required' })
      .regex(/^postgres(ql)?:\/\/.+/, 'must be a postgresql:// connection string'),
    DATABASE_POOL_MAX: int(10, 1, 200),
    DATABASE_CONNECTION_TIMEOUT_MS: int(5000, 100, 60000),

    JWT_SECRET: z.string({ error: 'is required' }).min(32, 'must be at least 32 characters'),
    JWT_EXPIRES_IN: duration.default(900),
    JWT_ISSUER: z.string().min(1).default('rote-control-plane'),
    JWT_AUDIENCE: z.string().min(1).default('rote'),
    REFRESH_TOKEN_TTL_DAYS: int(7, 1, 90),
    COOKIE_SECURE: z.stringbool().optional(),
    AUTH_ALLOW_SIGNUP: flag(false),
    AUTH_MAX_FAILED_LOGINS: int(5, 1, 100),
    AUTH_LOCKOUT_MINUTES: int(15, 1, 1440),
    APPROVAL_REQUIRE_SEPARATE_REVIEWER: flag(true),

    ENGINE_URL: z.url({ protocol: /^https?$/ }).default('http://127.0.0.1:8700'),
    ENGINE_TOKEN: z.string().min(16, 'must be at least 16 characters').optional(),
    ENGINE_TIMEOUT_MS: int(15000, 500, 600000),
    ENGINE_ALLOW_HEADED: flag(false),
    RUN_SYNC_ENABLED: flag(true),
    RUN_SYNC_INTERVAL_MS: int(5000, 1000, 600000),

    DEMO_ENABLED: flag(false),
    SWAGGER_ENABLED: flag(true),
    RATE_LIMIT_TTL_MS: int(60000, 1000, 3600000),
    RATE_LIMIT_MAX: int(600, 1, 100000),
    AUTH_RATE_LIMIT_MAX: int(10, 1, 10000),
    UI_DIST_PATH: z.string().default(''),
  })
  .superRefine((env, ctx) => {
    if (WEAK_SECRETS.some((weak) => env.JWT_SECRET.toLowerCase().includes(weak))) {
      ctx.addIssue({
        code: 'custom',
        path: ['JWT_SECRET'],
        message: 'looks like a placeholder; generate a random secret',
      });
    }
    if (env.NODE_ENV === 'production' && !env.ENGINE_TOKEN) {
      ctx.addIssue({
        code: 'custom',
        path: ['ENGINE_TOKEN'],
        message: 'is required in production',
      });
    }
  });

export type Env = z.infer<typeof envSchema>;

/** Parse and validate the environment; throws one error naming every invalid variable. */
export function parseEnv(raw: NodeJS.ProcessEnv | Record<string, unknown>): Env {
  const result = envSchema.safeParse(raw);
  if (result.success) return result.data;
  const problems = result.error.issues
    .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('\n');
  throw new Error(`Invalid configuration; fix these environment variables:\n${problems}`);
}

/** The `validate` hook for @nestjs/config: fail fast, keep the raw strings for process.env. */
export function validateEnv(raw: Record<string, unknown>): Record<string, unknown> {
  parseEnv(raw);
  return raw;
}
