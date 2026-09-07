# capsule-envelope-v1 — cryptographic format

This document specifies exactly what is encrypted, with what, and how it is
serialised. It is the reference an independent reviewer should read first.

Implementation: `packages/crypto/`. Tests: `packages/crypto/test/` (80 cases).

---

## 1. Primitives

| Purpose | Algorithm | libsodium function |
|---|---|---|
| Manifest / small payloads | XChaCha20-Poly1305 (IETF) | `crypto_aead_xchacha20poly1305_ietf_*` |
| File contents | XChaCha20-Poly1305 secretstream | `crypto_secretstream_xchacha20poly1305_*` |
| Password → key | Argon2id v1.3 | `crypto_pwhash` |
| Subkey derivation | BLAKE2b-based KDF | `crypto_kdf_derive_from_key` |
| Secure-request delivery | X25519 sealed box | `crypto_box_seal` / `crypto_box_seal_open` |
| Fingerprints | BLAKE2b | `crypto_generichash` |
| Randomness (keys, ids, nonces) | libsodium CSPRNG | `randombytes_buf` |

No algorithm is implemented in this codebase. Everything above is libsodium,
loaded as `libsodium-wrappers-sumo` (the sumo build is required for
`crypto_pwhash`).

**Why XChaCha20 rather than AES-GCM:** the 192-bit nonce makes random nonce
generation safe without a counter the client would have to persist across
sessions. It also avoids depending on `SubtleCrypto`, which is unavailable on
insecure origins — a hard requirement for an HTTP preview (§6).

---

## 2. Key hierarchy

```
rootKey  (32 bytes, CSPRNG)          ← the secret carried in the URL fragment
   │
   └── manifestKey = crypto_kdf_derive_from_key(
                        subkey_len = 32,
                        subkey_id  = 1,
                        context    = "cndrlnk1",   (exactly 8 bytes)
                        key        = rootKey)

fileKey[i]  (32 bytes, CSPRNG, independent per file)
             stored INSIDE the encrypted manifest
```

Per-file keys are **not** derived from the root key. Each file gets its own
random key, held only inside the encrypted manifest. Consequences:

- Possessing one file's key discloses nothing about any other file.
- The manifest is the single gate to the whole payload — there is exactly one
  thing to protect, not N.

---

## 3. Associated Data (AAD)

Every ciphertext is bound to its position in the system, so a server that
reorders or relocates ciphertext cannot mislead a client.

```
AAD := LP(version) ‖ LP(objectType) ‖ LP(capsuleId) ‖ LP(objectId) ‖ u32be(chunkIndex)

LP(s) := u32be(byteLength(utf8(s))) ‖ utf8(s)
```

**The encoding is length-prefixed, not delimiter-joined.** With a delimiter,
`("ab","c")` and `("a","bc")` could produce identical AAD, letting an attacker
who influences ids forge a binding. Length prefixes make the serialisation
injective for *any* field content. This is asserted directly in
`packages/crypto/test/envelope.test.ts` ("AAD encoding is injective").

`objectType` values: `manifest`, `file`, `rootkey-wrap`, `request-prompt`,
`submission`.

This binding defeats, concretely:

| Attack | Defeated by |
|---|---|
| Serve chunk 5 in place of chunk 2 | `chunkIndex` in AAD + secretstream ordering |
| Serve file A's chunk as file B's | `objectId` in AAD |
| Serve capsule X's manifest as capsule Y's | `capsuleId` in AAD |
| Downgrade to an older envelope | `version` in AAD |

---

## 4. Wire format — sealed object

```
sealed := nonce(24) ‖ ciphertext ‖ tag(16)
```

The nonce is prepended rather than derived. A random 192-bit nonce makes reuse
negligible without requiring cross-session counter state in the browser.

`sealBytes` / `openBytes` in `packages/crypto/src/envelope.ts`.

---

## 5. Manifest

Serialisation for v1 is `utf8(JSON.stringify(manifest))`. The manifest is
authenticated as an opaque byte string — the AAD, not the key order, carries the
meaning — so a canonical key order is not required for v1.

Contents (all of it invisible to the server):

