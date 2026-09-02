import { defineConfig } from 'vitest/config';

/**
 * Unit test configuration — hermetic, no external services.
 * Integration tests (real PostgreSQL + storage) live in vitest.integration.config.ts
 * so that `pnpm test` stays runnable on a laptop with nothing installed.
 */
export default defineConfig({
  test: {
    name: 'unit',
    include: ['packages/*/test/**/*.test.ts', 'apps/*/test/unit/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30_000,
  },
});
