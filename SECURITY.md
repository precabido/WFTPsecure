# Security policy

## Reporting

Email `security@example.invalid` (configured in
`packages/config/src/brand.ts`). Please report privately and allow time for a
fix before public disclosure. See also `/.well-known/security.txt`.

Useful in a report: the affected version or commit, reproduction steps, and what
an attacker gains. A proof of concept against your own capsule is welcome; do
not attack capsules you did not create.

## Scope

**In scope**

- Anything that lets the server, or someone who has compromised it, read
  capsule plaintext
- Breaking the one-time claim guarantee (two recipients winning the same capsule)
- Consuming a capsule without an explicit user action (e.g. from a GET)
- Recovering a capsule after it was consumed, revoked or expired
- Reading or acting on a capsule without the correct key or token
- Cross-capsule or cross-object ciphertext replay
- Plaintext appearing in the database, object storage, Redis, or logs
- Stored XSS via capsule content (Markdown, filenames, structured fields)

**Out of scope**

- Anything requiring a compromised sender or recipient device
- Social engineering of a link's holder
- A recipient screenshotting, photographing or forwarding content
- Weak passwords chosen by users
- The HTTP preview's exposure to an active network attacker — this is a
  documented, deliberate property of a preview deployment, not a vulnerability
  (see `docs/known-limitations.md`)
- Denial of service by volume against the public preview

## Current status

**This software has not been externally audited.** It uses standard libsodium
primitives rather than home-grown algorithms, and the security properties are
covered by 197 automated tests, but that is evidence — not assurance.

## Design commitments

These are the properties a report should measure us against:

1. Plaintext never leaves the browser unencrypted.
2. The server never receives a key, a password, or a password hash.
3. A GET never consumes a capsule.
4. At most `max_claims` recipients can ever claim a capsule.
5. Modified ciphertext is never presented as content.
6. Filenames, titles and MIME types live only inside the encrypted manifest.
7. Logs contain no capsule content, no tokens and no full URLs.

## Dependency hygiene

Versions are pinned exactly and committed in `pnpm-lock.yaml`. Audit with:

```bash
pnpm audit --audit-level=moderate
pnpm licenses list
```

There is no CDN, no remote font, and no third-party script; the
Content-Security-Policy contains no third-party origin, and an E2E test asserts
that loading the app issues zero external requests.
