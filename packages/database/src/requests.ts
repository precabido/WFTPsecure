/**
 * Secure requests — "send me a file" in reverse (§8.4).
 *
 * The creator's X25519 public key is stored in the clear because it must be:
 * responders need it to seal their delivery, and a public key discloses nothing
 * about its private counterpart. The private key never reaches the server; it
 * lives only in the creator's management-link fragment.
 */

import { getPool, withTransaction, generateId, generateToken, hashToken } from './client.ts';

export type RequestState = 'open' | 'closed' | 'expired' | 'destroyed';

export interface SubmissionRecord {
  id: string;
  state: 'pending' | 'claimed' | 'destroyed';
  cipherBytes: number;
  createdAt: string;
  claimedAt: string | null;
}

export async function createSecureRequest(input: {
  id: string;
  version: string;
  publicKey: Buffer;
  encryptedPromptKey: string;
  maxSubmissions: number;
  expiresAt: Date;
  managementTokenHash: Buffer;
}): Promise<void> {
  await getPool().query(
    `INSERT INTO secure_requests
       (id, version, public_key, encrypted_prompt_key, max_submissions, expires_at, management_token_hash)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [
      input.id,
      input.version,
      input.publicKey,
      input.encryptedPromptKey,
      input.maxSubmissions,
      input.expiresAt,
      input.managementTokenHash,
    ],
  );
}

/** Public view a responder sees: the prompt location and the public key. */
export async function getRequestPublicStatus(requestId: string): Promise<{
  id: string;
  state: RequestState;
  publicKey: string;
  promptKey: string;
  submissionsRemaining: number;
  expiresAt: string;
} | null> {
  const { rows } = await getPool().query<{
    id: string;
    state: RequestState;
    public_key: Buffer;
    encrypted_prompt_key: string;
    max_submissions: number;
    submissions_count: number;
    expires_at: Date;
  }>(`SELECT * FROM secure_requests WHERE id = $1`, [requestId]);
  const row = rows[0];
  if (row === undefined) return null;

  const state: RequestState =
    row.state === 'open' && row.expires_at.getTime() <= Date.now() ? 'expired' : row.state;

  return {
    id: row.id,
    state,
    publicKey: row.public_key.toString('base64url'),
    promptKey: row.encrypted_prompt_key,
    submissionsRemaining: Math.max(0, row.max_submissions - row.submissions_count),
    expiresAt: row.expires_at.toISOString(),
  };
}

/**
 * Record a delivery.
 *
 * Uses the same single-statement conditional UPDATE pattern as the capsule
 * claim, for the same reason: two responders submitting at once must not be
 * able to push submissions_count past max_submissions.
 */
export async function addSubmission(input: {
  requestId: string;
  sealedKey: Buffer;
  encryptedManifestObjectKey: string;
  cipherBytes: number;
  objects: { id: string; storageKey: string; chunkCount: number; cipherBytes: number }[];
}): Promise<{ ok: true; submissionId: string } | { ok: false; reason: 'not-found' | 'closed' | 'full' }> {
  return withTransaction(async (client) => {
    const { rows } = await client.query<{ id: string }>(
      `UPDATE secure_requests
          SET submissions_count = submissions_count + 1
        WHERE id = $1
          AND state = 'open'
          AND submissions_count < max_submissions
          AND expires_at > now()
        RETURNING id`,
      [input.requestId],
    );
    if (rows[0] === undefined) {
      const { rows: probe } = await client.query<{ state: RequestState; full: boolean; expired: boolean }>(
        `SELECT state,
                submissions_count >= max_submissions AS full,
                expires_at <= now() AS expired
           FROM secure_requests WHERE id = $1`,
        [input.requestId],
      );
      const row = probe[0];
      if (row === undefined) return { ok: false as const, reason: 'not-found' as const };
      if (row.full) return { ok: false as const, reason: 'full' as const };
      return { ok: false as const, reason: 'closed' as const };
    }

    const submissionId = generateId();
    await client.query(
      `INSERT INTO request_submissions
         (id, request_id, sealed_key, encrypted_manifest_object_key, cipher_bytes)
       VALUES ($1,$2,$3,$4,$5)`,
      [submissionId, input.requestId, input.sealedKey, input.encryptedManifestObjectKey, input.cipherBytes],
    );
    for (const object of input.objects) {
      await client.query(
        `INSERT INTO submission_objects (id, submission_id, storage_key, chunk_count, cipher_bytes, state)
         VALUES ($1,$2,$3,$4,$5,'stored')`,
        [object.id, submissionId, object.storageKey, object.chunkCount, object.cipherBytes],
      );
    }
    await client.query(
      `UPDATE storage_accounting SET cipher_bytes = cipher_bytes + $1, updated_at = now() WHERE id = TRUE`,
      [input.cipherBytes],
    );
    return { ok: true as const, submissionId };
  });
}

export async function listSubmissions(requestId: string): Promise<SubmissionRecord[]> {
  const { rows } = await getPool().query<{
    id: string;
    state: SubmissionRecord['state'];
    cipher_bytes: string;
    created_at: Date;
    claimed_at: Date | null;
  }>(
    `SELECT id, state, cipher_bytes, created_at, claimed_at
       FROM request_submissions
      WHERE request_id = $1 AND state <> 'destroyed'
      ORDER BY created_at ASC`,
    [requestId],
  );
  return rows.map((r) => ({
    id: r.id,
    state: r.state,
    cipherBytes: Number(r.cipher_bytes),
    createdAt: r.created_at.toISOString(),
    claimedAt: r.claimed_at?.toISOString() ?? null,
  }));
}

/** Fetch a submission's sealed material so the creator can decrypt locally. */
export async function claimSubmission(
  requestId: string,
  submissionId: string,
): Promise<{ sealedKey: string; manifestKey: string; objectKeys: string[] } | null> {
  return withTransaction(async (client) => {
    const { rows } = await client.query<{
      sealed_key: Buffer;
      encrypted_manifest_object_key: string;
    }>(
      `UPDATE request_submissions
          SET state = 'claimed', claimed_at = COALESCE(claimed_at, now())
        WHERE id = $1 AND request_id = $2 AND state IN ('pending','claimed')
        RETURNING sealed_key, encrypted_manifest_object_key`,
      [submissionId, requestId],
    );
    const row = rows[0];
    if (row === undefined) return null;

    const { rows: objects } = await client.query<{ storage_key: string }>(
      `SELECT storage_key FROM submission_objects WHERE submission_id = $1`,
      [submissionId],
    );
    return {
      sealedKey: row.sealed_key.toString('base64url'),
      manifestKey: row.encrypted_manifest_object_key,
      objectKeys: objects.map((o) => o.storage_key),
    };
  });
}

export async function closeRequest(requestId: string): Promise<boolean> {
  const { rowCount } = await getPool().query(
    `UPDATE secure_requests SET state = 'closed', closed_at = now() WHERE id = $1 AND state = 'open'`,
    [requestId],
  );
  return (rowCount ?? 0) > 0;
}

export async function findRequestByManagementToken(requestId: string, token: string): Promise<boolean> {
  const { rows } = await getPool().query<{ ok: boolean }>(
    `SELECT (management_token_hash = $2) AS ok FROM secure_requests WHERE id = $1`,
    [requestId, hashToken(token)],
  );
  return rows[0]?.ok === true;
}

export { generateToken, generateId };
