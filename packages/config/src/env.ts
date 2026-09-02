/**
 * Environment resolution and the insecure-transport guard (§6).
 *
 * The guard exists because this product's entire value proposition is that
 * plaintext never leaves the browser — and that promise is only meaningful if
 * the JavaScript doing the encrypting arrives unmodified. Over plain HTTP an
 * active network attacker can rewrite the client bundle, so the app refuses to
 * boot in production mode on a non-HTTPS base URL unless an operator has
 * explicitly acknowledged the downgrade.
 */

export type AppMode = 'development' | 'preview' | 'production';

export interface AppEnv {
  mode: AppMode;
  publicBaseUrl: string;
  previewMode: boolean;
  /** Render the HTTP warning band in the UI. */
  previewWarning: boolean;
  /** Operator acknowledgement that this deployment runs without TLS. */
  allowInsecurePreview: boolean;
  /** True when publicBaseUrl is https:// — the UI must never claim more. */
  transportIsSecure: boolean;
  buildId: string;
  commitSha: string;
}

export class InsecureTransportError extends Error {
  override readonly name = 'InsecureTransportError';
}

function bool(raw: string | undefined, fallback = false): boolean {
  if (raw === undefined || raw === '') return fallback;
  return raw === 'true' || raw === '1' || raw === 'yes';
}

/**
 * Resolve and validate environment. Throws InsecureTransportError rather than
 * silently downgrading, so a misconfigured production deploy fails loudly at
 * boot instead of quietly serving a security claim it cannot keep.
 */
export function resolveEnv(source: NodeJS.ProcessEnv = process.env): AppEnv {
  const mode = (source.APP_MODE ?? 'development') as AppMode;
  const publicBaseUrl = (source.PUBLIC_BASE_URL ?? 'http://127.0.0.1:9999').replace(/\/+$/, '');
  const allowInsecurePreview = bool(source.ALLOW_INSECURE_PREVIEW);
  const transportIsSecure = publicBaseUrl.startsWith('https://');

  if (mode === 'production' && !transportIsSecure && !allowInsecurePreview) {
    throw new InsecureTransportError(
      'Refusing to start: APP_MODE=production requires PUBLIC_BASE_URL to use https://. ' +
        'Set ALLOW_INSECURE_PREVIEW=true only if you accept that an active network ' +
        'attacker can replace the client-side cryptography over plain HTTP.',
    );
  }

  return {
    mode,
    publicBaseUrl,
    previewMode: bool(source.PREVIEW_MODE, mode !== 'production'),
    // Default the warning ON whenever transport is not secure. An operator can
    // only turn it off; they can never turn it off *and* keep insecure transport
    // silently, because the default tracks transportIsSecure.
    previewWarning: bool(source.PUBLIC_PREVIEW_WARNING, !transportIsSecure),
    allowInsecurePreview,
    transportIsSecure,
    buildId: source.BUILD_ID ?? 'dev',
    commitSha: (source.COMMIT_SHA ?? 'unknown').slice(0, 12),
  };
}
