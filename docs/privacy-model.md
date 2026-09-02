# Privacy model

What the server sees, what it does not, and what remains observable regardless.

---

## What the server stores

| Category | Examples |
|---|---|
| Ciphertext | Encrypted manifests, encrypted file chunks, sealed submission keys |
| Random identifiers | Capsule ids (128-bit), object ids, storage keys, lease ids |
| Sizes | Ciphertext byte counts, chunk counts |
| Timestamps | Created, expires, unlock, claimed, destroyed |
| Counters | Claims used vs. permitted; submissions used vs. permitted |
| Hashes | SHA-256 of management, retrieval and upload tokens |
| State | available / consumed / revoked / expired / destroyed |
| Public keys | X25519 public key of a secure request (public by design) |

## What the server never receives

- Content, in any form
- Titles, sender aliases, messages, instructions
- Real filenames or MIME types
- Capsule passwords — not the password, not a hash, not a verifier
- Root keys or per-file keys
- The private key of a secure request
- Recipient themes and display preferences

These are enforced structurally rather than by convention: the database has no
column for them, and the API schemas use `.strict()`, so a client that began
sending a `title` field receives a 400 instead of silently writing plaintext.
There is a test for exactly that.

## Verification

`scripts/verify-no-plaintext.sh` creates a capsule whose every plaintext-bearing
field contains a unique canary, then searches:

1. PostgreSQL — every column of every table (`CAST(row AS text)`, so a column
   added later cannot be silently skipped)
2. Object storage — every blob, and every object key
3. Redis — every key name and value
4. Service logs — API, worker, gateway
5. The public status response
6. The server-rendered HTML

`scripts/verify-canary-detector.sh` then plants canaries deliberately and
asserts the detector reports them, so a passing result is not vacuous.

## Metadata that is unavoidable

**IP addresses.** To answer a request the server transiently sees the client's
address at the network layer. It is not stored. For abuse control we compute:

```
identity = HMAC-SHA256(rotating_secret, "<epoch>:<ip>")   truncated to 16 bytes
```

Only that identity and a counter reach Redis. The secret rotates (default
daily), so after rotation yesterday's counters cannot be re-linked to an address
even by someone holding the raw IP.

We do not claim "zero metadata". The following remain observable to a party who
can watch the network or read the database:

- **Timing** — when a capsule was created, claimed, retrieved
- **Approximate size** — ciphertext length reveals a bound on plaintext length
- **Existence** — whether a given id exists and what state it is in
- **Correlation** — creation and claim events can be linked in time

## Logging

Logs record the HTTP method, the *unresolved route pattern*
(`/api/v1/capsules/:capsuleId`, never the concrete id), and the status code.

Redacted before writing: `authorization`, `cookie`, `set-cookie`,
`x-management-token`, request bodies, and any field named `token`,
`retrievalToken`, `managementToken`, `encryptedManifest` or `sealedKey`.

The full URL is never logged. Capsule secrets live in the fragment and never
reach the server at all, but the *path* still contains the capsule id, and
correlating ids across log lines is exactly the trail we promised not to keep.

## Retention

| Data | Retained |
|---|---|
| Ciphertext | Until expiry, consumption or revocation, then deleted by the worker |
| Capsule tombstone | 24 hours after destruction, so the answer is "no longer available" rather than "never existed" |
| Rate-limit counters | One window (default 1 hour) |
| Upload sessions | 1 hour if never completed |
| Logs | Per operator policy; rotated at 10 MB × 5 files |

Deletion is described as **logical and cryptographic removal from the service,
plus deletion of the stored ciphertext**. It is not a claim about SSD sectors,
filesystem journals, or provider snapshots.

## Backups

Backups, if configured, should cover schema and configuration — not the
ephemeral ciphertext. Backing up capsule blobs would defeat the product: a
capsule "destroyed" at 14:00 would still exist in a 13:00 snapshot. See
`docs/runbook.md`.

## No accounts, no tracking

No user accounts, no cookies for identification, no analytics, no third-party
scripts, no remote fonts, no CDN. The Content-Security-Policy contains no
third-party origin at all, and an E2E test asserts that loading the app issues
zero external requests.

Local history ("remember this capsule on this device") is opt-in, off by
default, stores only the management reference, and never leaves the browser.
