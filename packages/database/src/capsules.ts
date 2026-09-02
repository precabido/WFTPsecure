/**
 * Capsule lifecycle, including the atomic claim (§15).
 *
 * THE CLAIM IS THE MOST SAFETY-CRITICAL CODE IN THE PRODUCT. If two recipients
 * can both win a one-time capsule, the central promise of the service is false.
 * Everything else here exists to keep that one operation honest.
 */

import type { PoolClient } from 'pg';
import { getPool, withTransaction, generateId, hashToken, generateToken } from './client.ts';

export type CapsuleState = 'available' | 'consumed' | 'revoked' | 'expired' | 'destroyed';
export type BurnMode = 'on-claim' | 'on-download' | 'time-only';

export interface CreateCapsuleInput {
  id: string;
  version: string;
  type: 'note' | 'files' | 'combined';
  burnMode: BurnMode;
  maxClaims: number;
  unlockAt: Date | null;
  expiresAt: Date;
  claimWindowSeconds: number;
  encryptedManifestObjectKey: string;
  totalCipherBytes: number;
  managementTokenHash: Buffer;
  objects: {
    id: string;
    storageKey: string;
    chunkCount: number;
    cipherBytes: number;
  }[];
}

export interface CapsuleStatus {
  id: string;
  state: CapsuleState;
  burnMode: BurnMode;
  maxClaims: number;
  claimsCount: number;
  unlockAt: Date | null;
  expiresAt: Date;
  totalCipherBytes: number;
  objectCount: number;
  createdAt: Date;
  claimedAt: Date | null;
}

/**
 * Public status shown on the recipient gate BEFORE any claim (§15 step 1).
 *
 * Deliberately minimal: enough for the page to render honest countdown and
 * policy copy, and nothing that would help an attacker distinguish "this id
 * never existed" from "this id was consumed" beyond what the state already
 * says. Callers map a missing row to a generic unavailable response.
 */
export interface PublicCapsuleStatus {
  id: string;
  state: CapsuleState;
  burnMode: BurnMode;
  maxClaims: number;
  claimsRemaining: number;
  unlockAt: string | null;
  expiresAt: string;
  /** Approximate encrypted size — already visible from traffic analysis. */
  totalCipherBytes: number;
  objectCount: number;
}

