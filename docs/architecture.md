# Architecture

## Services

```mermaid
flowchart TB
    subgraph browser["Browser — the only place plaintext exists"]
        UI["Next.js UI"]
        CRYPTO["@cinderlink/crypto<br/>libsodium (WASM, lazy)"]
        UI <--> CRYPTO
    end

    subgraph host["VPS — one published port"]
        GW["gateway<br/>nginx-unprivileged :8080<br/><b>published 9999</b>"]
        WEB["web<br/>Next.js :3000"]
        API["api<br/>Fastify :4000"]
        WORKER["worker<br/>sweep + reconcile"]
        PG[("postgres<br/>source of truth")]
        REDIS[("redis<br/>rate limits, locks")]
        BLOB[["object storage<br/>ciphertext only"]]
    end

    browser -->|"HTTP(S) — ciphertext only"| GW
    GW --> WEB
    GW -->|/api, /healthz| API
    API --> PG
    API --> REDIS
    API --> BLOB
    WORKER --> PG
    WORKER --> BLOB

    style browser fill:#efeaff,stroke:#5b34f0
    style BLOB fill:#fdf3e2,stroke:#8a5b0d
```

Only the gateway publishes a port. PostgreSQL, Redis, the API and the web app
are reachable only on `cinderlink_preview_9999_net`.

## Creating a capsule

```mermaid
sequenceDiagram
    participant B as Browser
    participant A as API
    participant S as Storage
    participant P as PostgreSQL

    Note over B: rootKey = randombytes(32)<br/>capsuleId generated locally
    loop each file
        B->>A: POST /uploads {capsuleId, expectedChunks}
        A->>P: INSERT upload_session
        A-->>B: uploadId, uploadToken
        loop each 1 MiB chunk
            Note over B: secretstream push,<br/>AAD binds (capsuleId, objectId, i)
            B->>A: PUT /uploads/:id/chunks/:i (ciphertext)
            A->>S: write blob
            A->>P: record chunk (idempotent)
        end
        B->>A: POST /uploads/:id/complete
        A->>P: verify EVERY index present, then close
    end
    Note over B: seal manifest (contains<br/>filenames + per-file keys)
    B->>A: POST /capsules {id, encryptedManifest, policy}
    A->>S: store manifest ciphertext
    A->>P: INSERT capsule + objects (transaction)
    A-->>B: managementToken (shown once)
    Note over B: link = /c/<id>#v=1&k=<rootKey>
```

The capsule row is created **only after every upload has completed**, so an
interrupted upload can never produce a usable capsule.

## Opening a capsule — the two-step gate

```mermaid
sequenceDiagram
    participant R as Recipient
    participant W as Web
    participant A as API
    participant P as PostgreSQL

    R->>W: GET /c/:id            (scanners land here too)
    W->>A: GET /capsules/:id/status
    A->>P: SELECT (pure read)
    A-->>W: state, policy, expiry
    W-->>R: gate — nothing consumed

    Note over R: explicit press:<br/>"Open and consume"
    R->>A: POST /capsules/:id/claim
    A->>P: single conditional UPDATE<br/>(increment + eligibility together)
    alt won
        P-->>A: row
        A->>P: INSERT retrieval_lease
        A-->>R: retrievalToken (short-lived)
        R->>A: GET /retrieval/manifest (Bearer)
        Note over R: decrypt locally with rootKey<br/>from the URL fragment
    else lost or unavailable
        P-->>A: 0 rows
        A-->>R: 404 unavailable (generic shape)
    end
```

## Secure request

```mermaid
sequenceDiagram
    participant C as Creator
    participant A as API
    participant D as Responder

    Note over C: X25519 keypair;<br/>secret key stays in the fragment
    C->>A: POST /requests {publicKey, encryptedPrompt}
    A-->>C: managementToken
    D->>A: GET /requests/:id/status
    A-->>D: publicKey + encrypted prompt
    Note over D: contentKey = random(32)<br/>seal manifest under contentKey<br/>crypto_box_seal(contentKey, publicKey)
    D->>A: POST /requests/:id/submissions
    Note over D: ephemeral secret discarded —<br/>responder cannot reopen it
    C->>A: POST /manage/requests/:id/.../claim
    A-->>C: sealedKey + sealed manifest
    Note over C: crypto_box_seal_open with the<br/>secret key from the fragment
```

## Packages

| Package | Responsibility | Does I/O? |
|---|---|---|
| `@cinderlink/config` | Brand name (single source), limits, env guard | no |
| `@cinderlink/crypto` | capsule-envelope-v1: seal, open, wrap, stream | no |
| `@cinderlink/contracts` | Zod schemas for every request | no |
| `@cinderlink/database` | Schema, migrations, **the atomic claim** | PostgreSQL |
| `@cinderlink/storage` | `StorageAdapter` + filesystem implementation | filesystem |
| `@cinderlink/test-utils` | Fast bulk RNG, polling helpers | no |

`@cinderlink/crypto` performs no I/O by design: it takes bytes and returns
bytes, which keeps the security-relevant surface small and testable in
isolation.

## Key dependencies

| Dependency | Version | Why |
|---|---|---|
| libsodium-wrappers-sumo | 0.7.15 | Sumo build required for Argon2id |
| fastify | 5.2.0 | Small, fast, schema-first |
| pg | 8.13.1 | Direct SQL; the claim must be one statement |
| ioredis | 5.4.2 | Rate limiting only |
| next / react | 15.1.3 / 19.0.0 | App Router, standalone output |
| tailwindcss | 3.4.17 | Utility engine; all visual design is our own |
| zod | 3.24.1 | Contract validation |
| qrcode-generator | 1.4.4 | Zero-dependency; lazy-loaded on the result screen |

All versions pinned exactly. No CDN, no remote fonts, no third-party scripts.