```jsonc
{
  "v": "capsule-envelope-v1",
  "kind": "note" | "files" | "combined" | "request",
  "template": "note" | "credentials" | "api-key" | "env-vars" | "code" | "json" | ...,
  "title": "…",             // optional
  "senderAlias": "…",       // optional, never verified, never an account
  "message": "…",           // optional
  "markdown": true,         // optional
  "instructions": "…",      // optional
  "fields": [ { "id", "label", "value", "secret", "multiline" } ],
  "code": { "language", "source" },
  "files": [ {
     "objectId", "name", "mimeType", "size", "chunkCount",
     "key":    "<base64url 32-byte file key>",
     "header": "<base64url 24-byte secretstream header>"
  } ],
  "receiver": { "theme", "accent", "destroyAnimation", "locale",
                "autoHideOnBlur", "holdToReveal", "visibleSeconds",
                "allowPreview", "forceDownload" },
  "createdAt": "ISO-8601"
}
```

Note that **filenames, MIME types and even the chosen theme live here**, not in
the database. A distinctive theme choice is a linkability signal; a filename is
often more revealing than the file.

---

## 6. Files — chunked secretstream

```
header := crypto_secretstream_init_push(fileKey)      → 24 bytes (into the manifest)
chunk[i] := push(state, plaintext[i], AD = fileChunkAad(capsuleId, objectId, i),
                 tag = (i == last ? TAG_FINAL : TAG_MESSAGE))
```

Ciphertext expansion is exactly 17 bytes per chunk (`ABYTES`).

Chunk size is **1 MiB**, chosen on measurement rather than preference.
Benchmarking secretstream over a 16 MiB payload (best of 3, after warm-up):

| Chunk size | Throughput |
|---|---|
| 64 KiB | 189 MiB/s |
| 256 KiB | 276 MiB/s |
| 512 KiB | 282 MiB/s |
| **1 MiB** | **285 MiB/s** |
| 2 MiB | 279 MiB/s |
| 4 MiB | 235 MiB/s |

Throughput is flat from 256 KiB to 2 MiB, so the tie was broken on the
constraints that do discriminate: peak memory on a phone (which holds plaintext
plus ciphertext for the in-flight chunk) and resume granularity on a flaky
mobile connection.

Secretstream, rather than per-chunk AEAD, gives three properties a naive design
would not:

1. **Reordering fails** — chunk N cannot decrypt in position M.
2. **Duplication fails** — replaying a chunk breaks the chain.
3. **Truncation is visible** — only the last chunk carries `TAG_FINAL`, so a
   short file is detected rather than silently yielding an authentic-looking
   prefix. `decryptChunks` refuses to return data if `TAG_FINAL` never arrives.

A zero-byte file still produces one empty `TAG_FINAL` chunk; a zero-chunk stream
would be indistinguishable from truncation.

---

## 7. Password protection

```
salt            := randombytes(16)
kek             := Argon2id(password, salt, ops, mem, ALG_ARGON2ID13) → 32 bytes
wrappedRootKey  := sealBytes(rootKey, kek, rootKeyWrapAad(capsuleId))
```

The password is never sent to the server — not the password, not a hash, not a
verifier. Validation is local: unwrapping either authenticates or it does not,
so a wrong password is caught **before** the capsule is claimed and costs the
capsule nothing.

**Default KDF profile: `ops = 4`, `mem = 64 MiB`.**

Measured here: libsodium's `MODERATE` profile (ops 3, mem 256 MiB) took 3.87 s,
which is unusable on a phone; `INTERACTIVE` (ops 2, mem 64 MiB) took 0.15 s,
which is too cheap. The chosen profile measures ~0.66 s. Memory is pinned at
64 MiB rather than raised because mobile Safari fails the WASM allocation well
below 256 MiB, and a capsule that cannot be opened on a phone is worse than one
that is somewhat cheaper to attack; iterations are raised to 4 to buy back
margin.

Parameters travel per capsule in the fragment, so raising the defaults later
does not break existing links. A hostile link cannot request an unbounded
allocation: `ops ≤ 16` and `8 MiB ≤ mem ≤ 512 MiB` are enforced before any
allocation happens.

