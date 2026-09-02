import js from '@eslint/js';
import tseslint from 'typescript-eslint';

/**
 * Lint rules for the backend workspaces.
 *
 * `apps/web` is excluded on purpose: it keeps the Circuit UI template's own
 * Foundry/Biome/ESLint setup unchanged. See ADR-0007.
 */
export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/node_modules/**', '**/.next/**', 'apps/web/**', 'apps/psp/**'],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      eqeqeq: ['error', 'always'],
      'no-console': ['warn', { allow: ['warn', 'error'] }],
    },
  },

  /**
   * The domain package is pure. These rules are the enforcement of ADR-0002 and
   * ADR-0007 — without them both are just good intentions in a markdown file.
   */
  {
    files: ['packages/domain/src/**/*.ts'],
    rules: {
      'no-restricted-globals': [
        'error',
        {
          name: 'Date',
          message:
            'ADR-0002: time is injected. Take a Clock and use Temporal types. `Date` belongs in the composition root only.',
        },
      ],

      'no-restricted-syntax': [
        'error',
        {
          selector: "NewExpression[callee.name='Date']",
          message:
            'ADR-0002: `new Date()` is forbidden in the domain. Take a Clock and call `clock.now()`.',
        },
        {
          selector: "MemberExpression[object.name='Temporal'][property.name='Now']",
          message:
            'ADR-0002: `Temporal.Now` reads ambient time. Take a Clock and call `clock.now()`.',
        },
        {
          selector: "MemberExpression[object.name='Math'][property.name='random']",
          message: 'The domain must be deterministic. Inject randomness if it is genuinely needed.',
        },
      ],

      'no-restricted-imports': [
        'error',
        {
          paths: [
            { name: 'pg', message: 'ADR-0007: the domain package performs no I/O.' },
            { name: 'ioredis', message: 'ADR-0007: the domain package performs no I/O.' },
            { name: 'fastify', message: 'ADR-0007: the domain package performs no I/O.' },
            { name: 'bullmq', message: 'ADR-0007: the domain package performs no I/O.' },
          ],
          patterns: [
            {
              group: ['node:fs', 'node:fs/*', 'node:http', 'node:https', 'node:net', 'node:dns'],
              message: 'ADR-0007: the domain package performs no I/O.',
            },
          ],
        },
      ],
    },
  },

  /** Tests may reach for things the domain itself may not. */
  {
    files: ['**/*.test.ts'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
);
