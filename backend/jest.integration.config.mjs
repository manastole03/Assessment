// Integration tests: the real HTTP stack and a real PostgreSQL (DATABASE_URL), with a fake engine.
// Each run migrates a throwaway schema and drops it afterwards.
import base from './jest.config.mjs';

/** @type {import('jest').Config} */
export default {
    ...base,
    roots: ['<rootDir>/test/integration'],
    testMatch: ['**/*.int-spec.ts'],
    globalSetup: '<rootDir>/test/integration/global-setup.ts',
    globalTeardown: '<rootDir>/test/integration/global-teardown.ts',
    testTimeout: 30000,
};
