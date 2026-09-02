/**
 * Cleanup worker (§19).
 *
 * Idempotent by construction: every sweep can run twice, or be killed halfway
 * and restarted, without corrupting state. That property is what lets us delete
 * blobs before rows — a crash leaves an orphan that reconciliation reclaims,
 * whereas deleting rows first would leave a blob nothing points at.
 *
 * Ordering within a tick:
 *   1. mark expired          (state transitions only)
 *   2. expire stale leases   (frees capsules for purge)
 *   3. purge capsule blobs   (storage, then metadata)
 *   4. purge submissions
 *   5. abandon stale uploads
 *   6. reconcile orphans     (storage vs database, both directions)
 *   7. drop old tombstones
 */

import { Redis } from 'ioredis';
import { createStorage, type StorageAdapter } from '@cinderlink/storage';
import * as db from '@cinderlink/database';
import { createLogger } from './logger.ts';

const TOMBSTONE_RETENTION_HOURS = Number.parseInt(process.env.TOMBSTONE_RETENTION_HOURS ?? '24', 10);
const TICK_SECONDS = Number.parseInt(process.env.WORKER_TICK_SECONDS ?? '30', 10);
const RECONCILE_EVERY_TICKS = Number.parseInt(process.env.WORKER_RECONCILE_TICKS ?? '20', 10);

export interface TickReport {
  expiredCapsules: number;
  expiredLeases: number;
  purgedCapsules: number;
  purgedSubmissions: number;
  staleUploads: number;
  orphansRemoved: number;
  tombstonesDropped: number;
}

export async function runTick(
  storage: StorageAdapter,
  options: { reconcile: boolean } = { reconcile: false },
): Promise<TickReport> {
  const report: TickReport = {
    expiredCapsules: 0,
    expiredLeases: 0,
    purgedCapsules: 0,
    purgedSubmissions: 0,
    staleUploads: 0,
    orphansRemoved: 0,
    tombstonesDropped: 0,
  };

  report.expiredCapsules = (await db.sweepExpiredCapsules()).length;
  await db.sweepExpiredRequests();
  report.expiredLeases = await db.sweepExpiredLeases();

  // --- capsules -----------------------------------------------------------
  for (const capsule of await db.findPurgeableCapsules(200)) {
    // Blobs first. If the process dies here, the capsule is still marked
    // purgeable and the next tick finishes the job.
    for (const key of capsule.objectKeys) await storage.deletePrefix(key);
    await storage.delete(capsule.manifestKey);
    await db.markCapsuleDestroyed(capsule.id, capsule.cipherBytes);
    report.purgedCapsules += 1;
  }

  // --- secure-request submissions ----------------------------------------
  for (const submission of await db.findPurgeableSubmissions(200)) {
    for (const key of submission.objectKeys) await storage.deletePrefix(key);
    await storage.delete(submission.manifestKey);
    await db.markSubmissionDestroyed(submission.id, submission.cipherBytes);
    report.purgedSubmissions += 1;
  }

  // --- abandoned uploads --------------------------------------------------
  for (const upload of await db.sweepStaleUploads()) {
    await storage.deletePrefix(upload.storageKey);
    report.staleUploads += 1;
  }

  // --- reconciliation -----------------------------------------------------
  if (options.reconcile) {
    // Expensive (lists the whole store), so it runs on a slower cadence.
    const stored = [
      ...(await storage.list('objects')),
      ...(await storage.list('manifests')),
      ...(await storage.list('prompts')),
      ...(await storage.list('submissions')),
    ];
    const orphans = await db.reconcileOrphans(stored);
    for (const key of orphans) await storage.delete(key);
    report.orphansRemoved = orphans.length;
  }

  report.tombstonesDropped = await db.purgeDestroyedCapsules(TOMBSTONE_RETENTION_HOURS);
  return report;
}

async function main(): Promise<void> {
  const log = createLogger();
  const storage = await createStorage();
  const redis = new Redis(process.env.REDIS_URL ?? 'redis://127.0.0.1:6379');

  let running = true;
  let ticks = 0;

  const shutdown = (signal: string): void => {
    log.info({ signal }, 'worker shutting down');
    running = false;
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  log.info({ tickSeconds: TICK_SECONDS }, 'worker started');

  while (running) {
    const started = Date.now();
    try {
      // A crude cross-process lock: if two workers ever run, only one sweeps.
      // Correctness does not depend on it — every operation is idempotent — but
      // it avoids duplicated storage traffic.
      const lock = await redis.set('worker:lock', String(process.pid), 'EX', TICK_SECONDS, 'NX');
      if (lock === 'OK') {
        ticks += 1;
        const report = await runTick(storage, { reconcile: ticks % RECONCILE_EVERY_TICKS === 0 });
        const didWork = Object.values(report).some((value) => value > 0);
        if (didWork) log.info(report, 'sweep complete');
      }
    } catch (error) {
      // Never let one bad tick kill the worker; the next tick retries.
      log.error({ err: error as Error }, 'sweep failed');
    }
    const elapsed = Date.now() - started;
    await new Promise((resolve) => setTimeout(resolve, Math.max(1000, TICK_SECONDS * 1000 - elapsed)));
  }

  redis.disconnect();
  await db.closePool();
  process.exit(0);
}

const isMain = process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main().catch((error: Error) => {
    console.error('[worker] fatal:', error.message);
    process.exit(1);
  });
}
