/**
 * Browser-side capsule orchestration.
 *
 * THIS FILE IS THE ZERO-KNOWLEDGE BOUNDARY. Every byte that leaves here for the
 * network has already been encrypted, and the root key is never a parameter to
 * any fetch(). If you are reviewing one file for the security claim, review this
 * one alongside @cinderlink/crypto.
 *
 * Invariants enforced below:
 *   - The capsule id is generated locally, so the manifest's AAD binds the real
 *     id without asking the server for one.
 *   - The root key exists only in this module and in the URL fragment.
 *   - Files are encrypted chunk by chunk; a whole file is never held in memory.
 *   - Key material is zeroed as soon as it is no longer needed (best effort).
 */

import {
  generateRootKey,
  generateFileKey,
  sealManifest,
  openManifest,
  createFileEncryptor,
  createFileDecryptor,
  wrapRootKey,
  unwrapRootKey,
  encodeFragment,
  decodeFragment,
  capsuleFingerprint,
  toBase64Url,
  fromBase64Url,
  randomId,
  wipe,
  capsuleUrl,
  manageUrl,
  EnvelopeError,
  PasswordError,
  type CapsuleManifest,
  type FileEntry,
  type ReceiverConfig,
  type StructuredField,
  type CapsuleKind,
  type TemplateId,
} from '@cinderlink/crypto';
import { brand } from '@cinderlink/config/brand';

export interface CreateInput {
  kind: CapsuleKind;
  template: TemplateId;
  title?: string;
  senderAlias?: string;
  message?: string;
  markdown?: boolean;
  instructions?: string;
  fields?: StructuredField[];
  code?: { language: string; source: string };
  files: File[];
  receiver: ReceiverConfig;
  policy: {
    burnMode: 'on-claim' | 'on-download' | 'time-only';
    maxClaims: number;
    ttlSeconds: number;
    unlockInSeconds: number | null;
    claimWindowSeconds: number;
  };
  password?: string;
  /** Split delivery: omit the key from the link and hand it over separately. */
  splitDelivery?: boolean;
}

export interface CreateResult {
  capsuleId: string;
  recipientUrl: string;
  manageUrl: string;
  /** Present only for split delivery — the key to send by another channel. */
  separateKey?: string;
  fingerprint: string[];
  expiresAt: string;
  totalBytes: number;
}

export type ProgressPhase = 'encrypting' | 'uploading' | 'sealing' | 'downloading' | 'decrypting';

export interface Progress {
  phase: ProgressPhase;
  /** 0..1 */
  ratio: number;
  fileName?: string;
}

export type ProgressFn = (progress: Progress) => void;

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
    // Same-origin only; CORS is disabled server-side (§16).
    credentials: 'omit',
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string; reason?: string };
    throw new ApiError(body.reason ?? body.error ?? `request failed (${response.status})`, response.status);
  }
  return (await response.json()) as T;
}

