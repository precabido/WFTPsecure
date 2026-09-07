import type { Config } from 'tailwindcss';

/**
 * Tailwind is used as a utility engine only — the visual design is entirely our
 * own (§7). Colours map to the CSS variables in globals.css rather than
 * Tailwind's default palette, so themes swap without class changes.
 */
export default {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        base: 'var(--surface-base)',
        raised: 'var(--surface-raised)',
        sunken: 'var(--surface-sunken)',
        inset: 'var(--surface-inset)',
        primary: 'var(--text-primary)',
        secondary: 'var(--text-secondary)',
        tertiary: 'var(--text-tertiary)',
        accent: 'var(--accent)',
        'accent-soft': 'var(--accent-soft)',
        danger: 'var(--danger)',
        safe: 'var(--safe)',
        warn: 'var(--warn)',
        subtle: 'var(--border-subtle)',
      },
      borderRadius: {
        sm: 'var(--radius-sm)',
        md: 'var(--radius-md)',
        lg: 'var(--radius-lg)',
        xl: 'var(--radius-xl)',
      },
      maxWidth: { content: '46rem', wide: '68rem' },
    },
  },
  plugins: [],
} satisfies Config;
