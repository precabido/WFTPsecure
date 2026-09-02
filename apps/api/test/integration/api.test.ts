/**
 * End-to-end API tests against real PostgreSQL, real Redis and real storage
 * (§33 "API" and "Privacidad").
 *
 * These use fastify's `inject`, which runs the full middleware and routing
 * stack in-process — same handlers, same validation, same headers as a socket
 * request, without binding a port.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Redis } from 'ioredis';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.ts';
import { FilesystemStorage } from '@cinderlink/storage';
import { migrate, getPool, closePool } from '@cinderlink/database';

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://postgres@127.0.0.1:55432/cinderlink_test';
const REDIS_URL = process.env.REDIS_URL ?? 'redis://127.0.0.1:56379';

let app: FastifyInstance;
let redis: Redis;
let storageRoot: string;
let storage: FilesystemStorage;

const b64 = (n: number) => randomBytes(n).toString('base64url');
const newId = () => randomBytes(16).toString('base64url');

/** Minimal valid create-capsule body. `encryptedManifest` is opaque to the API. */
function capsuleBody(overrides: Record<string, unknown> = {}) {
  return {
    id: newId(),
    version: 'capsule-envelope-v1',
    type: 'note',
    burnMode: 'on-claim',
    maxClaims: 1,
    ttlSeconds: 3600,
    unlockInSeconds: null,
    claimWindowSeconds: 900,
    encryptedManifest: b64(256),
    uploadIds: [],
    ...overrides,
  };
}

