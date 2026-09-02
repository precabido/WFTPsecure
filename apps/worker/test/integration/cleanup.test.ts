/**
 * Cleanup worker tests (§19, §33).
 *
 * The two properties that matter most here:
 *   - A capsule with an ACTIVE retrieval lease must survive the sweep. If it
 *     did not, a slow download would be destroyed mid-flight and the recipient
 *     would lose content nobody else ever saw (§15).
 *   - Purging must never leave a blob without a row, or a row without a blob.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { FilesystemStorage, chunkKey } from '@cinderlink/storage';
import * as db from '@cinderlink/database';
import { runTick } from '../../src/main.ts';

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://postgres@127.0.0.1:55432/cinderlink_test';

let storageRoot: string;
let storage: FilesystemStorage;

const newId = () => randomBytes(16).toString('base64url');

async function seedCapsule(overrides: Partial<db.CreateCapsuleInput> = {}) {
  const id = overrides.id ?? newId();
  const manifestKey = `manifests/${newId()}`;
  const storageKey = `objects/${newId()}`;
  await storage.put(manifestKey, new Uint8Array([1, 2, 3]));
  await storage.put(chunkKey(storageKey, 0), new Uint8Array(1024));
  await storage.put(chunkKey(storageKey, 1), new Uint8Array(1024));

  await db.createCapsule({
    id,
    version: 'capsule-envelope-v1',
    type: 'files',
    burnMode: 'on-claim',
    maxClaims: 1,
    unlockAt: null,
    expiresAt: new Date(Date.now() + 3600_000),
    claimWindowSeconds: 900,
    encryptedManifestObjectKey: manifestKey,
    totalCipherBytes: 2048 + 3,
    managementTokenHash: db.hashToken(newId()),
    objects: [{ id: newId(), storageKey, chunkCount: 2, cipherBytes: 2048 }],
    ...overrides,
  });
  return { id, manifestKey, storageKey };
}

beforeAll(async () => {
  process.env.DATABASE_URL = DATABASE_URL;
  await db.migrate(DATABASE_URL);
  storageRoot = await mkdtemp(join(tmpdir(), 'cinderlink-worker-'));
  storage = new FilesystemStorage(storageRoot);
  await storage.init();
});

afterAll(async () => {
  await db.closePool();
  await rm(storageRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  await db
    .getPool()
    .query('TRUNCATE capsules, capsule_events, capsule_objects, retrieval_leases, upload_sessions, upload_chunks CASCADE');
  await db.getPool().query('UPDATE storage_accounting SET cipher_bytes = 0 WHERE id = TRUE');
  // Storage must be reset alongside the database. Truncating rows while leaving
  // blobs behind makes the previous test's files look like genuine orphans to
  // the reconciler — which they would be — and any global orphan count then
  // measures test leakage instead of the behaviour under test.
  for (const prefix of ['objects', 'manifests', 'prompts', 'submissions']) {
    await storage.deletePrefix(prefix);
  }
});

describe('expiry sweep', () => {
  it('marks a past-due capsule expired and then destroys its blobs', async () => {
    const { id, manifestKey, storageKey } = await seedCapsule({
      expiresAt: new Date(Date.now() - 1000),
    });

    const report = await runTick(storage);
    expect(report.expiredCapsules).toBe(1);
    expect(report.purgedCapsules).toBe(1);

    // Both the manifest and every chunk are gone from storage.
    expect(await storage.get(manifestKey)).toBeNull();
    expect(await storage.get(chunkKey(storageKey, 0))).toBeNull();
    expect(await storage.get(chunkKey(storageKey, 1))).toBeNull();

    // The row survives as a tombstone so the state is honest, not "not found".
    const status = await db.getPublicStatus(id);
    expect(status?.state).toBe('destroyed');
  });

  it('leaves a live capsule completely alone', async () => {
    const { id, manifestKey } = await seedCapsule();
    const report = await runTick(storage);
    expect(report.purgedCapsules).toBe(0);
    expect(await storage.get(manifestKey)).not.toBeNull();
    expect((await db.getPublicStatus(id))?.state).toBe('available');
  });

  it('is idempotent across repeated ticks', async () => {
    await seedCapsule({ expiresAt: new Date(Date.now() - 1000) });
    const first = await runTick(storage);
    const second = await runTick(storage);
    const third = await runTick(storage);
    expect(first.purgedCapsules).toBe(1);
    expect(second.purgedCapsules).toBe(0);
    expect(third.purgedCapsules).toBe(0);
  });
});

describe('retrieval leases protect in-flight downloads (§15)', () => {
  it('does NOT purge a consumed capsule while its lease is still active', async () => {
    const { id, manifestKey } = await seedCapsule();
    const claim = await db.claimCapsule(id);
    expect(claim.ok).toBe(true);

    // The capsule is now 'consumed' — but someone is mid-download.
    const report = await runTick(storage);
    expect(report.purgedCapsules).toBe(0);
    expect(await storage.get(manifestKey)).not.toBeNull();

    // And the lease still resolves, so the download can continue.
    if (!claim.ok) throw new Error('unreachable');
    expect(await db.resolveRetrievalLease(claim.retrievalToken)).not.toBeNull();
  });

  it('purges once the lease window closes', async () => {
    const { id, manifestKey } = await seedCapsule();
    const claim = await db.claimCapsule(id, 1);
    expect(claim.ok).toBe(true);

    // Force the lease past its deadline rather than sleeping.
    await db.getPool().query(`UPDATE retrieval_leases SET expires_at = now() - interval '1 second'`);

    const report = await runTick(storage);
    expect(report.expiredLeases).toBe(1);
    expect(report.purgedCapsules).toBe(1);
    expect(await storage.get(manifestKey)).toBeNull();
  });

  it('purges promptly once retrieval is completed', async () => {
    const { id, manifestKey } = await seedCapsule();
    const claim = await db.claimCapsule(id);
    if (!claim.ok) throw new Error('unreachable');
    await db.completeRetrieval(claim.leaseId);

    const report = await runTick(storage);
    expect(report.purgedCapsules).toBe(1);
    expect(await storage.get(manifestKey)).toBeNull();
  });
});

describe('abandoned uploads', () => {
  it('deletes chunks of an upload that never completed', async () => {
    const session = await db.createUploadSession({ capsuleId: newId(), expectedChunks: 3, ttlSeconds: 60 });
    await storage.put(chunkKey(session.storageKey, 0), new Uint8Array(512));
    await db.recordChunk(session.uploadId, 0, 512);

    await db.getPool().query(`UPDATE upload_sessions SET expires_at = now() - interval '1 second'`);

    const report = await runTick(storage);
    expect(report.staleUploads).toBe(1);
    expect(await storage.get(chunkKey(session.storageKey, 0))).toBeNull();
  });
});

describe('reconciliation (§19)', () => {
  it('removes a stored blob that no row references', async () => {
    // Simulate the crash case: a chunk was written, then the process died
    // before the database learned about it.
    const orphanKey = `objects/${newId()}/c0`;
    await storage.put(orphanKey, new Uint8Array(64));
    expect(await storage.get(orphanKey)).not.toBeNull();

    const report = await runTick(storage, { reconcile: true });
    expect(report.orphansRemoved).toBeGreaterThanOrEqual(1);
    expect(await storage.get(orphanKey)).toBeNull();
  });

  it('never removes a blob that a live capsule references', async () => {
    const { manifestKey, storageKey } = await seedCapsule();
    const report = await runTick(storage, { reconcile: true });
    expect(report.orphansRemoved).toBe(0);
    expect(await storage.get(manifestKey)).not.toBeNull();
    expect(await storage.get(chunkKey(storageKey, 0))).not.toBeNull();
  });

  it('never removes chunks of an upload still in progress', async () => {
    const session = await db.createUploadSession({ capsuleId: newId(), expectedChunks: 2, ttlSeconds: 3600 });
    await storage.put(chunkKey(session.storageKey, 0), new Uint8Array(128));
    await db.recordChunk(session.uploadId, 0, 128);

    const report = await runTick(storage, { reconcile: true });
    expect(report.orphansRemoved).toBe(0);
    // The specific invariant: an open session's chunk is still referenced, so
    // it must survive even though no capsule row points at it yet.
    expect(await storage.get(chunkKey(session.storageKey, 0))).not.toBeNull();
  });
});

describe('storage accounting', () => {
  it('credits bytes on create and releases them on purge', async () => {
    await seedCapsule({ expiresAt: new Date(Date.now() - 1000) });
    expect(await db.getStorageUsage()).toBe(2051);
    await runTick(storage);
    expect(await db.getStorageUsage()).toBe(0);
  });
});
