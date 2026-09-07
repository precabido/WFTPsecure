/**
 * THE RACE TEST (§15, §33, §39).
 *
 * "Dos personas no pueden ganar una cápsula one-time" is the product's central
 * promise. This file is the evidence for it: real PostgreSQL, real concurrency,
 * no mocks, no serialisation in the test harness.
 *
 * A test that merely called claim() 100 times in a loop would prove nothing —
 * the interesting failure only appears when many connections contend for the
 * same row simultaneously. So every claim here is dispatched on its own pooled
 * connection and released together via Promise.all.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { getPool, closePool, hashToken } from '../src/client.ts';
import { migrate } from '../src/migrate.ts';
import { createCapsule, claimCapsule, getPublicStatus, revokeCapsule } from '../src/capsules.ts';
import { randomBytes } from 'node:crypto';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://postgres@127.0.0.1:55432/cinderlink_test';

function capsuleFixture(overrides: Partial<Parameters<typeof createCapsule>[0]> = {}) {
  const id = randomBytes(16).toString('base64url');
  return {
    id,
    version: 'capsule-envelope-v1',
    type: 'note' as const,
    burnMode: 'on-claim' as const,
    maxClaims: 1,
    unlockAt: null,
    expiresAt: new Date(Date.now() + 3600_000),
    claimWindowSeconds: 900,
    encryptedManifestObjectKey: `manifests/${randomBytes(16).toString('base64url')}`,
    totalCipherBytes: 1234,
    managementTokenHash: hashToken(randomBytes(32).toString('base64url')),
    objects: [],
    ...overrides,
  };
}

beforeAll(async () => {
  process.env.DATABASE_URL = DATABASE_URL;
  // Raise the pool so concurrency in the test is real contention on the row,
  // not queueing behind a small pool that would serialise the claims for us
  // and make the test pass vacuously.
  process.env.PG_POOL_MAX = '40';
  await migrate(DATABASE_URL);
});

afterAll(async () => {
  await closePool();
});

beforeEach(async () => {
  await getPool().query('TRUNCATE capsules, capsule_events, capsule_objects, retrieval_leases CASCADE');
});

describe('one-time capsule under concurrent claims', () => {
  it('lets exactly one of 100 simultaneous claimants win', async () => {
    const capsule = capsuleFixture({ maxClaims: 1 });
    await createCapsule(capsule);

    // Fire all 100 at once. Promise.all does not stagger them: each call grabs
    // its own connection and issues the conditional UPDATE concurrently.
    const results = await Promise.all(
      Array.from({ length: 100 }, () => claimCapsule(capsule.id)),
    );

    const winners = results.filter((r) => r.ok);
    const losers = results.filter((r) => !r.ok);

    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(99);

    // Every loser must be told the capsule is gone — never handed a token.
    for (const loser of losers) {
      expect(loser.ok).toBe(false);
      if (loser.ok) throw new Error('unreachable');
      expect(loser.reason).toBe('consumed');
    }

    // Exactly one retrieval token exists, and the counter did not overshoot.
    const { rows } = await getPool().query<{ claims_count: number; state: string }>(
      'SELECT claims_count, state FROM capsules WHERE id = $1',
      [capsule.id],
    );
    expect(rows[0]?.claims_count).toBe(1);
    expect(rows[0]?.state).toBe('consumed');

    const { rows: leases } = await getPool().query('SELECT id FROM retrieval_leases WHERE capsule_id = $1', [
      capsule.id,
    ]);
    expect(leases).toHaveLength(1);
  });

  it('holds at exactly one winner across 10 independent capsules', async () => {
    // Repeating the race reduces the chance that a single lucky scheduling
    // order masks a real bug.
    for (let round = 0; round < 10; round += 1) {
      const capsule = capsuleFixture({ maxClaims: 1 });
      await createCapsule(capsule);
      const results = await Promise.all(Array.from({ length: 50 }, () => claimCapsule(capsule.id)));
      expect(results.filter((r) => r.ok)).toHaveLength(1);
    }
  });

  it('admits exactly max_claims winners when the budget is greater than one', async () => {
    const capsule = capsuleFixture({ maxClaims: 5 });
    await createCapsule(capsule);

    const results = await Promise.all(Array.from({ length: 100 }, () => claimCapsule(capsule.id)));

    expect(results.filter((r) => r.ok)).toHaveLength(5);
    expect(results.filter((r) => !r.ok)).toHaveLength(95);

    const { rows } = await getPool().query<{ claims_count: number; state: string }>(
      'SELECT claims_count, state FROM capsules WHERE id = $1',
      [capsule.id],
    );
    // The CHECK constraint would have aborted an overshoot, but assert the
    // exact value so an off-by-one that stays within budget is still caught.
    expect(rows[0]?.claims_count).toBe(5);
    expect(rows[0]?.state).toBe('consumed');
  });

  it('issues one distinct retrieval token per winner, never a shared one', async () => {
    const capsule = capsuleFixture({ maxClaims: 3 });
    await createCapsule(capsule);
    const results = await Promise.all(Array.from({ length: 30 }, () => claimCapsule(capsule.id)));
    const tokens = results.filter((r) => r.ok).map((r) => (r.ok ? r.retrievalToken : ''));
    expect(tokens).toHaveLength(3);
    expect(new Set(tokens).size).toBe(3);
  });
});

describe('claims respect every policy gate', () => {
  it('refuses an expired capsule', async () => {
    const capsule = capsuleFixture({ expiresAt: new Date(Date.now() - 1000) });
    await createCapsule(capsule);
    const result = await claimCapsule(capsule.id);
    expect(result).toMatchObject({ ok: false, reason: 'expired' });
  });

  it('refuses a capsule whose unlock time has not arrived', async () => {
    const capsule = capsuleFixture({ unlockAt: new Date(Date.now() + 3600_000) });
    await createCapsule(capsule);
    expect(await claimCapsule(capsule.id)).toMatchObject({ ok: false, reason: 'locked' });
  });

  it('allows a claim once the unlock time has passed', async () => {
    const capsule = capsuleFixture({ unlockAt: new Date(Date.now() - 1000) });
    await createCapsule(capsule);
    expect((await claimCapsule(capsule.id)).ok).toBe(true);
  });

  it('refuses an unknown id without revealing that it is unknown to the caller', async () => {
    const result = await claimCapsule(randomBytes(16).toString('base64url'));
    expect(result).toMatchObject({ ok: false, reason: 'not-found' });
  });

  it('refuses a revoked capsule and kills its outstanding leases', async () => {
    const capsule = capsuleFixture({ maxClaims: 5 });
    await createCapsule(capsule);
    const first = await claimCapsule(capsule.id);
    expect(first.ok).toBe(true);

    expect(await revokeCapsule(capsule.id)).toBe(true);
    expect(await claimCapsule(capsule.id)).toMatchObject({ ok: false, reason: 'revoked' });

    // Revocation must stop an in-flight download, not merely block new ones.
    const { rows } = await getPool().query<{ state: string }>(
      'SELECT state FROM retrieval_leases WHERE capsule_id = $1',
      [capsule.id],
    );
    expect(rows.every((r) => r.state === 'expired')).toBe(true);
  });

  it('never lets a time-only capsule be consumed by reads', async () => {
    const capsule = capsuleFixture({ burnMode: 'time-only', maxClaims: 100 });
    await createCapsule(capsule);
    const results = await Promise.all(Array.from({ length: 20 }, () => claimCapsule(capsule.id)));
    expect(results.every((r) => r.ok)).toBe(true);
    const status = await getPublicStatus(capsule.id);
    expect(status?.state).toBe('available');
  });
});

describe('reading status never consumes (§15 link scanners)', () => {
  it('leaves the capsule claimable after repeated status reads', async () => {
    const capsule = capsuleFixture({ maxClaims: 1 });
    await createCapsule(capsule);

    // Simulate a link scanner, a chat preview and a user refreshing the page.
    for (let i = 0; i < 25; i += 1) {
      const status = await getPublicStatus(capsule.id);
      expect(status?.state).toBe('available');
      expect(status?.claimsRemaining).toBe(1);
    }

    // The real recipient can still claim it.
    expect((await claimCapsule(capsule.id)).ok).toBe(true);

    const { rows } = await getPool().query<{ claims_count: number }>(
      'SELECT claims_count FROM capsules WHERE id = $1',
      [capsule.id],
    );
    expect(rows[0]?.claims_count).toBe(1);
  });

  it('reports expiry at read time without waiting for the sweep', async () => {
    const capsule = capsuleFixture({ expiresAt: new Date(Date.now() - 5000) });
    await createCapsule(capsule);
    // The row still says 'available'; the read must not.
    expect((await getPublicStatus(capsule.id))?.state).toBe('expired');
  });

  it('returns null for an unknown id so callers can emit a generic response', async () => {
    expect(await getPublicStatus(randomBytes(16).toString('base64url'))).toBeNull();
  });
});
