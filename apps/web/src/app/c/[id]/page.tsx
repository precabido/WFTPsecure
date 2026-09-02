'use client';

/**
 * Recipient route (§15, §21).
 *
 * THE CRITICAL BEHAVIOUR: loading this page does nothing but read public
 * status. The capsule is consumed only when the person presses "Open and
 * consume". Link scanners, chat previews, mail gateways and accidental
 * refreshes all issue GETs — none of them may destroy the content.
 *
 * That is why there is no claim call in any effect: claiming lives exclusively
 * in an onClick handler.
 */

import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { PasswordError, EnvelopeError, LinkError, parseDeliveryKey } from '@cinderlink/crypto';
import { t, formatDuration, formatBytes, type Locale } from '@/lib/i18n';
import { usePrefs } from '@/components/shell';
import { SealMark } from '@/components/seal-mark';
import { CapsuleViewer } from '@/components/capsule-viewer';
import { fetchStatus, claimAndOpen, type PublicStatus, type OpenedCapsule } from '@/lib/capsule-client';

type Phase = 'loading' | 'gate' | 'opening' | 'open' | 'unavailable';

export default function CapsulePage() {
  const params = useParams<{ id: string }>();
  const capsuleId = params.id;
  const { locale } = usePrefs();
  const strings = t(locale);

  const [phase, setPhase] = useState<Phase>('loading');
  const [status, setStatus] = useState<PublicStatus | null>(null);
  const [fragment, setFragment] = useState('');
  const [needs, setNeeds] = useState<'none' | 'password' | 'key'>('none');
  const [password, setPassword] = useState('');
  const [keyInput, setKeyInput] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [opened, setOpened] = useState<OpenedCapsule | null>(null);
  const [now, setNow] = useState(() => Date.now());

  // Read-only status fetch. Deliberately the ONLY network call on mount.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const hash = window.location.hash.replace(/^#/, '');
      setFragment(hash);

      if (hash.includes('p=a2')) setNeeds('password');
      else if (hash.includes('x=1')) setNeeds('key');
      else setNeeds('none');

      const fetched = await fetchStatus(capsuleId);
      if (cancelled) return;
      setStatus(fetched);
      setPhase(fetched === null || fetched.state !== 'available' ? 'unavailable' : 'gate');
    })();
    return () => {
      cancelled = true;
    };
  }, [capsuleId]);

  // Local countdown; purely cosmetic, the server enforces the real deadline.
  useEffect(() => {
    if (phase !== 'gate') return undefined;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [phase]);

  const onOpen = useCallback(async () => {
    setError(null);
    setPhase('opening');
    try {
      const result = await claimAndOpen(
        capsuleId,
        fragment,
        needs === 'password' ? password : undefined,
        needs === 'key' ? parseDeliveryKey(keyInput) : undefined,
      );
      setOpened(result);
      setPhase('open');
    } catch (caught) {
      if (caught instanceof PasswordError) setError(strings.wrongPassword);
      else if (caught instanceof LinkError) setError(strings.states.corrupt);
      else if (caught instanceof EnvelopeError) {
        // Wrong key and tampered ciphertext are indistinguishable to Poly1305;
        // report the one the recipient can act on.
        setError(needs === 'key' ? strings.wrongKey : strings.tampered);
      } else setError(strings.unavailable);

      // Re-read status: a failed claim may have consumed the capsule if the
      // failure happened after the claim (e.g. a bad manifest), so the gate
      // must not offer a retry that cannot succeed.
      const refreshed = await fetchStatus(capsuleId);
      setStatus(refreshed);
      setPhase(refreshed !== null && refreshed.state === 'available' ? 'gate' : 'unavailable');
    }
  }, [capsuleId, fragment, needs, password, keyInput, strings]);

  if (phase === 'loading') {
    return (
      <Centered>
        <div className="h-16 w-16 rounded-full" style={{ background: 'var(--surface-sunken)' }} aria-hidden="true" />
        <span className="sr-only">{locale === 'es' ? 'Cargando' : 'Loading'}</span>
      </Centered>
    );
  }

  if (phase === 'unavailable' || status === null) {
    const reason = status?.state ?? 'not-found';
    return (
      <Centered>
        <SealMark size={56} state="consumed" />
        <h1 className="text-lg font-semibold">{strings.unavailable}</h1>
        <p style={{ color: 'var(--text-secondary)' }}>
          {strings.states[reason as keyof typeof strings.states] ?? strings.states['not-found']}
        </p>
        {error !== null && (
          <p role="alert" style={{ color: 'var(--danger)', fontSize: '0.875rem' }}>
            {error}
          </p>
        )}
        <a href="/" className="btn btn-secondary mt-2">
          {locale === 'es' ? 'Crear una cápsula' : 'Create a capsule'}
        </a>
      </Centered>
    );
  }

  if (phase === 'open' && opened !== null) {
    return <CapsuleViewer opened={opened} locale={locale} />;
  }

  const remaining = new Date(status.expiresAt).getTime() - now;
  const isOneTime = status.maxClaims === 1 && status.burnMode !== 'time-only';

  return (
    <Centered>
      <div className="surface w-full max-w-[26rem] p-6 text-center animate-rise-in">
        <div className="mb-4 flex justify-center">
          <SealMark size={56} />
        </div>

        <h1 className="text-lg font-semibold tracking-tight">{strings.waiting}</h1>

        <dl className="mt-4 flex flex-col gap-2 text-sm">
          <div className="flex justify-between">
            <dt style={{ color: 'var(--text-secondary)' }}>{strings.remaining}</dt>
            <dd className="numeric">{formatDuration(remaining, locale)}</dd>
          </div>
          <div className="flex justify-between">
            <dt style={{ color: 'var(--text-secondary)' }}>{strings.openings}</dt>
            <dd className="numeric">
              {isOneTime ? strings.onceOnly : `${status.claimsRemaining} / ${status.maxClaims}`}
            </dd>
          </div>
          {status.objectCount > 0 && (
            <div className="flex justify-between">
              <dt style={{ color: 'var(--text-secondary)' }}>{strings.items}</dt>
              <dd className="numeric">
                {status.objectCount} · {formatBytes(status.totalCipherBytes)}
              </dd>
            </div>
          )}
        </dl>

        {isOneTime && (
          <p
            className="mt-4 rounded-md px-3 py-2.5 text-sm"
            style={{ background: 'var(--warn-soft)', border: '1px solid var(--warn-border)', color: 'var(--warn)' }}
          >
            {strings.oneTimeWarning}
          </p>
        )}

        {needs === 'password' && (
          <label className="mt-4 flex flex-col gap-1.5 text-left">
            <span className="text-sm font-medium">{strings.enterPassword}</span>
            <input
              className="field"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && password !== '') void onOpen();
              }}
            />
          </label>
        )}

        {needs === 'key' && (
          <label className="mt-4 flex flex-col gap-1.5 text-left">
            <span className="text-sm font-medium">{strings.enterKey}</span>
            <input
              className="field numeric"
              value={keyInput}
              spellCheck={false}
              autoCapitalize="none"
              autoCorrect="off"
              onChange={(event) => setKeyInput(event.target.value)}
              style={{ fontSize: '0.8125rem' }}
            />
          </label>
        )}

        {error !== null && (
          <p role="alert" className="mt-3 text-sm" style={{ color: 'var(--danger)' }}>
            {error}
          </p>
        )}

        {/*
          The consuming action. Nothing else on this page mutates state, and
          this handler is reached only by a deliberate press.
        */}
        <button
          type="button"
          className="btn btn-primary mt-5 w-full"
          data-testid="open-and-consume"
          disabled={
            phase === 'opening' ||
            (needs === 'password' && password === '') ||
            (needs === 'key' && keyInput.trim() === '')
          }
          onClick={() => void onOpen()}
        >
          {phase === 'opening' ? `${strings.decrypting}…` : strings.openAndConsume}
        </button>

        <p className="mt-3 text-sm" style={{ color: 'var(--text-tertiary)' }}>
          {strings.encryptedHere}
        </p>
      </div>
    </Centered>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto flex min-h-[70vh] w-full max-w-content flex-col items-center justify-center gap-3 px-4 py-10">
      {children}
    </div>
  );
}
