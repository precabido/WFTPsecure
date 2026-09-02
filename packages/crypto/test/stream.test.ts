/**
 * Chunked file encryption tests (§33: chunk removed / duplicated / reordered /
 * truncated / tampered).
 *
 * Each of these corresponds to a real attack on a chunked-upload service: a
 * malicious or buggy server hands the client a different set of chunks than the
 * one that was uploaded. The client must refuse rather than produce a plausible
 * file, because a partially-correct decrypted file is worse than none — the
 * user would trust it.
 */

import { describe, it, expect } from 'vitest';
import {
  generateFileKey,
  createFileEncryptor,
  createFileDecryptor,
  encryptBuffer,
  decryptChunks,
} from '../src/stream.ts';
import { EnvelopeError } from '../src/envelope.ts';
import { randomId, timingSafeEqual, utf8 } from '../src/bytes.ts';
import { bulkRandomBytes } from '@cinderlink/test-utils';

const CHUNK = 1024;

async function fixture(sizeBytes: number, chunkBytes = CHUNK) {
  const key = await generateFileKey();
  const capsuleId = await randomId();
  const objectId = await randomId(12);
  const plaintext = bulkRandomBytes(sizeBytes);
  const { header, chunks } = await encryptBuffer(plaintext, key, capsuleId, objectId, chunkBytes);
  return { key, capsuleId, objectId, plaintext, header, chunks };
}

describe('file stream roundtrip', () => {
  it('recovers a multi-chunk binary file byte for byte', async () => {
    const f = await fixture(CHUNK * 3 + 17);
    expect(f.chunks).toHaveLength(4);
    const out = await decryptChunks(f.header, f.chunks, f.key, f.capsuleId, f.objectId);
    expect(timingSafeEqual(out, f.plaintext)).toBe(true);
  });

  it('recovers a file that lands exactly on a chunk boundary', async () => {
    const f = await fixture(CHUNK * 2);
    expect(f.chunks).toHaveLength(2);
    const out = await decryptChunks(f.header, f.chunks, f.key, f.capsuleId, f.objectId);
    expect(timingSafeEqual(out, f.plaintext)).toBe(true);
  });

  it('recovers a single-byte file', async () => {
    const f = await fixture(1);
    expect(f.chunks).toHaveLength(1);
    expect(timingSafeEqual(await decryptChunks(f.header, f.chunks, f.key, f.capsuleId, f.objectId), f.plaintext)).toBe(true);
  });

  it('handles a zero-byte file with one terminated chunk', async () => {
    const f = await fixture(0);
    // A zero-chunk stream would be indistinguishable from truncation.
    expect(f.chunks).toHaveLength(1);
    expect(await decryptChunks(f.header, f.chunks, f.key, f.capsuleId, f.objectId)).toHaveLength(0);
  });

  it('expands each chunk by exactly the secretstream overhead', async () => {
    const f = await fixture(CHUNK * 2);
    for (const chunk of f.chunks) expect(chunk.length).toBe(CHUNK + 17);
  });
});

