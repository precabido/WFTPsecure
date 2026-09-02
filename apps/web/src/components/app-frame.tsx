'use client';

import type { ReactNode } from 'react';
import { PrefsProvider, Header, Footer, PreviewBanner, usePrefs } from './shell';

function Chrome({
  children,
  buildId,
  commit,
  preview,
  showPreviewWarning,
}: {
  children: ReactNode;
  buildId: string;
  commit: string;
  preview: boolean;
  showPreviewWarning: boolean;
}) {
  const { locale } = usePrefs();
  return (
    <>
      {/* §27: keyboard users must be able to skip repeated navigation. */}
      <a
        href="#main"
        className="btn btn-secondary sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50"
      >
        {locale === 'es' ? 'Saltar al contenido' : 'Skip to content'}
      </a>
      <PreviewBanner show={showPreviewWarning} locale={locale} />
      <Header />
      <main id="main" tabIndex={-1}>
        {children}
      </main>
      <Footer buildId={buildId} commit={commit} preview={preview} />
    </>
  );
}

export function AppFrame(props: {
  children: ReactNode;
  buildId: string;
  commit: string;
  preview: boolean;
  showPreviewWarning: boolean;
}) {
  return (
    <PrefsProvider>
      <Chrome {...props} />
    </PrefsProvider>
  );
}
