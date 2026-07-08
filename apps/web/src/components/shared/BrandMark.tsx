/**
 * BrandMark — the Agentis identity: a split-brain hexagon in thin engineered
 * strokes, recreated as inline SVG so it renders crisp at any size and inherits
 * `currentColor` (→ inverts black/white with the theme for free).
 *
 * `variant="mark"` renders the glyph alone; `variant="full"` adds the tracked
 * AGENTIS wordmark beside it.
 */

interface BrandMarkProps {
  size?: number;
  variant?: 'mark' | 'full';
  className?: string;
  title?: string;
}

export function BrandMark({ size = 24, variant = 'mark', className, title = 'Agentis' }: BrandMarkProps) {
  const glyph = (
    <svg
      width={size}
      height={size}
      viewBox="0 0 100 100"
      fill="none"
      stroke="currentColor"
      strokeWidth={5}
      strokeLinejoin="miter"
      strokeLinecap="square"
      role="img"
      aria-label={variant === 'mark' ? title : undefined}
      aria-hidden={variant === 'full' ? true : undefined}
      className={variant === 'mark' ? className : undefined}
    >
      {/* left half */}
      <path d="M46 13 L17 33 L17 67 L46 87 L46 13 Z" />
      <path d="M46 50 L28 50" />
      {/* right half (mirror) */}
      <path d="M54 13 L83 33 L83 67 L54 87 L54 13 Z" />
      <path d="M54 50 L72 50" />
    </svg>
  );

  if (variant === 'mark') return glyph;

  return (
    <span className={['inline-flex items-center gap-2.5', className].filter(Boolean).join(' ')}>
      {glyph}
      <span
        className="font-semibold text-text-primary"
        style={{ letterSpacing: '0.34em', fontSize: size * 0.58 }}
      >
        AGENTIS
      </span>
    </span>
  );
}
