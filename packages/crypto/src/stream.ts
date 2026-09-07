/**
 * Chunked file encryption with crypto_secretstream (§13).
 *
 * Why secretstream rather than per-chunk AEAD: secretstream maintains an
 * internal, rekeying state across pushes, so it authenticates the *sequence*
 * as well as each chunk. That gives us three properties a naive per-chunk AEAD
 * would not:
 *
 *   1. Reordering fails      — chunk N cannot decrypt in position M.
 *   2. Duplication fails     — replaying a chunk breaks the chain.
 *   3. Truncation is visible — only the last chunk carries TAG_FINAL, so a
 *                              short file is detected rather than silently
 *                              yielding a shorter (still authentic) prefix.
 *
 * We additionally bind (version, capsuleId, objectId, chunkIndex) as AD on each
 * push, so a chunk cannot be replayed into a *different* file or capsule even
 * if an attacker controls both ciphertexts.
 */

import { getSodium } from './sodium.ts';
import { fileChunkAad } from './aad.ts';
import { EnvelopeError } from './envelope.ts';

export interface FileEncryptor {
  /** 24-byte secretstream header; store it in the encrypted manifest. */
  header: Uint8Array;
  /** Encrypt one chunk. `isFinal` must be true for exactly the last chunk. */
  encryptChunk(plaintext: Uint8Array, index: number, isFinal: boolean): Promise<Uint8Array>;
}

export interface FileDecryptor {
  /**
   * Decrypt one chunk in order. Throws EnvelopeError on any mismatch. Returns
   * `{ plaintext, isFinal }`; callers must verify a final chunk was seen.
   */
  decryptChunk(ciphertext: Uint8Array, index: number): Promise<{ plaintext: Uint8Array; isFinal: boolean }>;
}

export async function generateFileKey(): Promise<Uint8Array> {
  const sodium = await getSodium();
  return sodium.crypto_secretstream_xchacha20poly1305_keygen();
}

/** Ciphertext overhead added to every chunk (Poly1305 tag + tag byte). */
export async function chunkOverheadBytes(): Promise<number> {
  const sodium = await getSodium();
  return sodium.crypto_secretstream_xchacha20poly1305_ABYTES;
}

export async function createFileEncryptor(
  fileKey: Uint8Array,
  capsuleId: string,
  objectId: string,
): Promise<FileEncryptor> {
  const sodium = await getSodium();
  const { state, header } = sodium.crypto_secretstream_xchacha20poly1305_init_push(fileKey);
  let expectedIndex = 0;
  let finished = false;

  return {
    header,
    async encryptChunk(plaintext, index, isFinal) {
      if (finished) throw new EnvelopeError('stream already finalised', 'malformed');
      if (index !== expectedIndex) {
        throw new EnvelopeError(
          `chunks must be encrypted in order (expected ${expectedIndex}, got ${index})`,
          'malformed',
        );
      }
      const tag = isFinal
        ? sodium.crypto_secretstream_xchacha20poly1305_TAG_FINAL
        : sodium.crypto_secretstream_xchacha20poly1305_TAG_MESSAGE;
      const ciphertext = sodium.crypto_secretstream_xchacha20poly1305_push(
        state,
        plaintext,
        fileChunkAad(capsuleId, objectId, index),
        tag,
      );
      expectedIndex += 1;
      finished = isFinal;
      return ciphertext;
    },
  };
}

export async function createFileDecryptor(
  header: Uint8Array,
  fileKey: Uint8Array,
  capsuleId: string,
  objectId: string,
): Promise<FileDecryptor> {
  const sodium = await getSodium();
  if (header.length !== sodium.crypto_secretstream_xchacha20poly1305_HEADERBYTES) {
    throw new EnvelopeError('secretstream header has wrong length', 'malformed');
  }
  let state: unknown;
  try {
    state = sodium.crypto_secretstream_xchacha20poly1305_init_pull(header, fileKey);
  } catch {
    throw new EnvelopeError('cannot initialise stream: bad header or key', 'bad-key');
  }
  let expectedIndex = 0;
  let sawFinal = false;

  return {
    async decryptChunk(ciphertext, index) {
      if (sawFinal) {
        // Extra data after TAG_FINAL means the file was extended.
        throw new EnvelopeError('unexpected chunk after end of stream', 'tampered');
      }
      if (index !== expectedIndex) {
        throw new EnvelopeError(
          `chunk out of order (expected ${expectedIndex}, got ${index})`,
          'tampered',
        );
      }
      let result: { message: Uint8Array; tag: number } | false;
      try {
        result = sodium.crypto_secretstream_xchacha20poly1305_pull(
          state,
          ciphertext,
          fileChunkAad(capsuleId, objectId, index),
        );
      } catch {
        result = false;
      }
      if (result === false) {
        throw new EnvelopeError(
          `chunk ${index} failed authentication: modified, reordered, or wrong key`,
          'tampered',
        );
      }
      expectedIndex += 1;
      const isFinal = result.tag === sodium.crypto_secretstream_xchacha20poly1305_TAG_FINAL;
      sawFinal = isFinal;
      return { plaintext: result.message, isFinal };
    },
  };
}

/**
 * Convenience: encrypt a whole in-memory buffer into chunks.
 *
 * Only for small payloads and tests — the browser upload path streams via
 * {@link createFileEncryptor} so a large file is never fully resident.
 */
export async function encryptBuffer(
  plaintext: Uint8Array,
  fileKey: Uint8Array,
  capsuleId: string,
  objectId: string,
  chunkBytes: number,
): Promise<{ header: Uint8Array; chunks: Uint8Array[] }> {
  const encryptor = await createFileEncryptor(fileKey, capsuleId, objectId);
  const chunks: Uint8Array[] = [];
  // A zero-length file still needs one (empty, FINAL) chunk so that the
  // decryptor sees a terminated stream instead of an ambiguous truncation.
  const count = Math.max(1, Math.ceil(plaintext.length / chunkBytes));
  for (let i = 0; i < count; i += 1) {
    const slice = plaintext.subarray(i * chunkBytes, Math.min((i + 1) * chunkBytes, plaintext.length));
    chunks.push(await encryptor.encryptChunk(slice, i, i === count - 1));
  }
  return { header: encryptor.header, chunks };
}

/** Convenience inverse of {@link encryptBuffer}; verifies stream termination. */
export async function decryptChunks(
  header: Uint8Array,
  chunks: Uint8Array[],
  fileKey: Uint8Array,
  capsuleId: string,
  objectId: string,
): Promise<Uint8Array> {
  const decryptor = await createFileDecryptor(header, fileKey, capsuleId, objectId);
  const parts: Uint8Array[] = [];
  let sawFinal = false;
  for (let i = 0; i < chunks.length; i += 1) {
    const { plaintext, isFinal } = await decryptor.decryptChunk(chunks[i] as Uint8Array, i);
    parts.push(plaintext);
    sawFinal = isFinal;
  }
  if (!sawFinal) {
    // Every chunk authenticated, but the terminator never arrived: the file was
    // truncated. Refuse rather than hand back a plausible prefix (§13).
    throw new EnvelopeError('stream truncated: final chunk missing', 'tampered');
  }
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
