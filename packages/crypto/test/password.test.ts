/**
 * Password wrapping, link encoding, fingerprints and sealed submissions (§33).
 */

import { describe, it, expect } from 'vitest';
import {
  wrapRootKey,
  unwrapRootKey,
  PasswordError,
  DEFAULT_KDF,
  estimatePasswordStrength,
} from '../src/password.ts';
import { generateRootKey, EnvelopeError } from '../src/envelope.ts';
import { encodeFragment, decodeFragment, LinkError, capsuleUrl, manageUrl } from '../src/link.ts';
import { capsuleFingerprint, formatFingerprint, formatDeliveryKey, parseDeliveryKey } from '../src/fingerprint.ts';
import { generateRequestKeypair, sealSubmission, openSubmission } from '../src/sealed.ts';
import { randomId, timingSafeEqual, toBase64Url } from '../src/bytes.ts';
import { brand } from '@cinderlink/config/brand';
import type { SubmissionManifest } from '../src/types.ts';

// A cheap KDF profile keeps the suite fast; the production profile is exercised
// once below so a regression in the real parameters still fails the build.
const FAST_KDF = { alg: 'argon2id13' as const, ops: 1, mem: 8 * 1024 * 1024 };

describe('password wrapping', () => {
  it('recovers the root key with the correct password', async () => {
    const root = await generateRootKey();
    const id = await randomId();
    const wrapped = await wrapRootKey(root, 'correct horse battery staple', id, FAST_KDF);
    const recovered = await unwrapRootKey(wrapped, 'correct horse battery staple', id);
    expect(timingSafeEqual(recovered, root)).toBe(true);
  });

  it('rejects the wrong password locally, with no network involved', async () => {
    const root = await generateRootKey();
    const id = await randomId();
    const wrapped = await wrapRootKey(root, 'right', id, FAST_KDF);
    await expect(unwrapRootKey(wrapped, 'wrong', id)).rejects.toMatchObject({ code: 'wrong-password' });
  });

  it('rejects a single-character difference', async () => {
    const root = await generateRootKey();
    const id = await randomId();
    const wrapped = await wrapRootKey(root, 'passphrase-2026', id, FAST_KDF);
    await expect(unwrapRootKey(wrapped, 'passphrase-2027', id)).rejects.toThrow(PasswordError);
  });

  it('binds the wrap to the capsule id, so it cannot be moved to another capsule', async () => {
    const root = await generateRootKey();
    const wrapped = await wrapRootKey(root, 'pw', await randomId(), FAST_KDF);
    await expect(unwrapRootKey(wrapped, 'pw', await randomId())).rejects.toThrow(PasswordError);
  });

  it('uses a fresh salt per capsule', async () => {
    const root = await generateRootKey();
    const a = await wrapRootKey(root, 'pw', await randomId(), FAST_KDF);
    const b = await wrapRootKey(root, 'pw', await randomId(), FAST_KDF);
    expect(timingSafeEqual(a.salt, b.salt)).toBe(false);
  });

  it('handles a Unicode passphrase', async () => {
    const root = await generateRootKey();
    const id = await randomId();
    const pw = 'contraseña-日本語-🔐';
    const wrapped = await wrapRootKey(root, pw, id, FAST_KDF);
    expect(timingSafeEqual(await unwrapRootKey(wrapped, pw, id), root)).toBe(true);
  });

  it('rejects hostile KDF parameters instead of allocating gigabytes', async () => {
    const root = await generateRootKey();
    const id = await randomId();
    const wrapped = await wrapRootKey(root, 'pw', id, FAST_KDF);
    const hostile = { ...wrapped, kdf: { alg: 'argon2id13' as const, ops: 1, mem: 8 * 1024 * 1024 * 1024 } };
    await expect(unwrapRootKey(hostile, 'pw', id)).rejects.toMatchObject({ code: 'bad-params' });
  });

  it('rejects an unknown KDF algorithm', async () => {
    const root = await generateRootKey();
    const id = await randomId();
    const wrapped = await wrapRootKey(root, 'pw', id, FAST_KDF);
    const hostile = { ...wrapped, kdf: { alg: 'scrypt' as unknown as 'argon2id13', ops: 1, mem: 8 * 1024 * 1024 } };
    await expect(unwrapRootKey(hostile, 'pw', id)).rejects.toMatchObject({ code: 'bad-params' });
  });

  it('rejects a root key of the wrong size', async () => {
    await expect(wrapRootKey(new Uint8Array(8), 'pw', await randomId(), FAST_KDF)).rejects.toThrow(EnvelopeError);
  });

  it('works with the production KDF profile', async () => {
    const root = await generateRootKey();
    const id = await randomId();
    const wrapped = await wrapRootKey(root, 'production profile check', id, DEFAULT_KDF);
    expect(wrapped.kdf).toEqual(DEFAULT_KDF);
    expect(timingSafeEqual(await unwrapRootKey(wrapped, 'production profile check', id), root)).toBe(true);
  });
});

