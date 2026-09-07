/**
 * Secure requests — anonymous sealed delivery (§8.4).
 *
 * The creator asks someone for a file. The responder has no account and holds
 * no shared secret, so symmetric encryption is not available: whatever key the
 * responder used would have to reach the creator somehow.
 *
 * libsodium's sealed boxes solve exactly this. The creator publishes an X25519
 * *public* key in the request link. The responder's browser generates an
 * ephemeral keypair, derives a shared secret against the creator's public key,
 * encrypts, and discards its own secret key. The result:
 *
 *   - Only the creator's secret key can open the delivery.
 *   - The responder cannot decrypt their own submission after sending it.
 *   - The server sees ciphertext and an ephemeral public key, nothing more.
 *
 * The creator's secret key lives only in their management link fragment. If
 * they lose it, deliveries are unrecoverable — stated plainly in the UI rather
 * than papered over with a "recovery" that would require escrowing the key.
 */

import { getSodium } from './sodium.ts';
import { submissionAad } from './aad.ts';
import { sealBytes, openBytes, EnvelopeError } from './envelope.ts';
import { utf8 } from './bytes.ts';
import { brand } from '@cinderlink/config/brand';
import type { SubmissionManifest } from './types.ts';

export interface RequestKeypair {
  publicKey: Uint8Array;
  secretKey: Uint8Array;
}

export async function generateRequestKeypair(): Promise<RequestKeypair> {
  const sodium = await getSodium();
  const pair = sodium.crypto_box_keypair();
  return { publicKey: pair.publicKey, secretKey: pair.privateKey };
}

/**
 * Seal a responder's submission to the request creator.
 *
 * Two layers on purpose:
 *   1. The submission manifest is AEAD-encrypted under a fresh random content
 *      key, bound by AAD to (requestId, submissionId) so it cannot be replayed
 *      into another request.
 *   2. That content key is sealed to the creator's public key.
 *
 * The alternative — sealing the whole manifest directly — would work for small
 * payloads but gives no place to hang the AAD binding, since crypto_box_seal
 * takes no associated data.
 */
export async function sealSubmission(
  manifest: SubmissionManifest,
  creatorPublicKey: Uint8Array,
  requestId: string,
  submissionId: string,
): Promise<{ sealedKey: Uint8Array; sealedManifest: Uint8Array }> {
  const sodium = await getSodium();
  if (creatorPublicKey.length !== sodium.crypto_box_PUBLICKEYBYTES) {
    throw new EnvelopeError('request public key has wrong length', 'bad-key');
  }
  const contentKey = sodium.randombytes_buf(32);
  try {
    const sealedManifest = await sealBytes(
      utf8.encode(JSON.stringify(manifest)),
      contentKey,
      submissionAad(requestId, submissionId),
    );
    const sealedKey = sodium.crypto_box_seal(contentKey, creatorPublicKey);
    return { sealedKey, sealedManifest };
  } finally {
    sodium.memzero(contentKey);
  }
}

/** Open a sealed submission with the creator's keypair. */
export async function openSubmission(
  sealedKey: Uint8Array,
  sealedManifest: Uint8Array,
  keypair: RequestKeypair,
  requestId: string,
  submissionId: string,
): Promise<SubmissionManifest> {
  const sodium = await getSodium();
  let contentKey: Uint8Array;
  try {
    contentKey = sodium.crypto_box_seal_open(sealedKey, keypair.publicKey, keypair.secretKey);
  } catch {
    throw new EnvelopeError('cannot open sealed key: wrong keypair or modified data', 'tampered');
  }
  try {
    const plaintext = await openBytes(
      sealedManifest,
      contentKey,
      submissionAad(requestId, submissionId),
    );
    const parsed = JSON.parse(utf8.decode(plaintext)) as SubmissionManifest;
    if (parsed.v !== brand.envelopeVersion) {
      throw new EnvelopeError(`unsupported submission version: ${String(parsed.v)}`, 'unsupported-version');
    }
    return parsed;
  } catch (error) {
    if (error instanceof EnvelopeError) throw error;
    throw new EnvelopeError('submission manifest is malformed', 'malformed');
  } finally {
    sodium.memzero(contentKey);
  }
}
