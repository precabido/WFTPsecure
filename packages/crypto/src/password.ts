/**
 * Password protection via Argon2id key wrapping (§11).
 *
 * The password never leaves the browser and is never sent to the server in any
 * form — not the password, not a hash of it, not a verifier. Instead:
 *
 *   1. Content is encrypted under a random rootKey (independent of the password).
 *   2. A KEK is derived from the password with Argon2id + a random salt.
 *   3. The rootKey is *wrapped* (AEAD-encrypted) under the KEK.
 *   4. The wrapped key, salt and KDF parameters travel in the URL fragment.
 *
 * Consequences worth being explicit about:
 *   - Validation is local: unwrapping either authenticates or it doesn't, so a
 *     wrong password is detected before the capsule is consumed (§11).
 *   - Because the wrapped key is in the fragment, anyone who intercepts the
 *     *link* can mount an offline guessing attack. Argon2id raises the cost per
 *     guess, but a weak password is still a weak password — this is stated in
 *     docs/known-limitations.md rather than hidden.
 *   - Parameters are stored per capsule, so raising defaults later does not
 *     break existing links.
 */

import { getSodium } from './sodium.ts';
import { rootKeyWrapAad } from './aad.ts';
import { sealBytes, openBytes, EnvelopeError, ROOT_KEY_BYTES } from './envelope.ts';

export interface KdfParams {
  /** Only 'argon2id13' is defined for envelope v1. */
  alg: 'argon2id13';
  /** Iteration count (libsodium opslimit). */
  ops: number;
  /** Memory in bytes (libsodium memlimit). */
  mem: number;
}

/**
 * Default KDF profile.
 *
 * Memory is pinned at 64 MiB rather than libsodium's MODERATE 256 MiB because
 * mobile Safari will fail the WASM allocation well below that, and a capsule
 * that cannot be opened on a phone is worse than one that is slightly cheaper
 * to attack. Iterations are raised to 4 to buy back margin. Measured cost is
 * recorded in docs/crypto-format.md.
 */
export const DEFAULT_KDF: KdfParams = {
  alg: 'argon2id13',
  ops: 4,
  mem: 64 * 1024 * 1024,
};

/** Reject absurd parameters from a hostile link before allocating memory. */
const MAX_OPS = 16;
const MAX_MEM = 512 * 1024 * 1024;

export interface WrappedRootKey {
  /** nonce‖ciphertext of the root key under the password-derived KEK. */
  wrapped: Uint8Array;
  salt: Uint8Array;
  kdf: KdfParams;
}

export class PasswordError extends Error {
  override readonly name = 'PasswordError';
  constructor(
    message: string,
    readonly code: 'wrong-password' | 'bad-params',
  ) {
    super(message);
  }
}

async function deriveKek(
  password: string,
  salt: Uint8Array,
  kdf: KdfParams,
): Promise<Uint8Array> {
  const sodium = await getSodium();
  if (kdf.alg !== 'argon2id13') {
    throw new PasswordError(`unsupported KDF: ${String(kdf.alg)}`, 'bad-params');
  }
  if (!Number.isInteger(kdf.ops) || kdf.ops < 1 || kdf.ops > MAX_OPS) {
    throw new PasswordError('KDF ops out of accepted range', 'bad-params');
  }
  if (!Number.isInteger(kdf.mem) || kdf.mem < 8 * 1024 * 1024 || kdf.mem > MAX_MEM) {
    throw new PasswordError('KDF memory out of accepted range', 'bad-params');
  }
  if (salt.length !== sodium.crypto_pwhash_SALTBYTES) {
    throw new PasswordError('salt has wrong length', 'bad-params');
  }
  return sodium.crypto_pwhash(
    32,
    password,
    salt,
    kdf.ops,
    kdf.mem,
    sodium.crypto_pwhash_ALG_ARGON2ID13,
  );
}

/** Wrap `rootKey` so it can only be recovered with `password`. */
export async function wrapRootKey(
  rootKey: Uint8Array,
  password: string,
  capsuleId: string,
  kdf: KdfParams = DEFAULT_KDF,
): Promise<WrappedRootKey> {
  if (rootKey.length !== ROOT_KEY_BYTES) {
    throw new EnvelopeError('root key has wrong length', 'bad-key');
  }
  const sodium = await getSodium();
  const salt = sodium.randombytes_buf(sodium.crypto_pwhash_SALTBYTES);
  const kek = await deriveKek(password, salt, kdf);
  try {
    const wrapped = await sealBytes(rootKey, kek, rootKeyWrapAad(capsuleId));
    return { wrapped, salt, kdf };
  } finally {
    sodium.memzero(kek);
  }
}

/**
 * Recover the root key from a password.
 *
 * Throws PasswordError('wrong-password') on failure. This is a *local* check:
 * no network round-trip happens, so a wrong password costs the attacker one
 * Argon2id evaluation and costs the capsule nothing (§11 — validate before
 * consuming).
 */
export async function unwrapRootKey(
  wrappedKey: WrappedRootKey,
  password: string,
  capsuleId: string,
): Promise<Uint8Array> {
  const sodium = await getSodium();
  const kek = await deriveKek(password, wrappedKey.salt, wrappedKey.kdf);
  try {
    return await openBytes(wrappedKey.wrapped, kek, rootKeyWrapAad(capsuleId));
  } catch {
    throw new PasswordError('incorrect password', 'wrong-password');
  } finally {
    sodium.memzero(kek);
  }
}

/**
 * Offline password strength estimate for the creation UI.
 *
 * Deliberately crude and honest: it scores length and character-class variety
 * and it never leaves the browser. It is guidance for humans, not a security
 * control, and the UI must not present it as one.
 */
export function estimatePasswordStrength(password: string): {
  score: 0 | 1 | 2 | 3 | 4;
  label: 'very-weak' | 'weak' | 'fair' | 'strong' | 'very-strong';
} {
  const length = password.length;
  let classes = 0;
  if (/[a-z]/.test(password)) classes += 1;
  if (/[A-Z]/.test(password)) classes += 1;
  if (/[0-9]/.test(password)) classes += 1;
  if (/[^A-Za-z0-9]/.test(password)) classes += 1;
  // Multi-word passphrases beat short mixed-class passwords; weight length.
  const bits = length * (classes >= 3 ? 3.2 : classes === 2 ? 2.6 : 2.0);
  const score = bits >= 90 ? 4 : bits >= 70 ? 3 : bits >= 50 ? 2 : bits >= 32 ? 1 : 0;
  const labels = ['very-weak', 'weak', 'fair', 'strong', 'very-strong'] as const;
  return { score: score as 0 | 1 | 2 | 3 | 4, label: labels[score] as never };
}
