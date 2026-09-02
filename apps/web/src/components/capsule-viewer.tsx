'use client';

/**
 * Opened capsule (§21 "Página de receptor abierta").
 *
 * Hygiene rules this component follows (§12):
 *   - Decrypted content lives in React state only. It is never written to
 *     localStorage, sessionStorage, IndexedDB, a data attribute, or a log.
 *   - Object URLs are revoked as soon as a preview closes and on unmount, so a
 *     decrypted blob does not linger reachable in the document.
 *   - The privacy curtain is presented honestly: it hides content from someone
 *     glancing at the screen. It cannot stop an OS screenshot, and the copy
 *     says so rather than implying protection it does not have.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { wipe, type FileEntry, type CapsuleManifest } from '@cinderlink/crypto';
import { t, formatBytes, type Locale } from '@/lib/i18n';
import {
  downloadFile,
  completeRetrieval,
  canPreview,
  sanitizeFilename,
  type OpenedCapsule,
  type Progress,
} from '@/lib/capsule-client';
import { SealMark } from './seal-mark';
import { MarkdownView } from './markdown-view';

export function CapsuleViewer({ opened, locale }: { opened: OpenedCapsule; locale: Locale }) {
  const strings = t(locale);
  const manifest = opened.manifest;
  const receiver = manifest.receiver;

  const [hidden, setHidden] = useState(false);
  const [destroyed, setDestroyed] = useState(false);
  const [secondsLeft, setSecondsLeft] = useState(receiver.visibleSeconds);
  const [revealed, setRevealed] = useState<Record<string, boolean>>({});
  const [progress, setProgress] = useState<Progress | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ url: string; entry: FileEntry } | null>(null);

  const previewUrlRef = useRef<string | null>(null);

  /** Revoke any live object URL. Called on close, destroy and unmount. */
  const revokePreview = useCallback(() => {
    if (previewUrlRef.current !== null) {
      URL.revokeObjectURL(previewUrlRef.current);
      previewUrlRef.current = null;
    }
    setPreview(null);
  }, []);

  // Auto-hide when the tab loses focus (§22), if the sender asked for it.
  useEffect(() => {
    if (!receiver.autoHideOnBlur) return undefined;
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') setHidden(true);
    };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('blur', onVisibility);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('blur', onVisibility);
    };
  }, [receiver.autoHideOnBlur]);

  // Local visibility timer (§22). Cosmetic — the content is already delivered.
  useEffect(() => {
    if (receiver.visibleSeconds <= 0 || destroyed) return undefined;
    const timer = setInterval(() => {
      setSecondsLeft((value) => {
        if (value <= 1) {
          setHidden(true);
          clearInterval(timer);
          return 0;
        }
        return value - 1;
      });
    }, 1000);
    return () => clearInterval(timer);
  }, [receiver.visibleSeconds, destroyed]);

  // Best-effort scrub on unmount (§12) — documented as best effort, not a
  // guarantee, because the engine may hold copies we cannot reach.
  useEffect(
    () => () => {
      revokePreview();
      void wipe(opened.rootKey);
    },
    [opened.rootKey, revokePreview],
  );

  async function onDestroy() {
    revokePreview();
    await completeRetrieval(opened.retrievalToken);
    await wipe(opened.rootKey);
    setDestroyed(true);
  }

  async function onDownload(entry: FileEntry) {
    setFileError(null);
    try {
      const blob = await downloadFile(opened, entry, setProgress);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      // The name is sanitised here, in the browser — the server never saw it.
      anchor.download = sanitizeFilename(entry.name);
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      // Give the browser a moment to start the save before releasing the blob.
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
    } catch {
      setFileError(strings.tampered);
    } finally {
      setProgress(null);
    }
  }

  async function onPreview(entry: FileEntry) {
    setFileError(null);
    try {
      const blob = await downloadFile(opened, entry, setProgress);
      revokePreview();
      const url = URL.createObjectURL(blob);
      previewUrlRef.current = url;
      setPreview({ url, entry });
    } catch {
      setFileError(strings.tampered);
    } finally {
      setProgress(null);
    }
  }

  if (destroyed) {
    return (
      <div className="mx-auto flex min-h-[60vh] max-w-content flex-col items-center justify-center gap-3 px-4">
        <SealMark size={56} state="consumed" />
        <h1 className="text-lg font-semibold">{strings.unavailable}</h1>
        <p style={{ color: 'var(--text-secondary)' }}>{strings.states.destroyed}</p>
        <a href="/" className="btn btn-secondary mt-2">
          {locale === 'es' ? 'Crear una cápsula' : 'Create a capsule'}
        </a>
      </div>
    );
  }

  return (
    <div
      className="mx-auto w-full max-w-content px-4 py-8 sm:px-6"
      data-capsule-theme={receiver.theme === 'paper' || receiver.theme === 'terminal' ? receiver.theme : undefined}
    >
      <div className="surface animate-rise-in overflow-hidden">
        <div
          className="flex flex-wrap items-center justify-between gap-3 border-b px-5 py-4"
          style={{ borderColor: 'var(--border-subtle)' }}
        >
          <div className="min-w-0">
            <h1 className="truncate text-base font-semibold tracking-tight">
              {manifest.title ?? (locale === 'es' ? 'Cápsula abierta' : 'Capsule opened')}
            </h1>
            {manifest.senderAlias !== undefined && (
              <p className="truncate text-sm" style={{ color: 'var(--text-tertiary)' }}>
                {locale === 'es' ? 'De' : 'From'} {manifest.senderAlias}
              </p>
            )}
          </div>

          <div className="flex shrink-0 items-center gap-2">
            {receiver.visibleSeconds > 0 && !hidden && (
              <span className="chip chip-warn numeric" aria-live="polite">
                {secondsLeft}s
              </span>
            )}
            <button type="button" className="btn btn-secondary text-sm" onClick={() => setHidden(!hidden)}>
              {hidden ? strings.reveal : strings.hide}
            </button>
            <button type="button" className="btn btn-danger text-sm" onClick={() => void onDestroy()}>
              {strings.destroyNow}
            </button>
          </div>
        </div>

        <div className={hidden ? 'privacy-curtain' : ''} aria-hidden={hidden}>
          <div className="flex flex-col gap-5 p-5">
            {manifest.instructions !== undefined && (
              <p
                className="rounded-md px-3 py-2.5 text-sm"
                style={{ background: 'var(--surface-sunken)', border: '1px solid var(--border-subtle)' }}
              >
                {manifest.instructions}
              </p>
            )}

            {manifest.message !== undefined &&
              (manifest.markdown === true ? (
                <MarkdownView source={manifest.message} />
              ) : (
                <CopyBlock value={manifest.message} locale={locale} />
              ))}

            {manifest.fields !== undefined && manifest.fields.length > 0 && (
              <dl className="flex flex-col gap-2.5">
                {manifest.fields.map((field) => (
                  <div key={field.id} className="flex flex-col gap-1">
                    <dt className="text-sm font-medium" style={{ color: 'var(--text-secondary)' }}>
                      {field.label}
                    </dt>
                    <dd>
                      <CopyBlock
                        value={field.value}
                        locale={locale}
                        masked={field.secret && revealed[field.id] !== true}
                        multiline={field.multiline === true}
                        onToggleMask={
                          field.secret
                            ? () => setRevealed({ ...revealed, [field.id]: revealed[field.id] !== true })
                            : undefined
                        }
                        holdToReveal={receiver.holdToReveal}
                      />
                    </dd>
                  </div>
                ))}
              </dl>
            )}

            {manifest.code !== undefined && (
              <div>
                <span className="chip mb-1.5">{manifest.code.language}</span>
                <CopyBlock value={manifest.code.source} locale={locale} multiline mono />
              </div>
            )}

            {manifest.files !== undefined && manifest.files.length > 0 && (
              <FileList
                files={manifest.files}
                locale={locale}
                allowPreview={receiver.allowPreview && !receiver.forceDownload}
                progress={progress}
                onDownload={onDownload}
                onPreview={onPreview}
              />
            )}

            {fileError !== null && (
              <p role="alert" className="text-sm" style={{ color: 'var(--danger)' }}>
                {fileError}
              </p>
            )}
          </div>
        </div>

        {hidden && (
          <div className="border-t px-5 py-4 text-center" style={{ borderColor: 'var(--border-subtle)' }}>
            <button type="button" className="btn btn-secondary" onClick={() => setHidden(false)}>
              {strings.reveal}
            </button>
            <p className="mt-2 text-sm" style={{ color: 'var(--text-tertiary)' }}>
              {locale === 'es'
                ? 'La cortina oculta el contenido en pantalla. No impide capturas del sistema operativo ni fotos con otro dispositivo.'
                : 'The curtain hides content on screen. It cannot prevent operating-system screenshots or a photo taken with another device.'}
            </p>
          </div>
        )}
      </div>

      {preview !== null && (
        <PreviewModal
          url={preview.url}
          entry={preview.entry}
          locale={locale}
          onClose={revokePreview}
        />
      )}
    </div>
  );
}

