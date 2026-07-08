/**
 * styleIntent — the one place that lowers bounded AG-UI `style` intent to Agentis
 * Design System token classes. Agents emit intent (tone/elevation/pad/…); this
 * maps it to real Tailwind token utilities. **No raw CSS ever leaves here.**
 *
 * Every node's renderer reads its `node.style` through these helpers, so the look
 * is consistent, accessible, dark/light-correct, and themeable for free.
 */
import clsx from 'clsx';
import type { StyleIntent, Tone } from '@agentis/core';
import type { Density } from './theme';

export type Elevation = NonNullable<StyleIntent['elevation']>;
type Pad = NonNullable<StyleIntent['pad']>;
type Align = NonNullable<StyleIntent['align']>;
type Size = NonNullable<StyleIntent['size']>;
type Emphasis = NonNullable<StyleIntent['emphasis']>;

// ── Box / container intent ──────────────────────────────────

const ELEVATION: Record<Elevation, string> = {
  // `raised` is the premium panel — its look is driven by the active design
  // language's `--s-*` vars (radius / bg / border / shadow), not fixed tokens.
  flat: '',
  raised: 's-panel',
  inset: 'bg-canvas border border-line s-round',
  outline: 'border border-line s-round bg-surface/40',
};

const PAD_COMFORTABLE: Record<Pad, string> = { none: '', sm: 'p-2', md: 'p-4', lg: 'p-6', xl: 'p-8' };
const PAD_COMPACT: Record<Pad, string> = { none: '', sm: 'p-1.5', md: 'p-3', lg: 'p-4', xl: 'p-6' };

const TONE_BORDER: Record<Tone, string> = {
  neutral: '',
  accent: 'border-accent',
  success: 'border-success',
  warning: 'border-warn',
  danger: 'border-danger',
  info: 'border-info',
};

const ALIGN: Record<Align, string> = {
  start: 'items-start',
  center: 'items-center',
  end: 'items-end',
  between: 'justify-between',
};

export function padClass(pad: Pad | undefined, density: Density, fallback: Pad): string {
  const table = density === 'compact' ? PAD_COMPACT : PAD_COMFORTABLE;
  return table[pad ?? fallback];
}

export function alignClass(align?: Align): string {
  return align ? ALIGN[align] : '';
}

export interface ContainerOpts {
  /** Elevation used when the node declares none. */
  defaultElevation?: Elevation;
  /** Pad used when the node declares none. */
  defaultPad?: Pad;
}

/**
 * Box classes for a container node (Card/Section/Stack/Toolbar/…): elevation,
 * padding (density-aware), tone border, sticky/scroll, and alignment.
 */
export function containerClasses(style: StyleIntent | undefined, density: Density, opts: ContainerOpts = {}): string {
  const elevation = style?.elevation ?? opts.defaultElevation ?? 'flat';
  const pad = style?.pad ?? opts.defaultPad ?? (elevation === 'flat' ? 'none' : 'md');
  const tone = style?.tone && style.tone !== 'neutral' ? TONE_BORDER[style.tone] : '';
  return clsx(
    ELEVATION[elevation],
    padClass(pad, density, 'none'),
    tone,
    alignClass(style?.align),
    style?.sticky && 'sticky top-0 z-10',
    style?.scroll && 'overflow-auto',
  );
}

// ── Text intent ─────────────────────────────────────────────

const TONE_TEXT: Record<Tone, string> = {
  neutral: '',
  accent: 'text-accent',
  success: 'text-success',
  warning: 'text-warn',
  danger: 'text-danger',
  info: 'text-info',
};

const EMPHASIS_TEXT: Record<Emphasis, string> = {
  muted: 'text-text-muted',
  normal: 'text-text-secondary',
  strong: 'text-text-primary font-semibold',
};

const SIZE_TEXT: Record<Size, string> = {
  sm: 'text-[12px]',
  md: 'text-[14px]',
  lg: 'text-[18px] font-semibold',
  xl: 'text-[24px] font-semibold leading-tight',
};

/** Text colour/weight/size for content nodes (Text/Heading/Markdown/…). */
export function textClasses(style: StyleIntent | undefined): string {
  return clsx(
    style?.tone && TONE_TEXT[style.tone],
    style?.emphasis && EMPHASIS_TEXT[style.emphasis],
    style?.size && SIZE_TEXT[style.size],
  );
}

// ── Soft tone (badges, callouts, pills) ─────────────────────

const TONE_SOFT: Record<Tone, string> = {
  neutral: 'bg-surface-2 text-text-secondary',
  accent: 'bg-accent-soft text-accent',
  success: 'bg-success-soft text-success',
  warning: 'bg-warn-soft text-warn',
  danger: 'bg-danger-soft text-danger',
  info: 'bg-info-soft text-info',
};

export function toneSoftClass(tone?: Tone): string {
  return TONE_SOFT[tone ?? 'neutral'];
}

/** Bar/fill colour class for progress & status dots. */
const TONE_FILL: Record<Tone, string> = {
  neutral: 'bg-text-muted',
  accent: 'bg-accent',
  success: 'bg-success',
  warning: 'bg-warn',
  danger: 'bg-danger',
  info: 'bg-info',
};

export function toneFillClass(tone?: Tone): string {
  return TONE_FILL[tone ?? 'accent'];
}

/** Heuristic: derive a tone from a free-text status string (used by boards/timelines). */
export function toneFromStatus(status: string): Tone {
  if (/fail|error|down|risk|reject|block|critical/i.test(status)) return 'danger';
  if (/wait|warn|review|pending|hold|queue/i.test(status)) return 'warning';
  if (/done|ok|live|online|healthy|approv|complete|success|active/i.test(status)) return 'success';
  return 'neutral';
}
