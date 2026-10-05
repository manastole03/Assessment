import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';

import { configureApp } from '../../src/app.setup.js';
import { type AppConfig, appConfig } from '../../src/config/configuration.js';
import { PrismaService } from '../../src/database/prisma.service.js';
import type { Role } from '../../src/generated/prisma/enums.js';
import { hashPassword } from '../../src/modules/users/password-hashing.js';
import { FakeEngine } from './fake-engine.js';

export const PASSWORD = 'correct horse battery 9';

export interface TestContext {
  app: INestApplication;
  engine: FakeEngine;
  prisma: PrismaService;
  config: AppConfig;
  http: () => TestAgent;
  close: () => Promise<void>;
}

/** The real application (same module graph and HTTP pipeline as production) wired to a fake engine. */
export async function createTestApp(env: Record<string, string> = {}): Promise<TestContext> {
  const engine = new FakeEngine();
  const engineUrl = env['ENGINE_URL'] ?? (await engine.start());
  Object.assign(process.env, {
    ENGINE_URL: engineUrl,
    RATE_LIMIT_MAX: '100000',
    AUTH_RATE_LIMIT_MAX: '10000',
    DEMO_ENABLED: 'true',
    AUTH_ALLOW_SIGNUP: 'false',
    ...env,
  });

  const { AppModule } = await import('../../src/app.module.js');
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>({ logger: false });
  const config = app.get<AppConfig>(appConfig.KEY);
  configureApp(app, config);
  await app.init();

  return {
    app,
    engine,
    prisma: app.get(PrismaService),
    config,
    http: () => request.agent(app.getHttpServer()),
    close: async () => {
      await app.close();
      await engine.stop();
    },
  };
}

/** Empty every table in the test schema (fast, and resets between test files). */
export async function resetDatabase(prisma: PrismaService): Promise<void> {
  const schema = process.env['ROTE_TEST_SCHEMA'];
  if (!schema) throw new Error('resetDatabase only runs inside the integration test schema');
  const tables = [
    'audit_logs',
    'interventions',
    'capability_approvals',
    'runs',
    'api_keys',
    'sessions',
    'job_leases',
    'users',
  ];
  await prisma.$executeRawUnsafe(
    `TRUNCATE ${tables.map((t) => `"${schema}"."${t}"`).join(', ')} CASCADE`,
  );
}

export async function createUser(
  prisma: PrismaService,
  email: string,
  role: Role,
  name = email.split('@')[0] ?? email,
) {
  return prisma.user.create({
    data: { email, name, role, passwordHash: await hashPassword(PASSWORD) },
  });
}

export interface Session {
  agent: TestAgent;
  csrf: string;
  accessToken: string;
}

function cookieValue(setCookie: string[] | string | undefined, name: string): string {
  const all = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  const cookie = all.find((c) => c.startsWith(`${name}=`));
  if (!cookie) throw new Error(`no ${name} cookie`);
  return decodeURIComponent(cookie.slice(name.length + 1).split(';')[0] ?? '');
}

/** Sign in as a browser would: the agent keeps the cookies; `csrf` goes in X-CSRF-Token on writes. */
export async function login(
  ctx: TestContext,
  email: string,
  password = PASSWORD,
): Promise<Session> {
  const agent = ctx.http();
  const response = await agent.post('/api/v1/auth/login').send({ email, password }).expect(200);
  const body = response.body as { data: { accessToken: string } };
  return {
    agent,
    csrf: cookieValue(response.headers['set-cookie'], 'rote_csrf'),
    accessToken: body.data.accessToken,
  };
}

export { cookieValue };
