'use client';

/**
 * Management page (§21 "Página de gestión").
 *
 * "Control the capsule without seeing what is inside." Everything shown here
 * comes from operational metadata: state, counters, timestamps. There is no way
 * to read the content from this page, because the management token is not a
 * decryption key and the server has no plaintext to hand over.
 *
 * Absent by design: IP addresses, user agents, geolocation, referrers.
 */

import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { ttlPresets, limits } from '@cinderlink/config/limits';
import { t, formatDuration, formatBytes, type Locale } from '@/lib/i18n';
import { usePrefs } from '@/components/shell';
import { SealMark } from '@/components/seal-mark';

interface ManagementView {
  id: string;
  state: 'available' | 'consumed' | 'revoked' | 'expired' | 'destroyed';
  burnMode: string;
  maxClaims: number;
  claimsCount: number;
  expiresAt: string;
  createdAt: string;
  claimedAt: string | null;
  totalCipherBytes: number;
  objectCount: number;
  events: { kind: string; at: string }[];
}

export default function ManagePage() {
  const params = useParams<{ id: string }>();
  const capsuleId = params.id;
  const { locale } = usePrefs();
  const strings = t(locale);

  const [token, setToken] = useState<string | null>(null);
  const [view, setView] = useState<ManagementView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    // The management token lives in the fragment, so it never reaches the
    // server in a request line or a Referer header.
    const params2 = new URLSearchParams(window.location.hash.replace(/^#/, ''));
    setToken(params2.get('t'));
  }, []);

  const load = useCallback(
    async (bearer: string) => {
      const response = await fetch(`/api/v1/manage/${capsuleId}/status`, {
        headers: { authorization: `Bearer ${bearer}` },
        credentials: 'omit',
      });
      if (!response.ok) {
        setError(response.status === 401 ? strings.states['not-found'] : strings.unavailable);
        setView(null);
        return;
      }
      setView((await response.json()) as ManagementView);
      setError(null);
    },
    [capsuleId, strings],
  );

  useEffect(() => {
    if (token !== null) void load(token);
  }, [token, load]);

  async function act(path: string, init: RequestInit = {}) {
    if (token === null) return;
    setBusy(true);
    try {
      // content-type is set only when a body exists: Fastify rejects an empty
      // body that claims to be JSON, and `revoke` legitimately has no body.
      const headers: Record<string, string> = {
        authorization: `Bearer ${token}`,
        ...((init.headers as Record<string, string>) ?? {}),
      };
      if (init.body !== undefined && init.body !== null) headers['content-type'] = 'application/json';
      await fetch(`/api/v1/manage/${capsuleId}/${path}`, {
        ...init,
        method: init.method ?? 'POST',
        headers,
        credentials: 'omit',
      });
      await load(token);
    } finally {
      setBusy(false);
    }
  }

  if (token === null) {
    return (
      <Centered>
        <SealMark size={48} state="consumed" />
        <h1 className="text-lg font-semibold">{strings.unavailable}</h1>
        <p style={{ color: 'var(--text-secondary)' }}>
          {locale === 'es'
            ? 'Este enlace de gestión no contiene la clave necesaria.'
            : 'This management link does not carry the required key.'}
        </p>
      </Centered>
    );
  }

  if (error !== null) {
    return (
      <Centered>
        <SealMark size={48} state="consumed" />
        <h1 className="text-lg font-semibold">{strings.unavailable}</h1>
        <p style={{ color: 'var(--text-secondary)' }}>{error}</p>
      </Centered>
    );
  }

  if (view === null) {
    return (
      <Centered>
        <span className="sr-only">{locale === 'es' ? 'Cargando' : 'Loading'}</span>
      </Centered>
    );
  }

  const stateTone =
    view.state === 'available' ? 'chip-safe' : view.state === 'destroyed' || view.state === 'revoked' ? 'chip-danger' : 'chip-warn';

  return (
    <div className="mx-auto w-full max-w-content px-4 py-8 sm:px-6">
      <div className="surface overflow-hidden">
        <div className="border-b px-5 py-4" style={{ borderColor: 'var(--border-subtle)' }}>
          <h1 className="text-base font-semibold tracking-tight">{strings.manageTitle}</h1>
          <p className="numeric mt-1 truncate text-xs" style={{ color: 'var(--text-tertiary)' }}>
            {view.id}
          </p>
        </div>

        <dl className="grid grid-cols-2 gap-4 p-5 sm:grid-cols-3">
          <Stat label={locale === 'es' ? 'Estado' : 'State'}>
            <span className={`chip ${stateTone}`}>{view.state}</span>
          </Stat>
          <Stat label={strings.openings}>
            <span className="numeric">
              {view.claimsCount} / {view.maxClaims}
            </span>
          </Stat>
          <Stat label={strings.expiresIn}>
            <span className="numeric">
              {formatDuration(new Date(view.expiresAt).getTime() - Date.now(), locale)}
            </span>
          </Stat>
          <Stat label={locale === 'es' ? 'Creada' : 'Created'}>
            <span className="numeric text-sm">{new Date(view.createdAt).toLocaleString(locale)}</span>
          </Stat>
          <Stat label={locale === 'es' ? 'Tamaño cifrado' : 'Encrypted size'}>
            <span className="numeric">{formatBytes(view.totalCipherBytes)}</span>
          </Stat>
          <Stat label={locale === 'es' ? 'Elementos' : 'Items'}>
            <span className="numeric">{view.objectCount}</span>
          </Stat>
        </dl>

        {view.state === 'available' && (
          <div className="flex flex-wrap gap-2 border-t px-5 py-4" style={{ borderColor: 'var(--border-subtle)' }}>
            <button
              type="button"
              className="btn btn-danger"
              disabled={busy}
              data-testid="revoke"
              onClick={() => void act('revoke')}
            >
              {strings.revoke}
            </button>

            <label className="flex items-center gap-2">
              <span className="text-sm" style={{ color: 'var(--text-secondary)' }}>
                {strings.shorten}
              </span>
              <select
                className="field"
                style={{ width: 'auto', minHeight: 44 }}
                disabled={busy}
                defaultValue=""
                onChange={(event) => {
                  if (event.target.value !== '') {
                    void act('expiry', {
                      method: 'PATCH',
                      body: JSON.stringify({ ttlSeconds: Number(event.target.value) }),
                    });
                  }
                }}
              >
                <option value="">—</option>
                {ttlPresets
                  .filter((preset) => preset.seconds <= limits.maxTtlHours * 3600)
                  .map((preset) => (
                    <option key={preset.id} value={preset.seconds}>
                      {formatDuration(preset.seconds * 1000, locale)}
                    </option>
                  ))}
              </select>
            </label>
          </div>
        )}

        {/* Content-free timeline (§21). */}
        <div className="border-t px-5 py-4" style={{ borderColor: 'var(--border-subtle)' }}>
          <h2 className="mb-2 text-sm font-medium">{strings.history}</h2>
          <ol className="flex flex-col gap-1.5">
            {view.events.map((event, index) => (
              <li key={index} className="flex justify-between gap-4 text-sm">
                <span>{strings.events[event.kind as keyof typeof strings.events] ?? event.kind}</span>
                <span className="numeric" style={{ color: 'var(--text-tertiary)' }}>
                  {new Date(event.at).toLocaleString(locale)}
                </span>
              </li>
            ))}
          </ol>
          <p className="mt-3 text-sm" style={{ color: 'var(--text-tertiary)' }}>
            {locale === 'es'
              ? 'No se registran direcciones IP, navegadores ni ubicaciones. Este panel no puede mostrar el contenido.'
              : 'No IP addresses, browsers or locations are recorded. This panel cannot show the content.'}
          </p>
        </div>
      </div>
    </div>
  );
}

function Stat({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <dt className="text-xs uppercase tracking-wide" style={{ color: 'var(--text-tertiary)', letterSpacing: '0.04em' }}>
        {label}
      </dt>
      <dd>{children}</dd>
    </div>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto flex min-h-[60vh] w-full max-w-content flex-col items-center justify-center gap-3 px-4">
      {children}
    </div>
  );
}
