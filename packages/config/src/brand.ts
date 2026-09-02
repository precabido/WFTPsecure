/**
 * SINGLE SOURCE OF TRUTH FOR PRODUCT NAMING.
 *
 * The product name must never be hard-coded anywhere else in the codebase.
 * Everything user-visible (UI copy, <title>, manifest, docs headers, email-ish
 * strings) reads from here so the product can be renamed by editing this file
 * alone — no search-and-replace across hundreds of files.
 *
 * Lint rule `no-hardcoded-brand` (scripts/check-brand.sh) enforces this.
 */

export const brand = {
  /** Display name, used verbatim in UI chrome. */
  name: 'CINDERLINK',
  /** Name in running prose / sentence case. */
  nameProse: 'Cinderlink',
  /** Lowercase machine-safe slug: docker project, storage prefixes, css ns. */
  slug: 'cinderlink',

  tagline: {
    en: 'Share once. Leave nothing.',
    es: 'Compártelo una vez. Que no quede nada.',
  },

  /**
   * The core noun of the product. Deliberately NOT "message" — a capsule is a
   * container that may hold text, secrets, files, or a request for files.
   */
  unit: {
    en: { singular: 'capsule', plural: 'capsules' },
    es: { singular: 'cápsula', plural: 'cápsulas' },
  },

  /** Security contact surfaced in SECURITY.md and /.well-known/security.txt. */
  securityContact: 'security@example.invalid',

  /** Versioned crypto envelope identifier. Changing this is a breaking change. */
  envelopeVersion: 'capsule-envelope-v1',
} as const;

export type Brand = typeof brand;

/** Locale-aware unit noun, e.g. unitNoun('es', 'plural') -> 'cápsulas'. */
export function unitNoun(locale: 'en' | 'es', form: 'singular' | 'plural' = 'singular'): string {
  return brand.unit[locale][form];
}
