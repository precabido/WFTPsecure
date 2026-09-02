/**
 * Shared test helpers.
 *
 * Bulk random data comes from the platform CSPRNG rather than libsodium's
 * randombytes_buf, which is ~0.3 MiB/s in the wrappers build (a 5 MiB fixture
 * took 15 s before this helper existed). Fixtures are test data, not key
 * material, so webcrypto is both correct and three orders of magnitude faster.
 */

/** Fill a buffer with cryptographically random bytes, quickly. */
export function bulkRandomBytes(length: number): Uint8Array {
  const out = new Uint8Array(length);
  // webcrypto caps a single getRandomValues call at 65536 bytes.
  const MAX = 65536;
  for (let offset = 0; offset < length; offset += MAX) {
    crypto.getRandomValues(out.subarray(offset, Math.min(offset + MAX, length)));
  }
  return out;
}

/** Deterministic pseudo-random fill, for fixtures that must be reproducible. */
export function seededBytes(length: number, seed = 1): Uint8Array {
  const out = new Uint8Array(length);
  // xorshift32 — fast, adequate for non-security test payloads.
  let state = seed >>> 0 || 1;
  for (let i = 0; i < length; i += 1) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    out[i] = state & 0xff;
  }
  return out;
}

/** Await a condition, polling until it holds or the deadline passes. */
export async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  { timeoutMs = 5000, intervalMs = 25, label = 'condition' } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