export async function createCapsule(input: CreateCapsuleInput): Promise<void> {
  await withTransaction(async (client) => {
    await client.query(
      `INSERT INTO capsules (
         id, version, type, burn_mode, max_claims, unlock_at, expires_at,
         claim_window_seconds, encrypted_manifest_object_key, total_cipher_bytes,
         management_token_hash
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        input.id,
        input.version,
        input.type,
        input.burnMode,
        input.maxClaims,
        input.unlockAt,
        input.expiresAt,
        input.claimWindowSeconds,
        input.encryptedManifestObjectKey,
        input.totalCipherBytes,
        input.managementTokenHash,
      ],
    );

    for (const object of input.objects) {
      await client.query(
        `INSERT INTO capsule_objects (id, capsule_id, storage_key, chunk_count, cipher_bytes, state)
         VALUES ($1,$2,$3,$4,$5,'stored')`,
        [object.id, input.id, object.storageKey, object.chunkCount, object.cipherBytes],
      );
    }

    await client.query(`INSERT INTO capsule_events (capsule_id, kind) VALUES ($1,'created')`, [input.id]);
    await client.query(
      `UPDATE storage_accounting SET cipher_bytes = cipher_bytes + $1, updated_at = now() WHERE id = TRUE`,
      [input.totalCipherBytes],
    );
  });
}

/**
 * Read public status. A GET must never mutate — link scanners, chat previews
 * and mail gateways all issue GETs, and consuming a capsule from one would
 * destroy content the recipient never saw (§15).
 */
export async function getPublicStatus(capsuleId: string): Promise<PublicCapsuleStatus | null> {
  const { rows } = await getPool().query<{
    id: string;
    state: CapsuleState;
    burn_mode: BurnMode;
    max_claims: number;
    claims_count: number;
    unlock_at: Date | null;
    expires_at: Date;
    total_cipher_bytes: string;
    object_count: string;
  }>(
    `SELECT c.id, c.state, c.burn_mode, c.max_claims, c.claims_count,
            c.unlock_at, c.expires_at, c.total_cipher_bytes,
            (SELECT count(*) FROM capsule_objects o WHERE o.capsule_id = c.id) AS object_count
       FROM capsules c
      WHERE c.id = $1`,
    [capsuleId],
  );
  const row = rows[0];
  if (row === undefined) return null;

  // Expiry is evaluated at read time as well as by the worker, so a capsule is
  // never presented as available in the window between expiry and the sweep.
  const state: CapsuleState =
    row.state === 'available' && row.expires_at.getTime() <= Date.now() ? 'expired' : row.state;

  return {
    id: row.id,
    state,
    burnMode: row.burn_mode,
    maxClaims: row.max_claims,
    claimsRemaining: Math.max(0, row.max_claims - row.claims_count),
    unlockAt: row.unlock_at?.toISOString() ?? null,
    expiresAt: row.expires_at.toISOString(),
    totalCipherBytes: Number(row.total_cipher_bytes),
    objectCount: Number(row.object_count),
  };
}

export type ClaimFailure =
  | 'not-found'
  | 'expired'
  | 'revoked'
  | 'consumed'
  | 'locked'
  | 'destroyed';

export interface ClaimSuccess {
  ok: true;
  retrievalToken: string;
  leaseId: string;
  leaseExpiresAt: Date;
  manifestObjectKey: string;
  claimsRemaining: number;
}

export interface ClaimRejection {
  ok: false;
  reason: ClaimFailure;
}

/**
 * Atomically claim a capsule and open a retrieval lease.
 *
 * Concurrency argument — why exactly one caller can win:
 *
 * The claim is a single conditional UPDATE whose WHERE clause includes
 * `claims_count < max_claims` and `state = 'available'`. Under PostgreSQL's
 * READ COMMITTED isolation, when two transactions target the same row the
 * second one blocks on the first's row lock. When the first commits, the second
 * does NOT proceed blindly: it re-reads the updated row and re-evaluates its
 * WHERE clause against the new version (EvalPlanQual). For a one-time capsule
 * the first claim sets claims_count to 1, so the second transaction's
 * `claims_count < 1` predicate is now false, it matches zero rows, and it
 * reports 'consumed'.
 *
 * This is why the counter increment and the eligibility test must live in the
 * SAME statement. A read-then-write pair — SELECT to check, UPDATE to
 * increment — would leave a window where both transactions read count = 0 and
 * both proceed. That race is exercised by 100 concurrent claimants in
 * apps/api/test/integration/claim-race.test.ts.
 *
 * We take no advisory lock and no SELECT ... FOR UPDATE, because the row lock
 * that the UPDATE itself acquires is already the strongest guarantee available
 * and is held for the shortest possible time.
 */
export async function claimCapsule(
  capsuleId: string,
  claimWindowSecondsOverride?: number,
): Promise<ClaimSuccess | ClaimRejection> {
  return withTransaction(async (client) => {
    const { rows } = await client.query<{
      id: string;
      claims_count: number;
      max_claims: number;
      claim_window_seconds: number;
      encrypted_manifest_object_key: string;
      burn_mode: BurnMode;
    }>(
      `UPDATE capsules
          SET claims_count = claims_count + 1,
              claimed_at   = COALESCE(claimed_at, now()),
              state        = CASE
                               WHEN burn_mode <> 'time-only'
                                AND claims_count + 1 >= max_claims THEN 'consumed'::capsule_state
                               ELSE state
                             END
        WHERE id = $1
          AND state = 'available'
          AND claims_count < max_claims
          AND expires_at > now()
          AND (unlock_at IS NULL OR unlock_at <= now())
        RETURNING id, claims_count, max_claims, claim_window_seconds,
                  encrypted_manifest_object_key, burn_mode`,
      [capsuleId],
    );

    const row = rows[0];
    if (row === undefined) {
      // Nothing matched. Re-read to explain *why*, so the recipient sees an
      // honest reason rather than a generic failure. This read is outside the
      // race: the capsule is already un-claimable by every predicate.
      return { ok: false, reason: await explainClaimFailure(client, capsuleId) };
    }

    // §15: hand the winner a short lease rather than destroying immediately, so
    // a dropped connection does not obliterate content nobody read.
    const retrievalToken = generateToken();
    const leaseId = generateId();
    const windowSeconds = claimWindowSecondsOverride ?? row.claim_window_seconds;
    const leaseExpiresAt = new Date(Date.now() + windowSeconds * 1000);

    await client.query(
      `INSERT INTO retrieval_leases (id, capsule_id, token_hash, expires_at)
       VALUES ($1,$2,$3,$4)`,
      [leaseId, capsuleId, hashToken(retrievalToken), leaseExpiresAt],
    );
    await client.query(`INSERT INTO capsule_events (capsule_id, kind) VALUES ($1,'claimed')`, [capsuleId]);

    return {
      ok: true,
      retrievalToken,
      leaseId,
      leaseExpiresAt,
      manifestObjectKey: row.encrypted_manifest_object_key,
      claimsRemaining: Math.max(0, row.max_claims - row.claims_count),
    };
  });
}

async function explainClaimFailure(client: PoolClient, capsuleId: string): Promise<ClaimFailure> {
  const { rows } = await client.query<{
    state: CapsuleState;
    claims_count: number;
    max_claims: number;
    expires_at: Date;
    unlock_at: Date | null;
  }>(
    `SELECT state, claims_count, max_claims, expires_at, unlock_at FROM capsules WHERE id = $1`,
    [capsuleId],
  );
  const row = rows[0];
  if (row === undefined) return 'not-found';
  if (row.state === 'destroyed') return 'destroyed';
  if (row.state === 'revoked') return 'revoked';
  if (row.state === 'consumed') return 'consumed';
  if (row.expires_at.getTime() <= Date.now()) return 'expired';
  if (row.unlock_at !== null && row.unlock_at.getTime() > Date.now()) return 'locked';
  if (row.claims_count >= row.max_claims) return 'consumed';
  return 'consumed';
}

export interface LeaseContext {
  leaseId: string;
  capsuleId: string;
  manifestObjectKey: string;
}

/**
 * Resolve a retrieval bearer token to its lease.
 *
 * Looked up by token hash, so the token itself is never stored and a database
 * dump cannot be replayed against this endpoint.
 */
export async function resolveRetrievalLease(token: string): Promise<LeaseContext | null> {
  const { rows } = await getPool().query<{
    id: string;
    capsule_id: string;
    encrypted_manifest_object_key: string;
  }>(
    `SELECT l.id, l.capsule_id, c.encrypted_manifest_object_key
       FROM retrieval_leases l
       JOIN capsules c ON c.id = l.capsule_id
      WHERE l.token_hash = $1
        AND l.state = 'active'
        AND l.expires_at > now()
        AND c.state <> 'destroyed'`,
    [hashToken(token)],
  );
  const row = rows[0];
  if (row === undefined) return null;
  return {
    leaseId: row.id,
    capsuleId: row.capsule_id,
    manifestObjectKey: row.encrypted_manifest_object_key,
  };
}

/**
 * Mark retrieval complete. For burn-on-download this is what actually consumes
 * the capsule; the worker then purges the ciphertext.
 */
export async function completeRetrieval(leaseId: string): Promise<void> {
  await withTransaction(async (client) => {
    const { rows } = await client.query<{ capsule_id: string }>(
      `UPDATE retrieval_leases
          SET state = 'completed', completed_at = now()
        WHERE id = $1 AND state = 'active'
        RETURNING capsule_id`,
      [leaseId],
    );
    const row = rows[0];
    if (row === undefined) return;

    await client.query(`INSERT INTO capsule_events (capsule_id, kind) VALUES ($1,'retrieved')`, [row.capsule_id]);
    await client.query(
      `UPDATE capsules
          SET state = 'consumed'
        WHERE id = $1
          AND burn_mode <> 'time-only'
          AND claims_count >= max_claims
          AND state = 'available'`,
      [row.capsule_id],
    );
  });
}

/** Revoke immediately (§10 manual control). Idempotent. */
export async function revokeCapsule(capsuleId: string): Promise<boolean> {
  return withTransaction(async (client) => {
    const { rowCount } = await client.query(
      `UPDATE capsules
          SET state = 'revoked'
        WHERE id = $1 AND state IN ('available','consumed')`,
      [capsuleId],
    );
    if (rowCount === 0) return false;
    // Kill outstanding leases too: revoking must stop an in-flight download,
    // otherwise "revoke" would be advisory rather than effective.
    await client.query(
      `UPDATE retrieval_leases SET state = 'expired' WHERE capsule_id = $1 AND state = 'active'`,
      [capsuleId],
    );
    await client.query(`INSERT INTO capsule_events (capsule_id, kind) VALUES ($1,'revoked')`, [capsuleId]);
    return true;
  });
}

/**
 * Change expiry within policy (§10).
 *
 * Shortening is always allowed. Extending is allowed only before the first
 * claim and never beyond the deployment's maximum TTL — otherwise a management
 * link would let anyone turn an ephemeral service into permanent storage.
 */
export async function updateExpiry(
  capsuleId: string,
  newExpiresAt: Date,
  maxTtlMs: number,
): Promise<{ ok: true } | { ok: false; reason: 'not-found' | 'too-far' | 'already-claimed' | 'in-past' }> {
  if (newExpiresAt.getTime() <= Date.now()) return { ok: false, reason: 'in-past' };
  if (newExpiresAt.getTime() > Date.now() + maxTtlMs) return { ok: false, reason: 'too-far' };

  return withTransaction(async (client) => {
    const { rows } = await client.query<{ expires_at: Date; claims_count: number }>(
      `SELECT expires_at, claims_count FROM capsules WHERE id = $1 AND state = 'available' FOR UPDATE`,
      [capsuleId],
    );
    const row = rows[0];
    if (row === undefined) return { ok: false, reason: 'not-found' as const };

    const isExtension = newExpiresAt.getTime() > row.expires_at.getTime();
    if (isExtension && row.claims_count > 0) return { ok: false, reason: 'already-claimed' as const };

    await client.query(`UPDATE capsules SET expires_at = $2 WHERE id = $1`, [capsuleId, newExpiresAt]);
    return { ok: true as const };
  });
}

export interface ManagementView {
  status: CapsuleStatus;
  events: { kind: string; at: string }[];
}

/** Management view: state and a content-free timeline (§21). */
export async function getManagementView(capsuleId: string): Promise<ManagementView | null> {
  const pool = getPool();
  const { rows } = await pool.query<{
    id: string;
    state: CapsuleState;
    burn_mode: BurnMode;
    max_claims: number;
    claims_count: number;
    unlock_at: Date | null;
    expires_at: Date;
    total_cipher_bytes: string;
    created_at: Date;
    claimed_at: Date | null;
    object_count: string;
  }>(
    `SELECT c.*, (SELECT count(*) FROM capsule_objects o WHERE o.capsule_id = c.id) AS object_count
       FROM capsules c WHERE c.id = $1`,
    [capsuleId],
  );
  const row = rows[0];
  if (row === undefined) return null;

  const { rows: events } = await pool.query<{ kind: string; at: Date }>(
    `SELECT kind, at FROM capsule_events WHERE capsule_id = $1 ORDER BY at ASC, id ASC LIMIT 50`,
    [capsuleId],
  );

  const state: CapsuleState =
    row.state === 'available' && row.expires_at.getTime() <= Date.now() ? 'expired' : row.state;

  return {
    status: {
      id: row.id,
      state,
      burnMode: row.burn_mode,
      maxClaims: row.max_claims,
      claimsCount: row.claims_count,
      unlockAt: row.unlock_at,
      expiresAt: row.expires_at,
      totalCipherBytes: Number(row.total_cipher_bytes),
      objectCount: Number(row.object_count),
      createdAt: row.created_at,
      claimedAt: row.claimed_at,
    },
    events: events.map((event) => ({ kind: event.kind, at: event.at.toISOString() })),
  };
}

/** Look up a capsule by management token, in constant time w.r.t. the token. */
export async function findByManagementToken(capsuleId: string, token: string): Promise<boolean> {
  const { rows } = await getPool().query<{ ok: boolean }>(
    `SELECT (management_token_hash = $2) AS ok FROM capsules WHERE id = $1`,
    [capsuleId, hashToken(token)],
  );
  return rows[0]?.ok === true;
}
