'use client';

/**
 * Advanced settings (§22).
 *
 * Progressive disclosure: nothing here is required to create a capsule, and
 * every control is phrased in plain language with the consequence stated.
 * Notably absent by policy: custom HTML/CSS/JS, remote image URLs, embeds,
 * external fonts — anything that would let a sender inject content into the
 * recipient's page.
 */

import { useId, useState } from 'react';
import { estimatePasswordStrength } from '@cinderlink/crypto';
import { readWindowPresets, limits } from '@cinderlink/config/limits';
import { t, type Locale } from '@/lib/i18n';
import type { ReceiverConfig, StructuredField, TemplateId } from '@cinderlink/crypto';

const TEMPLATES: TemplateId[] = ['note', 'credentials', 'api-key', 'env-vars', 'code', 'json'];

/** Local password generator — never leaves the browser (§11). */
function generatePassphrase(): string {
  const words = [
    'ancla', 'bruma', 'cobre', 'delta', 'ebano', 'faro', 'grava', 'hielo',
    'islote', 'jade', 'kelp', 'lienzo', 'marea', 'nacar', 'onix', 'pizarra',
    'quilla', 'risco', 'savia', 'tundra', 'umbral', 'vega', 'yunque', 'zafiro',
  ];
  const picks: string[] = [];
  const random = new Uint32Array(5);
  crypto.getRandomValues(random);
  for (let i = 0; i < 5; i += 1) {
    picks.push(words[(random[i] as number) % words.length] as string);
  }
  return picks.join('-');
}

