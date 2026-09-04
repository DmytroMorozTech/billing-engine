import next from '@next/eslint-plugin-next';
import circuitUI from '@sumup-oss/eslint-plugin-circuit-ui';
import { configs, defineConfig } from '@sumup-oss/foundry/eslint';
import jest from 'eslint-plugin-jest';
import testingLibrary from 'eslint-plugin-testing-library';

export default defineConfig([
  configs.ignores,
  {
    extends: [configs.typescript],
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: ['*.js', '*.cjs'],
        },
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    extends: [
      next.configs.recommended,
      configs.next,
      circuitUI.configs.recommended,
    ],
  },
  configs.browser,
  {
    // App Router code is a Server Component unless it says otherwise, and
    // `configs.browser` otherwise flags `fetch` and `Promise.all` as
    // unsupported in Opera Mini — a browser this code never reaches. A file
    // that gains `'use client'` has to come back off this list.
    files: ['lib/**/*.ts', 'app/**/page.tsx', 'app/**/layout.tsx'],
    rules: { 'compat/compat': 'off' },
  },
  {
    extends: [
      jest.configs['flat/recommended'],
      testingLibrary.configs['flat/react'],
      configs.tests,
    ],
  },
]);
