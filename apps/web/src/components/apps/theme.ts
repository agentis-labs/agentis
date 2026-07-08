/**
 * Surface themes — composition defaults read from a surface's ROOT node `style`.
 *
 * A "theme" here is not a palette swap (the global dark/light tokens own that);
 * it sets the *defaults* a surface composes against — density, the accent used
 * for charts/progress, and how containers elevate. Agents pick a theme that fits
 * the app: `operations` (dense ops command center), `analytics` (KPI dashboards),
 * `product` (consumer-grade), `editorial` (content-forward).
 */
import { createContext, useContext } from 'react';
import type { AccentName, DesignLanguage, SurfaceTheme } from '@agentis/core';
import { resolveDesign, type ResolvedDesign } from './designLanguage';

export type Density = 'comfortable' | 'compact';

export interface ResolvedTheme {
  theme: SurfaceTheme;
  density: Density;
  /** Accent used when a node declares none — charts, progress, sparklines. */
  defaultAccent: AccentName;
  /** Max content width (px) — dashboards/operations surfaces go wide; content surfaces stay readable. */
  contentWidth: number;
  /** The resolved design language (look bundle → scoped `--s-*` CSS vars). */
  design: ResolvedDesign;
}

/** Per-theme defaults. Every theme leads with the flagship `agentis` design
 * system (INTERFACE-OVERHAUL-10X — one system, structural variants); a stored
 * legacy `design` id still wins via resolveTheme's explicit-design override. */
const PRESETS: Record<SurfaceTheme, Omit<ResolvedTheme, 'theme' | 'design'> & { design: DesignLanguage }> = {
  operations: { density: 'compact', defaultAccent: 'accent', contentWidth: 1680, design: 'agentis' },
  analytics: { density: 'compact', defaultAccent: 'accent', contentWidth: 1520, design: 'agentis' },
  product: { density: 'comfortable', defaultAccent: 'accent', contentWidth: 1120, design: 'agentis' },
  editorial: { density: 'comfortable', defaultAccent: 'accent', contentWidth: 860, design: 'editorial' },
};

export const DEFAULT_THEME: ResolvedTheme = {
  theme: 'analytics',
  density: 'compact',
  defaultAccent: 'accent',
  contentWidth: 1520,
  design: resolveDesign('agentis'),
};

/**
 * Resolve a theme from the root node's optional `theme`/`design`/`density` style
 * intent. `design` overrides the theme's default language; `density` overrides the
 * theme's default density.
 */
export function resolveTheme(theme?: SurfaceTheme, design?: DesignLanguage, density?: Density): ResolvedTheme {
  // Fall back to defaults when no theme is set OR when the stored theme is an
  // unknown/legacy value not in PRESETS — never let an out-of-enum value crash render.
  const preset = (theme && PRESETS[theme]) || { density: DEFAULT_THEME.density, defaultAccent: DEFAULT_THEME.defaultAccent, contentWidth: DEFAULT_THEME.contentWidth, design: DEFAULT_THEME.design.id };
  return {
    theme: (theme && PRESETS[theme]) ? theme : DEFAULT_THEME.theme,
    density: density ?? preset.density,
    defaultAccent: preset.defaultAccent,
    contentWidth: preset.contentWidth,
    design: resolveDesign(design ?? preset.design),
  };
}

const ThemeCtx = createContext<ResolvedTheme>(DEFAULT_THEME);
export const ThemeProvider = ThemeCtx.Provider;
export function useTheme(): ResolvedTheme {
  return useContext(ThemeCtx);
}

// ── Accent palette (token-backed; no arbitrary hex from agents) ──

export const ACCENT_COLOR: Record<AccentName, string> = {
  accent: 'var(--color-accent)',
  info: 'var(--color-info)',
  success: 'var(--color-success)',
  warning: 'var(--color-warn)',
  danger: 'var(--color-danger)',
  orange: '#f97316',
  blue: '#3b82f6',
  purple: '#a855f7',
  teal: '#14b8a6',
  rose: '#f43f5e',
  lime: '#84cc16',
};

export function accentColor(name?: AccentName | null): string {
  return name ? ACCENT_COLOR[name] : ACCENT_COLOR.accent;
}

/** Series palette for multi-series charts — the app accent leads, then distinct
 * token-aligned hues (color belongs to DATA; the first series carries the brand). */
export const CHART_PALETTE: AccentName[] = ['accent', 'teal', 'purple', 'orange', 'rose', 'lime', 'info', 'success'];

export function seriesColor(index: number, override?: AccentName): string {
  if (override) return accentColor(override);
  const name = CHART_PALETTE[index % CHART_PALETTE.length];
  return accentColor(name);
}
