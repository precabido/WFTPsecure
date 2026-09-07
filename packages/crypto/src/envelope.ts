/**
 * capsule-envelope-v1 — manifest sealing and key hierarchy (§12).
 *
 * Key hierarchy
 * -------------
 *   rootKey  (32 random bytes — the secret carried in the URL fragment)
 *     └─ manifestKey = crypto_kdf_derive_from_key(rootKey, id=1, ctx="cndrlnk1")
 *
 * Per-file keys are NOT derived from the root key: each file gets its own
 * independent random key which is stored *inside* the encrypted manifest. That
 * means possessing one file's key never reveals another's, and the manifest is
 * the single gate to the whole payload.
 *
 * Wire format for a sealed object
 * -------------------------------
 *   nonce (24 bytes) ‖ ciphertext‖tag (XChaCha20-Poly1305 IETF)
 *
 * The nonce is prepended rather than derived, because a random 192-bit nonce
 * makes reuse negligible without requiring the client to track a counter across
 * sessions.
 */

import { brand } from '@cinderlink/config/brand';
import { getSodium } from './sodium.ts';
import { manifestAad } from './aad.ts';
import { concatBytes, utf8 } from './bytes.ts';
import type { CapsuleManifest } from './types.ts';

/** libsodium KDF contexts are exactly 8 bytes. */
const KDF_CONTEXT = 'cndrlnk1';
const SUBKEY_MANIFEST = 1;

export const ROOT_KEY_BYTES = 32;

export type EnvelopeErrorCode =
  | 'bad-key'
  | 'tampered'
  | 'unsupported-version'
  | 'malformed'
  | 'too-large';

export class EnvelopeError extends Error {
  override readonly name = 'EnvelopeError';
  readonly code: EnvelopeErrorCode;

  constructor(message: string, code: EnvelopeErrorCode) {
    super(message);
    this.code = code;
  }
}

export async function generateRootKey(): Promise<Uint8Array> {
  const sodium = await getSodium();
  return sodium.randombytes_buf(ROOT_KEY_BYTES);
}

/** Derive the manifest encryption key from the root key. */
export async function deriveManifestKey(rootKey: Uint8Array): Promise<Uint8Array> {
  if (rootKey.length !== ROOT_KEY_BYTES) {
    throw new EnvelopeError(`root key must be ${ROOT_KEY_BYTES} bytes`, 'bad-key');
  }
  const sodium = await getSodium();
  return sodium.crypto_kdf_derive_from_key(32, SUBKEY_MANIFEST, KDF_CONTEXT, rootKey);
}

/**
 * Encrypt an arbitrary byte payload under `key`, bound to `aad`.
 * Returns nonce‖ciphertext.
 */
export async function sealBytes(
  plaintext: Uint8Array,
  key: Uint8Array,
  aad: Uint8Array,
): Promise<Uint8Array> {
  const sodium = await getSodium();
  const nonce = sodium.randombytes_buf(sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES);
  const ciphertext = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
    plaintext,
    aad,
    null,
    nonce,
    key,
  );
  return concatBytes(nonce, ciphertext);
}

/**
 * Decrypt nonce‖ciphertext produced by {@link sealBytes}.
 *
 * Any failure — wrong key, flipped bit, wrong AAD, truncation — surfaces as a
 * single 'tampered' error. We deliberately do not distinguish "wrong key" from
 * "modified ciphertext" here: Poly1305 cannot tell them apart, and pretending
 * otherwise would invite callers to build a false signal on top.
 */
export async function openBytes(
  sealed: Uint8Array,
  key: Uint8Array,
  aad: Uint8Array,
): Promise<Uint8Array> {
  const sodium = await getSodium();
  const nonceLength = sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES;
  if (sealed.length < nonceLength + sodium.crypto_aead_xchacha20poly1305_ietf_ABYTES) {
    throw new EnvelopeError('sealed payload is too short to be valid', 'malformed');
  }
  const nonce = sealed.subarray(0, nonceLength);
  const ciphertext = sealed.subarray(nonceLength);
  try {
    return sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(null, ciphertext, aad, nonce, key);
  } catch {
    throw new EnvelopeError(
      'authentication failed: wrong key, wrong context, or modified ciphertext',
      'tampered',
    );
  }
}

/**
 * Canonical manifest serialisation.
 *
 * JSON.stringify with an explicit key order would be ideal, but the manifest is
 * only ever produced and consumed by this package and is authenticated as an
 * opaque byte string — the AAD, not the byte order, is what binds meaning. We
 * therefore use plain JSON and document it as the v1 serialisation.
 */
export function serializeManifest(manifest: CapsuleManifest): Uint8Array {
  return utf8.encode(JSON.stringify(manifest));
}

export function deserializeManifest(bytes: Uint8Array): CapsuleManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(utf8.decode(bytes));
  } catch {
    throw new EnvelopeError('manifest is not valid UTF-8 JSON', 'malformed');
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new EnvelopeError('manifest is not an object', 'malformed');
  }
  const manifest = parsed as CapsuleManifest;
  if (manifest.v !== brand.envelopeVersion) {
    // Forward-compat: an older client meeting a newer envelope must refuse
    // rather than guess. The version is also in the AAD, so this check is a
    // friendly message, not the security boundary.
    throw new EnvelopeError(
      `unsupported envelope version: ${String(manifest.v)}`,
      'unsupported-version',
    );
  }
  return manifest;
}

/** Encrypt a manifest for `capsuleId` under `rootKey`. */
export async function sealManifest(
  manifest: CapsuleManifest,
  rootKey: Uint8Array,
  capsuleId: string,
): Promise<Uint8Array> {
  const manifestKey = await deriveManifestKey(rootKey);
  try {
    return await sealBytes(serializeManifest(manifest), manifestKey, manifestAad(capsuleId));
  } finally {
    (await getSodium()).memzero(manifestKey);
  }
}

/** Decrypt and validate a manifest sealed for `capsuleId`. */
export async function openManifest(
  sealed: Uint8Array,
  rootKey: Uint8Array,
  capsuleId: string,
): Promise<CapsuleManifest> {
  const manifestKey = await deriveManifestKey(rootKey);
  try {
    const plaintext = await openBytes(sealed, manifestKey, manifestAad(capsuleId));
    return deserializeManifest(plaintext);
  } finally {
    (await getSodium()).memzero(manifestKey);
  }
}