describe('password strength estimate', () => {
  it('rates a long passphrase above a short mixed password', async () => {
    const passphrase = estimatePasswordStrength('marea cobre faro onix tundra');
    const short = estimatePasswordStrength('Aa1!xY');
    expect(passphrase.score).toBeGreaterThan(short.score);
  });

  it('rates an empty password at the floor', () => {
    expect(estimatePasswordStrength('').score).toBe(0);
  });
});

describe('link fragment encoding', () => {
  it('roundtrips a plain key link', async () => {
    const root = await generateRootKey();
    const decoded = await decodeFragment(await encodeFragment({ mode: 'key', rootKey: root }));
    expect(decoded.mode).toBe('key');
    if (decoded.mode !== 'key') throw new Error('unreachable');
    expect(timingSafeEqual(decoded.rootKey, root)).toBe(true);
  });

  it('roundtrips a password link including KDF parameters', async () => {
    const root = await generateRootKey();
    const id = await randomId();
    const wrapped = await wrapRootKey(root, 'pw', id, FAST_KDF);
    const decoded = await decodeFragment(await encodeFragment({ mode: 'password', wrapped }));
    expect(decoded.mode).toBe('password');
    if (decoded.mode !== 'password') throw new Error('unreachable');
    expect(decoded.wrapped.kdf).toEqual(FAST_KDF);
    expect(timingSafeEqual(await unwrapRootKey(decoded.wrapped, 'pw', id), root)).toBe(true);
  });

  it('roundtrips a split-delivery link that carries no key at all', async () => {
    const fragment = await encodeFragment({ mode: 'split' });
    expect(fragment).not.toMatch(/k=/);
    expect((await decodeFragment(fragment)).mode).toBe('split');
  });

  it('tolerates a leading # on decode', async () => {
    const root = await generateRootKey();
    const fragment = await encodeFragment({ mode: 'key', rootKey: root });
    expect((await decodeFragment(`#${fragment}`)).mode).toBe('key');
  });

  it('rejects an unknown link version', async () => {
    await expect(decodeFragment('v=99&k=abc')).rejects.toMatchObject({ code: 'unsupported-version' });
  });

  it('rejects a fragment with no secret', async () => {
    await expect(decodeFragment('v=1')).rejects.toMatchObject({ code: 'malformed' });
  });

  it('rejects an incomplete password fragment', async () => {
    await expect(decodeFragment('v=1&p=a2&w=abc')).rejects.toThrow(LinkError);
  });

  it('keeps the key out of the path in the assembled URL', async () => {
    const root = await generateRootKey();
    const fragment = await encodeFragment({ mode: 'key', rootKey: root });
    const url = capsuleUrl('http://127.0.0.1:9999', 'abc123', fragment);
    const [path, hash] = url.split('#');
    expect(path).toBe('http://127.0.0.1:9999/c/abc123');
    // The secret must live only after '#', which browsers never transmit.
    expect(hash).toContain('k=');
    expect(path).not.toContain('k=');
  });

  it('puts the management token on a separate route from the recipient link', () => {
    const url = manageUrl('http://127.0.0.1:9999', 'abc123', 'tok');
    expect(url).toBe('http://127.0.0.1:9999/m/abc123#t=tok');
  });
});

