/**
 * Rate limiting with pseudonymised client identity (§18).
 *
 * The tension: abuse control needs to recognise a repeat caller, but storing
 * IP addresses would build exactly the metadata trail this product promises not
 * to keep. The compromise:
 *
 *   key = HMAC-SHA256(rotating_secret, client_ip)  truncated to 16 bytes
 *
 * The server still *sees* the IP at the network layer — that is unavoidable and
 * is stated plainly in docs/privacy-model.md rather than hidden behind a "zero
 * metadata" claim. What it does not do is persist it: only the HMAC lands in
 * Redis, the secret rotates, and after rotation yesterday's counters cannot be
 * re-linked to an address even with the raw IP in hand.
 */

import { createHmac, randomBytes } from 'node:crypto';
import type Redis from 'ioredis';

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetSeconds: number;
}

export class RateLimiter {
  readonly #redis: Redis;
  readonly #secret: Buffer;
  readonly #rotationSeconds: number;

  constructor(redis: Redis, secret?: string, rotationSeconds = 86_400) {
    this.#redis = redis;
    // A missing secret must not silently degrade to an empty key: generate a
    // process-local one so identities are still pseudonymous, just not stable
    // across restarts.
    this.#secret = Buffer.from(secret ?? randomBytes(32).toString('hex'), 'utf8');
    this.#rotationSeconds = rotationSeconds;
  }

  /**
   * Derive the pseudonymous bucket for a client.
   *
   * The rotation epoch is mixed into the HMAC input, so keys change wholesale
   * when the window turns over without needing to re-key Redis.
   */
  identify(clientIp: string): string {
    const epoch = Math.floor(Date.now() / 1000 / this.#rotationSeconds);
    return createHmac('sha256', this.#secret)
      .update(`${epoch}:${clientIp}`)
      .digest('base64url')
      .slice(0, 22);
  }

  /**
   * Fixed-window counter.
   *
   * INCR then conditional EXPIRE, pipelined: the first increment in a window
   * sets the TTL. A fixed window can allow up to 2x the limit across a boundary;
   * that is an accepted trade for the preview, where the limits exist to stop
   * bulk abuse rather than to meter a paid API.
   */
  async consume(bucket: string, identity: string, limit: number, windowSeconds: number): Promise<RateLimitResult> {
    const key = `rl:${bucket}:${identity}`;
    const pipeline = this.#redis.multi();
    pipeline.incr(key);
    pipeline.ttl(key);
    const results = await pipeline.exec();

    const count = Number(results?.[0]?.[1] ?? 1);
    let ttl = Number(results?.[1]?.[1] ?? -1);
    if (ttl < 0) {
      await this.#redis.expire(key, windowSeconds);
      ttl = windowSeconds;
    }

    return {
      allowed: count <= limit,
      remaining: Math.max(0, limit - count),
      resetSeconds: ttl,
    };
  }

  /** Track concurrent uploads so one client cannot monopolise the store. */
  async acquireSlot(identity: string, limit: number, ttlSeconds: number): Promise<boolean> {
    const key = `slots:${identity}`;
    const count = await this.#redis.incr(key);
    await this.#redis.expire(key, ttlSeconds);
    if (count > limit) {
      await this.#redis.decr(key);
      return false;
    }
    return true;
  }

  async releaseSlot(identity: string): Promise<void> {
    const key = `slots:${identity}`;
    const value = await this.#redis.decr(key);
    if (value < 0) await this.#redis.set(key, '0');
  }
}

/**
 * Determine the client address.
 *
 * Only trusts X-Forwarded-For when TRUST_PROXY is set, because the gateway is
 * the sole legitimate source of that header. Without the guard any client could
 * forge it and evade every limit here by rotating a header value.
 */
export function clientAddress(
  headers: Record<string, string | string[] | undefined>,
  socketAddress: string | undefined,
  trustProxy: boolean,
): string {
  if (trustProxy) {
    const forwarded = headers['x-forwarded-for'];
    const raw = Array.isArray(forwarded) ? forwarded[0] : forwarded;
    const first = raw?.split(',')[0]?.trim();
    if (first) return first;
  }
  return socketAddress ?? 'unknown';
}