describe('file stream refuses manipulated inputs', () => {
  it('rejects a removed chunk', async () => {
    const f = await fixture(CHUNK * 3);
    const missing = [f.chunks[0]!, f.chunks[2]!]; // chunk 1 dropped
    await expect(decryptChunks(f.header, missing, f.key, f.capsuleId, f.objectId)).rejects.toThrow(EnvelopeError);
  });

  it('rejects a duplicated chunk', async () => {
    const f = await fixture(CHUNK * 3);
    const duped = [f.chunks[0]!, f.chunks[0]!, f.chunks[1]!, f.chunks[2]!];
    await expect(decryptChunks(f.header, duped, f.key, f.capsuleId, f.objectId)).rejects.toThrow(EnvelopeError);
  });

  it('rejects reordered chunks', async () => {
    const f = await fixture(CHUNK * 3);
    const swapped = [f.chunks[1]!, f.chunks[0]!, f.chunks[2]!, f.chunks[3]!];
    await expect(decryptChunks(f.header, swapped, f.key, f.capsuleId, f.objectId)).rejects.toThrow(EnvelopeError);
  });

  it('rejects a truncated file even though every surviving chunk authenticates', async () => {
    const f = await fixture(CHUNK * 3);
    const truncated = f.chunks.slice(0, 2);
    // This is the subtle one: chunks 0 and 1 are genuine and verify fine. Only
    // the absent TAG_FINAL reveals that the file is incomplete.
    await expect(decryptChunks(f.header, truncated, f.key, f.capsuleId, f.objectId)).rejects.toMatchObject({
      code: 'tampered',
    });
  });

  it('rejects data appended after the final chunk', async () => {
    const f = await fixture(CHUNK);
    const extended = [...f.chunks, f.chunks[0]!];
    await expect(decryptChunks(f.header, extended, f.key, f.capsuleId, f.objectId)).rejects.toThrow(EnvelopeError);
  });

  it('rejects a flipped bit inside a chunk', async () => {
    const f = await fixture(CHUNK * 2);
    const damaged = f.chunks.map((c) => Uint8Array.from(c));
    damaged[1]![5] = (damaged[1]![5] as number) ^ 0x02;
    await expect(decryptChunks(f.header, damaged, f.key, f.capsuleId, f.objectId)).rejects.toThrow(EnvelopeError);
  });

  it('rejects the wrong file key', async () => {
    const f = await fixture(CHUNK);
    await expect(decryptChunks(f.header, f.chunks, await generateFileKey(), f.capsuleId, f.objectId)).rejects.toThrow(EnvelopeError);
  });

  it('rejects a corrupted secretstream header', async () => {
    const f = await fixture(CHUNK);
    const header = Uint8Array.from(f.header);
    header[0] = (header[0] as number) ^ 0xff;
    await expect(decryptChunks(header, f.chunks, f.key, f.capsuleId, f.objectId)).rejects.toThrow(EnvelopeError);
  });

  it('rejects a header of the wrong length', async () => {
    const f = await fixture(CHUNK);
    await expect(decryptChunks(new Uint8Array(8), f.chunks, f.key, f.capsuleId, f.objectId)).rejects.toMatchObject({
      code: 'malformed',
    });
  });

  it('rejects chunks replayed into a different capsule (AAD binding)', async () => {
    const f = await fixture(CHUNK * 2);
    const otherCapsule = await randomId();
    await expect(decryptChunks(f.header, f.chunks, f.key, otherCapsule, f.objectId)).rejects.toThrow(EnvelopeError);
  });

  it('rejects chunks replayed into a different object of the same capsule', async () => {
    const f = await fixture(CHUNK * 2);
    const otherObject = await randomId(12);
    await expect(decryptChunks(f.header, f.chunks, f.key, f.capsuleId, otherObject)).rejects.toThrow(EnvelopeError);
  });
});

describe('encryptor guards', () => {
  it('refuses out-of-order encryption', async () => {
    const enc = await createFileEncryptor(await generateFileKey(), await randomId(), await randomId(12));
    await enc.encryptChunk(utf8.encode('a'), 0, false);
    await expect(enc.encryptChunk(utf8.encode('b'), 2, true)).rejects.toThrow(EnvelopeError);
  });

  it('refuses to push after finalising', async () => {
    const enc = await createFileEncryptor(await generateFileKey(), await randomId(), await randomId(12));
    await enc.encryptChunk(utf8.encode('a'), 0, true);
    await expect(enc.encryptChunk(utf8.encode('b'), 1, false)).rejects.toThrow(EnvelopeError);
  });

  it('emits a 24-byte header', async () => {
    const enc = await createFileEncryptor(await generateFileKey(), await randomId(), await randomId(12));
    expect(enc.header).toHaveLength(24);
  });
});

describe('streaming decryptor reports finality', () => {
  it('flags exactly the last chunk as final', async () => {
    const f = await fixture(CHUNK * 2 + 5);
    const dec = await createFileDecryptor(f.header, f.key, f.capsuleId, f.objectId);
    const flags: boolean[] = [];
    for (let i = 0; i < f.chunks.length; i += 1) {
      flags.push((await dec.decryptChunk(f.chunks[i]!, i)).isFinal);
    }
    expect(flags).toEqual([false, false, true]);
  });
});

describe('larger payloads', () => {
  it('roundtrips 5 MiB through 2 MiB chunks', async () => {
    const f = await fixture(5 * 1024 * 1024, 2 * 1024 * 1024);
    expect(f.chunks).toHaveLength(3);
    const out = await decryptChunks(f.header, f.chunks, f.key, f.capsuleId, f.objectId);
    expect(out.length).toBe(5 * 1024 * 1024);
    expect(timingSafeEqual(out, f.plaintext)).toBe(true);
  });
});