beforeAll(async () => {
  process.env.DATABASE_URL = DATABASE_URL;
  process.env.PG_POOL_MAX = '20';
  await migrate(DATABASE_URL);

  storageRoot = await mkdtemp(join(tmpdir(), 'cinderlink-test-'));
  storage = new FilesystemStorage(storageRoot);
  await storage.init();
  redis = new Redis(REDIS_URL);

  app = await buildApp({
    storage,
    redis,
    env: {
      ...process.env,
      APP_MODE: 'preview',
      PUBLIC_BASE_URL: 'http://127.0.0.1:9999',
      ALLOW_INSECURE_PREVIEW: 'true',
      BUILD_ID: 'test-build',
      // Generous limits so rate limiting does not mask functional failures;
      // the limiter itself is tested explicitly below.
      RL_CREATE_PER_HOUR: '100000',
      RL_CLAIM_PER_HOUR: '100000',
      RL_CHUNK_PER_HOUR: '100000',
      // The disk guard checks REAL filesystem use. CI machines are routinely
      // past 80% full, which would refuse every upload and make these tests
      // fail for a reason unrelated to what they assert. Pressure behaviour is
      // tested explicitly below instead.
      STORAGE_ROOT: storageRoot,
      STORAGE_PRESSURE_PERCENT: '100',
    },
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  redis.disconnect();
  await closePool();
  await rm(storageRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  await getPool().query(
    'TRUNCATE capsules, capsule_events, capsule_objects, retrieval_leases, upload_sessions, upload_chunks, secure_requests, request_submissions, submission_objects CASCADE',
  );
  await redis.flushdb();
});

describe('health and meta', () => {
  it('exposes only status and build id (§29)', async () => {
    const response = await app.inject({ method: 'GET', url: '/healthz' });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toEqual({ status: 'ok', build: 'test-build' });

    // Explicitly assert the things that must NOT be present.
    const raw = response.body;
    for (const forbidden of ['postgres', 'redis', 'hostname', 'DATABASE_URL', '/srv', 'password']) {
      expect(raw.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
  });
});

describe('security headers (§26)', () => {
  it('sets a third-party-free CSP and the privacy headers', async () => {
    const response = await app.inject({ method: 'GET', url: '/healthz' });
    const csp = response.headers['content-security-policy'] as string;

    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    // wasm-unsafe-eval is required for libsodium; plain unsafe-eval is not.
    expect(csp).toContain("'wasm-unsafe-eval'");
    expect(csp).not.toContain("'unsafe-eval'");
    expect(csp).not.toMatch(/https?:\/\//); // no third-party origins at all

    expect(response.headers['referrer-policy']).toBe('no-referrer');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['x-frame-options']).toBe('DENY');
    expect(response.headers['cache-control']).toContain('no-store');
    expect(response.headers['x-robots-tag']).toContain('noindex');
    expect(response.headers['x-powered-by']).toBeUndefined();
  });
});

describe('capsule creation', () => {
  it('creates a capsule and returns a management token exactly once', async () => {
    const body = capsuleBody();
    const response = await app.inject({ method: 'POST', url: '/api/v1/capsules', payload: body });
    expect(response.statusCode).toBe(201);
    const created = response.json();
    expect(created.id).toBe(body.id);
    expect(created.managementToken).toMatch(/^[A-Za-z0-9_-]{40,}$/);

    // The token must be stored only as a hash.
    const { rows } = await getPool().query<{ management_token_hash: Buffer }>(
      'SELECT management_token_hash FROM capsules WHERE id = $1',
      [body.id],
    );
    expect(rows[0]?.management_token_hash.toString('utf8')).not.toContain(created.managementToken);
    expect(rows[0]?.management_token_hash).toHaveLength(32);
  });

  it('rejects an unknown field rather than silently storing it', async () => {
    // A client bug that started sending `title` must fail loudly, not persist
    // plaintext. This is what .strict() buys.
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/capsules',
      payload: { ...capsuleBody(), title: 'my secret title' },
    });
    expect(response.statusCode).toBe(400);
  });

  it('rejects a TTL beyond the policy ceiling', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/capsules',
      payload: capsuleBody({ ttlSeconds: 999_999 }),
    });
    expect(response.statusCode).toBe(400);
  });

  it('rejects a duplicate id', async () => {
    const body = capsuleBody();
    expect((await app.inject({ method: 'POST', url: '/api/v1/capsules', payload: body })).statusCode).toBe(201);
    const second = await app.inject({ method: 'POST', url: '/api/v1/capsules', payload: body });
    expect(second.statusCode).toBe(409);
  });

  it('rejects a non-base64url manifest', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/capsules',
      payload: capsuleBody({ encryptedManifest: 'not/valid+base64url==' }),
    });
    expect(response.statusCode).toBe(400);
  });

  it('rejects a low-entropy id', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/capsules',
      payload: capsuleBody({ id: 'short' }),
    });
    expect(response.statusCode).toBe(400);
  });
});

describe('GET never consumes (§15, §33 link scanners)', () => {
  async function create() {
    const body = capsuleBody();
    await app.inject({ method: 'POST', url: '/api/v1/capsules', payload: body });
    return body.id;
  }

  it('survives GET, HEAD and repeated reloads before the claim', async () => {
    const id = await create();

    for (let i = 0; i < 10; i += 1) {
      const get = await app.inject({ method: 'GET', url: `/api/v1/capsules/${id}/status` });
      expect(get.statusCode).toBe(200);
      expect(get.json().state).toBe('available');

      const head = await app.inject({ method: 'HEAD', url: `/api/v1/capsules/${id}/status` });
      expect(head.statusCode).toBe(200);
    }

    // Still claimable afterwards — nothing was consumed by all that traffic.
    const claim = await app.inject({ method: 'POST', url: `/api/v1/capsules/${id}/claim` });
    expect(claim.statusCode).toBe(200);
    expect(claim.json().retrievalToken).toBeTruthy();
  });

  it('refuses GET on the claim route', async () => {
    const id = await create();
    const response = await app.inject({ method: 'GET', url: `/api/v1/capsules/${id}/claim` });
    // Fastify answers 404 for a method/route pair it does not serve.
    expect([404, 405]).toContain(response.statusCode);
    expect((await app.inject({ method: 'POST', url: `/api/v1/capsules/${id}/claim` })).statusCode).toBe(200);
  });

  it('never returns ciphertext from the public status endpoint', async () => {
    const body = capsuleBody();
    await app.inject({ method: 'POST', url: '/api/v1/capsules', payload: body });
    const status = await app.inject({ method: 'GET', url: `/api/v1/capsules/${body.id}/status` });
    expect(status.body).not.toContain(body.encryptedManifest);
    expect(status.json().manifest).toBeUndefined();
  });
});

