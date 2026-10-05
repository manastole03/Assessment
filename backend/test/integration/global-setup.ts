/**
 * Integration tests run against a real PostgreSQL in a schema of their own (created and migrated
 * here, dropped in global-teardown), so they never touch development data and can run in parallel
 * CI jobs against one server. The server comes from TEST_DATABASE_URL, DATABASE_URL, or backend/.env.
 */
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';

import { parse } from 'dotenv';

export default function globalSetup(): void {
  const fileEnv = existsSync('.env') ? parse(readFileSync('.env')) : {};
  const base =
    process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL'] ?? fileEnv['DATABASE_URL'];
  if (!base) {
    throw new Error(
      'Integration tests need PostgreSQL: set TEST_DATABASE_URL (e.g. the compose Postgres)',
    );
  }
  const schema = `it_${Date.now().toString(36)}_${randomBytes(3).toString('hex')}`;
  const url = new URL(base);
  url.searchParams.set('schema', schema);

  process.env['DATABASE_URL'] = url.toString();
  process.env['ROTE_TEST_SCHEMA'] = schema;
  execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
    env: { ...process.env, DATABASE_URL: url.toString() },
    stdio: 'pipe',
  });
}