function CopyBlock({
  value,
  locale,
  masked = false,
  multiline = false,
  mono = false,
  onToggleMask,
  holdToReveal = false,
}: {
  value: string;
  locale: Locale;
  masked?: boolean;
  multiline?: boolean;
  mono?: boolean;
  onToggleMask?: () => void;
  holdToReveal?: boolean;
}) {
  const strings = t(locale);
  const [copied, setCopied] = useState(false);
  const [held, setHeld] = useState(false);
  const showMasked = masked && !(holdToReveal && held);

  return (
    <div className="flex items-start gap-2">
      <pre
        className={`flex-1 overflow-x-auto rounded-md px-3 py-2.5 ${mono ? 'numeric' : ''}`}
        style={{
          background: 'var(--surface-sunken)',
          border: '1px solid var(--border-subtle)',
          whiteSpace: multiline ? 'pre' : 'pre-wrap',
          wordBreak: multiline ? 'normal' : 'break-word',
          fontSize: '0.875rem',
          fontFamily: mono ? undefined : 'inherit',
          margin: 0,
          maxHeight: '22rem',
        }}
      >
        {showMasked ? '•'.repeat(Math.min(value.length, 32)) : value}
      </pre>

      <div className="flex shrink-0 flex-col gap-1.5">
        {/* Copy works even while masked — the point is to paste, not to read. */}
        <button
          type="button"
          className="btn btn-secondary text-sm"
          style={{ minHeight: 36, padding: '0 0.6rem' }}
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(value);
              setCopied(true);
              setTimeout(() => setCopied(false), 1600);
            } catch {
              /* clipboard permission denied */
            }
          }}
        >
          {copied ? strings.copied : strings.copy}
        </button>

        {onToggleMask !== undefined && (
          <button
            type="button"
            className="btn btn-ghost text-sm"
            style={{ minHeight: 36, padding: '0 0.6rem' }}
            onClick={holdToReveal ? undefined : onToggleMask}
            onPointerDown={holdToReveal ? () => setHeld(true) : undefined}
            onPointerUp={holdToReveal ? () => setHeld(false) : undefined}
            onPointerLeave={holdToReveal ? () => setHeld(false) : undefined}
            aria-label={showMasked ? strings.reveal : strings.hide}
          >
            <span aria-hidden="true">{showMasked ? '👁' : '🙈'}</span>
          </button>
        )}
      </div>
    </div>
  );
}

