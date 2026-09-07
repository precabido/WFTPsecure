# Threat model

Honest version: what this system actually defends, what it cannot, and what
residual risk a user accepts by using it.

---

## Assets

| Asset | Where it lives | Consequence of loss |
|---|---|---|
| Capsule plaintext | Sender's browser, recipient's browser | Full disclosure |
| Root key | URL fragment, both browsers' memory | Full disclosure of that capsule |
| Per-file keys | Inside the encrypted manifest | Disclosure of that file |
| Capsule password | User's head / password manager | Enables offline attack on an intercepted link |
| Management token | Creator's management link | Ability to revoke or shorten — **not** to read |
| Retrieval token | Winning claimant, for the lease window | Ability to fetch that capsule's ciphertext |
| Request private key | Creator's management-link fragment | Ability to open deliveries |
| Operational metadata | PostgreSQL | Timing/size correlation |

Note the asymmetry: the management token permits control, never disclosure. A
stolen management link lets someone destroy a capsule, not read it.

---

## Trust boundaries

```
┌─ Sender's device ────────────┐        ┌─ Recipient's device ─────────┐
│ plaintext, rootKey, password │        │ plaintext, rootKey, password │
│ ── TRUSTED (out of scope) ── │        │ ── TRUSTED (out of scope) ── │
└──────────────┬───────────────┘        └──────────────┬───────────────┘
               │ ciphertext only                       │ ciphertext only
               ▼                                       ▼
       ┌───────────────────────────────────────────────────────┐
       │ Network  ── UNTRUSTED ──                              │
       │ Over HTTPS: sees sizes and timing.                    │
       │ Over HTTP (this preview): can also REPLACE THE CLIENT │
       │ CODE, which defeats everything below.                 │
       └───────────────────────┬───────────────────────────────┘
                               ▼
       ┌───────────────────────────────────────────────────────┐
       │ Server  ── SEMI-TRUSTED (honest but curious) ──       │
       │ Holds ciphertext, random ids, sizes, timestamps,      │
       │ token hashes. Cannot decrypt anything.                │
       └───────────────────────────────────────────────────────┘
```

The server is modelled as **honest but curious**: it may read everything it
stores, but is assumed not to serve malicious JavaScript. That assumption is the
weakest link and is stated as such below — no browser-delivered cryptography can
escape it.

---

## Adversaries

| # | Adversary | Capability | Outcome |
|---|---|---|---|
| A1 | Database thief | Full SQL dump | **Defeated.** Ciphertext, random ids, token hashes only. |
| A2 | Storage operator | Reads all blobs | **Defeated.** Ciphertext with random keys, no filenames. |
| A3 | Link scanner / mail gateway | Issues GET/HEAD | **Defeated.** GET never mutates; only POST /claim consumes. |
| A4 | Racing recipients | Two claims at once | **Defeated.** Single conditional UPDATE; exactly one winner. |
| A5 | Enumerating attacker | Guesses ids | **Defeated.** 128-bit random ids; failed claims rate-limited. |
| A6 | Ciphertext tamperer | Modifies stored blobs | **Defeated.** AEAD fails; client refuses to display. |
| A7 | Chunk shuffler | Reorders/drops/duplicates chunks | **Defeated.** secretstream + AAD chunk index. |
| A8 | Passive network (HTTPS) | Observes traffic | **Partial.** Sees sizes and timing, not content. |
| A9 | **Active network (HTTP)** | Rewrites responses | **NOT DEFEATED.** Can replace the client bundle. |
| A10 | Malicious server operator | Serves modified JS | **NOT DEFEATED.** Same as A9. |
| A11 | Compromised endpoint | Malware, keylogger, extension | **NOT DEFEATED.** Out of scope. |
| A12 | Dishonest recipient | Screenshots, forwards, copies | **NOT DEFEATED.** Cannot be. |
| A13 | Single-channel interceptor | Reads the channel carrying link+key | **NOT DEFEATED.** Split delivery mitigates. |
| A14 | Offline guesser | Has the link, guesses the password | **Partial.** Argon2id raises cost only. |
| A15 | Infrastructure snapshotter | Provider-level disk snapshots | **NOT DEFEATED.** Outside our control. |
| A16 | Supply-chain attacker | Compromises a dependency | **NOT DEFEATED.** Lockfile pinning only. |

