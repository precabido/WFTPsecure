/**
 * API contracts (§16).
 *
 * Every request body and route parameter is validated here before it reaches a
 * handler. Two rules shape these schemas:
 *
 *   1. The server must never accept a field it has no business storing. There
 *      is no `title`, `filename` or `mimeType` anywhere in this file — if such
 *      a field appeared, a client bug could start leaking plaintext and the
 *      server would happily persist it. `.strict()` makes unexpected fields a
 *      400 rather than a silent pass-through.
 *   2. Bounds come from @cinderlink/config so the preview's abuse limits and
 *      the validation layer cannot drift apart.
 */

import { z } from 'zod';
import { limits } from '@cinderlink/config/limits';

/** Opaque high-entropy id: base64url, 16–64 chars. */
export const idSchema = z
  .string()
  .min(16)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/, 'id must be base64url');

const base64urlSchema = z
  .string()
  .max(4096)
  .regex(/^[A-Za-z0-9_-]*$/, 'expected base64url');

export const capsuleTypeSchema = z.enum(['note', 'files', 'combined']);
export const burnModeSchema = z.enum(['on-claim', 'on-download', 'time-only']);

const maxTtlMs = limits.maxTtlHours * 3600 * 1000;

/**
 * Expiry is accepted as a duration in seconds rather than an absolute
 * timestamp, so a client with a skewed clock cannot create a capsule that is
 * already expired or that outlives the policy ceiling.
 */
export const createCapsuleSchema = z
  .object({
    id: idSchema,
    version: z.string().min(1).max(64),
    type: capsuleTypeSchema,
    burnMode: burnModeSchema,
    maxClaims: z.number().int().min(1).max(limits.maxClaims),
    ttlSeconds: z
      .number()
      .int()
      .min(60)
      .max(Math.floor(maxTtlMs / 1000)),
    unlockInSeconds: z.number().int().min(0).max(Math.floor(maxTtlMs / 1000)).nullable().default(null),
    claimWindowSeconds: z
      .number()
      .int()
      .min(30)
      .max(limits.maxClaimWindowSeconds)
      .default(limits.defaultClaimWindowSeconds),
    /** Base64url ciphertext of the manifest. The server never decodes it. */
    encryptedManifest: z
      .string()
      .min(1)
      .max(Math.ceil((limits.maxManifestCipherBytes * 4) / 3) + 16)
      .regex(/^[A-Za-z0-9_-]+$/, 'manifest must be base64url'),
    /** Upload session ids whose objects belong to this capsule. */
    uploadIds: z.array(idSchema).max(limits.maxFilesPerCapsule).default([]),
  })
  .strict();

export type CreateCapsuleRequest = z.infer<typeof createCapsuleSchema>;

export const createCapsuleResponseSchema = z.object({
  id: z.string(),
  managementToken: z.string(),
  expiresAt: z.string(),
});

export const capsuleStatusResponseSchema = z.object({
  id: z.string(),
  state: z.enum(['available', 'consumed', 'revoked', 'expired', 'destroyed']),
  burnMode: burnModeSchema,
  maxClaims: z.number(),
  claimsRemaining: z.number(),
  unlockAt: z.string().nullable(),
  expiresAt: z.string(),
  totalCipherBytes: z.number(),
  objectCount: z.number(),
});

export const claimResponseSchema = z.object({
  retrievalToken: z.string(),
  leaseExpiresAt: z.string(),
  claimsRemaining: z.number(),
});

export const createUploadSchema = z
  .object({
    capsuleId: idSchema,
    expectedChunks: z
      .number()
      .int()
      .min(1)
      .max(Math.ceil(limits.maxFileBytes / limits.chunkBytes) + 1),
  })
  .strict();

export const uploadChunkParamsSchema = z.object({
  uploadId: idSchema,
  chunkIndex: z.coerce.number().int().min(0).max(100_000),
});

export const completeUploadSchema = z.object({}).strict();

export const revokeSchema = z.object({}).strict();

export const updateExpirySchema = z
  .object({
    ttlSeconds: z
      .number()
      .int()
      .min(60)
      .max(Math.floor(maxTtlMs / 1000)),
  })
  .strict();

export const createRequestSchema = z
  .object({
    id: idSchema,
    version: z.string().min(1).max(64),
    /** Creator's X25519 public key, base64url. 32 bytes -> 43 chars. */
    publicKey: base64urlSchema.min(43).max(43),
    encryptedPrompt: z
      .string()
      .min(1)
      .max(Math.ceil((limits.maxManifestCipherBytes * 4) / 3) + 16)
      .regex(/^[A-Za-z0-9_-]+$/),
    maxSubmissions: z.number().int().min(1).max(limits.maxSubmissionsPerRequest),
    ttlSeconds: z
      .number()
      .int()
      .min(60)
      .max(Math.floor(maxTtlMs / 1000)),
  })
  .strict();

export const createSubmissionSchema = z
  .object({
    /** Sealed content key (crypto_box_seal output: 32 + 48 bytes). */
    sealedKey: base64urlSchema.min(100).max(140),
    encryptedManifest: z
      .string()
      .min(1)
      .max(Math.ceil((limits.maxManifestCipherBytes * 4) / 3) + 16)
      .regex(/^[A-Za-z0-9_-]+$/),
    uploadIds: z.array(idSchema).max(limits.maxFilesPerCapsule).default([]),
  })
  .strict();

/**
 * Error envelope.
 *
 * `reason` is a stable machine code so the UI can localise the message. It is
 * intentionally coarse for lookup failures: 'unavailable' covers not-found,
 * consumed, revoked and destroyed on hostile paths so that probing an id
 * teaches an attacker nothing (§21).
 */
export const errorResponseSchema = z.object({
  error: z.string(),
  reason: z.string().optional(),
});

export type ErrorResponse = z.infer<typeof errorResponseSchema>;

export const healthResponseSchema = z.object({
  status: z.literal('ok'),
  build: z.string(),
});

export { z };
