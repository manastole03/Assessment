// ESLint flat config: type-aware typescript-eslint rules, Prettier owns formatting.
import eslint from '@eslint/js';
import prettier from 'eslint-config-prettier';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
    { ignores: ['dist/', 'coverage/', 'node_modules/', 'src/generated/'] },
    eslint.configs.recommended,
    ...tseslint.configs.recommendedTypeChecked,
    {
        languageOptions: {
            globals: { ...globals.node, ...globals.jest },
            parserOptions: {
                projectService: { allowDefaultProject: ['*.mjs', '*.js'] },
                tsconfigRootDir: import.meta.dirname,
            },
        },
        rules: {
            '@typescript-eslint/no-explicit-any': 'error',
            '@typescript-eslint/no-floating-promises': 'error',
            '@typescript-eslint/no-misused-promises': [
                'error',
                { checksVoidReturn: { attributes: false } },
            ],
            '@typescript-eslint/no-unused-vars': [
                'error',
                { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
            ],
            '@typescript-eslint/require-await': 'off',
            '@typescript-eslint/switch-exhaustiveness-check': 'error',
            '@typescript-eslint/prefer-nullish-coalescing': 'error',
            '@typescript-eslint/no-unnecessary-condition': 'off',
            eqeqeq: ['error', 'always'],
            'no-console': 'error',
        },
    },
    {
        // Tests build fixtures freely; production code may not.
        files: ['test/**/*.ts'],
        rules: {
            '@typescript-eslint/no-unsafe-assignment': 'off',
            '@typescript-eslint/no-unsafe-member-access': 'off',
            '@typescript-eslint/no-unsafe-argument': 'off',
            '@typescript-eslint/no-unsafe-call': 'off',
            '@typescript-eslint/unbound-method': 'off',
        },
    },
    {
        files: ['**/*.mjs', '**/*.js'],
        ...tseslint.configs.disableTypeChecked,
    },
    {
        files: ['prisma/seed.ts'],
        rules: { 'no-console': 'off' },
    },
    prettier,
);
