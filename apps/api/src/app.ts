/**
 * Fastify application (§16).
 *
 * Route design constraints that show up throughout:
 *   - No token ever appears in a path. Retrieval and management tokens travel
 *     in `Authorization: Bearer`, because paths land in logs, referrers and
 *     browser history in ways headers do not.
 *   - GET never mutates. Claiming is a POST and only a POST (§15).
 *   - Lookup failures collapse to one generic response so that probing an id
 *     cannot distinguish "never existed" from "already consumed" (§21).
 */

import Fastify, { type FastifyInstance, type FastifyRequest, type FastifyReply } from 'fastify';
import { Redis } from 'ioredis';
import { z } from 'zod';
import { resolveEnv, limits, resolveRateLimits, brand } from '@cinderlink/config';
import {
  createCapsuleSchema,
  createUploadSchema,
  uploadChunkParamsSchema,
  updateExpirySchema,
  createRequestSchema,
  createSubmissionSchema,
  idSchema,
} from '@cinderlink/contracts';
import * as db from '@cinderlink/database';
import { chunkKey, type StorageAdapter } from '@cinderlink/storage';
import { createLogger } from './logger.ts';
import { registerSecurity } from './security.ts';
import { RateLimiter, clientAddress } from './rate-limit.ts';
import { DiskGuard } from './disk.ts';

export interface BuildOptions {
  storage: StorageAdapter;
  redis: Redis;
  env?: NodeJS.ProcessEnv;
}

/** Generic unavailable response — used for every capsule lookup failure. */
function unavailable(reply: FastifyReply, reason: string) {
  return reply.code(404).send({ error: 'unavailable', reason });
}

function bearerToken(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (typeof header !== 'string') return null;
  const match = /^Bearer\s+([A-Za-z0-9_-]{20,200})$/.exec(header.trim());
  return match?.[1] ?? null;
}

