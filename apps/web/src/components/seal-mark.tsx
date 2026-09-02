/**
 * The capsule seal (§20 "metáfora visual").
 *
 * An abstract digital seal: a thin ring that closes, a geometric capsule inside,
 * and a small spark at the moment of sealing. Deliberately NOT a padlock, a
 * flame, or a skull — the product should read as a serious security tool.
 *
 * Drawn as inline SVG so there is no image request and no CDN dependency (§28).
 */

export function SealMark({
  size = 28,
  animate = false,
  state = 'idle',
}: {
  size?: number;
  animate?: boolean;
  state?: 'idle' | 'sealing' | 'sealed' | 'consumed';
}) {
  const gradientId = `seal-gradient-${state}`;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 100 100"
      fill="none"
      aria-hidden="true"
      focusable="false"
      style={{ display: 'block' }}
    >
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#6d4aff" />
          <stop offset="100%" stopColor="#22b8cf" />
        </linearGradient>
      </defs>

      {/* Outer ring — draws itself closed when sealing. */}
      <circle
        cx="50"
        cy="50"
        r="44"
        stroke={state === 'consumed' ? 'var(--border-default)' : `url(#${gradientId})`}
        strokeWidth="3"
        strokeLinecap="round"
        className={animate ? 'animate-seal-ring' : undefined}
        transform="rotate(-90 50 50)"
        opacity={state === 'consumed' ? 0.4 : 1}
      />

      {/* Inner capsule: a rounded vertical lozenge, the product's unit made
          geometric rather than literal. */}
      <rect
        x="36"
        y="26"
        width="28"
        height="48"
        rx="14"
        stroke={state === 'consumed' ? 'var(--border-default)' : `url(#${gradientId})`}
        strokeWidth="3"
        fill="none"
        opacity={state === 'consumed' ? 0.35 : 0.9}
      />

      {/* The seam that closes across the capsule when it is sealed. */}
      <line
        x1="36"
        y1="50"
        x2="64"
        y2="50"
        stroke={state === 'consumed' ? 'var(--border-default)' : `url(#${gradientId})`}
        strokeWidth="3"
        strokeLinecap="round"
        opacity={state === 'idle' ? 0.25 : 0.85}
      />

      {state === 'sealing' && animate && (
        <circle cx="50" cy="50" r="10" fill={`url(#${gradientId})`} className="animate-seal-spark" />
      )}
    </svg>
  );
}

/** Wordmark used in the header. Reads the product name from brand config. */
export function BrandMark({ name, compact = false }: { name: string; compact?: boolean }) {
  return (
    <span className="inline-flex items-center gap-2.5">
      <SealMark size={compact ? 22 : 26} />
      <span
        className="font-semibold tracking-tight"
        style={{ fontSize: compact ? '0.95rem' : '1.05rem', letterSpacing: '-0.01em' }}
      >
        {name}
      </span>
    </span>
  );
}