function FileList({
  files,
  locale,
  allowPreview,
  progress,
  onDownload,
  onPreview,
}: {
  files: FileEntry[];
  locale: Locale;
  allowPreview: boolean;
  progress: Progress | null;
  onDownload: (entry: FileEntry) => Promise<void>;
  onPreview: (entry: FileEntry) => Promise<void>;
}) {
  const strings = t(locale);
  return (
    <ul className="flex flex-col gap-2">
      {files.map((entry) => {
        const busy = progress?.fileName === entry.name;
        return (
          <li
            key={entry.objectId}
            className="flex flex-wrap items-center justify-between gap-2 rounded-md px-3 py-2.5"
            style={{ background: 'var(--surface-sunken)', border: '1px solid var(--border-subtle)' }}
          >
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium" title={entry.name}>
                {entry.name}
              </span>
              <span className="numeric block text-xs" style={{ color: 'var(--text-tertiary)' }}>
                {formatBytes(entry.size)}
                {busy ? ` · ${strings.decrypting} ${Math.round((progress?.ratio ?? 0) * 100)}%` : ''}
              </span>
            </span>

            <span className="flex shrink-0 gap-1.5">
              {/* Preview is opt-in per file and never automatic (§14). */}
              {allowPreview && canPreview(entry.mimeType) && (
                <button
                  type="button"
                  className="btn btn-ghost text-sm"
                  style={{ minHeight: 36 }}
                  disabled={busy}
                  onClick={() => void onPreview(entry)}
                >
                  {locale === 'es' ? 'Vista previa' : 'Preview'}
                </button>
              )}
              <button
                type="button"
                className="btn btn-secondary text-sm"
                style={{ minHeight: 36 }}
                disabled={busy}
                onClick={() => void onDownload(entry)}
              >
                {strings.download}
              </button>
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Media preview (§14).
 *
 * Only image/audio/video from the allowlist reach here, and the Blob was
 * constructed with a sanitised MIME type. There is no <iframe>, no <object>,
 * and no innerHTML anywhere in this path, so an "image" that is really markup
 * cannot execute in our origin.
 */
function PreviewModal({
  url,
  entry,
  locale,
  onClose,
}: {
  url: string;
  entry: FileEntry;
  locale: Locale;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const kind = entry.mimeType.split('/')[0];

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={entry.name}
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: 'rgb(0 0 0 / 0.6)' }}
      onClick={onClose}
    >
      <div
        className="surface max-h-[86vh] max-w-[52rem] overflow-auto p-4"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between gap-3">
          <span className="truncate text-sm font-medium">{entry.name}</span>
          <button type="button" className="btn btn-secondary text-sm" onClick={onClose} autoFocus>
            {locale === 'es' ? 'Cerrar' : 'Close'}
          </button>
        </div>

        {kind === 'image' && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={url} alt={entry.name} style={{ maxWidth: '100%', height: 'auto', display: 'block' }} />
        )}
        {kind === 'audio' && <audio src={url} controls style={{ width: '100%' }} />}
        {kind === 'video' && <video src={url} controls style={{ maxWidth: '100%' }} />}
      </div>
    </div>
  );
}
