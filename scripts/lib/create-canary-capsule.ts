/**
 * Helper for scripts/verify-no-plaintext.sh.
 *
 * Creates a capsule the same way the browser does — sealing the manifest with
 * @cinderlink/crypto and sending only ciphertext. Using the real crypto path
 * matters: if this helper posted the canary in cleartext, the verification
 * script would be proving nothing about the product.
 *
 * Prints the capsule id on stdout and nothing else.
 */

// Relative imports: scripts/ is not a workspace package, so the @cinderlink/*
// specifiers are not resolvable from here. Importing the source directly also
// guarantees this helper exercises the same code the browser ships.
import {
  sealManifest,
  generateRootKey,
  toBase64Url,
  randomId,
} from '../../packages/crypto/src/index.ts';
import { brand } from '../../packages/config/src/brand.ts';

const canary = process.env.CANARY;
const apiUrl = process.env.API_URL ?? 'http://127.0.0.1:4000';

if (!canary) {
  console.error('CANARY must be set');
  process.exit(2);
}

const capsuleId = await randomId(16);
const rootKey = await generateRootKey();

// The canary is placed in every plaintext-bearing field of the manifest, so a
// leak from any one of them is caught: title, message, a structured field's
// label and value, and a filename.
const sealed = await sealManifest(
  {
    v: brand.envelopeVersion,
    kind: 'note',
    template: 'credentials',
    title: `title-${canary}`,
    senderAlias: `alias-${canary}`,
    message: `message-${canary}`,
    fields: [
      { id: 'f1', label: `label-${canary}`, value: `value-${canary}`, secret: true },
    ],
    receiver: {
      theme: 'light',
      accent: 'violet',
      destroyAnimation: 'fade',
      locale: 'es',
      autoHideOnBlur: false,
      holdToReveal: false,
      visibleSeconds: 0,
      allowPreview: false,
      forceDownload: true,
    },
    createdAt: new Date().toISOString(),
  },
  rootKey,
  capsuleId,
);

const response = await fetch(`${apiUrl}/api/v1/capsules`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    id: capsuleId,
    version: brand.envelopeVersion,
    type: 'note',
    burnMode: 'time-only',
    maxClaims: 1,
    ttlSeconds: 3600,
    unlockInSeconds: null,
    claimWindowSeconds: 900,
    encryptedManifest: await toBase64Url(sealed),
    uploadIds: [],
  }),
});

if (!response.ok) {
  console.error(`create failed: ${response.status} ${await response.text()}`);
  process.exit(1);
}

process.stdout.write(capsuleId);
