import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end configuration (§33 "E2E").
 *
 * These run against an already-running stack rather than starting one, so the
 * tests exercise the same build that is deployed. BASE_URL points at the web
 * app (which proxies /api to the API).
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  // Serial: several tests assert on capsule state transitions and on console
  // cleanliness, which parallel runs would make non-deterministic.
  workers: 1,
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  reporter: [['list'], ['json', { outputFile: 'test-results/e2e-results.json' }]],
  use: {
    baseURL: process.env.BASE_URL ?? 'http://127.0.0.1:3000',
    // Use a pre-installed Chromium when one is provided. Playwright pins a
    // browser build per release; on a machine whose build differs, pointing at
    // the existing binary is preferable to downloading a second copy.
    ...(process.env.CHROMIUM_PATH ? { launchOptions: { executablePath: process.env.CHROMIUM_PATH } } : {}),
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    // The preview is HTTP; do not let Playwright upgrade or complain.
    ignoreHTTPSErrors: true,
  },
  projects: [
    {
      name: 'desktop-chrome',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1280, height: 900 },
      },
    },
    {
      name: 'mobile',
      use: {
        ...devices['Pixel 5'],
      },
    },
  ],
});