export class ApiError extends Error {
  override readonly name = 'ApiError';
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

/**
 * Create a capsule.
 *
 * Order is deliberate: files upload first, and the capsule row is only created
 * once every upload has completed. That is what makes §13's "an incomplete
 * upload must never produce a usable capsule" true from the client side too.
 */
export async function createCapsule(
  input: CreateInput,
  baseUrl: string,
  onProgress?: ProgressFn,
  chunkBytes = 1024 * 1024,
): Promise<CreateResult> {
  const capsuleId = await randomId(16);
  const rootKey = await generateRootKey();

  try {
    const fileEntries: FileEntry[] = [];
    const uploadIds: string[] = [];
    let uploadedBytes = 0;
    const totalPlainBytes = input.files.reduce((sum, file) => sum + file.size, 0);

    for (const file of input.files) {
      const chunkCount = Math.max(1, Math.ceil(file.size / chunkBytes));

      const session = await api<{ uploadId: string; uploadToken: string; objectId: string }>(
        '/api/v1/uploads',
        { method: 'POST', body: JSON.stringify({ capsuleId, expectedChunks: chunkCount }) },
      );
      uploadIds.push(session.uploadId);

      const fileKey = await generateFileKey();
      const encryptor = await createFileEncryptor(fileKey, capsuleId, session.objectId);

      for (let index = 0; index < chunkCount; index += 1) {
        const start = index * chunkBytes;
        const end = Math.min(start + chunkBytes, file.size);
        // slice() returns a Blob view; only this window is read into memory,
        // so a 50 MiB file never becomes a 50 MiB ArrayBuffer.
        const plaintext = new Uint8Array(await file.slice(start, end).arrayBuffer());
        const ciphertext = await encryptor.encryptChunk(plaintext, index, index === chunkCount - 1);

        const response = await fetch(`/api/v1/uploads/${session.uploadId}/chunks/${index}`, {
          method: 'PUT',
          headers: {
            authorization: `Bearer ${session.uploadToken}`,
            'content-type': 'application/octet-stream',
          },
          body: ciphertext as BodyInit,
          credentials: 'omit',
        });
        if (!response.ok) throw new ApiError(`chunk ${index} rejected`, response.status);

        uploadedBytes += plaintext.length;
        onProgress?.({
          phase: 'uploading',
          ratio: totalPlainBytes === 0 ? 1 : uploadedBytes / totalPlainBytes,
          fileName: file.name,
        });
      }

      await api(`/api/v1/uploads/${session.uploadId}/complete`, { method: 'POST', body: '{}' });

      fileEntries.push({
        objectId: session.objectId,
        // The filename lives ONLY here, inside the manifest that is about to be
        // encrypted. It is never sent as a field, a header, or a storage key.
        name: file.name,
        mimeType: file.type || 'application/octet-stream',
        size: file.size,
        chunkCount,
        key: await toBase64Url(fileKey),
        header: await toBase64Url(encryptor.header),
      });
      await wipe(fileKey);
    }

    onProgress?.({ phase: 'sealing', ratio: 0.9 });

    const manifest: CapsuleManifest = {
      v: brand.envelopeVersion,
      kind: input.kind,
      template: input.template,
      ...(input.title ? { title: input.title } : {}),
      ...(input.senderAlias ? { senderAlias: input.senderAlias } : {}),
      ...(input.message ? { message: input.message } : {}),
      ...(input.markdown ? { markdown: true } : {}),
      ...(input.instructions ? { instructions: input.instructions } : {}),
      ...(input.fields && input.fields.length > 0 ? { fields: input.fields } : {}),
      ...(input.code ? { code: input.code } : {}),
      ...(fileEntries.length > 0 ? { files: fileEntries } : {}),
      receiver: input.receiver,
      createdAt: new Date().toISOString(),
    };

    const sealed = await sealManifest(manifest, rootKey, capsuleId);

    const created = await api<{ id: string; managementToken: string; expiresAt: string }>(
      '/api/v1/capsules',
      {
        method: 'POST',
        body: JSON.stringify({
          id: capsuleId,
          version: brand.envelopeVersion,
          type: input.kind === 'request' ? 'note' : input.kind,
          burnMode: input.policy.burnMode,
          maxClaims: input.policy.maxClaims,
          ttlSeconds: input.policy.ttlSeconds,
          unlockInSeconds: input.policy.unlockInSeconds,
          claimWindowSeconds: input.policy.claimWindowSeconds,
          encryptedManifest: await toBase64Url(sealed),
          uploadIds,
        }),
      },
    );

    // Build the fragment last, so the key only becomes a string at the moment
    // it is needed for display.
    const fragment = input.password
      ? await encodeFragment({
          mode: 'password',
          wrapped: await wrapRootKey(rootKey, input.password, capsuleId),
        })
      : input.splitDelivery
        ? await encodeFragment({ mode: 'split' })
        : await encodeFragment({ mode: 'key', rootKey });

    const fingerprint = await capsuleFingerprint(rootKey, capsuleId);
    const separateKey = input.splitDelivery ? await toBase64Url(rootKey) : undefined;

    onProgress?.({ phase: 'sealing', ratio: 1 });

    return {
      capsuleId,
      recipientUrl: capsuleUrl(baseUrl, capsuleId, fragment),
      manageUrl: manageUrl(baseUrl, capsuleId, created.managementToken),
      ...(separateKey ? { separateKey } : {}),
      fingerprint,
      expiresAt: created.expiresAt,
      totalBytes: sealed.length + totalPlainBytes,
    };
  } finally {
    // The root key must not outlive this call. The caller received only derived
    // strings (the fragment, the fingerprint).
    await wipe(rootKey);
  }
}

export interface OpenedCapsule {
  manifest: CapsuleManifest;
  retrievalToken: string;
  /** Kept so file downloads can decrypt after the manifest is open. */
  rootKey: Uint8Array;
  capsuleId: string;
}

/**
 * Claim and open a capsule.
 *
 * Called ONLY from an explicit user action (§15) — never on page load, never
 * from an effect that could fire during a prefetch.
 */
export async function claimAndOpen(
  capsuleId: string,
  fragment: string,
  password?: string,
  separateKeyInput?: string,
): Promise<OpenedCapsule> {
  const secret = await decodeFragment(fragment);

  let rootKey: Uint8Array;
  if (secret.mode === 'key') {
    rootKey = secret.rootKey;
  } else if (secret.mode === 'password') {
    if (!password) throw new PasswordError('password required', 'wrong-password');
    // Unwrapping happens BEFORE the claim, so a mistyped password costs an
    // Argon2id evaluation and not the capsule (§11).
    rootKey = await unwrapRootKey(secret.wrapped, password, capsuleId);
  } else {
    if (!separateKeyInput) throw new EnvelopeError('key required', 'bad-key');
    rootKey = await fromBase64Url(separateKeyInput);
  }

  const claim = await api<{ retrievalToken: string }>(`/api/v1/capsules/${capsuleId}/claim`, {
    method: 'POST',
  });

  const retrieved = await api<{ manifest: string }>('/api/v1/retrieval/manifest', {
    headers: { authorization: `Bearer ${claim.retrievalToken}` },
  });

  const manifest = await openManifest(await fromBase64Url(retrieved.manifest), rootKey, capsuleId);

  return { manifest, retrievalToken: claim.retrievalToken, rootKey, capsuleId };
}

/**
 * Download and decrypt one file, verifying the stream as it goes.
 *
 * Returns a Blob only if EVERY chunk authenticated and the stream terminated
 * properly. A partially-verified file is never handed back — the user would
 * reasonably trust whatever they were given (§13).
 */
export async function downloadFile(
  opened: OpenedCapsule,
  entry: FileEntry,
  onProgress?: ProgressFn,
): Promise<Blob> {
  const fileKey = await fromBase64Url(entry.key);
  const header = await fromBase64Url(entry.header);
  const decryptor = await createFileDecryptor(header, fileKey, opened.capsuleId, entry.objectId);

  const parts: BlobPart[] = [];
  let sawFinal = false;

  try {
    for (let index = 0; index < entry.chunkCount; index += 1) {
      const response = await fetch(
        `/api/v1/retrieval/objects/${entry.objectId}/chunks/${index}`,
        { headers: { authorization: `Bearer ${opened.retrievalToken}` }, credentials: 'omit' },
      );
      if (!response.ok) throw new ApiError(`chunk ${index} unavailable`, response.status);

      const ciphertext = new Uint8Array(await response.arrayBuffer());
      const { plaintext, isFinal } = await decryptor.decryptChunk(ciphertext, index);
      // Copy into a fresh buffer: the decryptor's output may be a view onto
      // libsodium's heap, which is reused on the next pull.
      parts.push(new Uint8Array(plaintext).buffer as ArrayBuffer);
      sawFinal = isFinal;

      onProgress?.({ phase: 'decrypting', ratio: (index + 1) / entry.chunkCount, fileName: entry.name });
    }

    if (!sawFinal) {
      throw new EnvelopeError('file truncated: refusing to deliver a partial file', 'tampered');
    }
    return new Blob(parts, { type: safeMimeType(entry.mimeType) });
  } finally {
    await wipe(fileKey);
  }
}

/**
 * Restrict the MIME type used for the object URL.
 *
 * The client-declared MIME is untrusted (§14). Anything outside the safe media
 * allowlist becomes application/octet-stream, so the browser downloads it
 * instead of rendering it — which is what stops an "image" that is really HTML
 * or SVG from executing script in our origin.
 */
const PREVIEWABLE_MIME = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'audio/mpeg',
  'audio/ogg',
  'audio/wav',
  'audio/webm',
  'video/mp4',
  'video/webm',
]);

