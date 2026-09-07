/**
 * PostgreSQL access.
 *
 * PostgreSQL is the single source of truth for capsule state (§17). Redis is
 * used for rate limiting and short-lived coordination only — never as the
 * authority on whether a capsule may be claimed, because a Redis eviction or
 * restart would then be able to resurrect a consumed capsule.
 */

import pg from 'pg';
import { createHash, randomBytes as nodeRandomBytes, timingSafeEqual } from 'node:crypto';

export type Pool = pg.Pool;
export type PoolClient = pg.PoolClient;

let pool: pg.Pool | null = null;

export function getPool(connectionString = process.env.DATABASE_URL): pg.Pool {
  if (pool === null) {
    if (!connectionString) throw new Error('DATABASE_URL is not set');
    pool = new pg.Pool({
      connectionString,
      max: Number.parseInt(process.env.PG_POOL_MAX ?? '10', 10),
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
      // Fail a runaway query rather than pinning a connection forever.
      statement_timeout: 15_000,
    });
    pool.on('error', (error) => {
      // A pooled client can die between checkouts; log without crashing.
      // The message never contains capsule content — only connection state.
      console.error('[db] idle client error:', error.message);
    });
  }
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool !== null) {
    await pool.end();
    pool = null;
  }
}

/** Run `fn` inside a transaction, rolling back on any throw. */
export async function withTransaction<T>(
  fn: (client: pg.PoolClient) => Promise<T>,
  poolOverride?: pg.Pool,
): Promise<T> {
  const client = await (poolOverride ?? getPool()).connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // The connection is already broken; the pool will discard it.
    }
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Opaque bearer tokens (§16).
 *
 * 32 bytes from the OS CSPRNG. We store only SHA-256 of the token: a database
 * dump therefore does not let an attacker claim capsules or manage them.
 *
 * SHA-256 without a slow KDF is the right choice here specifically because
 * these are 256-bit random tokens, not passwords — there is no dictionary to
 * search, so iteration would buy nothing and cost latency on every request.
 */
export function generateToken(): string {
  return nodeRandomBytes(32).toString('base64url');
}

export function hashToken(token: string): Buffer {
  return createHash('sha256').update(token, 'utf8').digest();
}

/** Constant-time token comparison, to avoid leaking a prefix match by timing. */
export function tokenMatches(token: string, storedHash: Buffer): boolean {
  const candidate = hashToken(token);
  if (candidate.length !== storedHash.length) return false;
  return timingSafeEqual(candidate, storedHash);
}

/** Random identifier for server-side rows (objects, leases, uploads). */
export function generateId(bytes = 16): string {
  return nodeRandomBytes(bytes).toString('base64url');
}
