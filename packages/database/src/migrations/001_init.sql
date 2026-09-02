-- capsule-envelope-v1 schema (§17).
--
-- Design rule for this file: every column must be either ciphertext, a random
-- identifier, a hash, or an operational number/timestamp. If a column could
-- ever hold something a human wrote, it does not belong here — it belongs in
-- the encrypted manifest. There are deliberately no columns for title, sender
-- alias, filename, MIME type, or password hint.

CREATE TYPE capsule_state AS ENUM (
  'available',   -- created and claimable
  'consumed',    -- claim budget exhausted; awaiting purge
  'revoked',     -- creator revoked it
  'expired',     -- past expires_at; awaiting purge
  'destroyed'    -- ciphertext purged, tombstone retained until retention window ends
);

CREATE TYPE object_state AS ENUM ('pending', 'stored', 'destroyed');
CREATE TYPE upload_state AS ENUM ('open', 'completed', 'aborted', 'expired');
CREATE TYPE lease_state AS ENUM ('active', 'completed', 'expired');
CREATE TYPE request_state AS ENUM ('open', 'closed', 'expired', 'destroyed');
CREATE TYPE submission_state AS ENUM ('pending', 'claimed', 'destroyed');

-- Burn semantics, kept explicit rather than inferred from max_claims so the
-- recipient-facing warning copy and the worker agree on intent.
CREATE TYPE burn_mode AS ENUM (
  'on-claim',      -- consumed the moment a claim wins
  'on-download',   -- consumed when retrieval completes
  'time-only'      -- never consumed by reads; only expiry destroys it
);

CREATE TABLE capsules (
  -- Client-generated 128-bit base64url id. Generated client-side so the
  -- encrypted manifest's AAD can bind the real id at encryption time without a
  -- server round-trip. High entropy is what makes enumeration impractical.
  id                            TEXT PRIMARY KEY CHECK (char_length(id) BETWEEN 16 AND 64),
  version                       TEXT NOT NULL,
  type                          TEXT NOT NULL CHECK (type IN ('note','files','combined')),
  state                         capsule_state NOT NULL DEFAULT 'available',
  burn_mode                     burn_mode NOT NULL DEFAULT 'on-claim',

  max_claims                    INTEGER NOT NULL CHECK (max_claims BETWEEN 1 AND 100),
  claims_count                  INTEGER NOT NULL DEFAULT 0 CHECK (claims_count >= 0),

  unlock_at                     TIMESTAMPTZ,
  expires_at                    TIMESTAMPTZ NOT NULL,
  claim_window_seconds          INTEGER NOT NULL CHECK (claim_window_seconds BETWEEN 30 AND 3600),

  encrypted_manifest_object_key TEXT NOT NULL,
  total_cipher_bytes            BIGINT NOT NULL DEFAULT 0 CHECK (total_cipher_bytes >= 0),

  -- SHA-256 of the opaque management token. The token itself is shown once, in
  -- the creator's browser, and never stored.
  management_token_hash         BYTEA NOT NULL,

  created_at                    TIMESTAMPTZ NOT NULL DEFAULT now(),
  claimed_at                    TIMESTAMPTZ,
  destroyed_at                  TIMESTAMPTZ,

  -- claims_count may never exceed the budget; belt-and-braces behind the
  -- conditional UPDATE that performs claims.
  CONSTRAINT claims_within_budget CHECK (claims_count <= max_claims)
);

-- Worker sweep: find things to destroy. Partial index keeps it small — rows
-- already destroyed are the majority over time and are excluded.
CREATE INDEX capsules_expiry_sweep_idx ON capsules (expires_at)
  WHERE state <> 'destroyed';
CREATE INDEX capsules_purge_sweep_idx ON capsules (state, destroyed_at)
  WHERE state <> 'destroyed';