export function safeMimeType(declared: string): string {
  return PREVIEWABLE_MIME.has(declared) ? declared : 'application/octet-stream';
}

export function canPreview(declared: string): boolean {
  return PREVIEWABLE_MIME.has(declared);
}

/**
 * Sanitise a filename in the browser, immediately before saving (§14).
 *
 * The server never sees this name, so this is the only place it can be made
 * safe. Strips path separators, control characters, leading dots, and Windows
 * reserved device names.
 */
export function sanitizeFilename(name: string): string {
  const base = name
    // Path separators would let a name escape the download directory.
    .replace(/[/\\]/g, '_')
    // Control characters (NUL especially) can truncate a name in native APIs.
    // Written with explicit escapes rather than literal bytes so the source
    // file stays free of unprintable characters.
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, '')
    // A leading dot hides the file on POSIX systems.
    .replace(/^\.+/, '')
    .trim()
    .slice(0, 200);
  const reserved = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i;
  if (base === '' || reserved.test(base)) return `download-${Date.now()}`;
  return base;
}

/** Tell the server the recipient finished, so the worker can purge promptly. */
export async function completeRetrieval(retrievalToken: string): Promise<void> {
  await fetch('/api/v1/retrieval/complete', {
    method: 'POST',
    headers: { authorization: `Bearer ${retrievalToken}` },
    credentials: 'omit',
  }).catch(() => undefined);
}

export interface PublicStatus {
  id: string;
  state: 'available' | 'consumed' | 'revoked' | 'expired' | 'destroyed';
  burnMode: 'on-claim' | 'on-download' | 'time-only';
  maxClaims: number;
  claimsRemaining: number;
  unlockAt: string | null;
  expiresAt: string;
  totalCipherBytes: number;
  objectCount: number;
}

/** Pure read — safe for link scanners and page refreshes (§15). */
export async function fetchStatus(capsuleId: string): Promise<PublicStatus | null> {
  const response = await fetch(`/api/v1/capsules/${capsuleId}/status`, { credentials: 'omit' });
  if (!response.ok) return null;
  return (await response.json()) as PublicStatus;
}