describe('fingerprint', () => {
  it('is deterministic for the same key and capsule', async () => {
    const root = await generateRootKey();
    const id = await randomId();
    expect(await capsuleFingerprint(root, id)).toEqual(await capsuleFingerprint(root, id));
  });

  it('changes when the key changes', async () => {
    const id = await randomId();
    const a = await capsuleFingerprint(await generateRootKey(), id);
    const b = await capsuleFingerprint(await generateRootKey(), id);
    expect(a).not.toEqual(b);
  });

  it('changes when the capsule id changes', async () => {
    const root = await generateRootKey();
    expect(await capsuleFingerprint(root, await randomId())).not.toEqual(
      await capsuleFingerprint(root, await randomId()),
    );
  });

  it('yields four words from the frozen list', async () => {
    const words = await capsuleFingerprint(await generateRootKey(), await randomId());
    expect(words).toHaveLength(4);
    expect(formatFingerprint(words)).toMatch(/^[a-z]+ · [a-z]+ · [a-z]+ · [a-z]+$/);
  });
});

describe('split-delivery key formatting', () => {
  it('groups and ungroups losslessly', async () => {
    const key = await toBase64Url(await generateRootKey());
    const formatted = formatDeliveryKey(key);
    expect(formatted).toContain(' ');
    expect(parseDeliveryKey(formatted)).toBe(key);
  });

  it('survives the whitespace damage that chat apps add', async () => {
    const key = await toBase64Url(await generateRootKey());
    expect(parseDeliveryKey(`  ${formatDeliveryKey(key)} \n`)).toBe(key);
  });

  it('preserves - and _, which are base64url characters and not separators', () => {
    // Regression: a hyphen separator plus a strip-hyphens parser silently
    // corrupted every key containing '-'. The alphabet is A-Za-z0-9-_ .
    const key = 'ab-cd_ef-gh_ij-kl_mn-op_qr-st_uv-wx_yz01-23_45';
    expect(parseDeliveryKey(formatDeliveryKey(key))).toBe(key);
  });

  it('round-trips 500 random keys without loss', async () => {
    for (let i = 0; i < 500; i += 1) {
      const key = await toBase64Url(await generateRootKey());
      expect(parseDeliveryKey(formatDeliveryKey(key))).toBe(key);
    }
  });

  it('rejoins a key broken across lines', () => {
    const key = 'AAAA-BBBB_CCCC';
    expect(parseDeliveryKey('AAAA-\nBBBB_\r\n  CCCC')).toBe(key);
  });
});

describe('secure request sealed boxes', () => {
  const submission = (): SubmissionManifest => ({
    v: brand.envelopeVersion,
    message: 'Here is the signed contract.',
    responderAlias: 'Ana',
    createdAt: '2026-01-01T00:00:00.000Z',
  });

  it('lets only the creator open a submission', async () => {
    const creator = await generateRequestKeypair();
    const requestId = await randomId();
    const submissionId = await randomId(12);
    const { sealedKey, sealedManifest } = await sealSubmission(submission(), creator.publicKey, requestId, submissionId);
    expect(await openSubmission(sealedKey, sealedManifest, creator, requestId, submissionId)).toEqual(submission());
  });

  it('denies a different keypair', async () => {
    const creator = await generateRequestKeypair();
    const attacker = await generateRequestKeypair();
    const requestId = await randomId();
    const submissionId = await randomId(12);
    const { sealedKey, sealedManifest } = await sealSubmission(submission(), creator.publicKey, requestId, submissionId);
    await expect(openSubmission(sealedKey, sealedManifest, attacker, requestId, submissionId)).rejects.toThrow(EnvelopeError);
  });

  it('denies a submission replayed into another request', async () => {
    const creator = await generateRequestKeypair();
    const requestId = await randomId();
    const submissionId = await randomId(12);
    const { sealedKey, sealedManifest } = await sealSubmission(submission(), creator.publicKey, requestId, submissionId);
    await expect(openSubmission(sealedKey, sealedManifest, creator, await randomId(), submissionId)).rejects.toThrow(EnvelopeError);
  });

  it('denies a tampered sealed manifest', async () => {
    const creator = await generateRequestKeypair();
    const requestId = await randomId();
    const submissionId = await randomId(12);
    const { sealedKey, sealedManifest } = await sealSubmission(submission(), creator.publicKey, requestId, submissionId);
    const damaged = Uint8Array.from(sealedManifest);
    damaged[30] = (damaged[30] as number) ^ 0x40;
    await expect(openSubmission(sealedKey, damaged, creator, requestId, submissionId)).rejects.toThrow(EnvelopeError);
  });

  it('rejects a public key of the wrong length', async () => {
    await expect(sealSubmission(submission(), new Uint8Array(16), await randomId(), await randomId(12))).rejects.toThrow(EnvelopeError);
  });
});
