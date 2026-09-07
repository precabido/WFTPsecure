import type { Metadata, Viewport } from 'next';
import { brand } from '@cinderlink/config/brand';
import { resolveEnv } from '@cinderlink/config/env';
import './globals.css';
import { AppFrame } from '@/components/app-frame';

const env = resolveEnv();

export const metadata: Metadata = {
  title: `${brand.name} — ${brand.tagline.es}`,
  description: brand.tagline.en,
  // §6: the preview must never be indexed.
  robots: { index: false, follow: false, nocache: true },
  // No favicon fetch to a third party; the seal is inline SVG.
  icons: {
    icon: [
      {
        url:
          'data:image/svg+xml,' +
          encodeURIComponent(
            `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><circle cx="50" cy="50" r="44" fill="none" stroke="#6d4aff" stroke-width="8"/><rect x="36" y="26" width="28" height="48" rx="14" fill="none" stroke="#22b8cf" stroke-width="8"/></svg>`,
          ),
        type: 'image/svg+xml',
      },
    ],
  },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  // §27: never block zoom — capping scale breaks accessibility for low vision.
  maximumScale: 5,
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#fbfaf9' },
    { media: '(prefers-color-scheme: dark)', color: '#0e0e10' },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es" suppressHydrationWarning>
      <body>
        <AppFrame
          buildId={env.buildId}
          commit={env.commitSha}
          preview={env.previewMode}
          showPreviewWarning={env.previewWarning}
        >
          {children}
        </AppFrame>
      </body>
    </html>
  );
}