describe('claim and retrieval', () => {
  async function createAndClaim() {
    const body = capsuleBody();
    await app.inject({ method: 'POST', url: '/api/v1/capsules', payload: body });
    const claim = await app.inject({ method: 'POST', url: `/api/v1/capsules/${body.id}/claim` });
    return { body, token: claim.json().retrievalToken as string };
  }

  it('returns the manifest verbatim to the lease holder', async () => {
    const { body, token } = await createAndClaim();
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/retrieval/manifest',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(200);
    // Byte-identical: the server stored ciphertext and did not touch it.
    expect(response.json().manifest).toBe(body.encryptedManifest);
  });

  it('rejects a second claim on a one-time capsule', async () => {
    const { body } = await createAndClaim();
    const second = await app.inject({ method: 'POST', url: `/api/v1/capsules/${body.id}/claim` });
    expect(second.statusCode).toBe(404);
    expect(second.json().reason).toBe('consumed');
  });

  it('rejects a missing, malformed or wrong retrieval token', async () => {
    await createAndClaim();
    for (const headers of [
      {},
      { authorization: 'Bearer short' },
      { authorization: `Bearer ${b64(32)}` },
      { authorization: 'NotBearer abcdefghijklmnopqrstuvwxyz' },
    ]) {
      const response = await app.inject({ method: 'GET', url: '/api/v1/retrieval/manifest', headers });
      expect(response.statusCode).toBe(401);
    }
  });

  it('never accepts a retrieval token in the URL path', async () => {
    const { token } = await createAndClaim();
    const response = await app.inject({ method: 'GET', url: `/api/v1/retrieval/manifest?token=${token}` });
    expect(response.statusCode).toBe(401);
  });

  it('stops serving after the lease is completed and the capsule purged', async () => {
    const { token } = await createAndClaim();
    expect(
      (await app.inject({ method: 'POST', url: '/api/v1/retrieval/complete', headers: { authorization: `Bearer ${token}` } }))
        .statusCode,
    ).toBe(204);
    // The lease is spent; a replay must fail.
    const replay = await app.inject({
      method: 'GET',
      url: '/api/v1/retrieval/manifest',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(replay.statusCode).toBe(401);
  });
});

describe('management', () => {
  async function create() {
    const body = capsuleBody({ maxClaims: 3 });
    const created = await app.inject({ method: 'POST', url: '/api/v1/capsules', payload: body });
    return { id: body.id, token: created.json().managementToken as string };
  }

  it('reports a content-free timeline', async () => {
    const { id, token } = await create();
    await app.inject({ method: 'POST', url: `/api/v1/capsules/${id}/claim` });

    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/manage/${id}/status`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(200);
    const view = response.json();
    expect(view.claimsCount).toBe(1);
    expect(view.events.map((e: { kind: string }) => e.kind)).toEqual(['created', 'claimed']);

    // §21: no IP, no user agent, no geolocation, no content anywhere.
    const raw = response.body.toLowerCase();
    for (const forbidden of ['ip', 'useragent', 'user-agent', 'country', 'city', 'manifest']) {
      expect(raw).not.toContain(`"${forbidden}"`);
    }
  });

  it('rejects a wrong management token', async () => {
    const { id } = await create();
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/manage/${id}/status`,
      headers: { authorization: `Bearer ${b64(32)}` },
    });
    expect(response.statusCode).toBe(401);
  });

  it('revokes and blocks further claims', async () => {
    const { id, token } = await create();
    const revoke = await app.inject({
      method: 'POST',
      url: `/api/v1/manage/${id}/revoke`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(revoke.json().revoked).toBe(true);
    const claim = await app.inject({ method: 'POST', url: `/api/v1/capsules/${id}/claim` });
    expect(claim.json().reason).toBe('revoked');
  });

  it('allows shortening expiry and refuses extension beyond the ceiling', async () => {
    const { id, token } = await create();
    const shorten = await app.inject({
      method: 'PATCH',
      url: `/api/v1/manage/${id}/expiry`,
      headers: { authorization: `Bearer ${token}` },
      payload: { ttlSeconds: 300 },
    });
    expect(shorten.statusCode).toBe(200);

    const tooFar = await app.inject({
      method: 'PATCH',
      url: `/api/v1/manage/${id}/expiry`,
      headers: { authorization: `Bearer ${token}` },
      payload: { ttlSeconds: 999_999 },
    });
    expect(tooFar.statusCode).toBe(400);
  });
});

describe('chunked uploads', () => {
  it('refuses to complete an upload with a missing chunk', async () => {
    const capsuleId = newId();
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/uploads',
      payload: { capsuleId, expectedChunks: 3 },
    });
    expect(created.statusCode).toBe(201);
    const { uploadId, uploadToken } = created.json();
    const auth = { authorization: `Bearer ${uploadToken}` };

    // Upload chunks 0 and 2, skipping 1.
    for (const index of [0, 2]) {
      const put = await app.inject({
        method: 'PUT',
        url: `/api/v1/uploads/${uploadId}/chunks/${index}`,
        headers: { ...auth, 'content-type': 'application/octet-stream' },
        payload: Buffer.from(randomBytes(1024)),
      });
      expect(put.statusCode).toBe(201);
    }

    const complete = await app.inject({
      method: 'POST',
      url: `/api/v1/uploads/${uploadId}/complete`,
      headers: auth,
    });
    // An incomplete upload must never yield a usable object (§13).
    expect(complete.statusCode).toBe(409);
    expect(complete.json().error).toBe('incomplete');
  });

  it('treats a re-uploaded chunk as idempotent, so resume is safe', async () => {
    const capsuleId = newId();
    const { uploadId, uploadToken } = (
      await app.inject({ method: 'POST', url: '/api/v1/uploads', payload: { capsuleId, expectedChunks: 2 } })
    ).json();
    const auth = { authorization: `Bearer ${uploadToken}`, 'content-type': 'application/octet-stream' };

    const first = await app.inject({ method: 'PUT', url: `/api/v1/uploads/${uploadId}/chunks/0`, headers: auth, payload: Buffer.alloc(512, 1) });
    const repeat = await app.inject({ method: 'PUT', url: `/api/v1/uploads/${uploadId}/chunks/0`, headers: auth, payload: Buffer.alloc(512, 1) });
    expect(first.statusCode).toBe(201);
    expect(repeat.statusCode).toBe(200);
    expect(repeat.json().duplicate).toBe(true);

    await app.inject({ method: 'PUT', url: `/api/v1/uploads/${uploadId}/chunks/1`, headers: auth, payload: Buffer.alloc(512, 2) });
    const complete = await app.inject({
      method: 'POST',
      url: `/api/v1/uploads/${uploadId}/complete`,
      headers: { authorization: `Bearer ${uploadToken}` },
    });
    expect(complete.statusCode).toBe(200);
    expect(complete.json().chunkCount).toBe(2);
  });

  it('reports received indices so a client can resume', async () => {
    const { uploadId, uploadToken } = (
      await app.inject({ method: 'POST', url: '/api/v1/uploads', payload: { capsuleId: newId(), expectedChunks: 4 } })
    ).json();
    const auth = { authorization: `Bearer ${uploadToken}` };
    for (const index of [0, 2]) {
      await app.inject({
        method: 'PUT',
        url: `/api/v1/uploads/${uploadId}/chunks/${index}`,
        headers: { ...auth, 'content-type': 'application/octet-stream' },
        payload: Buffer.alloc(256, index),
      });
    }
    const status = await app.inject({ method: 'GET', url: `/api/v1/uploads/${uploadId}/status`, headers: auth });
    expect(status.json().receivedIndices).toEqual([0, 2]);
  });

  it('rejects a chunk index beyond the declared count', async () => {
    const { uploadId, uploadToken } = (
      await app.inject({ method: 'POST', url: '/api/v1/uploads', payload: { capsuleId: newId(), expectedChunks: 2 } })
    ).json();
    const response = await app.inject({
      method: 'PUT',
      url: `/api/v1/uploads/${uploadId}/chunks/9`,
      headers: { authorization: `Bearer ${uploadToken}`, 'content-type': 'application/octet-stream' },
      payload: Buffer.alloc(16),
    });
    expect(response.statusCode).toBe(400);
  });

  it('rejects an upload chunk without a token', async () => {
    const { uploadId } = (
      await app.inject({ method: 'POST', url: '/api/v1/uploads', payload: { capsuleId: newId(), expectedChunks: 1 } })
    ).json();
    const response = await app.inject({
      method: 'PUT',
      url: `/api/v1/uploads/${uploadId}/chunks/0`,
      headers: { 'content-type': 'application/octet-stream' },
      payload: Buffer.alloc(16),
    });
    expect(response.statusCode).toBe(401);
  });
});

