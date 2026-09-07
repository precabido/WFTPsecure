/**
 * Operational limits (§18, §29).
 *
 * Preview values are deliberately conservative: the public preview is anonymous
 * and unauthenticated, so every limit here is an abuse-control boundary, not a
 * product ceiling. All values are overridable via environment so a private
 * deployment can raise them without a code change.
 */

const MiB = 1024 * 1024;

function intFrom(source: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = source[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function int(name: string, fallback: number): number {
  return intFrom(process.env, name, fallback);
}

export const limits = {
  /** Max plaintext characters in a note capsule (enforced client-side; the
   *  server only ever sees ciphertext, so it enforces the ciphertext bound). */
  maxTextChars: int('MAX_TEXT_CHARS', 100_000),

  maxFilesPerCapsule: int('MAX_FILES_PER_CAPSULE', 10),
  maxFileBytes: int('MAX_FILE_MB', 50) * MiB,
  maxCapsuleCipherBytes: int('MAX_CAPSULE_MB', 100) * MiB,

  /** Encrypted manifest is small by construction; cap it to stop blob abuse. */
  maxManifestCipherBytes: int('MAX_MANIFEST_KB', 512) * 1024,

  /**
   * Chunk size for streamed file encryption (§13 allows 1–4 MiB).
   *
   * Chosen as 1 MiB on measurement, not on feel. Benchmarking secretstream over
   * a 16 MiB payload showed throughput is flat between 256 KiB and 2 MiB
   * (276–285 MiB/s) and only degrades at 4 MiB; see docs/qa-report.md. Since
   * speed does not discriminate, the tie is broken on the constraints that do:
   *   - peak memory: a phone holds plaintext + ciphertext for the in-flight
   *     chunk, so 1 MiB halves the high-water mark versus 2 MiB;
   *   - resumability: finer chunks mean less repeated work after a dropped
   *     connection on a mobile network.
   */
  chunkBytes: int('CHUNK_BYTES', 1 * MiB),

  /** Ciphertext chunk is plaintext + secretstream ABYTES (17). Allow slack. */
  maxChunkCipherBytes: int('CHUNK_BYTES', 1 * MiB) + 4096,

  maxTtlHours: int('MAX_TTL_HOURS', 24),
  maxClaims: int('MAX_CLAIMS', 10),

  /** How long a winning claimant has to finish downloading (§15 lease). */
  defaultClaimWindowSeconds: int('CLAIM_WINDOW_SECONDS', 900),
  maxClaimWindowSeconds: int('MAX_CLAIM_WINDOW_SECONDS', 3600),

  /** Upload sessions are garbage-collected after this long without completion. */
  uploadSessionTtlSeconds: int('UPLOAD_SESSION_TTL_SECONDS', 3600),

  maxSubmissionsPerRequest: int('MAX_SUBMISSIONS_PER_REQUEST', 20),

  /** Refuse new uploads above this disk utilisation (§18). */
  storagePressurePercent: int('STORAGE_PRESSURE_PERCENT', 80),
} as const;

/** TTL presets offered in the UI (§10). Values in seconds. */
export const ttlPresets = [
  { id: '5m', seconds: 300 },
  { id: '15m', seconds: 900 },
  { id: '30m', seconds: 1800 },
  { id: '1h', seconds: 3600 },
  { id: '6h', seconds: 21600 },
  { id: '24h', seconds: 86400 },
  { id: '3d', seconds: 259200 },
  { id: '7d', seconds: 604800 },
] as const;

export type TtlPresetId = (typeof ttlPresets)[number]['id'];

/** Read-window presets, in seconds, for burn-after-open (§10). */
export const readWindowPresets = [10, 30, 60, 300] as const;

export interface RateLimits {
  createPerHour: number;
  claimPerHour: number;
  /** Failed claims are limited far harder — this is the enumeration surface. */
  failedClaimPerHour: number;
  uploadChunkPerHour: number;
  concurrentUploads: number;
}

/**
 * Resolve rate limits from a specific environment.
 *
 * Takes `source` explicitly rather than reading process.env at module scope.
 * The static `limits` object above is read once at import, which is correct for
 * values baked into Zod schemas — but rate limits are per-application state, and
 * an app that accepts an `env` argument must actually honour it. Capturing them
 * at import time made `buildApp({ env })` silently ignore the caller's limits,
 * which a test caught by exhausting a window that never closed.
 */
export function resolveRateLimits(source: NodeJS.ProcessEnv = process.env): RateLimits {
  return {
    createPerHour: intFrom(source, 'RL_CREATE_PER_HOUR', 30),
    claimPerHour: intFrom(source, 'RL_CLAIM_PER_HOUR', 120),
    failedClaimPerHour: intFrom(source, 'RL_FAILED_CLAIM_PER_HOUR', 40),
    uploadChunkPerHour: intFrom(source, 'RL_CHUNK_PER_HOUR', 2000),
    concurrentUploads: intFrom(source, 'RL_CONCURRENT_UPLOADS', 4),
  };
}

/** Process-level defaults, for callers with no per-app environment. */
export const rateLimits: RateLimits = resolveRateLimits();
