/**
 * API process entrypoint.
 *
 * Boot order matters: resolveEnv() runs first so that a production deployment
 * pointed at a non-HTTPS base URL fails here, loudly, before it ever accepts a
 * request and starts making promises it cannot keep (§6).
 */

import { Redis } from 'ioredis';
import { resolveEnv, InsecureTransportError } from '@cinderlink/config';
import { createStorage } from '@cinderlink/storage';
import { migrate, closePool } from '@cinderlink/database';
import { buildApp } from './app.ts';

async function main(): Promise<void> {
  const env = resolveEnv();

  const redis = new Redis(process.env.REDIS_URL ?? 'redis://127.0.0.1:6379', {
    maxRetriesPerRequest: 3,
    lazyConnect: false,
  });
  const storage = await createStorage();

  if (process.env.RUN_MIGRATIONS === 'true') {
    const applied = await migrate();
    if (applied.length > 0) console.log(`[api] applied migrations: ${applied.join(', ')}`);
  }

  const app = await buildApp({ storage, redis });
  const port = Number.parseInt(process.env.PORT ?? '4000', 10);
  const host = process.env.HOST ?? '0.0.0.0';

  await app.listen({ port, host });
  app.log.info(
    { mode: env.mode, preview: env.previewMode, build: env.buildId },
    'api listening',
  );

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, 'shutting down');
    await app.close();
    redis.disconnect();
    await closePool();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((error: Error) => {
  if (error instanceof InsecureTransportError) {
    // This is a configuration refusal, not a crash — say so without a stack.
    console.error(`\n[api] ${error.message}\n`);
    process.exit(78); // EX_CONFIG
  }
  console.error('[api] failed to start:', error.message);
  process.exit(1);
});
