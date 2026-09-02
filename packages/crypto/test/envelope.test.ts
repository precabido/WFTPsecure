/**
 * Envelope + manifest tests (§33 "Criptografía").
 *
 * These assertions are the security contract of the product. If any of them
 * regress, the zero-knowledge claim on the marketing page becomes false — so
 * they are deliberately blunt about *what an attacker cannot do*, not just
 * about happy-path roundtrips.
 */

import { describe, it, expect } from 'vitest';
import { brand } from '@cinderlink/config/brand';
import {
  generateRootKey,
  sealManifest,
  openManifest,
  sealBytes,
  openBytes,
  deriveManifestKey,
  EnvelopeError,
  ROOT_KEY_BYTES,
} from '../src/envelope.ts';
import { manifestAad, buildAad } from '../src/aad.ts';
import { randomId, utf8, randomBytes, timingSafeEqual } from '../src/bytes.ts';
import { getSodium } from '../src/sodium.ts';
import type { CapsuleManifest } from '../src/types.ts';

function manifest(overrides: Partial<CapsuleManifest> = {}): CapsuleManifest {
  return {
    v: brand.envelopeVersion,
    kind: 'note',
    template: 'note',
    title: 'Deploy key rotation',
    senderAlias: 'ops',
    message: 'Rotate before Friday.',
    receiver: {
      theme: 'dark',
      accent: 'violet',
      destroyAnimation: 'dissolve',
      locale: 'es',
      autoHideOnBlur: true,
      holdToReveal: false,
      visibleSeconds: 0,
      allowPreview: true,
      forceDownload: false,
    },
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('root key', () => {
  it('is 32 bytes and not repeated across calls', async () => {
    const a = await generateRootKey();
    const b = await generateRootKey();
    expect(a).toHaveLength(ROOT_KEY_BYTES);
    expect(b).toHaveLength(ROOT_KEY_BYTES);
    expect(timingSafeEqual(a, b)).toBe(false);
  });

  it('derives a manifest subkey that differs from the root key', async () => {
    const root = await generateRootKey();
    const sub = await deriveManifestKey(root);
    expect(sub).toHaveLength(32);
    // A bug that returned the root key itself would silently widen key reuse.
    expect(timingSafeEqual(sub, root)).toBe(false);
  });

  it('derives deterministically from the same root key', async () => {
    const root = await generateRootKey();
    expect(timingSafeEqual(await deriveManifestKey(root), await deriveManifestKey(root))).toBe(true);
  });

  it('rejects a root key of the wrong length', async () => {
    await expect(deriveManifestKey(new Uint8Array(16))).rejects.toThrow(EnvelopeError);
  });
});

describe('manifest roundtrip', () => {
  it('recovers an ASCII manifest', async () => {
    const root = await generateRootKey();
    const id = await randomId();
    const sealed = await sealManifest(manifest(), root, id);
    expect(await openManifest(sealed, root, id)).toEqual(manifest());
  });

  it('recovers Unicode exactly, including emoji and RTL', async () => {
    const root = await generateRootKey();
    const id = await randomId();
    const tricky = manifest({
      title: '密码 · Contraseña · كلمة السر',
      message: 'Ünïcödé ✅ 🔐 — naïve café; مرحبا بالعالم; 𝕘𝕝𝕪𝕡𝕙𝕤',
      senderAlias: 'Ñandú 🦤',
    });
    const sealed = await sealManifest(tricky, root, id);
    const opened = await openManifest(sealed, root, id);
    expect(opened.title).toBe(tricky.title);
    expect(opened.message).toBe(tricky.message);
    expect(opened.senderAlias).toBe(tricky.senderAlias);
  });

  it('preserves newlines exactly (required for .env payloads)', async () => {
    const root = await generateRootKey();
    const id = await randomId();
    const env = 'API_KEY=abc123\nDB_URL=postgres://x\r\nEMPTY=\n\nTRAILING=1\n';
    const sealed = await sealManifest(
      manifest({
        template: 'env-vars',
        fields: [{ id: 'f1', label: '.env', value: env, secret: true, multiline: true }],
      }),
      root,
      id,
    );
    const opened = await openManifest(sealed, root, id);
    expect(opened.fields?.[0]?.value).toBe(env);
  });

  it('produces a different ciphertext each time (fresh nonce)', async () => {
    const root = await generateRootKey();
    const id = await randomId();
    const a = await sealManifest(manifest(), root, id);
    const b = await sealManifest(manifest(), root, id);
    expect(timingSafeEqual(a, b)).toBe(false);
  });
});

describe('manifest rejects everything it should', () => {
  it('rejects a wrong root key', async () => {
    const id = await randomId();
    const sealed = await sealManifest(manifest(), await generateRootKey(), id);
    await expect(openManifest(sealed, await generateRootKey(), id)).rejects.toThrow(EnvelopeError);
  });

  it('rejects a manifest replayed under a different capsule id (AAD binding)', async () => {
    const root = await generateRootKey();
    const sealed = await sealManifest(manifest(), root, await randomId());
    // Same key, same bytes — only the claimed capsule identity changed.
    await expect(openManifest(sealed, root, await randomId())).rejects.toThrow(/authentication failed/);
  });

  it('rejects a flipped ciphertext bit', async () => {
    const root = await generateRootKey();
    const id = await randomId();
    const sealed = await sealManifest(manifest(), root, id);
    const tampered = Uint8Array.from(sealed);
    const target = tampered.length - 20;
    tampered[target] = (tampered[target] as number) ^ 0x01;
    await expect(openManifest(tampered, root, id)).rejects.toThrow(EnvelopeError);
  });

  it('rejects a modified nonce', async () => {
    const root = await generateRootKey();
    const id = await randomId();
    const sealed = await sealManifest(manifest(), root, id);
    const tampered = Uint8Array.from(sealed);
    tampered[0] = (tampered[0] as number) ^ 0xff; // nonce is the first 24 bytes
    await expect(openManifest(tampered, root, id)).rejects.toThrow(EnvelopeError);
  });

  it('rejects a truncated payload without throwing something unhelpful', async () => {
    const root = await generateRootKey();
    const id = await randomId();
    const sealed = await sealManifest(manifest(), root, id);
    await expect(openManifest(sealed.subarray(0, 10), root, id)).rejects.toMatchObject({
      code: 'malformed',
    });
  });

  it('rejects an unknown envelope version', async () => {
    const root = await generateRootKey();
    const id = await randomId();
    // Seal a manifest that claims a future version, using the real key path.
    const key = await deriveManifestKey(root);
    const future = JSON.stringify({ ...manifest(), v: 'capsule-envelope-v99' });
    const sealed = await sealBytes(utf8.encode(future), key, manifestAad(id));
    await expect(openManifest(sealed, root, id)).rejects.toMatchObject({
      code: 'unsupported-version',
    });
  });

  it('rejects non-JSON plaintext that still authenticates', async () => {
    const root = await generateRootKey();
    const id = await randomId();
    const key = await deriveManifestKey(root);
    const sealed = await sealBytes(utf8.encode('not json at all'), key, manifestAad(id));
    await expect(openManifest(sealed, root, id)).rejects.toMatchObject({ code: 'malformed' });
  });
});

describe('AAD encoding is injective', () => {
  it('does not collide when field boundaries shift', async () => {
    // The classic delimiter bug: ("ab","c") vs ("a","bc") must never agree.
    const a = buildAad({ version: 'v', objectType: 'file', capsuleId: 'ab', objectId: 'c', chunkIndex: 0 });
    const b = buildAad({ version: 'v', objectType: 'file', capsuleId: 'a', objectId: 'bc', chunkIndex: 0 });
    expect(timingSafeEqual(a, b)).toBe(false);
  });

  it('separates chunk indices', () => {
    const a = buildAad({ version: 'v', objectType: 'file', capsuleId: 'c', objectId: 'o', chunkIndex: 1 });
    const b = buildAad({ version: 'v', objectType: 'file', capsuleId: 'c', objectId: 'o', chunkIndex: 2 });
    expect(timingSafeEqual(a, b)).toBe(false);
  });

  it('separates object types', () => {
    const a = buildAad({ version: 'v', objectType: 'file', capsuleId: 'c', objectId: '', chunkIndex: 0 });
    const b = buildAad({ version: 'v', objectType: 'manifest', capsuleId: 'c', objectId: '', chunkIndex: 0 });
    expect(timingSafeEqual(a, b)).toBe(false);
  });

  it('separates envelope versions', () => {
    const a = buildAad({ version: 'capsule-envelope-v1', objectType: 'file', capsuleId: 'c', objectId: 'o', chunkIndex: 0 });
    const b = buildAad({ version: 'capsule-envelope-v2', objectType: 'file', capsuleId: 'c', objectId: 'o', chunkIndex: 0 });
    expect(timingSafeEqual(a, b)).toBe(false);
  });

  it('refuses an out-of-range chunk index', () => {
    expect(() => buildAad({ version: 'v', objectType: 'file', capsuleId: 'c', objectId: 'o', chunkIndex: -1 })).toThrow(RangeError);
  });
});

describe('raw byte sealing', () => {
  it('roundtrips arbitrary binary data', async () => {
    const key = await randomBytes(32);
    const aad = utf8.encode('ctx');
    const payload = await randomBytes(1024);
    const sealed = await sealBytes(payload, key, aad);
    expect(timingSafeEqual(await openBytes(sealed, key, aad), payload)).toBe(true);
  });

  it('roundtrips an empty payload', async () => {
    const key = await randomBytes(32);
    const aad = utf8.encode('ctx');
    const sealed = await sealBytes(new Uint8Array(0), key, aad);
    expect(await openBytes(sealed, key, aad)).toHaveLength(0);
  });

  it('rejects the right ciphertext under the wrong AAD', async () => {
    const key = await randomBytes(32);
    const sealed = await sealBytes(utf8.encode('x'), key, utf8.encode('aad-A'));
    await expect(openBytes(sealed, key, utf8.encode('aad-B'))).rejects.toThrow(EnvelopeError);
  });
});

describe('memory hygiene', () => {
  it('memzero actually clears a buffer', async () => {
    const sodium = await getSodium();
    const buffer = await randomBytes(32);
    expect(buffer.some((b) => b !== 0)).toBe(true);
    sodium.memzero(buffer);
    expect(buffer.every((b) => b === 0)).toBe(true);
  });
});