export async function buildApp(options: BuildOptions): Promise<FastifyInstance> {
  const appEnv = options.env ?? process.env;
  const env = resolveEnv(appEnv);
  // Resolved from THIS app's environment, not captured at module import, so a
  // caller passing `env` actually gets the limits it asked for.
  const rateLimits = resolveRateLimits(appEnv);
  const logger = createLogger();
  const trustProxy = appEnv.TRUST_PROXY === 'true';

  const app = Fastify({
    loggerInstance: logger,
    trustProxy,
    // Ciphertext chunks are the largest bodies; cap generously but finitely.
    bodyLimit: limits.maxChunkCipherBytes + 64 * 1024,
    disableRequestLogging: false,
    // Never echo a stack trace or internal path to a client.
    genReqId: () => db.generateId(8),
  });

  const limiter = new RateLimiter(
    options.redis,
    appEnv.RATE_LIMIT_SECRET,
    Number.parseInt(appEnv.RATE_LIMIT_ROTATION_SECONDS ?? '86400', 10),
  );

  registerSecurity(app, { previewMode: env.previewMode });

  // Raw binary bodies for chunk uploads. Chunks are opaque ciphertext, so no
  // parsing happens — the buffer goes straight to storage.
  app.addContentTypeParser(
    'application/octet-stream',
    { parseAs: 'buffer' },
    (_request, body, done) => done(null, body),
  );

  /**
   * Tolerate an empty JSON body.
   *
   * Several endpoints legitimately take no body — claim, revoke, close,
   * retrieval-complete. Fastify's default JSON parser rejects an empty body
   * whenever `content-type: application/json` is present, which is a reasonable
   * default for a data-carrying API but wrong for these routes: it makes
   * `curl -X POST -H 'content-type: application/json' .../claim` fail, and it
   * made the browser client fail until it stopped sending the header. Treating
   * an empty body as `{}` accepts both shapes and keeps genuinely malformed
   * JSON a 400.
   */
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_request, body, done) => {
    const text = typeof body === 'string' ? body.trim() : '';
    if (text === '') return done(null, {});
    try {
      done(null, JSON.parse(text) as unknown);
    } catch {
      const error = new Error('malformed JSON body') as Error & { statusCode?: number };
      error.statusCode = 400;
      done(error, undefined);
    }
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof z.ZodError) {
      // Report that validation failed, not which field or what was expected —
      // schema shape is a free hint for someone probing the API.
      request.log.warn({ issues: error.issues.length }, 'validation failed');
      return reply.code(400).send({ error: 'invalid-request' });
    }
    // Fastify's own errors (malformed JSON, empty body with a JSON
    // content-type, payload too large) carry an accurate 4xx statusCode.
    // Blanket-500ing them was wrong twice over: it told the caller the server
    // had broken when the request had, and it turned every client mistake into
    // an error-level log line that would page someone. Preserve the status and
    // log a bad request at warn.
    const statusCode = (error as { statusCode?: number }).statusCode;
    if (typeof statusCode === 'number' && statusCode >= 400 && statusCode < 500) {
      request.log.warn({ code: (error as { code?: string }).code, statusCode }, 'bad request');
      return reply.code(statusCode).send({
        error: statusCode === 413 ? 'payload-too-large' : 'invalid-request',
      });
    }
    request.log.error({ err: error }, 'request failed');
    return reply.code(500).send({ error: 'internal-error' });
  });

  app.setNotFoundHandler((_request, reply) => reply.code(404).send({ error: 'not-found' }));

  /** Pseudonymous identity for this request (§18). */
  const identify = (request: FastifyRequest): string =>
    limiter.identify(clientAddress(request.headers, request.socket.remoteAddress, trustProxy));

  async function enforce(
    request: FastifyRequest,
    reply: FastifyReply,
    bucket: string,
    limit: number,
    windowSeconds = 3600,
  ): Promise<boolean> {
    const result = await limiter.consume(bucket, identify(request), limit, windowSeconds);
    if (!result.allowed) {
      reply.header('Retry-After', String(result.resetSeconds));
      reply.code(429).send({ error: 'rate-limited' });
      return false;
    }
    return true;
  }

  /**
   * Refuse new writes when the disk is close to full, or our own quota is spent
   * (§18).
   *
   * Checks REAL filesystem utilisation, not just an accounting counter. A byte
   * cap cannot tell you whether there is room on a host you share with other
   * services.
   */
  // Both bounds are resolved from THIS app's environment. `limits` is captured
  // from process.env at module import, so using it directly here would repeat
  // the bug already fixed for rate limits: buildApp({ env }) would silently
  // ignore the caller's threshold.
  const diskGuard = new DiskGuard({
    storageRoot: appEnv.STORAGE_ROOT ?? '/tmp',
    pressurePercent: Number.parseInt(
      appEnv.STORAGE_PRESSURE_PERCENT ?? String(limits.storagePressurePercent),
      10,
    ),
    // Absolute floor. On a shared volume this, not the percentage, is what
    // keeps the host safe: it guarantees we never write the disk below a
    // fixed reserve regardless of how full other tenants have made it.
    minFreeBytes: Number.parseInt(appEnv.STORAGE_MIN_FREE_BYTES ?? String(2 * 1024 * 1024 * 1024), 10),
    capBytes: Number.parseInt(appEnv.STORAGE_CAP_BYTES ?? String(8 * 1024 * 1024 * 1024), 10),
  });

  async function storageHasRoom(additionalBytes: number): Promise<boolean> {
    return (await diskGuard.check(additionalBytes, await db.getStorageUsage())) === null;
  }

  // ---------------------------------------------------------------- health

  app.get('/healthz', async (_request, reply) => {
    // §29: status and build id only. No hostname, no versions, no DB URL.
    return reply.send({ status: 'ok', build: env.buildId });
  });

  // --------------------------------------------------------------- uploads

  app.post('/api/v1/uploads', async (request, reply) => {
    if (!(await enforce(request, reply, 'create', rateLimits.createPerHour))) return reply;
    const body = createUploadSchema.parse(request.body);

    if (!(await storageHasRoom(body.expectedChunks * limits.chunkBytes))) {
      return reply.code(507).send({ error: 'storage-full' });
    }
    if (!(await limiter.acquireSlot(identify(request), rateLimits.concurrentUploads, 3600))) {
      return reply.code(429).send({ error: 'too-many-uploads' });
    }

    const session = await db.createUploadSession({
      capsuleId: body.capsuleId,
      expectedChunks: body.expectedChunks,
      ttlSeconds: limits.uploadSessionTtlSeconds,
    });

    return reply.code(201).send({
      uploadId: session.uploadId,
      uploadToken: session.uploadToken,
      objectId: session.objectId,
      expiresAt: session.expiresAt.toISOString(),
      chunkBytes: limits.chunkBytes,
    });
  });

  app.put('/api/v1/uploads/:uploadId/chunks/:chunkIndex', async (request, reply) => {
    if (!(await enforce(request, reply, 'chunk', rateLimits.uploadChunkPerHour))) return reply;

    const params = uploadChunkParamsSchema.parse(request.params);
    const token = bearerToken(request);
    if (token === null) return reply.code(401).send({ error: 'unauthorized' });

    const session = await db.authorizeUpload(params.uploadId, token);
    if (session === null) return reply.code(401).send({ error: 'unauthorized' });

    if (params.chunkIndex >= session.expectedChunks) {
      return reply.code(400).send({ error: 'chunk-index-out-of-range' });
    }

    const body = request.body;
    if (!Buffer.isBuffer(body) || body.length === 0) {
      return reply.code(400).send({ error: 'empty-chunk' });
    }
    if (body.length > limits.maxChunkCipherBytes) {
      return reply.code(413).send({ error: 'chunk-too-large' });
    }

    // Write the blob first, then record it. If we crash between the two, the
    // orphan blob is reclaimed by reconciliation (§19); the reverse order would
    // leave a recorded chunk with no data, which the recipient could not detect
    // until decryption failed.
    await options.storage.put(chunkKey(session.storageKey, params.chunkIndex), new Uint8Array(body));
    const result = await db.recordChunk(params.uploadId, params.chunkIndex, body.length);

    return reply.code(result.duplicate ? 200 : 201).send({ received: true, duplicate: result.duplicate });
  });

  app.get('/api/v1/uploads/:uploadId/status', async (request, reply) => {
    const { uploadId } = z.object({ uploadId: idSchema }).parse(request.params);
    const token = bearerToken(request);
    if (token === null || (await db.authorizeUpload(uploadId, token)) === null) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    const status = await db.getUploadStatus(uploadId);
    if (status === null) return reply.code(404).send({ error: 'not-found' });
    return reply.send({
      state: status.state,
      expectedChunks: status.expectedChunks,
      receivedChunks: status.receivedChunks,
      receivedIndices: status.receivedIndices,
      expiresAt: status.expiresAt.toISOString(),
    });
  });

  app.post('/api/v1/uploads/:uploadId/complete', async (request, reply) => {
    const { uploadId } = z.object({ uploadId: idSchema }).parse(request.params);
    const token = bearerToken(request);
    if (token === null || (await db.authorizeUpload(uploadId, token)) === null) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    const result = await db.completeUpload(uploadId);
    if (!result.ok) return reply.code(409).send({ error: result.reason });
    await limiter.releaseSlot(identify(request));
    return reply.send({ objectId: result.objectId, chunkCount: result.chunkCount });
  });

  app.delete('/api/v1/uploads/:uploadId', async (request, reply) => {
    const { uploadId } = z.object({ uploadId: idSchema }).parse(request.params);
    const token = bearerToken(request);
    const session = token === null ? null : await db.authorizeUpload(uploadId, token);
    if (session === null) return reply.code(401).send({ error: 'unauthorized' });
    await db.abortUpload(uploadId);
    await options.storage.deletePrefix(session.storageKey);
    await limiter.releaseSlot(identify(request));
    return reply.code(204).send();
  });

  // -------------------------------------------------------------- capsules

  app.post('/api/v1/capsules', async (request, reply) => {
    if (!(await enforce(request, reply, 'create', rateLimits.createPerHour))) return reply;
    const body = createCapsuleSchema.parse(request.body);

    const manifest = Buffer.from(body.encryptedManifest, 'base64url');
    if (manifest.length === 0 || manifest.length > limits.maxManifestCipherBytes) {
      return reply.code(413).send({ error: 'manifest-too-large' });
    }

    // Only uploads created for THIS capsule id may be attached. Without this
    // check a caller could adopt someone else's completed upload by id.
    const uploads = await db.listCompletedUploads(body.id);
    const allowed = new Set(uploads.map((u) => u.objectId));
    const attached = uploads.filter((u) => body.uploadIds.length === 0 || allowed.has(u.objectId));

    const objectBytes = attached.reduce((sum, u) => sum + u.cipherBytes, 0);
    const totalCipherBytes = objectBytes + manifest.length;
    if (totalCipherBytes > limits.maxCapsuleCipherBytes) {
      return reply.code(413).send({ error: 'capsule-too-large' });
    }
    if (attached.length > limits.maxFilesPerCapsule) {
      return reply.code(413).send({ error: 'too-many-files' });
    }
    if (!(await storageHasRoom(totalCipherBytes))) {
      return reply.code(507).send({ error: 'storage-full' });
    }

    const managementToken = db.generateToken();
    const manifestKey = `manifests/${db.generateId(24)}`;
    await options.storage.put(manifestKey, new Uint8Array(manifest));

    const expiresAt = new Date(Date.now() + body.ttlSeconds * 1000);
    const unlockAt =
      body.unlockInSeconds === null || body.unlockInSeconds === 0
        ? null
        : new Date(Date.now() + body.unlockInSeconds * 1000);

    try {
      await db.createCapsule({
        id: body.id,
        version: body.version,
        type: body.type,
        burnMode: body.burnMode,
        maxClaims: body.maxClaims,
        unlockAt,
        expiresAt,
        claimWindowSeconds: body.claimWindowSeconds,
        encryptedManifestObjectKey: manifestKey,
        totalCipherBytes,
        managementTokenHash: db.hashToken(managementToken),
        objects: attached.map((u) => ({
          id: u.objectId,
          storageKey: u.storageKey,
          chunkCount: u.chunkCount,
          cipherBytes: u.cipherBytes,
        })),
      });
    } catch (error) {
      // Roll back the blob we just wrote so a rejected create leaves nothing.
      await options.storage.delete(manifestKey).catch(() => undefined);
      if ((error as { code?: string }).code === '23505') {
        return reply.code(409).send({ error: 'id-already-exists' });
      }
      throw error;
    }

    return reply.code(201).send({
      id: body.id,
      managementToken,
      expiresAt: expiresAt.toISOString(),
    });
  });

  /**
   * Public status. Safe for link scanners: it is a pure read (§15).
   */
  app.get('/api/v1/capsules/:capsuleId/status', async (request, reply) => {
    const { capsuleId } = z.object({ capsuleId: idSchema }).parse(request.params);
    const status = await db.getPublicStatus(capsuleId);
    if (status === null) return unavailable(reply, 'not-found');
    return reply.send(status);
  });

  /**
   * Claim — the only endpoint that consumes a capsule, and it is a POST.
   */
  app.post('/api/v1/capsules/:capsuleId/claim', async (request, reply) => {
    const { capsuleId } = z.object({ capsuleId: idSchema }).parse(request.params);
    if (!(await enforce(request, reply, 'claim', rateLimits.claimPerHour))) return reply;

    const result = await db.claimCapsule(capsuleId);
    if (!result.ok) {
      // Failed claims are limited harder than successful ones: this is the
      // endpoint an enumeration attack would hammer.
      await limiter.consume('claim-fail', identify(request), rateLimits.failedClaimPerHour, 3600);
      return unavailable(reply, result.reason);
    }

    return reply.send({
      retrievalToken: result.retrievalToken,
      leaseExpiresAt: result.leaseExpiresAt.toISOString(),
      claimsRemaining: result.claimsRemaining,
    });
  });

  // ------------------------------------------------------------- retrieval

  app.get('/api/v1/retrieval/manifest', async (request, reply) => {
    const token = bearerToken(request);
    if (token === null) return reply.code(401).send({ error: 'unauthorized' });
    const lease = await db.resolveRetrievalLease(token);
    if (lease === null) return reply.code(401).send({ error: 'unauthorized' });

    const manifest = await options.storage.get(lease.manifestObjectKey);
    if (manifest === null) return unavailable(reply, 'destroyed');

    const objects = await db.listCapsuleObjects(lease.capsuleId);
    return reply.send({
      manifest: Buffer.from(manifest).toString('base64url'),
      objects: objects.map((o) => ({ objectId: o.objectId, chunkCount: o.chunkCount })),
    });
  });

  app.get('/api/v1/retrieval/objects/:objectId/chunks/:chunkIndex', async (request, reply) => {
    const params = z
      .object({ objectId: z.string().min(8).max(64), chunkIndex: z.coerce.number().int().min(0).max(100_000) })
      .parse(request.params);

    const token = bearerToken(request);
    if (token === null) return reply.code(401).send({ error: 'unauthorized' });
    const lease = await db.resolveRetrievalLease(token);
    if (lease === null) return reply.code(401).send({ error: 'unauthorized' });

    // The object must belong to the leased capsule; otherwise a valid lease for
    // capsule A would read capsule B's chunks.
    const object = await db.findCapsuleObject(lease.capsuleId, params.objectId);
    if (object === null) return unavailable(reply, 'not-found');
    if (params.chunkIndex >= object.chunkCount) return reply.code(400).send({ error: 'chunk-index-out-of-range' });

    const data = await options.storage.get(chunkKey(object.storageKey, params.chunkIndex));
    if (data === null) return unavailable(reply, 'destroyed');

    // Always an attachment, never inline: the browser must not be tempted to
    // render ciphertext as HTML or SVG (§14).
    reply.header('Content-Type', 'application/octet-stream');
    reply.header('Content-Disposition', 'attachment');
    return reply.send(Buffer.from(data));
  });

  app.post('/api/v1/retrieval/complete', async (request, reply) => {
    const token = bearerToken(request);
    if (token === null) return reply.code(401).send({ error: 'unauthorized' });
    const lease = await db.resolveRetrievalLease(token);
    if (lease === null) return reply.code(401).send({ error: 'unauthorized' });
    await db.completeRetrieval(lease.leaseId);
    return reply.code(204).send();
  });

  // ------------------------------------------------------------ management

  async function requireManagement(
    request: FastifyRequest,
    reply: FastifyReply,
    capsuleId: string,
  ): Promise<boolean> {
    const token = bearerToken(request);
    if (token === null || !(await db.findByManagementToken(capsuleId, token))) {
      reply.code(401).send({ error: 'unauthorized' });
      return false;
    }
    return true;
  }

  app.get('/api/v1/manage/:capsuleId/status', async (request, reply) => {
    const { capsuleId } = z.object({ capsuleId: idSchema }).parse(request.params);
    if (!(await requireManagement(request, reply, capsuleId))) return reply;
    const view = await db.getManagementView(capsuleId);
    if (view === null) return unavailable(reply, 'not-found');
    return reply.send({
      ...view.status,
      unlockAt: view.status.unlockAt?.toISOString() ?? null,
      expiresAt: view.status.expiresAt.toISOString(),
      createdAt: view.status.createdAt.toISOString(),
      claimedAt: view.status.claimedAt?.toISOString() ?? null,
      events: view.events,
    });
  });

  app.post('/api/v1/manage/:capsuleId/revoke', async (request, reply) => {
    const { capsuleId } = z.object({ capsuleId: idSchema }).parse(request.params);
    if (!(await requireManagement(request, reply, capsuleId))) return reply;
    const revoked = await db.revokeCapsule(capsuleId);
    return reply.send({ revoked });
  });

  app.patch('/api/v1/manage/:capsuleId/expiry', async (request, reply) => {
    const { capsuleId } = z.object({ capsuleId: idSchema }).parse(request.params);
    if (!(await requireManagement(request, reply, capsuleId))) return reply;
    const body = updateExpirySchema.parse(request.body);
    const result = await db.updateExpiry(
      capsuleId,
      new Date(Date.now() + body.ttlSeconds * 1000),
      limits.maxTtlHours * 3600 * 1000,
    );
    if (!result.ok) return reply.code(409).send({ error: result.reason });
    return reply.send({ ok: true });
  });

  // ------------------------------------------------------- secure requests

  app.post('/api/v1/requests', async (request, reply) => {
    if (!(await enforce(request, reply, 'create', rateLimits.createPerHour))) return reply;
    const body = createRequestSchema.parse(request.body);

    const publicKey = Buffer.from(body.publicKey, 'base64url');
    if (publicKey.length !== 32) return reply.code(400).send({ error: 'invalid-public-key' });

    const prompt = Buffer.from(body.encryptedPrompt, 'base64url');
    if (prompt.length === 0 || prompt.length > limits.maxManifestCipherBytes) {
      return reply.code(413).send({ error: 'prompt-too-large' });
    }

    const managementToken = db.generateToken();
    const promptKey = `prompts/${db.generateId(24)}`;
    await options.storage.put(promptKey, new Uint8Array(prompt));

    const expiresAt = new Date(Date.now() + body.ttlSeconds * 1000);
    try {
      await db.createSecureRequest({
        id: body.id,
        version: body.version,
        publicKey,
        encryptedPromptKey: promptKey,
        maxSubmissions: body.maxSubmissions,
        expiresAt,
        managementTokenHash: db.hashToken(managementToken),
      });
    } catch (error) {
      await options.storage.delete(promptKey).catch(() => undefined);
      if ((error as { code?: string }).code === '23505') return reply.code(409).send({ error: 'id-already-exists' });
      throw error;
    }

    return reply.code(201).send({ id: body.id, managementToken, expiresAt: expiresAt.toISOString() });
  });

  app.get('/api/v1/requests/:requestId/status', async (request, reply) => {
    const { requestId } = z.object({ requestId: idSchema }).parse(request.params);
    const status = await db.getRequestPublicStatus(requestId);
    if (status === null) return unavailable(reply, 'not-found');

    const prompt = await options.storage.get(status.promptKey);
    return reply.send({
      id: status.id,
      state: status.state,
      publicKey: status.publicKey,
      encryptedPrompt: prompt === null ? null : Buffer.from(prompt).toString('base64url'),
      submissionsRemaining: status.submissionsRemaining,
      expiresAt: status.expiresAt,
    });
  });

  app.post('/api/v1/requests/:requestId/submissions', async (request, reply) => {
    const { requestId } = z.object({ requestId: idSchema }).parse(request.params);
    if (!(await enforce(request, reply, 'create', rateLimits.createPerHour))) return reply;
    const body = createSubmissionSchema.parse(request.body);

    const manifest = Buffer.from(body.encryptedManifest, 'base64url');
    const sealedKey = Buffer.from(body.sealedKey, 'base64url');
    if (manifest.length === 0 || manifest.length > limits.maxManifestCipherBytes) {
      return reply.code(413).send({ error: 'manifest-too-large' });
    }
    if (!(await storageHasRoom(manifest.length))) return reply.code(507).send({ error: 'storage-full' });

    const uploads = await db.listCompletedUploads(requestId);
    const manifestKey = `submissions/${db.generateId(24)}`;
    await options.storage.put(manifestKey, new Uint8Array(manifest));

    const result = await db.addSubmission({
      requestId,
      sealedKey,
      encryptedManifestObjectKey: manifestKey,
      cipherBytes: manifest.length + uploads.reduce((sum, u) => sum + u.cipherBytes, 0),
      objects: uploads.map((u) => ({
        id: u.objectId,
        storageKey: u.storageKey,
        chunkCount: u.chunkCount,
        cipherBytes: u.cipherBytes,
      })),
    });

    if (!result.ok) {
      await options.storage.delete(manifestKey).catch(() => undefined);
      return reply.code(409).send({ error: result.reason });
    }
    return reply.code(201).send({ submissionId: result.submissionId });
  });

  async function requireRequestManagement(
    request: FastifyRequest,
    reply: FastifyReply,
    requestId: string,
  ): Promise<boolean> {
    const token = bearerToken(request);
    if (token === null || !(await db.findRequestByManagementToken(requestId, token))) {
      reply.code(401).send({ error: 'unauthorized' });
      return false;
    }
    return true;
  }

  app.get('/api/v1/manage/requests/:requestId/submissions', async (request, reply) => {
    const { requestId } = z.object({ requestId: idSchema }).parse(request.params);
    if (!(await requireRequestManagement(request, reply, requestId))) return reply;
    return reply.send({ submissions: await db.listSubmissions(requestId) });
  });

  app.post('/api/v1/manage/requests/:requestId/submissions/:submissionId/claim', async (request, reply) => {
    const params = z
      .object({ requestId: idSchema, submissionId: z.string().min(8).max(64) })
      .parse(request.params);
    if (!(await requireRequestManagement(request, reply, params.requestId))) return reply;

    const claimed = await db.claimSubmission(params.requestId, params.submissionId);
    if (claimed === null) return unavailable(reply, 'not-found');

    const manifest = await options.storage.get(claimed.manifestKey);
    if (manifest === null) return unavailable(reply, 'destroyed');

    return reply.send({
      sealedKey: claimed.sealedKey,
      encryptedManifest: Buffer.from(manifest).toString('base64url'),
    });
  });

  app.post('/api/v1/manage/requests/:requestId/close', async (request, reply) => {
    const { requestId } = z.object({ requestId: idSchema }).parse(request.params);
    if (!(await requireRequestManagement(request, reply, requestId))) return reply;
    return reply.send({ closed: await db.closeRequest(requestId) });
  });

  // ------------------------------------------------------------- reporting

  /**
   * Abuse report (§18).
   *
   * The server cannot read the capsule, so this endpoint deliberately makes no
   * claim about having reviewed content. It purges the ciphertext by id and
   * says exactly that.
   */
  app.post('/api/v1/report/:capsuleId', async (request, reply) => {
    const { capsuleId } = z.object({ capsuleId: idSchema }).parse(request.params);
    if (!(await enforce(request, reply, 'report', 20))) return reply;
    const revoked = await db.revokeCapsule(capsuleId);
    request.log.warn({ reported: true }, 'capsule reported and revoked without inspection');
    return reply.send({
      accepted: true,
      revoked,
      note: 'The capsule was revoked by identifier. Its contents were not and cannot be inspected.',
    });
  });

  app.get('/api/v1/meta', async (_request, reply) =>
    reply.send({
      product: brand.name,
      envelope: brand.envelopeVersion,
      preview: env.previewMode,
      transportIsSecure: env.transportIsSecure,
      limits: {
        maxFileBytes: limits.maxFileBytes,
        maxCapsuleCipherBytes: limits.maxCapsuleCipherBytes,
        maxFilesPerCapsule: limits.maxFilesPerCapsule,
        maxTtlHours: limits.maxTtlHours,
        chunkBytes: limits.chunkBytes,
        maxClaims: limits.maxClaims,
      },
    }),
  );

  return app;
}
