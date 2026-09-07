/**
 * Playwright global setup: block until the stack is genuinely ready.
 *
 * Why this exists: these tests run against an already-running stack. If a run
 * starts while the web server is still swapping builds, the HTML references a
 * stylesheet hash that no longer exists, the page renders unstyled, and axe
 * reports contrast violations that have nothing to do with the code under test.
 * That happened once and cost a debugging cycle.
 *
 * So readiness here means more than "the port answers": the health endpoint
 * must respond AND the home page's stylesheet must actually load.
 */

import type { FullConfig } from '@playwright/test';

const READY_TIMEOUT_MS = 90_000;
const POLL_MS = 1000;

async function stylesheetLoads(baseUrl: string): Promise<boolean> {
  const home = await fetch(baseUrl, { redirect: 'follow' });
  if (!home.ok) return false;
  const html = await home.text();

  const match = /\/_next\/static\/css\/[^"']+\.css/.exec(html);
  // A dev build may inline styles and ship no stylesheet link; that is fine.
  if (match === null) return true;

  const css = await fetch(new URL(match[0], baseUrl));
  if (!css.ok) return false;
  // Confirm it really is our stylesheet and not an error page served as HTML.
  return (await css.text()).includes('--surface-base');
}

export default async function globalSetup(config: FullConfig): Promise<void> {
  const baseUrl =
    process.env.BASE_URL ?? (config.projects[0]?.use.baseURL as string | undefined) ?? 'http://127.0.0.1:3000';

  const deadline = Date.now() + READY_TIMEOUT_MS;
  let lastProblem = 'no attempt made';

  while (Date.now() < deadline) {
    try {
      const health = await fetch(new URL('/healthz', baseUrl));
      if (!health.ok) {
        lastProblem = `/healthz returned ${health.status}`;
      } else if (!(await stylesheetLoads(baseUrl))) {
        lastProblem = 'stylesheet did not load (server is probably mid-restart)';
      } else {
        // eslint-disable-next-line no-console
        console.log(`[e2e] stack ready at ${baseUrl}`);
        return;
      }
    } catch (error) {
      lastProblem = (error as Error).message;
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }

  throw new Error(
    `[e2e] stack at ${baseUrl} was not ready within ${READY_TIMEOUT_MS / 1000}s: ${lastProblem}`,
  );
}
