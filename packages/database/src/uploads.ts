/**
 * Chunked upload sessions (§13).
 *
 * The invariant this file protects: an incomplete upload must never produce a
 * usable capsule. Chunks accumulate against a session; only when every expected
 * index has landed does completeUpload flip the session to 'completed', and
 * only a completed session may be referenced when the capsule row is created.
 */

import type { PoolClient } from 'pg';
import { getPool, withTransaction, generateId, generateToken, hashToken } from './client.ts';

export interface UploadSession {
  uploadId: string;
  uploadToken: string;
  objectId: string;
  storageKey: string;
  expiresAt: Date;
}

export interface UploadStatus {
  uploadId: string;
  state: 'open' | 'completed' | 'aborted' | 'expired';
  expectedChunks: number;
  receivedChunks: number;
  /** Indices already stored — lets a resuming client skip finished work. */
  receivedIndices: number[];
  cipherBytes: number;
  expiresAt: Date;
}

export async function createUploadSession(input: {
  capsuleId: string;
  expectedChunks: number;
  ttlSeconds: number;
}): Promise<UploadSession> {
  const uploadId = generateId();
  const uploadToken = generateToken();
  const objectId = generateId(12);
  // Storage keys are random and carry no filename (§14): anyone who can list
  // the object store learns nothing about what the files are.
  const storageKey = `objects/${generateId(24)}`;
  const expiresAt = new Date(Date.now() + input.ttlSeconds * 1000);

  await getPool().query(
    `INSERT INTO upload_sessions (id, token_hash, capsule_id, object_id, storage_key, expected_chunks, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [uploadId, hashToken(uploadToken), input.capsuleId, objectId, storageKey, input.expectedChunks, expiresAt],
  );

  return { uploadId, uploadToken, objectId, storageKey, expiresAt };
}

/** Resolve an upload bearer token; returns null if wrong, expired or closed. */
export async function authorizeUpload(
  uploadId: string,
  token: string,
): Promise<{ storageKey: string; expectedChunks: number; capsuleId: string; objectId: string } | null> {
  const { rows } = await getPool().query<{
    storage_key: string;
    expected_chunks: number;
    capsule_id: string;
    object_id: string;
  }>(
    `SELECT storage_key, expected_chunks, capsule_id, object_id
       FROM upload_sessions
      WHERE id = $1 AND token_hash = $2 AND state = 'open' AND expires_at > now()`,
    [uploadId, hashToken(token)],
  );
  const row = rows[0];
  if (row === undefined) return null;
  return {
    storageKey: row.storage_key,
    expectedChunks: row.expected_chunks,
    capsuleId: row.capsule_id,
    objectId: row.object_id,
  };
}

/**
 * Record that a chunk landed.
 *
 * ON CONFLICT DO NOTHING makes re-uploading the same index a no-op rather than
 * an error or a double-count. That is what makes resume safe: a client that
 * loses its connection mid-PUT may legitimately retry an index it already sent.
 */
export async function recordChunk(
  uploadId: string,
  chunkIndex: number,
  cipherBytes: number,
): Promise<{ accepted: boolean; duplicate: boolean }> {
  return withTransaction(async (client: PoolClient) => {
    const { rowCount } = await client.query(
      `INSERT INTO upload_chunks (upload_id, chunk_index, cipher_bytes)
       VALUES ($1,$2,$3)
       ON CONFLICT (upload_id, chunk_index) DO NOTHING`,
      [uploadId, chunkIndex, cipherBytes],
    );
    if (rowCount === 0) return { accepted: true, duplicate: true };

    await client.query(
      `UPDATE upload_sessions
          SET received_chunks = received_chunks + 1,
              cipher_bytes    = cipher_bytes + $2
        WHERE id = $1`,
      [uploadId, cipherBytes],
    );
    return { accepted: true, duplicate: false };
  });
}

export async function getUploadStatus(uploadId: string): Promise<UploadStatus | null> {
  const pool = getPool();
  const { rows } = await pool.query<{
    id: string;
    state: UploadStatus['state'];
    expected_chunks: number;
    received_chunks: number;
    cipher_bytes: string;
    expires_at: Date;
  }>(`SELECT id, state, expected_chunks, received_chunks, cipher_bytes, expires_at FROM upload_sessions WHERE id = $1`, [
    uploadId,
  ]);
  const row = rows[0];
  if (row === undefined) return null;

  const { rows: chunks } = await pool.query<{ chunk_index: number }>(
    `SELECT chunk_index FROM upload_chunks WHERE upload_id = $1 ORDER BY chunk_index`,
    [uploadId],
  );

  return {
    uploadId: row.id,
    state: row.state === 'open' && row.expires_at.getTime() <= Date.now() ? 'expired' : row.state,
    expectedChunks: row.expected_chunks,
    receivedChunks: row.received_chunks,
    receivedIndices: chunks.map((c) => c.chunk_index),
    cipherBytes: Number(row.cipher_bytes),
    expiresAt: row.expires_at,
  };
}

/**
 * Close an upload once every chunk has arrived.
 *
 * The completeness check counts DISTINCT indices in [0, expected) rather than
 * trusting received_chunks, so a bug in the counter cannot let a hole through.
 */
export async function completeUpload(
  uploadId: string,
): Promise<
  | { ok: true; objectId: string; storageKey: string; chunkCount: number; cipherBytes: number }
  | { ok: false; reason: 'not-found' | 'incomplete' | 'closed' }
> {
  return withTransaction(async (client) => {
    const { rows } = await client.query<{
      state: string;
      object_id: string;
      storage_key: string;
      expected_chunks: number;
      cipher_bytes: string;
    }>(
      `SELECT state, object_id, storage_key, expected_chunks, cipher_bytes
         FROM upload_sessions WHERE id = $1 FOR UPDATE`,
      [uploadId],
    );
    const row = rows[0];
    if (row === undefined) return { ok: false as const, reason: 'not-found' as const };
    if (row.state !== 'open') return { ok: false as const, reason: 'closed' as const };

    const { rows: countRows } = await client.query<{ present: string }>(
      `SELECT count(DISTINCT chunk_index) AS present
         FROM upload_chunks
        WHERE upload_id = $1 AND chunk_index >= 0 AND chunk_index < $2`,
      [uploadId, row.expected_chunks],
    );
    if (Number(countRows[0]?.present ?? 0) !== row.expected_chunks) {
      return { ok: false as const, reason: 'incomplete' as const };
    }

    await client.query(`UPDATE upload_sessions SET state = 'completed' WHERE id = $1`, [uploadId]);
    return {
      ok: true as const,
      objectId: row.object_id,
      storageKey: row.storage_key,
      chunkCount: row.expected_chunks,
      cipherBytes: Number(row.cipher_bytes),
    };
  });
}

export async function abortUpload(uploadId: string): Promise<void> {
  await getPool().query(`UPDATE upload_sessions SET state = 'aborted' WHERE id = $1 AND state = 'open'`, [uploadId]);
}

/** All completed uploads for a capsule, used when assembling the capsule row. */
export async function listCompletedUploads(
  capsuleId: string,
): Promise<{ objectId: string; storageKey: string; chunkCount: number; cipherBytes: number }[]> {
  const { rows } = await getPool().query<{
    object_id: string;
    storage_key: string;
    expected_chunks: number;
    cipher_bytes: string;
  }>(
    `SELECT object_id, storage_key, expected_chunks, cipher_bytes
       FROM upload_sessions
      WHERE capsule_id = $1 AND state = 'completed'`,
    [capsuleId],
  );
  return rows.map((r) => ({
    objectId: r.object_id,
    storageKey: r.storage_key,
    chunkCount: r.expected_chunks,
    cipherBytes: Number(r.cipher_bytes),
  }));
}
