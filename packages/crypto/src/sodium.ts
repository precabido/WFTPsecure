/**
 * Lazy libsodium loader (§7, §28).
 *
 * libsodium's WASM payload is ~200 KB and costs real time to instantiate, so it
 * must never be pulled into the initial bundle of an informational page. Every
 * crypto entry point in this package awaits `getSodium()`, which imports the
 * module on first use and memoises the ready instance.
 *
 * We use the *sumo* build because we need crypto_pwhash (Argon2id), which is
 * absent from the standard build.
 */

// The upstream package has no bundled types that match the sumo surface we use,
// so we describe exactly the subset this codebase depends on.
export interface Sodium {
  crypto_aead_xchacha20poly1305_ietf_KEYBYTES: number;
  crypto_aead_xchacha20poly1305_ietf_NPUBBYTES: number;
  crypto_aead_xchacha20poly1305_ietf_ABYTES: number;
  crypto_aead_xchacha20poly1305_ietf_keygen(): Uint8Array;
  crypto_aead_xchacha20poly1305_ietf_encrypt(
    message: Uint8Array,
    additionalData: Uint8Array | null,
    secretNonce: null,
    publicNonce: Uint8Array,
    key: Uint8Array,
  ): Uint8Array;
  crypto_aead_xchacha20poly1305_ietf_decrypt(
    secretNonce: null,
    ciphertext: Uint8Array,
    additionalData: Uint8Array | null,
    publicNonce: Uint8Array,
    key: Uint8Array,
  ): Uint8Array;

  crypto_secretstream_xchacha20poly1305_KEYBYTES: number;
  crypto_secretstream_xchacha20poly1305_HEADERBYTES: number;
  crypto_secretstream_xchacha20poly1305_ABYTES: number;
  crypto_secretstream_xchacha20poly1305_TAG_MESSAGE: number;
  crypto_secretstream_xchacha20poly1305_TAG_FINAL: number;
  crypto_secretstream_xchacha20poly1305_keygen(): Uint8Array;
  crypto_secretstream_xchacha20poly1305_init_push(key: Uint8Array): {
    state: unknown;
    header: Uint8Array;
  };
  crypto_secretstream_xchacha20poly1305_push(
    state: unknown,
    message: Uint8Array,
    additionalData: Uint8Array | null,
    tag: number,
  ): Uint8Array;
  crypto_secretstream_xchacha20poly1305_init_pull(header: Uint8Array, key: Uint8Array): unknown;
  crypto_secretstream_xchacha20poly1305_pull(
    state: unknown,
    ciphertext: Uint8Array,
    additionalData: Uint8Array | null,
  ): { message: Uint8Array; tag: number } | false;

  crypto_pwhash_SALTBYTES: number;
  crypto_pwhash_ALG_ARGON2ID13: number;
  crypto_pwhash_OPSLIMIT_INTERACTIVE: number;
  crypto_pwhash_MEMLIMIT_INTERACTIVE: number;
  crypto_pwhash(
    outLength: number,
    password: string | Uint8Array,
    salt: Uint8Array,
    opsLimit: number,
    memLimit: number,
    algorithm: number,
  ): Uint8Array;

  crypto_kdf_KEYBYTES: number;
  crypto_kdf_derive_from_key(
    subkeyLength: number,
    subkeyId: number,
    context: string,
    key: Uint8Array,
  ): Uint8Array;

  crypto_box_PUBLICKEYBYTES: number;
  crypto_box_SECRETKEYBYTES: number;
  crypto_box_keypair(): { publicKey: Uint8Array; privateKey: Uint8Array; keyType: string };
  crypto_box_seal(message: Uint8Array, publicKey: Uint8Array): Uint8Array;
  crypto_box_seal_open(
    ciphertext: Uint8Array,
    publicKey: Uint8Array,
    privateKey: Uint8Array,
  ): Uint8Array;

  crypto_generichash(hashLength: number, message: Uint8Array, key?: Uint8Array | null): Uint8Array;

  randombytes_buf(length: number): Uint8Array;
  randombytes_uniform(upperBound: number): number;
  memzero(bytes: Uint8Array): void;

  to_base64(bytes: Uint8Array, variant: number): string;
  from_base64(input: string, variant: number): Uint8Array;
  base64_variants: { URLSAFE_NO_PADDING: number; ORIGINAL: number };
}

let sodiumPromise: Promise<Sodium> | null = null;

/**
 * Resolve the ready libsodium instance. Safe to call concurrently — the import
 * and the `ready` await happen exactly once.
 */
export function getSodium(): Promise<Sodium> {
  if (sodiumPromise === null) {
    sodiumPromise = import('libsodium-wrappers-sumo').then(async (mod) => {
      // The package ships both a default export and a namespace depending on
      // the bundler/interop path; normalise before awaiting `ready`.
      const candidate = (mod as unknown as { default?: unknown }).default ?? mod;
      const sodium = candidate as Sodium & { ready: Promise<void> };
      await sodium.ready;
      return sodium as Sodium;
    });
  }
  return sodiumPromise;
}

/** Test seam: forget the memoised instance. Not used in production paths. */
export function resetSodiumForTests(): void {
  sodiumPromise = null;
}
