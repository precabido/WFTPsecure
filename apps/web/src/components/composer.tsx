'use client';

/**
 * The capsule composer (§21 "Página principal").
 *
 * Above the fold, immediately usable: pick a tab, type or drop, choose a
 * duration, create. Everything else lives behind "Customise" (§1 progressive
 * disclosure) so that a first-time user never meets a cryptography decision.
 */

import { useCallback, useMemo, useRef, useState } from 'react';
import { ttlPresets, limits } from '@cinderlink/config/limits';
import { t, formatBytes, formatDuration, type Locale } from '@/lib/i18n';
import { createCapsule, type CreateResult, type Progress } from '@/lib/capsule-client';
import type { ReceiverConfig, StructuredField, CapsuleKind, TemplateId } from '@cinderlink/crypto';
import { SealResult } from './seal-result';
import { AdvancedPanel } from './advanced-panel';

const DEFAULT_RECEIVER: ReceiverConfig = {
  theme: 'light',
  accent: 'violet',
  destroyAnimation: 'dissolve',
  locale: 'es',
  autoHideOnBlur: false,
  holdToReveal: false,
  visibleSeconds: 0,
  allowPreview: true,
  forceDownload: false,
};

type Tab = 'note' | 'files' | 'combined' | 'request';

export function Composer({ locale, baseUrl }: { locale: Locale; baseUrl: string }) {
  const strings = t(locale);

  const [tab, setTab] = useState<Tab>('note');
  const [template, setTemplate] = useState<TemplateId>('note');
  const [message, setMessage] = useState('');
  const [title, setTitle] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [fields, setFields] = useState<StructuredField[]>([]);
  const [ttlSeconds, setTtlSeconds] = useState(3600);
  const [maxClaims, setMaxClaims] = useState(1);
  const [password, setPassword] = useState('');
  const [splitDelivery, setSplitDelivery] = useState(false);
  const [receiver, setReceiver] = useState<ReceiverConfig>({ ...DEFAULT_RECEIVER, locale });
  const [advancedOpen, setAdvancedOpen] = useState(false);

  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<CreateResult | null>(null);
  const [dragging, setDragging] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);

  const totalFileBytes = useMemo(() => files.reduce((sum, f) => sum + f.size, 0), [files]);

  const canSubmit =
    !busy &&
    ((tab === 'note' && message.trim().length > 0) ||
      (tab === 'files' && files.length > 0) ||
      (tab === 'combined' && (message.trim().length > 0 || files.length > 0)) ||
      (tab === 'request' && message.trim().length > 0));

  const addFiles = useCallback(
    (incoming: FileList | File[]) => {
      setError(null);
      const list = Array.from(incoming);
      const next = [...files];
      for (const file of list) {
        if (next.length >= limits.maxFilesPerCapsule) {
          setError(
            locale === 'es'
              ? `Máximo ${limits.maxFilesPerCapsule} archivos por cápsula.`
              : `Maximum ${limits.maxFilesPerCapsule} files per capsule.`,
          );
          break;
        }
        if (file.size > limits.maxFileBytes) {
          setError(
            locale === 'es'
              ? `"${file.name}" supera el límite de ${formatBytes(limits.maxFileBytes)}.`
              : `"${file.name}" exceeds the ${formatBytes(limits.maxFileBytes)} limit.`,
          );
          continue;
        }
        next.push(file);
      }
      setFiles(next);
    },
    [files, locale],
  );

  async function onCreate() {
    setBusy(true);
    setError(null);
    setProgress({ phase: 'encrypting', ratio: 0 });
    try {
      const kind: CapsuleKind =
        tab === 'files' ? 'files' : tab === 'combined' ? 'combined' : 'note';

      const created = await createCapsule(
        {
          kind,
          template,
          ...(title ? { title } : {}),
          ...(message ? { message } : {}),
          ...(fields.length > 0 ? { fields } : {}),
          files,
          receiver,
          policy: {
            burnMode: maxClaims === 0 ? 'time-only' : 'on-claim',
            maxClaims: Math.max(1, maxClaims),
            ttlSeconds,
            unlockInSeconds: null,
            claimWindowSeconds: limits.defaultClaimWindowSeconds,
          },
          ...(password ? { password } : {}),
          ...(splitDelivery && !password ? { splitDelivery: true } : {}),
        },
        baseUrl,
        setProgress,
        limits.chunkBytes,
      );
      setResult(created);
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : locale === 'es'
            ? 'No se pudo crear la cápsula.'
            : 'Could not create the capsule.',
      );
    } finally {
      setBusy(false);
      setProgress(null);
    }
  }

  function reset() {
    setResult(null);
    setMessage('');
    setTitle('');
    setFiles([]);
    setFields([]);
    setPassword('');
    setSplitDelivery(false);
  }

  if (result !== null) {
    return <SealResult result={result} locale={locale} onCreateAnother={reset} />;
  }

  return (
    <div className="surface overflow-hidden">
      {/* Tabs (§21) */}
      <div
        role="tablist"
        aria-label={locale === 'es' ? 'Tipo de cápsula' : 'Capsule type'}
        className="flex gap-1 border-b p-1.5"
        style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-sunken)' }}
      >
        {(['note', 'files', 'combined', 'request'] as const).map((id) => (
          <button
            key={id}
            role="tab"
            type="button"
            id={`tab-${id}`}
            aria-selected={tab === id}
            aria-controls={`panel-${id}`}
            onClick={() => {
              setTab(id);
              setTemplate(id === 'files' ? 'files' : id === 'request' ? 'request' : 'note');
            }}
            className="btn flex-1 text-sm"
            style={
              tab === id
                ? {
                    background: 'var(--surface-raised)',
                    color: 'var(--text-primary)',
                    boxShadow: 'var(--shadow-sm)',
                  }
                : { background: 'transparent', color: 'var(--text-secondary)' }
            }
          >
            {strings.tabs[id]}
          </button>
        ))}
      </div>

      <div
        role="tabpanel"
        id={`panel-${tab}`}
        aria-labelledby={`tab-${tab}`}
        className="flex flex-col gap-4 p-4 sm:p-5"
      >
        {tab !== 'files' && (
          <div>
            <label htmlFor="composer-message" className="sr-only">
              {tab === 'request' ? strings.requestTitle : strings.notePlaceholder}
            </label>
            <textarea
              id="composer-message"
              className="field resize-y"
              rows={tab === 'request' ? 3 : 6}
              maxLength={limits.maxTextChars}
              placeholder={tab === 'request' ? strings.requestTitle : strings.notePlaceholder}
              value={message}
              onChange={(event) => setMessage(event.target.value)}
              style={{ minHeight: tab === 'request' ? '5rem' : '9rem', fontSize: '0.9375rem' }}
            />
            <p className="mt-1 text-right numeric" style={{ color: 'var(--text-tertiary)', fontSize: '0.75rem' }}>
              {message.length.toLocaleString()} / {limits.maxTextChars.toLocaleString()}
            </p>
          </div>
        )}

        {tab !== 'note' && tab !== 'request' && (
          <Dropzone
            locale={locale}
            dragging={dragging}
            files={files}
            totalBytes={totalFileBytes}
            onDragStateChange={setDragging}
            onFiles={addFiles}
            onRemove={(index) => setFiles(files.filter((_, i) => i !== index))}
            inputRef={fileInputRef}
          />
        )}

        {/* Quick duration picker (§21) */}
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-sm font-medium">{strings.duration}</legend>
          <div className="flex flex-wrap gap-1.5">
            {ttlPresets
              .filter((preset) => preset.seconds <= limits.maxTtlHours * 3600)
              .map((preset) => (
                <button
                  key={preset.id}
                  type="button"
                  onClick={() => setTtlSeconds(preset.seconds)}
                  aria-pressed={ttlSeconds === preset.seconds}
                  className="btn text-sm numeric"
                  style={{
                    minHeight: 40,
                    padding: '0 0.875rem',
                    background:
                      ttlSeconds === preset.seconds ? 'var(--accent-soft)' : 'var(--surface-raised)',
                    color: ttlSeconds === preset.seconds ? 'var(--accent)' : 'var(--text-secondary)',
                    border: `1px solid ${
                      ttlSeconds === preset.seconds ? 'var(--accent-border)' : 'var(--border-default)'
                    }`,
                  }}
                >
                  {formatDuration(preset.seconds * 1000, locale)}
                </button>
              ))}
          </div>
        </fieldset>

        {/* Policy summary (§21) */}
        <div
          className="flex flex-wrap items-center gap-2 rounded-lg px-3 py-2.5"
          style={{ background: 'var(--surface-sunken)', border: '1px solid var(--border-subtle)' }}
        >
          <span className="text-sm font-medium">{strings.policySummary}</span>
          <span className="chip numeric">{formatDuration(ttlSeconds * 1000, locale)}</span>
          <span className="chip">{maxClaims === 1 ? strings.onceOnly : strings.timesN(maxClaims)}</span>
          {password !== '' && <span className="chip chip-safe">{locale === 'es' ? 'Con contraseña' : 'Password'}</span>}
          {splitDelivery && password === '' && (
            <span className="chip chip-warn">{locale === 'es' ? 'Clave aparte' : 'Split key'}</span>
          )}
          {files.length > 0 && (
            <span className="chip numeric">
              {files.length} · {formatBytes(totalFileBytes)}
            </span>
          )}
        </div>

        <button
          type="button"
          className="btn btn-secondary self-start text-sm"
          aria-expanded={advancedOpen}
          aria-controls="advanced-panel"
          onClick={() => setAdvancedOpen(!advancedOpen)}
        >
          {strings.ctaCustomise}
          <span aria-hidden="true">{advancedOpen ? '▲' : '▼'}</span>
        </button>

        {advancedOpen && (
          <AdvancedPanel
            id="advanced-panel"
            locale={locale}
            maxClaims={maxClaims}
            onMaxClaims={setMaxClaims}
            password={password}
            onPassword={setPassword}
            splitDelivery={splitDelivery}
            onSplitDelivery={setSplitDelivery}
            title={title}
            onTitle={setTitle}
            receiver={receiver}
            onReceiver={setReceiver}
            template={template}
            onTemplate={setTemplate}
            fields={fields}
            onFields={setFields}
          />
        )}

        {error !== null && (
          <p
            role="alert"
            className="rounded-md px-3 py-2 text-sm"
            style={{ background: 'var(--danger-soft)', color: 'var(--danger)', border: '1px solid var(--danger-border)' }}
          >
            {error}
          </p>
        )}

        {/* §27: progress must be announced, not merely drawn. */}
        {progress !== null && (
          <div aria-live="polite" aria-atomic="true">
            <div className="mb-1 flex justify-between text-sm">
              <span>{progress.phase === 'uploading' ? strings.uploading : strings.encrypting}</span>
              <span className="numeric">{Math.round(progress.ratio * 100)}%</span>
            </div>
            <div
              role="progressbar"
              aria-valuenow={Math.round(progress.ratio * 100)}
              aria-valuemin={0}
              aria-valuemax={100}
              className="h-1.5 w-full overflow-hidden rounded-full"
              style={{ background: 'var(--surface-inset)' }}
            >
              <div
                className="h-full rounded-full"
                style={{
                  width: `${Math.round(progress.ratio * 100)}%`,
                  background: 'var(--accent-gradient)',
                  transition: 'width var(--motion-micro) var(--ease-out)',
                }}
              />
            </div>
          </div>
        )}

        <button type="button" className="btn btn-primary w-full" disabled={!canSubmit} onClick={onCreate}>
          {busy ? `${strings.encrypting}…` : strings.ctaCreate}
        </button>

        <p className="text-center text-sm" style={{ color: 'var(--text-secondary)' }}>
          {strings.encryptedHere}
        </p>
      </div>
    </div>
  );
}

