/**
 * URL fragment encoding (§11).
 *
 * The fragment (`#…`) is the delivery vehicle for key material because browsers
 * never send it to the server: it is absent from the request line, from access
 * logs, and from the `Referer` header. The path carries only an opaque id.
 *
 *   /c/<capsuleId>#v=1&k=<base64url rootKey>
 *
 * Three delivery shapes exist:
 *   - 'key'      the root key rides in the fragment (default, one-click open)
 *   - 'password' only a password-wrapped root key rides along (§11)
 *   - 'split'    no key travels with the link at all; it is delivered by hand
 *
 * Everything here is pure string handling — it never touches the network, and
 * callers must keep it that way. In particular the fragment must never be put
 * into a fetch URL, an <img> src, or an analytics payload.
 */

import { fromBase64Url, toBase64Url } from './bytes.ts';
import type { KdfParams, WrappedRootKey } from './password.ts';

/** Fragment schema version. Bumped independently of the envelope version. */
export const LINK_VERSION = '1';

export type CapsuleLinkSecret =
  | { mode: 'key'; rootKey: Uint8Array }
  | { mode: 'password'; wrapped: WrappedRootKey }
  | { mode: 'split' };

export type LinkErrorCode = 'unsupported-version' | 'malformed';

export class LinkError extends Error {
  override readonly name = 'LinkError';
  readonly code: LinkErrorCode;

  constructor(message: string, code: LinkErrorCode) {
    super(message);
    this.code = code;
  }
}

/** Encode the secret half of a capsule link (everything after '#'). */
export async function encodeFragment(secret: CapsuleLinkSecret): Promise<string> {
  const params = new URLSearchParams();
  params.set('v', LINK_VERSION);

  switch (secret.mode) {
    case 'key':
      params.set('k', await toBase64Url(secret.rootKey));
      break;
    case 'password':
      params.set('p', 'a2'); // argon2id13
      params.set('w', await toBase64Url(secret.wrapped.wrapped));
      params.set('s', await toBase64Url(secret.wrapped.salt));
      params.set('o', String(secret.wrapped.kdf.ops));
      params.set('m', String(secret.wrapped.kdf.mem));
      break;
    case 'split':
      params.set('x', '1'); // key delivered out of band
      break;
  }
  return params.toString();
}

/** Decode a fragment previously produced by {@link encodeFragment}. */
export async function decodeFragment(fragment: string): Promise<CapsuleLinkSecret> {
  const params = new URLSearchParams(fragment.replace(/^#/, ''));
  const version = params.get('v');
  if (version !== LINK_VERSION) {
    throw new LinkError(`unsupported link version: ${String(version)}`, 'unsupported-version');
  }

  if (params.get('p') !== null) {
    const alg = params.get('p');
    if (alg !== 'a2') throw new LinkError(`unsupported KDF marker: ${alg}`, 'unsupported-version');
    const wrapped = params.get('w');
    const salt = params.get('s');
    const ops = Number.parseInt(params.get('o') ?? '', 10);
    const mem = Number.parseInt(params.get('m') ?? '', 10);
    if (wrapped === null || salt === null || !Number.isFinite(ops) || !Number.isFinite(mem)) {
      throw new LinkError('password link is missing required parameters', 'malformed');
    }
    const kdf: KdfParams = { alg: 'argon2id13', ops, mem };
    try {
      return {
        mode: 'password',
        wrapped: {
          wrapped: await fromBase64Url(wrapped),
          salt: await fromBase64Url(salt),
          kdf,
        },
      };
    } catch {
      throw new LinkError('password link contains invalid base64url', 'malformed');
    }
  }

  const key = params.get('k');
  if (key !== null) {
    try {
      return { mode: 'key', rootKey: await fromBase64Url(key) };
    } catch {
      throw new LinkError('link key is not valid base64url', 'malformed');
    }
  }

  if (params.get('x') === '1') return { mode: 'split' };

  throw new LinkError('link carries no recognised secret', 'malformed');
}

/** Build the full recipient URL. */
export function capsuleUrl(baseUrl: string, capsuleId: string, fragment: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/c/${encodeURIComponent(capsuleId)}#${fragment}`;
}

/** Build the private management URL. Kept visually separate from the recipient
 *  link in the UI (§21) — mixing them is how management tokens leak. */
export function manageUrl(baseUrl: string, capsuleId: string, managementToken: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/m/${encodeURIComponent(capsuleId)}#t=${encodeURIComponent(managementToken)}`;
}

/** Build the public URL a responder uses to answer a secure request. */
export function requestUrl(baseUrl: string, requestId: string, fragment: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/r/${encodeURIComponent(requestId)}#${fragment}`;
}
