# CINDERLINK

**Share once. Leave nothing.** · *Compártelo una vez. Que no quede nada.*

Encrypted, ephemeral capsules for sharing a message, a credential, or a file
with one person, once. Everything is encrypted in the browser before it leaves
the device; the server stores ciphertext, random identifiers and the dates it
needs to expire things — and nothing else.

> **Status:** working software, verified by 185 automated tests. **Not
> externally audited.** The preview configuration runs over plain HTTP and is
> for test data only — see [Limitations](#limitations).

---

## The problem

Sending a password over chat leaves it in the scrollback, in the other person's
backup, and in whatever the app syncs to. Deleting your copy does not delete
theirs. Most "self-destructing" services fix the retention problem and keep the
disclosure one: the server can still read what you sent.

CINDERLINK does both. Content is encrypted in your browser under a key that
travels in the URL fragment — the part browsers never transmit — so the server
holds ciphertext it cannot open, and it destroys that ciphertext when the
capsule is consumed or expires.

## Quick start

```bash
pnpm install

# Services (Docker Compose provides these in a real deployment)
export DATABASE_URL="postgres://postgres@127.0.0.1:5432/cinderlink"
export REDIS_URL="redis://127.0.0.1:6379"
export STORAGE_DRIVER=filesystem
export STORAGE_ROOT=/srv/cinderlink/data/object-storage
export APP_MODE=preview ALLOW_INSECURE_PREVIEW=true

pnpm migrate
pnpm dev:api                                    # :4000
API_ORIGIN=http://127.0.0.1:4000 pnpm --filter @cinderlink/web dev   # :3000
```

Deployed:

```bash
./scripts/bootstrap-secrets.sh    # writes /srv/cinderlink/config/preview.env, mode 600
./scripts/deploy-preview.sh       # gates, builds, starts, health-checks, rolls back on failure
```

## How it works

1. Your browser generates a random 256-bit root key and encrypts the content.
2. Files are encrypted in 1 MiB chunks and uploaded; a whole file is never held
   in memory.
3. The capsule is created **only after every chunk has landed**.
4. You get a link whose fragment carries the key: `/c/<id>#v=1&k=<key>`.
5. Opening the link shows a gate. **Loading the page consumes nothing** — link
   scanners, chat previews and refreshes are all harmless.
6. Pressing *Open and consume* claims the capsule. Exactly one claimant can win.
7. Once consumed or expired, the worker deletes the ciphertext.

## Architecture

```
browser ──ciphertext──▶ gateway(9999) ──▶ web (Next.js)
                                      └──▶ api (Fastify) ──▶ postgres  (source of truth)
                                                          ├──▶ redis    (rate limits)
                                                          └──▶ storage  (ciphertext blobs)
                                            worker ───────▶ postgres + storage (sweep, reconcile)
```

Only the gateway publishes a port. See [docs/architecture.md](docs/architecture.md)
for sequence diagrams of creation, opening and secure requests.

| Package | Responsibility |
|---|---|
| `@cinderlink/config` | Product name (one file), limits, insecure-transport guard |
| `@cinderlink/crypto` | `capsule-envelope-v1` — seal, open, wrap, stream. No I/O. |
| `@cinderlink/contracts` | Zod schemas; `.strict()` so unknown fields are rejected |
| `@cinderlink/database` | Schema, migrations, the atomic claim |
| `@cinderlink/storage` | `StorageAdapter` + private filesystem backend |

## Cryptography

| Purpose | Algorithm |
|---|---|
| Manifests | XChaCha20-Poly1305 (IETF) |
| Files | `crypto_secretstream_xchacha20poly1305`, 1 MiB chunks |
| Passwords | Argon2id (ops 4, 64 MiB) — never sent to the server |
| Secure requests | X25519 sealed boxes |
| Randomness | libsodium CSPRNG |

Every ciphertext is bound by length-prefixed AAD to
`(version, objectType, capsuleId, objectId, chunkIndex)`, so a chunk cannot be
replayed into another position, another file, another capsule, or another
envelope version.

Full specification: [docs/crypto-format.md](docs/crypto-format.md).

## Threat model in one paragraph

Defends against a stolen database, a curious storage operator, link scanners,
racing recipients, id enumeration, and ciphertext tampering. Does **not** defend
against a compromised device on either end, a recipient who screenshots, a
single channel carrying both link and key, weak passwords, or — over plain
HTTP — an attacker who replaces the JavaScript that does the encrypting. Full
analysis: [docs/threat-model.md](docs/threat-model.md).

## Development

```bash
pnpm typecheck
pnpm test                 # 80 crypto unit tests, no services needed
pnpm test:integration     # 55 tests; needs PostgreSQL + Redis
pnpm e2e                  # 50 browser tests; needs the stack running
pnpm verify:no-plaintext  # canary sweep across DB, storage, Redis, logs
```

The API and worker run TypeScript directly under Node's native type stripping —
no build step, so the code that runs is the code that was reviewed. That is why
nothing in `apps/` or `packages/` uses TypeScript syntax that emits code
(parameter properties, enums, decorators).

## Environment

| Variable | Default | Notes |
|---|---|---|
| `APP_MODE` | `development` | `production` enforces HTTPS |
| `PUBLIC_BASE_URL` | `http://127.0.0.1:9999` | Must be `https://` in production |
| `ALLOW_INSECURE_PREVIEW` | `false` | Explicit acknowledgement of no TLS |
| `PUBLIC_PREVIEW_WARNING` | tracks transport | Shows the HTTP warning band |
| `DATABASE_URL` / `REDIS_URL` | — | Required |
| `STORAGE_DRIVER` / `STORAGE_ROOT` | `filesystem` | Must be outside the web root |
| `RATE_LIMIT_SECRET` | random per process | HMAC key for pseudonymous identities |
| `MAX_FILE_MB` / `MAX_CAPSULE_MB` | 50 / 100 | Preview limits |
| `MAX_TTL_HOURS` | 24 | Preview ceiling |

**The app refuses to start** in `APP_MODE=production` when `PUBLIC_BASE_URL` is
not `https://`, unless `ALLOW_INSECURE_PREVIEW=true` is set deliberately. It
exits 78 (`EX_CONFIG`) with an explanation rather than serving a promise it
cannot keep.

## Recovery

There are no accounts, and nothing is escrowed:

- **Lost management link** → no way to regain control; the capsule still expires
  on schedule.
- **Lost capsule key** → the content is unrecoverable. That is the design.
- **Lost secure-request private key** → deliveries are permanently unreadable.

Operational recovery (failed deploys, storage pressure, stuck services) is in
[docs/runbook.md](docs/runbook.md).

## Limitations

Read [docs/known-limitations.md](docs/known-limitations.md) before trusting this
with anything real. The short version:

- **The HTTP preview is not secure.** Over plain HTTP an attacker on the path
  can replace the encrypting code. Test data only.
- **Browser-delivered crypto trusts the server** even over HTTPS.
- **Screenshots cannot be prevented.** The privacy curtain says so itself.
- **Memory zeroing is best effort** — JavaScript offers no guarantee.
- **Deletion is logical and cryptographic**, not a claim about SSD sectors or
  provider snapshots.
- **Not audited.**

## Renaming

The product name lives in exactly one file: `packages/config/src/brand.ts`.
Change it there and it changes everywhere — UI, page titles, docs headers.

## Documentation

| Document | Contents |
|---|---|
| [HANDOFF-DEPLOY.md](docs/HANDOFF-DEPLOY.md) | **First-deployment brief**, including what must not be touched on a shared host |
| [architecture.md](docs/architecture.md) | Diagrams, flows, dependencies |
| [crypto-format.md](docs/crypto-format.md) | Envelope spec, AAD, KDF, links |
| [threat-model.md](docs/threat-model.md) | Adversaries, boundaries, residual risk |
| [privacy-model.md](docs/privacy-model.md) | What the server sees and stores |
| [runbook.md](docs/runbook.md) | Start, stop, deploy, rollback, recovery |
| [qa-report.md](docs/qa-report.md) | Test results, measurements, defects found |
| [known-limitations.md](docs/known-limitations.md) | Honest limits |
| [SECURITY.md](SECURITY.md) | Reporting and scope |

## Roadmap

Not implemented: official CLI, browser extension, mobile apps, WebRTC live
handoff, multi-recipient wrapped keys, WebAuthn, team workspaces, Tor onion
service, custom domains, reproducible builds, external audit, bug bounty,
transparency report, TypeScript/Python SDKs.

## Licence

Not yet selected.