CREATE TABLE capsule_objects (
  id           TEXT PRIMARY KEY,
  capsule_id   TEXT NOT NULL REFERENCES capsules(id) ON DELETE CASCADE,
  -- Random storage key. Never derived from a filename: a filename in a storage
  -- path would leak plaintext to anyone who can list the bucket (§14).
  storage_key  TEXT NOT NULL UNIQUE,
  chunk_count  INTEGER NOT NULL CHECK (chunk_count >= 1),
  cipher_bytes BIGINT NOT NULL CHECK (cipher_bytes >= 0),
  state        object_state NOT NULL DEFAULT 'pending',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX capsule_objects_capsule_idx ON capsule_objects (capsule_id);
CREATE INDEX capsule_objects_orphan_idx ON capsule_objects (state, created_at);

CREATE TABLE upload_sessions (
  id              TEXT PRIMARY KEY,
  token_hash      BYTEA NOT NULL,
  -- Bound to a capsule id before the capsule row exists, so a completed upload
  -- can only ever be attached to the capsule it was created for.
  capsule_id      TEXT NOT NULL,
  object_id       TEXT NOT NULL,
  storage_key     TEXT NOT NULL,
  expected_chunks INTEGER NOT NULL CHECK (expected_chunks >= 1),
  received_chunks INTEGER NOT NULL DEFAULT 0 CHECK (received_chunks >= 0),
  cipher_bytes    BIGINT NOT NULL DEFAULT 0,
  state           upload_state NOT NULL DEFAULT 'open',
  expires_at      TIMESTAMPTZ NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX upload_sessions_expiry_idx ON upload_sessions (expires_at) WHERE state = 'open';
CREATE INDEX upload_sessions_capsule_idx ON upload_sessions (capsule_id);

-- Which chunk indices have actually landed. A separate table (rather than a
-- counter alone) makes re-uploading the same index idempotent, which is what
-- makes resume safe after a dropped connection.
CREATE TABLE upload_chunks (
  upload_id    TEXT NOT NULL REFERENCES upload_sessions(id) ON DELETE CASCADE,
  chunk_index  INTEGER NOT NULL CHECK (chunk_index >= 0),
  cipher_bytes INTEGER NOT NULL CHECK (cipher_bytes >= 0),
  received_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (upload_id, chunk_index)
);

-- §15: the winning claimant gets a short lease so a flaky connection cannot
-- destroy the payload before they finish reading it.
CREATE TABLE retrieval_leases (
  id           TEXT PRIMARY KEY,
  capsule_id   TEXT NOT NULL REFERENCES capsules(id) ON DELETE CASCADE,
  token_hash   BYTEA NOT NULL,
  state        lease_state NOT NULL DEFAULT 'active',
  expires_at   TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX retrieval_leases_capsule_idx ON retrieval_leases (capsule_id);
CREATE INDEX retrieval_leases_expiry_idx ON retrieval_leases (expires_at) WHERE state = 'active';
-- Bearer token lookup must be an index probe, not a scan.
CREATE INDEX retrieval_leases_token_idx ON retrieval_leases (token_hash);

CREATE TABLE secure_requests (
  id                    TEXT PRIMARY KEY CHECK (char_length(id) BETWEEN 16 AND 64),
  version               TEXT NOT NULL,
  state                 request_state NOT NULL DEFAULT 'open',
  -- The creator's X25519 public key. Public by design: responders need it to
  -- seal their delivery, and it reveals nothing about the private key.
  public_key            BYTEA NOT NULL,
  -- Encrypted prompt describing what is being asked for.
  encrypted_prompt_key  TEXT NOT NULL,
  max_submissions       INTEGER NOT NULL CHECK (max_submissions BETWEEN 1 AND 100),
  submissions_count     INTEGER NOT NULL DEFAULT 0 CHECK (submissions_count >= 0),
  expires_at            TIMESTAMPTZ NOT NULL,
  management_token_hash BYTEA NOT NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at             TIMESTAMPTZ,
  destroyed_at          TIMESTAMPTZ,

  CONSTRAINT submissions_within_budget CHECK (submissions_count <= max_submissions)
);

CREATE INDEX secure_requests_expiry_idx ON secure_requests (expires_at) WHERE state <> 'destroyed';

CREATE TABLE request_submissions (
  id                            TEXT PRIMARY KEY,
  request_id                    TEXT NOT NULL REFERENCES secure_requests(id) ON DELETE CASCADE,
  -- Sealed content key (crypto_box_seal) — only the creator's secret key opens it.
  sealed_key                    BYTEA NOT NULL,
  encrypted_manifest_object_key TEXT NOT NULL,
  cipher_bytes                  BIGINT NOT NULL DEFAULT 0,
  state                         submission_state NOT NULL DEFAULT 'pending',
  created_at                    TIMESTAMPTZ NOT NULL DEFAULT now(),
  claimed_at                    TIMESTAMPTZ,
  destroyed_at                  TIMESTAMPTZ
);

CREATE INDEX request_submissions_request_idx ON request_submissions (request_id, created_at);
CREATE INDEX request_submissions_state_idx ON request_submissions (state);

-- Objects belonging to a submission (files the responder attached).
CREATE TABLE submission_objects (
  id            TEXT PRIMARY KEY,
  submission_id TEXT NOT NULL REFERENCES request_submissions(id) ON DELETE CASCADE,
  storage_key   TEXT NOT NULL UNIQUE,
  chunk_count   INTEGER NOT NULL CHECK (chunk_count >= 1),
  cipher_bytes  BIGINT NOT NULL CHECK (cipher_bytes >= 0),
  state         object_state NOT NULL DEFAULT 'pending',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX submission_objects_submission_idx ON submission_objects (submission_id);

-- Minimal, content-free audit trail surfaced on the management page (§21):
-- created / claimed / destroyed. No IP, no user agent, no geolocation.
CREATE TYPE capsule_event_kind AS ENUM ('created', 'claimed', 'retrieved', 'revoked', 'expired', 'destroyed');

CREATE TABLE capsule_events (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  capsule_id TEXT NOT NULL,
  kind       capsule_event_kind NOT NULL,
  at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX capsule_events_capsule_idx ON capsule_events (capsule_id, at);

-- Storage accounting so the worker can enforce a global cap without stat()ing
-- the whole tree on every request (§18).
CREATE TABLE storage_accounting (
  id            BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
  cipher_bytes  BIGINT NOT NULL DEFAULT 0 CHECK (cipher_bytes >= 0),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO storage_accounting (id, cipher_bytes) VALUES (TRUE, 0);
