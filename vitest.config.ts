import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/src/**/*.test.ts', 'apps/{api,worker}/src/**/*.test.ts'],
    environment: 'node',
  },
});
