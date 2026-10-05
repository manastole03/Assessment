import { jest } from '@jest/globals';

import type { AuthenticatedUser } from '../../src/common/interfaces/authenticated-user.interface.js';
import { type AppConfig, toAppConfig } from '../../src/config/configuration.js';
import { parseEnv } from '../../src/config/validation.js';
import type { User } from '../../src/generated/prisma/client.js';
import { Role, UserStatus } from '../../src/generated/prisma/enums.js';

/** The app configuration tests run with, with optional overrides per section. */
export function testConfig(
  overrides: { [K in keyof AppConfig]?: Partial<AppConfig[K]> } = {},
): AppConfig {
  const base = toAppConfig(parseEnv(process.env));
  const merged = { ...base } as Record<string, unknown>;
  for (const [key, value] of Object.entries(overrides)) {
    const section = base[key as keyof AppConfig];
    merged[key] =
      typeof section === 'object' && section !== null
        ? { ...section, ...(value as object) }
        : value;
  }
  return merged as unknown as AppConfig;
}

export function actor(
  role: Role = Role.OPERATOR,
  overrides: Partial<AuthenticatedUser> = {},
): AuthenticatedUser {
  return {
    id: `00000000-0000-7000-8000-00000000000${role.length}`,
    email: `${role.toLowerCase()}@example.com`,
    name: `${role} User`,
    role,
    authMethod: 'session',
    sessionId: '00000000-0000-7000-8000-0000000000aa',
    ...overrides,
  };
}

export function userRow(overrides: Partial<User> = {}): User {
  const now = new Date('2026-10-01T00:00:00Z');
  return {
    id: '00000000-0000-7000-8000-000000000001',
    email: 'dana@example.com',
    name: 'Dana Ops',
    passwordHash: '$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$aGFzaA',
    role: Role.OPERATOR,
    status: UserStatus.ACTIVE,
    failedLoginAttempts: 0,
    lockedUntil: null,
    lastLoginAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

/** A typed mock whose methods are all jest.fn(); give the ones a test uses an implementation. */
export function mockOf<T extends object>(
  implementation: Partial<Record<keyof T, unknown>> = {},
): jest.Mocked<T> {
  const target: Record<PropertyKey, unknown> = implementation;
  return new Proxy(target, {
    get(target, property) {
      if (!(property in target)) target[property] = jest.fn();
      return target[property];
    },
  }) as unknown as jest.Mocked<T>;
}
