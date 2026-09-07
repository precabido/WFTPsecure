/**
 * Canonical Associated Data construction (§12).
 *
 * Every ciphertext in the system is bound to *where it belongs* so that a
 * server that shuffles ciphertext cannot mislead a client. Concretely this
 * defeats: swapping chunk 5 for chunk 2, replaying object A's chunk under
 * object B's identity, replaying a capsule's manifest under a different capsule
 * id, and downgrading the envelope version.
 *
 * The encoding is length-prefixed rather than delimiter-joined. With a
 * delimiter, ("ab","c") and ("a","bc") could collide if a field ever contained
 * the delimiter; length prefixes make the serialisation injective for *any*
 * field content, so the binding cannot be forged by choosing clever ids.
 */

import { brand } from '@cinderlink/config/brand';

export type ObjectType = 'manifest' | 'file' | 'rootkey-wrap' | 'request-prompt' | 'submission';

export interface AadParts {
  /** Envelope version. Included so a v1 ciphertext can never verify as v2. */
  version: string;
  objectType: ObjectType;
  /** Capsule (or secure-request) identifier this ciphertext belongs to. */
  capsuleId: string;
  /** Object identifier within the capsule; '' for capsule-level ciphertext. */
  objectId: string;
  /** Zero for non-chunked objects. */
  chunkIndex: number;
}

const encoder = new TextEncoder();

function lengthPrefixed(value: string): Uint8Array {
  const bytes = encoder.encode(value);
  const out = new Uint8Array(4 + bytes.length);
  new DataView(out.buffer).setUint32(0, bytes.length, false);
  out.set(bytes, 4);
  return out;
}

/**
 * Build the AAD byte string for one ciphertext.
 *
 * AAD := LP(version) ‖ LP(objectType) ‖ LP(capsuleId) ‖ LP(objectId) ‖ u32be(chunkIndex)
 * where LP(s) := u32be(byteLength(s)) ‖ utf8(s)
 */
export function buildAad(parts: AadParts): Uint8Array {
  if (!Number.isInteger(parts.chunkIndex) || parts.chunkIndex < 0 || parts.chunkIndex > 0xffffffff) {
    throw new RangeError(`chunkIndex out of range: ${parts.chunkIndex}`);
  }
  const segments = [
    lengthPrefixed(parts.version),
    lengthPrefixed(parts.objectType),
    lengthPrefixed(parts.capsuleId),
    lengthPrefixed(parts.objectId),
  ];
  const total = segments.reduce((n, s) => n + s.length, 0) + 4;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const segment of segments) {
    out.set(segment, offset);
    offset += segment.length;
  }
  new DataView(out.buffer).setUint32(offset, parts.chunkIndex, false);
  return out;
}

/** AAD for the capsule's encrypted manifest. */
export function manifestAad(capsuleId: string): Uint8Array {
  return buildAad({
    version: brand.envelopeVersion,
    objectType: 'manifest',
    capsuleId,
    objectId: '',
    chunkIndex: 0,
  });
}

/** AAD for chunk `index` of file object `objectId`. */
export function fileChunkAad(capsuleId: string, objectId: string, index: number): Uint8Array {
  return buildAad({
    version: brand.envelopeVersion,
    objectType: 'file',
    capsuleId,
    objectId,
    chunkIndex: index,
  });
}

/** AAD for the password-wrapped root key carried in the URL fragment. */
export function rootKeyWrapAad(capsuleId: string): Uint8Array {
  return buildAad({
    version: brand.envelopeVersion,
    objectType: 'rootkey-wrap',
    capsuleId,
    objectId: '',
    chunkIndex: 0,
  });
}

/** AAD for a secure-request submission manifest. */
export function submissionAad(requestId: string, submissionId: string): Uint8Array {
  return buildAad({
    version: brand.envelopeVersion,
    objectType: 'submission',
    capsuleId: requestId,
    objectId: submissionId,
    chunkIndex: 0,
  });
}
