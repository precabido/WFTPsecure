/**
 * Byte / base64url helpers and best-effort secret hygiene.
 *
 * `wipe()` is deliberately named "best effort": libsodium's memzero clears the
 * bytes we hand it, but JavaScript gives no way to reach copies the engine may
 * have made (string interning, GC-moved buffers, JIT spill slots). This is
 * documented as a limitation rather than sold as a guarantee (§12, §35).
 */

import { getSodium } from './sodium.ts';

export const utf8 = {
  encode: (value: string): Uint8Array => new TextEncoder().encode(value),
  decode: (bytes: Uint8Array): string => new TextDecoder('utf-8', { fatal: true }).decode(bytes),
};

export async function toBase64Url(bytes: Uint8Array): Promise<string> {
  const sodium = await getSodium();
  return sodium.to_base64(bytes, sodium.base64_variants.URLSAFE_NO_PADDING);
}

export async function fromBase64Url(value: string): Promise<Uint8Array> {
  const sodium = await getSodium();
  return sodium.from_base64(value, sodium.base64_variants.URLSAFE_NO_PADDING);
}

/**
 * Maximum request size for {@link randomBytes}.
 *
 * libsodium-wrappers' randombytes_buf is dramatically slower than a native
 * CSPRNG for bulk output — measured at ~0.3 MiB/s here, so 5 MiB takes about
 * 15 seconds and would block the thread. Every legitimate caller in this
 * codebase asks for key- or id-sized buffers (16–32 bytes), so we cap the
 * request rather than let a future caller silently freeze a browser tab.
 * Bulk random data (test fixtures, padding) must come from the platform CSPRNG.
 */
const MAX_RANDOM_BYTES = 1024;

export async function randomBytes(length: number): Promise<Uint8Array> {
  if (!Number.isInteger(length) || length < 1 || length > MAX_RANDOM_BYTES) {
    throw new RangeError(
      `randomBytes supports 1..${MAX_RANDOM_BYTES} bytes (requested ${length}); ` +
        'use the platform CSPRNG for bulk random data',
    );
  }
  const sodium = await getSodium();
  return sodium.randombytes_buf(length);
}

/**
 * Generate an opaque, high-entropy identifier (§12: server stores only random
 * ids; §25: enumeration resistance comes from this entropy).
 *
 * Ids are generated client-side so that the encrypted manifest's AAD can bind
 * the real capsule id at encryption time, without a server round-trip that
 * would otherwise be needed to learn it.
 */
export async function randomId(bytes = 16): Promise<string> {
  return toBase64Url(await randomBytes(bytes));
}

/** Best-effort scrub of key material. See caveat in the file header. */
export async function wipe(...buffers: (Uint8Array | null | undefined)[]): Promise<void> {
  const sodium = await getSodium();
  for (const buffer of buffers) {
    if (buffer && buffer.length > 0) sodium.memzero(buffer);
  }
}

/** Concatenate byte arrays into a single fresh buffer. */
export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** Constant-time comparison, for comparing digests/fingerprints. */
export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= (a[i] as number) ^ (b[i] as number);
  return diff === 0;
}
