'use client';

/**
 * Creation result (§21 "Resultado de creación").
 *
 * The single most important layout decision here: the recipient link and the
 * management link are in visually distinct blocks, far apart, with different
 * treatments. Putting them side by side is how management tokens get pasted
 * into the wrong chat window.
 */

import { useEffect, useRef, useState } from 'react';
import { formatFingerprint, formatDeliveryKey } from '@cinderlink/crypto';
import { t, formatBytes, type Locale } from '@/lib/i18n';
import type { CreateResult } from '@/lib/capsule-client';
import { SealMark } from './seal-mark';
import { QrCode } from './qr-code';

function CopyField({
  label,
  value,
  locale,
  tone = 'default',
  mono = false,
}: {
  label: string;
  value: string;
  locale: Locale;
  tone?: 'default' | 'warn';
  mono?: boolean;
}) {
  const strings = t(locale);
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1800);
    } catch {
      // Clipboard can be denied; the value is selectable as a fallback.
    }
  }

  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-sm font-medium">{label}</span>
      <div className="flex gap-2">
        <input
          readOnly
          value={value}
          onFocus={(event) => event.currentTarget.select()}
          className={`field ${mono ? 'numeric' : ''}`}
          style={
            tone === 'warn'
              ? { background: 'var(--warn-soft)', borderColor: 'var(--warn-border)', fontSize: '0.8125rem' }
              : { fontSize: '0.8125rem' }
          }
          aria-label={label}
        />
        <button type="button" className="btn btn-secondary shrink-0" onClick={copy}>
          {copied ? strings.copied : strings.copy}
        </button>
      </div>
    </div>
  );
}

export function SealResult({
  result,
  locale,
  onCreateAnother,
}: {
  result: CreateResult;
  locale: Locale;
  onCreateAnother: () => void;
}) {
  const strings = t(locale);
  const [canShare, setCanShare] = useState(false);

  useEffect(() => {
    setCanShare(typeof navigator !== 'undefined' && typeof navigator.share === 'function');
  }, []);

  return (
    <div className="surface animate-rise-in overflow-hidden">
      <div className="flex flex-col items-center gap-3 px-5 pt-8 pb-5 text-center">
        <SealMark size={64} animate state="sealing" />
        <h2 className="text-xl font-semibold tracking-tight">{strings.sealed}</h2>
        <p className="numeric text-sm" style={{ color: 'var(--text-tertiary)' }}>
          {new Date(result.expiresAt).toLocaleString(locale)} · {formatBytes(result.totalBytes)}
        </p>
      </div>

      <div className="flex flex-col gap-5 border-t p-5" style={{ borderColor: 'var(--border-subtle)' }}>
        <CopyField label={strings.recipientLink} value={result.recipientUrl} locale={locale} />

        {result.separateKey !== undefined && (
          <>
            <CopyField
              label={strings.separateKey}
              value={formatDeliveryKey(result.separateKey)}
              locale={locale}
              tone="warn"
              mono
            />
            <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
              {strings.splitExplain}
            </p>
          </>
        )}

        <div className="flex flex-wrap items-start gap-5">
          <QrCode
            text={result.recipientUrl}
            size={132}
            label={locale === 'es' ? 'Código QR del enlace' : 'QR code for the link'}
          />

          <div className="flex min-w-[12rem] flex-1 flex-col gap-3">
            <div>
              <span className="text-sm font-medium">{strings.fingerprint}</span>
              <p className="numeric mt-1" style={{ fontSize: '0.9375rem', letterSpacing: '0.01em' }}>
                {formatFingerprint(result.fingerprint)}
              </p>
              <p className="mt-1 text-sm" style={{ color: 'var(--text-tertiary)' }}>
                {strings.fingerprintHelp}
              </p>
            </div>

            {canShare && (
              <button
                type="button"
                className="btn btn-secondary self-start text-sm"
                onClick={() => {
                  void navigator.share({ url: result.recipientUrl }).catch(() => undefined);
                }}
              >
                {strings.share}
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Management link — deliberately a separate, differently-styled block. */}
      <div
        className="m-5 flex flex-col gap-2.5 rounded-lg p-4"
        style={{ background: 'var(--danger-soft)', border: '1px solid var(--danger-border)' }}
      >
        <span className="text-sm font-semibold" style={{ color: 'var(--danger)' }}>
          {strings.manageLink}
        </span>
        <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
          {strings.manageWarning}
        </p>
        <CopyField label={strings.manageLink} value={result.manageUrl} locale={locale} />
      </div>

      <div className="px-5 pb-5">
        <button type="button" className="btn btn-secondary w-full" onClick={onCreateAnother}>
          {strings.createAnother}
        </button>
      </div>
    </div>
  );
}