**Residual risk, stated plainly:** because the wrapped key rides in the
fragment, anyone who intercepts the *link* can attack the password offline at
their own pace. Argon2id raises the per-guess cost; it does not rescue a weak
password.

---

## 8. Links

```
recipient : /c/<capsuleId>#v=1&k=<base64url rootKey>
password  : /c/<capsuleId>#v=1&p=a2&w=<wrapped>&s=<salt>&o=<ops>&m=<mem>
split     : /c/<capsuleId>#v=1&x=1        (key delivered out of band)
management: /m/<capsuleId>#t=<opaque management token>
request   : /r/<requestId>#v=1&k=<…>
```

The fragment is the delivery vehicle because browsers never transmit it: it is
absent from the request line, from access logs, and from the `Referer` header.
The path carries only a 128-bit random identifier.

`capsuleId` is generated **client-side**. This is deliberate: it lets the
manifest's AAD bind the real capsule id at encryption time without a
round-trip to learn it. The server validates the format and rejects duplicates.

### Split-delivery key encoding

The out-of-band key is base64url, grouped with **spaces**, never hyphens:

```
5GeidpzYy JbWAMZ L5g-_uj QghMU5 xWrT4q rdSXYx Cl0
```

`-` and `_` are both members of the base64url alphabet (RFC 4648 §5). A hyphen
separator would be indistinguishable from key material, and stripping hyphens on
parse silently corrupted roughly half of all keys — a real bug this codebase
shipped briefly and now has a regression test for
(`password.test.ts`, "preserves - and _").

---

## 9. Secure requests (sealed boxes)

The responder has no account and shares no secret with the creator, so
symmetric encryption is unavailable — whatever key they used would still have to
reach the creator.

```
creator publishes:  publicKey (X25519, 32 bytes) in the request link
responder does:     contentKey    := randombytes(32)
                    sealedManifest := sealBytes(manifest, contentKey,
                                                submissionAad(requestId, submissionId))
                    sealedKey      := crypto_box_seal(contentKey, creatorPublicKey)
creator opens:      contentKey := crypto_box_seal_open(sealedKey, pk, sk)
```

`crypto_box_seal` generates an ephemeral keypair and discards the ephemeral
secret, so the responder cannot decrypt their own submission afterwards.

Two layers rather than one because `crypto_box_seal` takes no associated data —
the inner AEAD layer is where the `(requestId, submissionId)` binding lives.

The creator's secret key exists only in their management-link fragment. If they
lose it, deliveries are unrecoverable. That is stated in the UI rather than
solved by escrowing the key.

---

## 10. Fingerprints

```
digest := BLAKE2b(4 bytes, "capsule-envelope-v1:fingerprint:" ‖ capsuleId ‖ ":" ‖ rootKey)
words  := FINGERPRINT_WORDS[digest[0..3]]        (256-word frozen list, 32 bits)
```

Rendered as `marea · cobre · faro · onix`. Purpose: sender and recipient compare
it over a *different* channel to confirm they hold the same capsule.

It is **not** a second factor and must never be presented as one — it is derived
entirely from material the link already carries.

---

## 11. Memory hygiene

Key material is passed to `sodium.memzero` as soon as it is no longer needed:
`manifestKey` after sealing, `fileKey` after each file, `kek` after wrapping,
`contentKey` after sealing a submission, and `rootKey` when a viewer unmounts.

**This is best effort, not a guarantee.** JavaScript gives no way to reach copies
the engine may have made — interned strings, GC-relocated buffers, JIT spill
slots. `memzero` clears the buffer it is handed and nothing else. See
`docs/known-limitations.md`.

---

## 12. Forward compatibility

The envelope version appears in three places: the manifest body, the AAD of
every ciphertext, and the link (`v=1`). A client meeting an unknown version
refuses rather than guessing. Because the version is in the AAD, a v1 ciphertext
can never authenticate as v2 even if an attacker rewrites the JSON field.

Changing `brand.envelopeVersion` is a breaking change: it invalidates every
existing link and every existing fingerprint.
