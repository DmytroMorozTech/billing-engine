import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'packages/*/src/**/*.test.ts',
      'apps/{api,worker}/src/**/*.test.ts',
    ],
    // Integration tests need a real database and are slower; they skip
    // themselves when DATABASE_URL is absent.
    testTimeout: 30_000,
    hookTimeout: 60_000,
    environment: 'node',
  },
});
