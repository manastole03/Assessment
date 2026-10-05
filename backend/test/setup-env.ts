// Deterministic configuration for tests. Integration tests override DATABASE_URL (global-setup.ts).
process.env['NODE_ENV'] = 'test';
process.env['LOG_LEVEL'] ??= 'silent';
process.env['DATABASE_URL'] ??= 'postgresql://rote:rote@localhost:5433/rote?schema=public';
process.env['JWT_SECRET'] = 'test-jwt-signing-key-0123456789abcdefghijklmnop';
process.env['ENGINE_URL'] ??= 'http://127.0.0.1:1';
process.env['ENGINE_TOKEN'] = 'test-engine-token-0123456789';
process.env['RUN_SYNC_ENABLED'] = 'false';
process.env['SWAGGER_ENABLED'] = 'false';
process.env['UI_DIST_PATH'] = '';
process.env['COOKIE_SECURE'] = 'false';

// Two dependencies (@nestjs/throttler, nestjs-pino) are CommonJS and require() the ESM-only
// @nestjs/common. Node allows that; Jest only does once the ESM side is fully evaluated, so load it first.
const { Logger } = await import('@nestjs/common');
await import('@nestjs/core');

// Expected errors in tests should not print stack traces; set TEST_LOGS=1 to see them.
if (!process.env['TEST_LOGS']) Logger.overrideLogger(false);
