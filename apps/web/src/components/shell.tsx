'use client';

/**
 * Application shell: header, preview banner, footer (§6, §21, §29).
 */

import { useEffect, useState, createContext, useContext, type ReactNode } from 'react';
import { brand } from '@cinderlink/config/brand';
import { BrandMark } from './seal-mark';
import { t, type Locale } from '@/lib/i18n';

interface Prefs {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  theme: 'light' | 'dark' | 'system';
  setTheme: (theme: 'light' | 'dark' | 'system') => void;
}

const PrefsContext = createContext<Prefs | null>(null);

export function usePrefs(): Prefs {
  const context = useContext(PrefsContext);
  if (context === null) throw new Error('usePrefs must be used inside <Shell>');
  return context;
}

function applyTheme(theme: 'light' | 'dark' | 'system'): void {
  const resolved =
    theme === 'system'
      ? window.matchMedia('(prefers-color-scheme: dark)').matches
        ? 'dark'
        : 'light'
      : theme;
  document.documentElement.dataset.theme = resolved;
}

export function PrefsProvider({ children }: { children: ReactNode }) {
  // Defaults must match the server render exactly, or hydration mismatches
  // appear as console errors (§33 requires zero). Stored preferences are
  // therefore applied in an effect, after the first paint.
  const [locale, setLocaleState] = useState<Locale>('es');
  const [theme, setThemeState] = useState<'light' | 'dark' | 'system'>('system');

  useEffect(() => {
    try {
      const savedLocale = localStorage.getItem('cl.locale');
      if (savedLocale === 'es' || savedLocale === 'en') setLocaleState(savedLocale);
      const savedTheme = localStorage.getItem('cl.theme');
      if (savedTheme === 'light' || savedTheme === 'dark' || savedTheme === 'system') {
        setThemeState(savedTheme);
      }
    } catch {
      // Private browsing can throw on localStorage access; defaults are fine.
    }
  }, []);

  useEffect(() => {
    applyTheme(theme);
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => theme === 'system' && applyTheme('system');
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, [theme]);

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  const setLocale = (next: Locale) => {
    setLocaleState(next);
    try {
      localStorage.setItem('cl.locale', next);
    } catch {
      /* ignore */
    }
  };

  const setTheme = (next: 'light' | 'dark' | 'system') => {
    setThemeState(next);
    try {
      localStorage.setItem('cl.theme', next);
    } catch {
      /* ignore */
    }
  };

  return (
    <PrefsContext.Provider value={{ locale, setLocale, theme, setTheme }}>{children}</PrefsContext.Provider>
  );
}

/**
 * HTTP preview warning band (§6).
 *
 * Shown whenever the deployment is not on HTTPS. It states the limitation in
 * plain language and does not soften it — over plain HTTP an active attacker
 * can replace the very JavaScript that does the encrypting.
 */
export function PreviewBanner({ show, locale }: { show: boolean; locale: Locale }) {
  if (!show) return null;
  const strings = t(locale);
  return (
    <div
      role="status"
      className="w-full border-b px-4 py-2 text-center"
      style={{
        background: 'var(--warn-soft)',
        borderColor: 'var(--warn-border)',
        color: 'var(--warn)',
        fontSize: '0.8125rem',
        lineHeight: 1.45,
      }}
    >
      <span aria-hidden="true" style={{ marginInlineEnd: '0.4rem' }}>
        ⚠
      </span>
      {strings.previewWarning}
    </div>
  );
}

export function Header() {
  const { locale, setLocale, theme, setTheme } = usePrefs();
  const strings = t(locale);

  return (
    <header className="w-full border-b" style={{ borderColor: 'var(--border-subtle)' }}>
      <div className="mx-auto flex max-w-wide items-center justify-between gap-4 px-4 py-3.5 sm:px-6">
        <a href="/" className="rounded-md" aria-label={brand.name}>
          <BrandMark name={brand.name} />
        </a>

        <nav className="flex items-center gap-1" aria-label={locale === 'es' ? 'Principal' : 'Main'}>
          <a href="/how-it-works" className="btn btn-ghost hidden px-3 text-sm sm:inline-flex">
            {strings.nav.how}
          </a>
          <a href="/security" className="btn btn-ghost hidden px-3 text-sm sm:inline-flex">
            {strings.nav.security}
          </a>
          <a href="/privacy" className="btn btn-ghost hidden px-3 text-sm sm:inline-flex">
            {strings.nav.privacy}
          </a>

          <button
            type="button"
            className="btn btn-ghost px-3 text-sm numeric"
            onClick={() => setLocale(locale === 'es' ? 'en' : 'es')}
            aria-label={locale === 'es' ? 'Switch to English' : 'Cambiar a español'}
          >
            {locale === 'es' ? 'EN' : 'ES'}
          </button>

          <button
            type="button"
            className="btn btn-ghost px-3"
            onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
            aria-label={theme === 'dark' ? strings.theme.light : strings.theme.dark}
          >
            <span aria-hidden="true">{theme === 'dark' ? '☀' : '☾'}</span>
          </button>
        </nav>
      </div>
    </header>
  );
}

/**
 * Footer (§29): build id, commit, mode, security link. Nothing internal —
 * no server paths, no container names, no environment values.
 */
export function Footer({ buildId, commit, preview }: { buildId: string; commit: string; preview: boolean }) {
  const { locale } = usePrefs();
  const strings = t(locale);
  return (
    <footer
      className="mt-16 w-full border-t px-4 py-6 sm:px-6"
      style={{ borderColor: 'var(--border-subtle)' }}
    >
      <div className="mx-auto flex max-w-wide flex-wrap items-center justify-between gap-3">
        <p style={{ color: 'var(--text-tertiary)', fontSize: '0.8125rem' }}>
          {brand.name} · {strings.tagline}
        </p>
        <p className="numeric" style={{ color: 'var(--text-tertiary)', fontSize: '0.75rem' }}>
          <a href="/security" className="underline underline-offset-2">
            {strings.nav.security}
          </a>
          <span aria-hidden="true"> · </span>
          build {buildId} · {commit}
          {preview ? ' · preview' : ''}
        </p>
      </div>
    </footer>
  );
}
