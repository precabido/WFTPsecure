/**
 * Security headers (§26).
 *
 * Set here in the application rather than only at the gateway, so that a
 * misconfigured or bypassed proxy cannot strip them silently. The gateway sets
 * the same headers for static routes it serves itself.
 */

import type { FastifyInstance, FastifyReply } from 'fastify';

/**
 * Content-Security-Policy.
 *
 * Notes on the two entries that look like relaxations:
 *
 *   'wasm-unsafe-eval' — libsodium is WebAssembly, and instantiating a WASM
 *   module counts as eval under CSP. This directive permits *only* WebAssembly
 *   compilation; it does not enable eval() or new Function(), which is why it
 *   exists as a separate token from 'unsafe-eval'. There is no way to run
 *   client-side cryptography without it short of shipping asm.js.
 *
 *   worker-src blob: — the encryption worker is constructed from a Blob so the
 *   bundler can inline it; without blob: the worker cannot start and encryption
 *   would fall back to blocking the main thread.
 *
 * Everything else is locked to 'self'. There are no third-party origins at all:
 * no CDN, no font host, no analytics (§7).
 */
export function contentSecurityPolicy(): string {
  return [
    "default-src 'self'",
    "script-src 'self' 'wasm-unsafe-eval'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' blob: data:",
    "media-src 'self' blob:",
    "font-src 'self'",
    "connect-src 'self'",
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "frame-src 'none'",
    "manifest-src 'self'",
  ].join('; ');
}

export const PERMISSIONS_POLICY = [
  'accelerometer=()',
  'autoplay=()',
  'camera=()',
  'display-capture=()',
  'encrypted-media=()',
  'fullscreen=(self)',
  'geolocation=()',
  'gyroscope=()',
  'interest-cohort=()',
  'magnetometer=()',
  // Voice notes (§9) need the microphone, and only from our own origin.
  'microphone=(self)',
  'midi=()',
  'payment=()',
  'usb=()',
].join(', ');

export function applySecurityHeaders(reply: FastifyReply, options: { previewMode: boolean }): void {
  reply.header('Content-Security-Policy', contentSecurityPolicy());
  reply.header('Referrer-Policy', 'no-referrer');
  reply.header('X-Content-Type-Options', 'nosniff');
  reply.header('X-Frame-Options', 'DENY');
  reply.header('Permissions-Policy', PERMISSIONS_POLICY);
  reply.header('Cross-Origin-Opener-Policy', 'same-origin');
  reply.header('Cross-Origin-Resource-Policy', 'same-origin');
  // Every API response is private by definition; none of it may be cached.
  reply.header('Cache-Control', 'no-store, max-age=0');
  reply.header('Pragma', 'no-cache');
  reply.removeHeader('X-Powered-By');

  if (options.previewMode) {
    // The preview must never be indexed (§6).
    reply.header('X-Robots-Tag', 'noindex, nofollow, noarchive');
  }
}

export function registerSecurity(app: FastifyInstance, options: { previewMode: boolean }): void {
  app.addHook('onSend', async (_request, reply, payload) => {
    applySecurityHeaders(reply, options);
    return payload;
  });
}
