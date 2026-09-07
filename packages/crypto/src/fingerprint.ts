/**
 * Capsule fingerprints and split-delivery key formatting (§11).
 *
 * A fingerprint is a short, human-speakable digest of (rootKey, capsuleId) that
 * sender and recipient can compare over a *different* channel — "does yours say
 * marea · cobre · faro · onix?". It detects a swapped link; it is not a second
 * factor and must never be presented as one, because it is derived from
 * material the link already carries.
 */

import { getSodium } from './sodium.ts';
import { concatBytes, utf8 } from './bytes.ts';
import { FINGERPRINT_WORDS } from './wordlist.ts';
import { brand } from '@cinderlink/config/brand';

const FINGERPRINT_WORD_COUNT = 4;

/**
 * Derive the fingerprint words for a capsule.
 *
 * Domain-separated by the envelope version so the same key under a future
 * envelope yields a different fingerprint.
 */
export async function capsuleFingerprint(
  rootKey: Uint8Array,
  capsuleId: string,
): Promise<string[]> {
  const sodium = await getSodium();
  const input = concatBytes(
    utf8.encode(`${brand.envelopeVersion}:fingerprint:`),
    utf8.encode(capsuleId),
    utf8.encode(':'),
    rootKey,
  );
  const digest = sodium.crypto_generichash(FINGERPRINT_WORD_COUNT, input);
  const words: string[] = [];
  for (let i = 0; i < FINGERPRINT_WORD_COUNT; i += 1) {
    words.push(FINGERPRINT_WORDS[digest[i] as number] as string);
  }
  return words;
}

/** Render a fingerprint for display: "marea · cobre · faro · onix". */
export function formatFingerprint(words: string[]): string {
  return words.join(' · ');
}

/**
 * Format a base64url key for out-of-band delivery (§11 split delivery).
 *
 * Grouping makes a 43-character key transcribable by a human reading it aloud
 * without losing their place.
 *
 * The separator is a SPACE, not a hyphen. This matters: '-' and '_' are both
 * members of the base64url alphabet (RFC 4648 §5), so a hyphen separator would
 * be indistinguishable from key material, and stripping hyphens on parse would
 * silently corrupt every key that happens to contain one — roughly half of
 * them. Whitespace is outside the alphabet, so the encoding stays reversible.
 */
export const DELIVERY_KEY_SEPARATOR = ' ';

export function formatDeliveryKey(base64UrlKey: string, groupSize = 6): string {
  const groups: string[] = [];
  for (let i = 0; i < base64UrlKey.length; i += groupSize) {
    groups.push(base64UrlKey.slice(i, i + groupSize));
  }
  return groups.join(DELIVERY_KEY_SEPARATOR);
}

/**
 * Inverse of {@link formatDeliveryKey}.
 *
 * Strips whitespace only — including the line breaks that chat clients insert
 * when wrapping. It must never strip '-' or '_'; see the note above. Case is
 * preserved because base64url is case-significant.
 */
export function parseDeliveryKey(input: string): string {
  return input.replace(/\s+/g, '');
}
