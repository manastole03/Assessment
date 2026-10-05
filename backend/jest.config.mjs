// Unit tests: fast, no database, no engine. ESM throughout (NestJS 12 ships ESM only).
/** @type {import('jest').Config} */
export default {
    rootDir: '.',
    testEnvironment: 'node',
    roots: ['<rootDir>/test/unit'],
    testMatch: ['**/*.spec.ts'],
    extensionsToTreatAsEsm: ['.ts'],
    moduleNameMapper: { '^(\\.{1,2}/.*)\\.js$': '$1' },
    transform: {
        '^.+\\.ts$': ['ts-jest', { useESM: true, tsconfig: '<rootDir>/tsconfig.json' }],
    },
    setupFiles: ['<rootDir>/test/setup-env.ts'],
    collectCoverageFrom: [
        'src/**/*.ts',
        '!src/main.ts',
        '!src/generated/**',
        '!src/**/*.module.ts',
    ],
    coverageDirectory: 'coverage',
    clearMocks: true,
};