function Dropzone({
  locale,
  dragging,
  files,
  totalBytes,
  onDragStateChange,
  onFiles,
  onRemove,
  inputRef,
}: {
  locale: Locale;
  dragging: boolean;
  files: File[];
  totalBytes: number;
  onDragStateChange: (dragging: boolean) => void;
  onFiles: (files: FileList | File[]) => void;
  onRemove: (index: number) => void;
  inputRef: React.RefObject<HTMLInputElement | null>;
}) {
  const strings = t(locale);
  return (
    <div>
      <div
        onDragOver={(event) => {
          event.preventDefault();
          onDragStateChange(true);
        }}
        onDragLeave={() => onDragStateChange(false)}
        onDrop={(event) => {
          event.preventDefault();
          onDragStateChange(false);
          if (event.dataTransfer.files.length > 0) onFiles(event.dataTransfer.files);
        }}
        className="flex flex-col items-center justify-center gap-2 rounded-lg px-4 py-8 text-center"
        style={{
          border: `1.5px dashed ${dragging ? 'var(--accent)' : 'var(--border-default)'}`,
          background: dragging ? 'var(--accent-soft)' : 'var(--surface-sunken)',
          transition: 'border-color var(--motion-micro), background var(--motion-micro)',
        }}
      >
        <p style={{ color: 'var(--text-secondary)', fontSize: '0.9375rem' }}>{strings.dropzone}</p>
        {/* §27: drag and drop always needs a button alternative. */}
        <button type="button" className="btn btn-secondary text-sm" onClick={() => inputRef.current?.click()}>
          {strings.dropzoneButton}
        </button>
        <input
          ref={inputRef}
          type="file"
          multiple
          className="sr-only"
          aria-label={strings.dropzoneButton}
          onChange={(event) => {
            if (event.target.files) onFiles(event.target.files);
            event.target.value = '';
          }}
        />
        <p className="numeric" style={{ color: 'var(--text-tertiary)', fontSize: '0.75rem' }}>
          {formatBytes(limits.maxFileBytes)} · {limits.maxFilesPerCapsule} max
        </p>
      </div>

      {files.length > 0 && (
        <ul className="mt-2 flex flex-col gap-1.5">
          {files.map((file, index) => (
            <li
              key={`${file.name}-${index}`}
              className="flex items-center justify-between gap-3 rounded-md px-3 py-2"
              style={{ background: 'var(--surface-sunken)', border: '1px solid var(--border-subtle)' }}
            >
              <span className="truncate text-sm" title={file.name}>
                {file.name}
              </span>
              <span className="flex shrink-0 items-center gap-2">
                <span className="numeric" style={{ color: 'var(--text-tertiary)', fontSize: '0.75rem' }}>
                  {formatBytes(file.size)}
                </span>
                <button
                  type="button"
                  className="btn btn-ghost"
                  style={{ minHeight: 32, padding: '0 0.5rem' }}
                  onClick={() => onRemove(index)}
                  aria-label={`${locale === 'es' ? 'Quitar' : 'Remove'} ${file.name}`}
                >
                  <span aria-hidden="true">×</span>
                </button>
              </span>
            </li>
          ))}
          <li className="numeric px-3 text-right" style={{ color: 'var(--text-tertiary)', fontSize: '0.75rem' }}>
            {formatBytes(totalBytes)} / {formatBytes(limits.maxCapsuleCipherBytes)}
          </li>
        </ul>
      )}
    </div>
  );
}