export function AdvancedPanel({
  id,
  locale,
  maxClaims,
  onMaxClaims,
  password,
  onPassword,
  splitDelivery,
  onSplitDelivery,
  title,
  onTitle,
  receiver,
  onReceiver,
  template,
  onTemplate,
  fields,
  onFields,
}: {
  id: string;
  locale: Locale;
  maxClaims: number;
  onMaxClaims: (value: number) => void;
  password: string;
  onPassword: (value: string) => void;
  splitDelivery: boolean;
  onSplitDelivery: (value: boolean) => void;
  title: string;
  onTitle: (value: string) => void;
  receiver: ReceiverConfig;
  onReceiver: (value: ReceiverConfig) => void;
  template: TemplateId;
  onTemplate: (value: TemplateId) => void;
  fields: StructuredField[];
  onFields: (value: StructuredField[]) => void;
}) {
  const strings = t(locale);
  const [showPassword, setShowPassword] = useState(false);
  const passwordId = useId();
  const strength = estimatePasswordStrength(password);

  const strengthLabels =
    locale === 'es'
      ? ['Muy débil', 'Débil', 'Aceptable', 'Fuerte', 'Muy fuerte']
      : ['Very weak', 'Weak', 'Fair', 'Strong', 'Very strong'];

  return (
    <div
      id={id}
      className="flex flex-col gap-5 rounded-lg p-4 animate-rise-in"
      style={{ background: 'var(--surface-sunken)', border: '1px solid var(--border-subtle)' }}
    >
      {/* Template ------------------------------------------------------- */}
      <fieldset>
        <legend className="mb-2 text-sm font-medium">
          {locale === 'es' ? 'Plantilla' : 'Template'}
        </legend>
        <div className="flex flex-wrap gap-1.5">
          {TEMPLATES.map((id2) => (
            <button
              key={id2}
              type="button"
              aria-pressed={template === id2}
              onClick={() => {
                onTemplate(id2);
                if (id2 === 'credentials' && fields.length === 0) {
                  onFields([
                    { id: 'service', label: locale === 'es' ? 'Servicio' : 'Service', value: '', secret: false },
                    { id: 'user', label: locale === 'es' ? 'Usuario' : 'Username', value: '', secret: false },
                    { id: 'pass', label: locale === 'es' ? 'Contraseña' : 'Password', value: '', secret: true },
                    { id: 'url', label: 'URL', value: '', secret: false },
                  ]);
                }
              }}
              className="btn text-sm"
              style={{
                minHeight: 36,
                padding: '0 0.75rem',
                background: template === id2 ? 'var(--accent-soft)' : 'var(--surface-raised)',
                color: template === id2 ? 'var(--accent)' : 'var(--text-secondary)',
                border: `1px solid ${template === id2 ? 'var(--accent-border)' : 'var(--border-default)'}`,
              }}
            >
              {strings.templates[id2]}
            </button>
          ))}
        </div>
      </fieldset>

      {/* Structured fields (§9) ------------------------------------------ */}
      {fields.length > 0 && (
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-sm font-medium">
            {locale === 'es' ? 'Campos' : 'Fields'}
          </legend>
          {fields.map((field, index) => (
            <label key={field.id} className="flex flex-col gap-1">
              <span className="text-sm" style={{ color: 'var(--text-secondary)' }}>
                {field.label}
              </span>
              <input
                className="field"
                type={field.secret ? 'password' : 'text'}
                value={field.value}
                // Password managers must not be blocked (§27).
                autoComplete={field.secret ? 'new-password' : 'off'}
                onChange={(event) => {
                  const next = [...fields];
                  next[index] = { ...field, value: event.target.value };
                  onFields(next);
                }}
              />
            </label>
          ))}
        </fieldset>
      )}

      {/* Openings -------------------------------------------------------- */}
      <fieldset>
        <legend className="mb-2 text-sm font-medium">{strings.openings}</legend>
        <div className="flex flex-wrap gap-1.5">
          {[1, 2, 3, 5, 10].map((count) => (
            <button
              key={count}
              type="button"
              aria-pressed={maxClaims === count}
              onClick={() => onMaxClaims(count)}
              disabled={count > limits.maxClaims}
              className="btn numeric text-sm"
              style={{
                minHeight: 40,
                padding: '0 0.875rem',
                background: maxClaims === count ? 'var(--accent-soft)' : 'var(--surface-raised)',
                color: maxClaims === count ? 'var(--accent)' : 'var(--text-secondary)',
                border: `1px solid ${maxClaims === count ? 'var(--accent-border)' : 'var(--border-default)'}`,
              }}
            >
              {count === 1 ? (locale === 'es' ? '1 vez' : 'once') : `${count}×`}
            </button>
          ))}
        </div>
      </fieldset>

      {/* Password (§11) -------------------------------------------------- */}
      <div className="flex flex-col gap-2">
        <label htmlFor={passwordId} className="text-sm font-medium">
          {strings.passwordOptional}
        </label>
        <div className="flex gap-2">
          <input
            id={passwordId}
            className="field"
            type={showPassword ? 'text' : 'password'}
            value={password}
            // Never block paste — blocking it pushes people to weaker passwords.
            onPaste={(event) => event.stopPropagation()}
            autoComplete="new-password"
            onChange={(event) => onPassword(event.target.value)}
            aria-describedby={`${passwordId}-hint`}
          />
          <button
            type="button"
            className="btn btn-secondary shrink-0 text-sm"
            onClick={() => setShowPassword(!showPassword)}
            aria-label={showPassword ? strings.hide : strings.reveal}
          >
            <span aria-hidden="true">{showPassword ? '🙈' : '👁'}</span>
          </button>
          <button
            type="button"
            className="btn btn-secondary shrink-0 text-sm"
            onClick={() => {
              onPassword(generatePassphrase());
              setShowPassword(true);
            }}
          >
            {strings.generatePassword}
          </button>
        </div>

        {password !== '' && (
          <div className="flex items-center gap-2" aria-live="polite">
            <div className="flex gap-1" aria-hidden="true">
              {[0, 1, 2, 3].map((step) => (
                <span
                  key={step}
                  className="h-1 w-8 rounded-full"
                  style={{
                    background:
                      step < strength.score
                        ? strength.score >= 3
                          ? 'var(--safe)'
                          : 'var(--warn)'
                        : 'var(--surface-inset)',
                  }}
                />
              ))}
            </div>
            <span className="text-sm" style={{ color: 'var(--text-secondary)' }}>
              {strengthLabels[strength.score]}
            </span>
          </div>
        )}

        <p id={`${passwordId}-hint`} className="text-sm" style={{ color: 'var(--text-tertiary)' }}>
          {strings.passwordHint}
        </p>
      </div>

      {/* Split delivery (§11) -------------------------------------------- */}
      {password === '' && (
        <label className="flex cursor-pointer items-start gap-2.5">
          <input
            type="checkbox"
            checked={splitDelivery}
            onChange={(event) => onSplitDelivery(event.target.checked)}
            className="mt-1 h-4 w-4"
          />
          <span>
            <span className="block text-sm font-medium">{strings.splitDelivery}</span>
            <span className="block text-sm" style={{ color: 'var(--text-tertiary)' }}>
              {strings.splitExplain}
            </span>
          </span>
        </label>
      )}

      {/* Title ------------------------------------------------------------ */}
      <label className="flex flex-col gap-1.5">
        <span className="text-sm font-medium">{locale === 'es' ? 'Título' : 'Title'}</span>
        <input
          className="field"
          value={title}
          maxLength={120}
          onChange={(event) => onTitle(event.target.value)}
          placeholder={locale === 'es' ? 'Visible solo tras abrir' : 'Visible only after opening'}
        />
      </label>

      {/* Recipient experience (§22) --------------------------------------- */}
      <fieldset className="flex flex-col gap-2.5">
        <legend className="mb-1 text-sm font-medium">
          {locale === 'es' ? 'Experiencia del destinatario' : 'Recipient experience'}
        </legend>

        <label className="flex cursor-pointer items-center gap-2.5">
          <input
            type="checkbox"
            checked={receiver.autoHideOnBlur}
            onChange={(event) => onReceiver({ ...receiver, autoHideOnBlur: event.target.checked })}
            className="h-4 w-4"
          />
          <span className="text-sm">
            {locale === 'es' ? 'Ocultar al cambiar de pestaña' : 'Hide when the tab loses focus'}
          </span>
        </label>

        <label className="flex cursor-pointer items-center gap-2.5">
          <input
            type="checkbox"
            checked={receiver.holdToReveal}
            onChange={(event) => onReceiver({ ...receiver, holdToReveal: event.target.checked })}
            className="h-4 w-4"
          />
          <span className="text-sm">
            {locale === 'es' ? 'Mantener pulsado para revelar' : 'Press and hold to reveal'}
          </span>
        </label>

        <label className="flex cursor-pointer items-center gap-2.5">
          <input
            type="checkbox"
            checked={receiver.forceDownload}
            onChange={(event) =>
              onReceiver({ ...receiver, forceDownload: event.target.checked, allowPreview: !event.target.checked })
            }
            className="h-4 w-4"
          />
          <span className="text-sm">
            {locale === 'es' ? 'Forzar descarga (sin vista previa)' : 'Force download (no preview)'}
          </span>
        </label>

        <label className="flex flex-col gap-1.5">
          <span className="text-sm">
            {locale === 'es' ? 'Tiempo visible tras abrir' : 'Visible time after opening'}
          </span>
          <select
            className="field"
            value={receiver.visibleSeconds}
            onChange={(event) => onReceiver({ ...receiver, visibleSeconds: Number(event.target.value) })}
          >
            <option value={0}>{locale === 'es' ? 'Sin límite' : 'No limit'}</option>
            {readWindowPresets.map((seconds) => (
              <option key={seconds} value={seconds}>
                {seconds}s
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1.5">
          <span className="text-sm">{locale === 'es' ? 'Tema' : 'Theme'}</span>
          <select
            className="field"
            value={receiver.theme}
            onChange={(event) =>
              onReceiver({ ...receiver, theme: event.target.value as ReceiverConfig['theme'] })
            }
          >
            <option value="light">{locale === 'es' ? 'Claro' : 'Light'}</option>
            <option value="dark">{locale === 'es' ? 'Oscuro' : 'Dark'}</option>
            <option value="paper">{locale === 'es' ? 'Papel' : 'Paper'}</option>
            <option value="terminal">Terminal</option>
          </select>
        </label>
      </fieldset>

      <p className="text-sm" style={{ color: 'var(--text-tertiary)' }}>
        {locale === 'es'
          ? 'Estas preferencias viajan dentro del manifiesto cifrado: el servidor no las ve.'
          : 'These preferences travel inside the encrypted manifest — the server never sees them.'}
      </p>
    </div>
  );
}