describe('rate limiting (§18)', () => {
  it('returns 429 with Retry-After once the window is exhausted', async () => {
    const limited = await buildApp({
      storage,
      redis,
      env: {
        ...process.env,
        APP_MODE: 'preview',
        ALLOW_INSECURE_PREVIEW: 'true',
        RL_CREATE_PER_HOUR: '3',
        STORAGE_ROOT: storageRoot,
        STORAGE_PRESSURE_PERCENT: '100',
      },
    });
    await limited.ready();
    try {
      const codes: number[] = [];
      for (let i = 0; i < 5; i += 1) {
        const response = await limited.inject({ method: 'POST', url: '/api/v1/capsules', payload: capsuleBody() });
        codes.push(response.statusCode);
        if (response.statusCode === 429) expect(response.headers['retry-after']).toBeDefined();
      }
      expect(codes.filter((c) => c === 201)).toHaveLength(3);
      expect(codes.filter((c) => c === 429)).toHaveLength(2);
    } finally {
      await limited.close();
    }
  });

  it('stores only a pseudonymous key in Redis, never an IP', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/v1/capsules',
      payload: capsuleBody(),
      remoteAddress: '203.0.113.45',
    });
    const keys = await redis.keys('*');
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) {
      expect(key).not.toContain('203.0.113.45');
      expect(key).not.toMatch(/\d+\.\d+\.\d+\.\d+/);
    }
  });
});

