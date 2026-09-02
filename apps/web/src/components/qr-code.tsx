'use client';

/**
 * QR code, rendered as inline SVG (§21, §28).
 *
 * Three deliberate choices:
 *   - The library is loaded lazily, only when this component mounts, so the QR
 *     encoder never appears in the initial bundle of the composer or of an
 *     informational page.
 *   - It is bundled from npm, not fetched from a CDN — the CSP forbids any
 *     third-party origin, and a QR of a secret link is the last thing that
 *     should depend on someone else's server.
 *   - Output is SVG paths rather than a canvas, so it scales, prints, and
 *     inverts correctly in dark mode without a second render.
 *
 * The encoded text may contain the capsule key in its fragment, so this code
 * must never transmit `text` anywhere. It does not: everything happens locally.
 */

import { useEffect, useState } from 'react';

export function QrCode({ text, size = 132, label }: { text: string; size?: number; label: string }) {
  const [modules, setModules] = useState<boolean[][] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const { default: qrcode } = await import('qrcode-generator');
        // typeNumber 0 = auto-select the smallest version that fits.
        // 'M' recovers ~15% damage, the usual choice for screen-displayed codes.
        const qr = qrcode(0, 'M');
        qr.addData(text);
        qr.make();
        const count = qr.getModuleCount();
        const grid: boolean[][] = [];
        for (let row = 0; row < count; row += 1) {
          const line: boolean[] = [];
          for (let col = 0; col < count; col += 1) line.push(qr.isDark(row, col));
          grid.push(line);
        }
        if (!cancelled) setModules(grid);
      } catch {
        // A missing QR is a cosmetic loss; the link itself is still copyable.
        if (!cancelled) setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [text]);

  if (failed) return null;

  if (modules === null) {
    return (
      <div
        style={{ width: size, height: size, background: 'var(--surface-sunken)', borderRadius: 'var(--radius-md)' }}
        aria-hidden="true"
      />
    );
  }

  const count = modules.length;
  const quiet = 2; // quiet zone in modules, required by the spec for scanning
  const total = count + quiet * 2;

  // One path string for every dark module keeps the DOM to a single node.
  let path = '';
  for (let row = 0; row < count; row += 1) {
    for (let col = 0; col < count; col += 1) {
      if (modules[row]?.[col]) path += `M${col + quiet},${row + quiet}h1v1h-1z`;
    }
  }

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${total} ${total}`}
      role="img"
      aria-label={label}
      style={{
        borderRadius: 'var(--radius-md)',
        // A QR needs a light quiet zone to scan; force it regardless of theme
        // rather than inheriting a dark surface that would break scanning.
        background: '#ffffff',
        padding: 0,
        display: 'block',
        flexShrink: 0,
      }}
    >
      <rect width={total} height={total} fill="#ffffff" />
      <path d={path} fill="#111111" shapeRendering="crispEdges" />
    </svg>
  );
}
