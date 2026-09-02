/**
 * Logging with aggressive redaction (§16).
 *
 * The threat here is mundane and common: a log line that quietly contains a
 * capsule URL, a bearer token, or a chunk of ciphertext. Anyone with log access
 * then has what they need. So redaction is configured centrally and the request
 * serialiser is overridden to drop the URL entirely rather than trusting that
 * no secret ever appears in a query string.
 */

import pino from 'pino';
import type { FastifyBaseLogger } from 'fastify';

/**
 * Returns the logger typed as FastifyBaseLogger.
 *
 * Annotating the return type matters: handing Fastify a concrete pino `Logger`
 * makes it infer a narrower instance type, so `buildApp` could no longer be
 * declared as returning a plain `FastifyInstance`. Widening here keeps the
 * public signature honest instead of casting at the call site.
 */
export function createLogger(): FastifyBaseLogger {
  return pino({
    level: process.env.LOG_LEVEL ?? 'info',
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        'req.headers["x-management-token"]',
        'res.headers["set-cookie"]',
        'req.body',
        'body',
        'token',
        'retrievalToken',
        'managementToken',
        'encryptedManifest',
        '*.encryptedManifest',
        'sealedKey',
      ],
      censor: '[redacted]',
    },
    serializers: {
      /**
       * Log the route, never the full URL.
       *
       * A capsule URL's secret lives in the fragment, which never reaches the
       * server — but the path still contains the capsule id, and correlating
       * ids across log lines is exactly the metadata trail we promised not to
       * keep. `routerPath` gives '/api/v1/capsules/:capsuleId' instead.
       */
      req(request: {
        method: string;
        routeOptions?: { url?: string };
        routerPath?: string;
        url?: string;
      }) {
        return {
          method: request.method,
          route: request.routeOptions?.url ?? request.routerPath ?? 'unmatched',
        };
      },
      res(reply: { statusCode: number }) {
        return { statusCode: reply.statusCode };
      },
      err: pino.stdSerializers.err,
    },
  });
}

export type Logger = FastifyBaseLogger;
