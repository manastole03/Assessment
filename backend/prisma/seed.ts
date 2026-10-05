/**
 * Idempotent seed: the first admin (so a fresh deployment can be signed in to) and, for demos, one
 * user per role. Credentials come from the environment, never from this file. Existing users are
 * left untouched: re-running never resets a password.
 *
 *   SEED_ADMIN_EMAIL, SEED_ADMIN_NAME, SEED_ADMIN_PASSWORD   (required)
 *   SEED_DEMO_USERS=true, SEED_DEMO_PASSWORD                 (optional demo accounts)
 */
import 'dotenv/config';

import { PrismaPg } from '@prisma/adapter-pg';
import { z } from 'zod';

import { splitDatabaseUrl } from '../src/config/database.config.js';
import { PrismaClient } from '../src/generated/prisma/client.js';
import { Role } from '../src/generated/prisma/enums.js';
import { hashPassword, PASSWORD_RULE } from '../src/modules/users/password-hashing.js';

const password = z
  .string()
  .regex(PASSWORD_RULE, 'must be 12-128 characters and not only letters or digits');

const env = z
  .object({
    DATABASE_URL: z.string().min(1),
    SEED_ADMIN_EMAIL: z.email().transform((value) => value.trim().toLowerCase()),
    SEED_ADMIN_NAME: z.string().min(1).max(120).default('Rote Admin'),
    SEED_ADMIN_PASSWORD: password,
    SEED_DEMO_USERS: z.stringbool().default(false),
    SEED_DEMO_PASSWORD: z.string().optional(),
  })
  .parse(process.env);

const DEMO_USERS = [
  { email: 'reviewer@rote.local', name: 'Riley Reviewer', role: Role.REVIEWER },
  { email: 'operator@rote.local', name: 'Dana Operator', role: Role.OPERATOR },
  { email: 'viewer@rote.local', name: 'Vic Viewer', role: Role.VIEWER },
] as const;

const { connectionString, schema } = splitDatabaseUrl(env.DATABASE_URL);
const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }, { schema }) });

async function ensureUser(
  email: string,
  name: string,
  role: Role,
  plaintext: string,
): Promise<void> {
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    console.log(`  = ${email} exists (${existing.role}); left unchanged`);
    return;
  }
  await prisma.user.create({
    data: { email, name, role, passwordHash: await hashPassword(plaintext) },
  });
  console.log(`  + ${email} (${role})`);
}

async function main(): Promise<void> {
  console.log('Seeding users');
  await ensureUser(env.SEED_ADMIN_EMAIL, env.SEED_ADMIN_NAME, Role.ADMIN, env.SEED_ADMIN_PASSWORD);

  if (env.SEED_DEMO_USERS) {
    const demo = password.safeParse(env.SEED_DEMO_PASSWORD);
    if (!demo.success) {
      console.log(
        '  ! SEED_DEMO_USERS is on but SEED_DEMO_PASSWORD is missing or too weak; skipping demo users',
      );
    } else {
      for (const user of DEMO_USERS) await ensureUser(user.email, user.name, user.role, demo.data);
    }
  }
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
