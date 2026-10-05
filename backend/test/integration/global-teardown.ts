import pg from 'pg';

/** Drop the schema the run created (unless KEEP_TEST_SCHEMA is set, for debugging a failure). */
export default async function globalTeardown(): Promise<void> {
  const schema = process.env['ROTE_TEST_SCHEMA'];
  const url = process.env['DATABASE_URL'];
  if (!schema || !url || process.env['KEEP_TEST_SCHEMA'] || !/^it_[a-z0-9_]+$/.test(schema)) return;
  // Global hooks load outside Jest's module mapping, so this stays self-contained.
  const connection = new URL(url);
  connection.searchParams.delete('schema');
  const client = new pg.Client({ connectionString: connection.toString() });
  await client.connect();
  try {
    await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  } finally {
    await client.end();
  }
}
