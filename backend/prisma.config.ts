// Prisma CLI configuration (migrate, generate, seed). The running app reads DATABASE_URL through its
// validated config instead (src/config).
import 'dotenv/config';
import { defineConfig } from 'prisma/config';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: 'tsx prisma/seed.ts',
  },
  // Read lazily: `prisma generate` (Docker builds, lint-only CI) must work without a database.
  datasource: {
    url: process.env['DATABASE_URL'],
  },
});