---

## What we defend, and how

**A1 — Database theft.** Every column is ciphertext, a random id, a hash, or an
operational number. There is deliberately no column for title, sender alias,
filename, MIME type, or password hint; `.strict()` on the API schemas turns a
client that started sending such a field into a 400 rather than a silent write.

**A3 — Link scanners.** `GET /c/:id` renders a shell and reads public status.
Consumption requires `POST /api/v1/capsules/:id/claim`, reached only from an
explicit button press. No React effect performs a claim. Verified by E2E: five
GET+HEAD probes and three reloads leave a one-time capsule claimable.

**A4 — The race.** One conditional UPDATE increments the counter and tests
eligibility in the same statement. Under READ COMMITTED a second transaction
blocks on the row lock, then re-evaluates its WHERE clause against the committed
row (EvalPlanQual), matches zero rows, and reports `consumed`. A
SELECT-then-UPDATE pair would reopen the window where both read count = 0.
Verified with 100 simultaneous claimants against real PostgreSQL, repeated over
10 independent capsules.

**A6/A7 — Tampering.** Poly1305 authenticates every chunk; the AAD binds
`(version, type, capsuleId, objectId, chunkIndex)`; secretstream authenticates
the sequence and marks the end. A truncated file is refused rather than returned
as a shorter, still-authentic prefix — the user would otherwise trust it.

---

## What we do NOT defend — and why it matters

**A9/A10 — Active network attacker over HTTP, or a malicious server.** This is
the fundamental limit of browser-delivered cryptography. The code that does the
encrypting arrives over the same channel as the data. Someone who can replace
that code can exfiltrate plaintext before it is ever encrypted, and no amount of
correct cryptography below that layer helps.

Over HTTPS this narrows to "trust the server operator and their TLS". Over plain
HTTP — which is what the preview at `:9999` is — it widens to *anyone on the
path*. This is why:

- the app refuses to boot in `APP_MODE=production` unless `PUBLIC_BASE_URL`
  is `https://` or an operator has explicitly set `ALLOW_INSECURE_PREVIEW=true`;
- a warning band is shown whenever transport is not secure;
- the UI never uses the words "secure connection".

Mitigations that would genuinely help — Subresource Integrity for a static
bundle, reproducible builds, a signed-code browser extension — are listed in the
roadmap. None is implemented.

**A11/A12 — Endpoints and recipients.** If the recipient's machine is
compromised, or the recipient simply takes a photograph of the screen, nothing
here applies. The privacy curtain reduces shoulder-surfing; the UI says
explicitly that it cannot stop an OS screenshot.

**A14 — Offline password guessing.** The wrapped key is in the fragment, so an
interceptor of the *link* can guess at their leisure. Argon2id at ~0.66 s per
guess raises the cost; it does not make a weak password strong.

**A15 — Deletion limits.** We delete rows and unlink blob files. We do not and
cannot guarantee that the underlying SSD, the filesystem journal, a provider
snapshot, or a backup no longer holds the bytes. The documentation describes
this as *logical and cryptographic removal from the service plus deletion of the
stored ciphertext* — never as guaranteed physical erasure.

---

## Metadata the server unavoidably observes

Stated so that "zero metadata" is never implied:

- **IP address**, transiently, at the network layer. It is not stored: rate
  limiting keys on `HMAC(rotating secret, IP)` truncated to 16 bytes.
- **Timing** of creation, claim and retrieval.
- **Approximate size** — ciphertext length and chunk count.
- **Existence and state** of a capsule id.

Correlating creation time with claim time across two IPs is a real linkability
signal this design does not remove.

---

## Assumptions

1. libsodium is correct.
2. The browser's CSPRNG is sound.
3. The user's device is not compromised.
4. The operator does not serve malicious JavaScript.
5. Over HTTPS, TLS holds.

Assumption 4 is doing the most work. A user who cannot accept it should not use
any browser-based encryption service, including this one.

---

## Status

**Not externally audited.** The implementation uses standard libsodium
primitives rather than home-grown algorithms, and the properties above are
covered by 197 automated tests — but that is not a substitute for independent
cryptographic review, and this document does not claim otherwise.