describe('storage pressure (§18)', () => {
  it('refuses uploads with 507 when the real disk is past the threshold', async () => {
    // A threshold of 1% is above no real filesystem, so the guard must refuse.
    // This is the case that matters on a shared host: our own accounting says
    // zero bytes stored, and the old cap-only check would have said yes.
    const pressured = await buildApp({
      storage,
      redis,
      env: {
        ...process.env,
        APP_MODE: 'preview',
        ALLOW_INSECURE_PREVIEW: 'true',
        RL_CREATE_PER_HOUR: '100000',
        STORAGE_ROOT: storageRoot,
        STORAGE_PRESSURE_PERCENT: '1',
      },
    });
    await pressured.ready();
    try {
      const capsule = await pressured.inject({
        method: 'POST',
        url: '/api/v1/capsules',
        payload: capsuleBody(),
      });
      expect(capsule.statusCode).toBe(507);
      expect(capsule.json().error).toBe('storage-full');

      const upload = await pressured.inject({
        method: 'POST',
        url: '/api/v1/uploads',
        payload: { capsuleId: newId(), expectedChunks: 1 },
      });
      expect(upload.statusCode).toBe(507);
    } finally {
      await pressured.close();
    }
  });

  it('accepts uploads when the threshold leaves headroom', async () => {
    const relaxed = await buildApp({
      storage,
      redis,
      env: {
        ...process.env,
        APP_MODE: 'preview',
        ALLOW_INSECURE_PREVIEW: 'true',
        RL_CREATE_PER_HOUR: '100000',
        STORAGE_ROOT: storageRoot,
        STORAGE_PRESSURE_PERCENT: '100',
      },
    });
    await relaxed.ready();
    try {
      const response = await relaxed.inject({
        method: 'POST',
        url: '/api/v1/capsules',
        payload: capsuleBody(),
      });
      expect(response.statusCode).toBe(201);
    } finally {
      await relaxed.close();
    }
  });
});

