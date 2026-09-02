/**
 * Expiry, purge and reconciliation queries (§19).
 *
 * ORDERING RULE, and the reason for it: metadata is only removed AFTER its
 * blobs are gone. If we deleted the capsule row first and then crashed, the
 * blobs would become orphans that nothing points at — undeletable except by a
 * full-store scan, and silently retained forever. So the worker's sequence is
 * always: mark destroyed -> delete blobs -> delete rows. A crash at any point
 * leaves work that the next sweep can finish, because every step is idempotent.
 */

import { getPool, withTransaction } from './client.ts';

export interface SweepReport {
  expiredCapsules: number;
  destroyedCapsules: number;
  expiredLeases: number;
  staleUploads: number;
  purgedRows: number;
  orphanObjects: number;
}

/** Mark capsules past their expiry. Their blobs are purged in a later step. */
export async function sweepExpiredCapsules(): Promise<string[]> {
  const { rows } = await getPool().query<{ id: string }>(
    `UPDATE capsules
        SET state = 'expired'
      WHERE state = 'available' AND expires_at <= now()
      RETURNING id`,
  );
  if (rows.length > 0) {
    await getPool().query(
      `INSERT INTO capsule_events (capsule_id, kind)
       SELECT unnest($1::text[]), 'expired'`,
      [rows.map((r) => r.id)],
    );
  }
  return rows.map((r) => r.id);
}

/** Expire retrieval leases whose window closed (§15 step 9). */
export async function sweepExpiredLeases(): Promise<number> {
  const { rowCount } = await getPool().query(
    `UPDATE retrieval_leases SET state = 'expired' WHERE state = 'active' AND expires_at <= now()`,
  );
  return rowCount ?? 0;
}

/** Abandon upload sessions that were never completed (§13). */
export async function sweepStaleUploads(): Promise<{ id: string; storageKey: string }[]> {
  const { rows } = await getPool().query<{ id: string; storage_key: string }>(
    `UPDATE upload_sessions
        SET state = 'expired'
      WHERE state = 'open' AND expires_at <= now()
      RETURNING id, storage_key`,
  );
  return rows.map((r) => ({ id: r.id, storageKey: r.storage_key }));
}

/**
 * Capsules whose ciphertext should now be deleted.
 *
 * A capsule is purgeable once it is expired, revoked, or consumed with no
 * active lease still running. The lease check is what stops us destroying a
 * payload out from under a recipient who is mid-download (§15).
 */
export async function findPurgeableCapsules(limit = 100): Promise<
  { id: string; manifestKey: string; objectKeys: string[]; cipherBytes: number }[]
> {
  const { rows } = await getPool().query<{
    id: string;
    encrypted_manifest_object_key: string;
    total_cipher_bytes: string;
    object_keys: string[] | null;
  }>(
    `SELECT c.id,
            c.encrypted_manifest_object_key,
            c.total_cipher_bytes,
            array_remove(array_agg(o.storage_key), NULL) AS object_keys
       FROM capsules c
       LEFT JOIN capsule_objects o ON o.capsule_id = c.id
      WHERE c.state IN ('expired','revoked','consumed')
        AND NOT EXISTS (
              SELECT 1 FROM retrieval_leases l
               WHERE l.capsule_id = c.id AND l.state = 'active' AND l.expires_at > now()
            )
      GROUP BY c.id
      LIMIT $1`,
    [limit],
  );
  return rows.map((r) => ({
    id: r.id,
    manifestKey: r.encrypted_manifest_object_key,
    objectKeys: r.object_keys ?? [],
    cipherBytes: Number(r.total_cipher_bytes),
  }));
}

/**
 * Record that a capsule's ciphertext is gone.
 *
 * Called only after the blobs have actually been deleted. The row is kept as a
 * tombstone with state='destroyed' so that a later request for the same id
 * answers "no longer available" rather than "never existed" — and so a
 * re-created id cannot collide with a live one.
 */
export async function markCapsuleDestroyed(capsuleId: string, freedBytes: number): Promise<void> {
  await withTransaction(async (client) => {
    await client.query(
      `UPDATE capsules
          SET state = 'destroyed', destroyed_at = now(), total_cipher_bytes = 0
        WHERE id = $1 AND state <> 'destroyed'`,
      [capsuleId],
    );
    await client.query(`DELETE FROM capsule_objects WHERE capsule_id = $1`, [capsuleId]);
    await client.query(`INSERT INTO capsule_events (capsule_id, kind) VALUES ($1,'destroyed')`, [capsuleId]);
    await client.query(
      `UPDATE storage_accounting
          SET cipher_bytes = GREATEST(0, cipher_bytes - $1), updated_at = now()
        WHERE id = TRUE`,
      [freedBytes],
    );
  });
}

