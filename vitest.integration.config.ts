import { defineConfig } from 'vitest/config';

/**
 * Integration tests — require a real PostgreSQL (and, for API tests, storage).
 * Set DATABASE_URL before running. These are separate from the unit suite so
 * `pnpm test` stays runnable with no services installed.
 */
export default defineConfig({
  test: {
    name: 'integration',
    include: ['packages/*/test-integration/**/*.test.ts', 'apps/*/test/integration/**/*.test.ts'],
    environment: 'node',
    testTimeout: 120_000,
    hookTimeout: 60_000,
    // One shared database: parallel files would truncate each other's fixtures.
    fileParallelism: false,
    pool: 'forks',
  },
});
