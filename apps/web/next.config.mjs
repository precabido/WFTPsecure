/**
 * Next.js configuration.
 *
 * Security headers are set here as well as at the gateway and in the API, so
 * that a direct hit on the web container (or a gateway misconfiguration) still
 * gets them. Defence in depth costs nothing here.
 */

/** Kept in sync with apps/api/src/security.ts — see the rationale for
 *  'wasm-unsafe-eval' and worker-src blob: there. */
const csp = [
  "default-src 'self'",
  // Next injects inline bootstrap scripts; 'unsafe-inline' is ignored by
  // browsers that support nonces/hashes but is required for older ones.
  "script-src 'self' 'wasm-unsafe-eval' 'unsafe-inline'",
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
  "manifest-src 'self'",
].join('; ');

const securityHeaders = [
  { key: 'Content-Security-Policy', value: csp },
  { key: 'Referrer-Policy', value: 'no-referrer' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
  { key: 'Cross-Origin-Resource-Policy', value: 'same-origin' },
  {
    key: 'Permissions-Policy',
    value: 'camera=(), geolocation=(), microphone=(self), payment=(), usb=(), interest-cohort=()',
  },
  { key: 'X-Robots-Tag', value: 'noindex, nofollow, noarchive' },
];

/** @type {import('next').NextConfig} */
export default {
  reactStrictMode: true,
  poweredByHeader: false,
  output: 'standalone',
  // Transpile workspace packages that ship raw TypeScript.
  transpilePackages: ['@cinderlink/crypto', '@cinderlink/config'],
  /**
   * In production the gateway (infra/gateway) routes /api and /healthz to the
   * API container, and the web app never sees those paths. This rewrite exists
   * so the same-origin fetches in lib/capsule-client work when the app is run
   * directly (local development, Playwright) without standing up nginx.
   * It is a no-op unless API_ORIGIN is set.
   */
  async rewrites() {
    const apiOrigin = process.env.API_ORIGIN;
    if (!apiOrigin) return [];
    return [
      { source: '/api/:path*', destination: `${apiOrigin}/api/:path*` },
      { source: '/healthz', destination: `${apiOrigin}/healthz` },
    ];
  },
  async headers() {
    return [
      { source: '/:path*', headers: securityHeaders },
      {
        // Capsule and management routes must never be cached anywhere (§26).
        source: '/(c|m|r)/:path*',
        headers: [
          ...securityHeaders,
          { key: 'Cache-Control', value: 'no-store, max-age=0' },
          { key: 'Pragma', value: 'no-cache' },
        ],
      },
    ];
  },
};
