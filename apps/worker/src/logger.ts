import pino from 'pino';

/** Worker logging. Sweeps only ever log counts — never ids or content. */
export function createLogger() {
  return pino({
    level: process.env.LOG_LEVEL ?? 'info',
    base: { service: 'worker' },
    redact: { paths: ['capsuleId', '*.capsuleId', 'storageKey', '*.storageKey'], censor: '[redacted]' },
  });
}