describe('unavailable states are indistinguishable to a prober (§21)', () => {
  it('answers 404 with the same shape for unknown and consumed ids', async () => {
    const unknown = await app.inject({ method: 'POST', url: `/api/v1/capsules/${newId()}/claim` });

    const body = capsuleBody();
    await app.inject({ method: 'POST', url: '/api/v1/capsules', payload: body });
    await app.inject({ method: 'POST', url: `/api/v1/capsules/${body.id}/claim` });
    const consumed = await app.inject({ method: 'POST', url: `/api/v1/capsules/${body.id}/claim` });

    expect(unknown.statusCode).toBe(consumed.statusCode);
    expect(Object.keys(unknown.json()).sort()).toEqual(Object.keys(consumed.json()).sort());
    expect(unknown.json().error).toBe('unavailable');
    expect(consumed.json().error).toBe('unavailable');
  });

  it('accepts a bodyless POST for claim, revoke and retrieval-complete', async () => {
    // Regression: the client sent `content-type: application/json` with no
    // body on these routes. Fastify rejects that (FST_ERR_CTP_EMPTY_JSON_BODY),
    // and the error handler turned the 400 into a 500 — so claim, revoke and
    // complete all failed in the browser while passing every server-side test
    // that happened to send a body.
    const body = capsuleBody();
    const created = await app.inject({ method: 'POST', url: '/api/v1/capsules', payload: body });
    const managementToken = created.json().managementToken as string;

    const claim = await app.inject({
      method: 'POST',
      url: `/api/v1/capsules/${body.id}/claim`,
      headers: { 'content-type': 'application/json' },
    });
    expect(claim.statusCode).toBe(200);

    const complete = await app.inject({
      method: 'POST',
      url: '/api/v1/retrieval/complete',
      headers: {
        authorization: `Bearer ${claim.json().retrievalToken}`,
        'content-type': 'application/json',
      },
    });
    expect(complete.statusCode).toBe(204);

    const revoke = await app.inject({
      method: 'POST',
      url: `/api/v1/manage/${body.id}/revoke`,
      headers: { authorization: `Bearer ${managementToken}`, 'content-type': 'application/json' },
    });
    expect(revoke.statusCode).toBe(200);
  });

  it('reports a malformed body as 4xx, never as a server error', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/capsules',
      headers: { 'content-type': 'application/json' },
      payload: '{ this is not json',
    });
    // A client mistake must not be reported as the server breaking.
    expect(response.statusCode).toBeGreaterThanOrEqual(400);
    expect(response.statusCode).toBeLessThan(500);
  });

  it('never leaks a stack trace or internal path on error', async () => {
    const response = await app.inject({ method: 'POST', url: '/api/v1/capsules', payload: { bad: true } });
    expect(response.statusCode).toBe(400);
    expect(response.body).not.toMatch(/\/home\/|\/srv\/|at Object\.|node_modules/);
  });
});
