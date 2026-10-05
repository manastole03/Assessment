import { registerAs } from '@nestjs/config';

import { parseEnv } from './validation.js';

export interface DatabaseConfig {
  /** The connection string for the pg driver (without Prisma's `schema` parameter). */
  url: string;
  /** The Postgres schema, from `?schema=` in DATABASE_URL (default: the server's search_path). */
  schema: string | undefined;
  /** Connections per API instance; size it so instances × poolMax stays under Postgres max_connections. */
  poolMax: number;
  connectionTimeoutMs: number;
  logQueries: boolean;
}

/**
 * Prisma's CLI reads `?schema=` from DATABASE_URL; the pg driver adapter needs it as an option
 * instead. Split it out so the CLI (migrations) and the app always target the same schema.
 */
export function splitDatabaseUrl(databaseUrl: string): {
  connectionString: string;
  schema: string | undefined;
} {
  const url = new URL(databaseUrl);
  const schema = url.searchParams.get('schema') ?? undefined;
  url.searchParams.delete('schema');
  return { connectionString: url.toString(), schema };
}

export function toDatabaseConfig(env: ReturnType<typeof parseEnv>): DatabaseConfig {
  const { connectionString, schema } = splitDatabaseUrl(env.DATABASE_URL);
  return {
    url: connectionString,
    schema,
    poolMax: env.DATABASE_POOL_MAX,
    connectionTimeoutMs: env.DATABASE_CONNECTION_TIMEOUT_MS,
    logQueries: env.LOG_LEVEL === 'trace',
  };
}

export const databaseConfig = registerAs('database', () => toDatabaseConfig(parseEnv(process.env)));