/**
 * Drop tombstones and their event history once the retention window passes.
 * Keeping them briefly gives honest "already consumed" answers; keeping them
 * forever would be a metadata archive we promised not to build.
 */
export async function purgeDestroyedCapsules(retentionHours: number): Promise<number> {
  const { rowCount } = await getPool().query(
    `DELETE FROM capsules
      WHERE state = 'destroyed'
        AND destroyed_at IS NOT NULL
        AND destroyed_at < now() - ($1 || ' hours')::interval`,
    [String(retentionHours)],
  );
  await getPool().query(
    `DELETE FROM capsule_events
      WHERE capsule_id NOT IN (SELECT id FROM capsules)`,
  );
  return rowCount ?? 0;
}

/**
 * Reconcile object storage against the database (§19).
 *
 * Returns keys present in the store that no live row references. The worker
 * deletes them. This catches the crash-between-steps case in either direction.
 */
export async function findReferencedStorageKeys(): Promise<Set<string>> {
  const pool = getPool();
  const referenced = new Set<string>();
  const queries = [
    `SELECT encrypted_manifest_object_key AS k FROM capsules WHERE state <> 'destroyed'`,
    `SELECT storage_key AS k FROM capsule_objects`,
    `SELECT storage_key AS k FROM upload_sessions WHERE state IN ('open','completed')`,
    `SELECT encrypted_manifest_object_key AS k FROM request_submissions WHERE state <> 'destroyed'`,
    `SELECT storage_key AS k FROM submission_objects`,
    `SELECT encrypted_prompt_key AS k FROM secure_requests WHERE state <> 'destroyed'`,
  ];
  for (const sql of queries) {
    const { rows } = await pool.query<{ k: string }>(sql);
    for (const row of rows) referenced.add(row.k);
  }
  return referenced;
}

export async function reconcileOrphans(storedKeys: string[]): Promise<string[]> {
  const referenced = await findReferencedStorageKeys();
  // A stored key is "objects/<id>/c3"; the reference is "objects/<id>".
  return storedKeys.filter((key) => {
    if (referenced.has(key)) return false;
    const parent = key.replace(/\/c\d+$/, '');
    return !referenced.has(parent);
  });
}

export async function getStorageUsage(): Promise<number> {
  const { rows } = await getPool().query<{ cipher_bytes: string }>(
    `SELECT cipher_bytes FROM storage_accounting WHERE id = TRUE`,
  );
  return Number(rows[0]?.cipher_bytes ?? 0);
}

/** Expire secure requests past their deadline. */
export async function sweepExpiredRequests(): Promise<number> {
  const { rowCount } = await getPool().query(
    `UPDATE secure_requests SET state = 'expired' WHERE state = 'open' AND expires_at <= now()`,
  );
  return rowCount ?? 0;
}

/** Submissions belonging to closed/expired requests, or already claimed. */
export async function findPurgeableSubmissions(limit = 100): Promise<
  { id: string; manifestKey: string; objectKeys: string[]; cipherBytes: number }[]
> {
  const { rows } = await getPool().query<{
    id: string;
    encrypted_manifest_object_key: string;
    cipher_bytes: string;
    object_keys: string[] | null;
  }>(
    `SELECT s.id, s.encrypted_manifest_object_key, s.cipher_bytes,
            array_remove(array_agg(o.storage_key), NULL) AS object_keys
       FROM request_submissions s
       LEFT JOIN submission_objects o ON o.submission_id = s.id
       JOIN secure_requests r ON r.id = s.request_id
      WHERE s.state <> 'destroyed'
        AND (s.state = 'claimed' OR r.state IN ('closed','expired','destroyed'))
      GROUP BY s.id
      LIMIT $1`,
    [limit],
  );
  return rows.map((r) => ({
    id: r.id,
    manifestKey: r.encrypted_manifest_object_key,
    objectKeys: r.object_keys ?? [],
    cipherBytes: Number(r.cipher_bytes),
  }));
}

export async function markSubmissionDestroyed(submissionId: string, freedBytes: number): Promise<void> {
  await withTransaction(async (client) => {
    await client.query(
      `UPDATE request_submissions SET state = 'destroyed', destroyed_at = now(), cipher_bytes = 0 WHERE id = $1`,
      [submissionId],
    );
    await client.query(`DELETE FROM submission_objects WHERE submission_id = $1`, [submissionId]);
    await client.query(
      `UPDATE storage_accounting SET cipher_bytes = GREATEST(0, cipher_bytes - $1), updated_at = now() WHERE id = TRUE`,
      [freedBytes],
    );
  });
}
