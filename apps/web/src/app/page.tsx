'use client';

/**
 * Home (§21).
 *
 * The composer is above the fold. There is no marketing landing page to scroll
 * past before the tool becomes usable — the hero is two lines and then the
 * product itself.
 */

import { useEffect, useState } from 'react';
import { t } from '@/lib/i18n';
import { usePrefs } from '@/components/shell';
import { Composer } from '@/components/composer';

export default function HomePage() {
  const { locale } = usePrefs();
  const strings = t(locale);
  const [baseUrl, setBaseUrl] = useState('');

  // window is unavailable during SSR; reading it in an effect keeps the server
  // and client markup identical and avoids a hydration warning (§28).
  useEffect(() => setBaseUrl(window.location.origin), []);

  return (
    <div className="mx-auto w-full max-w-content px-4 pt-8 sm:px-6 sm:pt-12">
      <div className="mb-6 sm:mb-8">
        <h1
          className="font-semibold tracking-tight"
          style={{ fontSize: 'clamp(1.6rem, 4.5vw, 2.15rem)', lineHeight: 1.15, letterSpacing: '-0.02em' }}
        >
          {strings.heroTitle}
        </h1>
        <p className="mt-2.5 max-w-[38rem]" style={{ color: 'var(--text-secondary)', fontSize: '1.0125rem' }}>
          {strings.heroSubtitle}
        </p>
      </div>

      <Composer locale={locale} baseUrl={baseUrl} />

      <p className="mt-4 text-center text-sm" style={{ color: 'var(--text-tertiary)' }}>
        {strings.serverStores}
      </p>
    </div>
  );
}
