import { defineConfig } from 'vitest/config';

// Integration tests run against real PostgreSQL and Valkey. They never skip silently: the setup
// file fails the run when TEST_DATABASE_URL / TEST_VALKEY_URL are missing.
export default defineConfig({
  test: {
    include: ['src/**/*.integration.test.ts'],
    setupFiles: ['src/test/integration-env.ts'],
    fileParallelism: false,
    testTimeout: 20_000,
  },
});
