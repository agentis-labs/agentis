/**
 * Surface themes — composition defaults read from a surface's ROOT node `style`.
 *
 * A "theme" here is not a palette swap (the global dark/light tokens own that);
 * it sets the *defaults* a surface composes against — density, the accent used
 * for charts/progress, and how containers elevate. Agents pick a theme that fits
 * the app: `console` (dense ops command center), `analytics` (KPI dashboards),
 * `product` (consumer-grade), `editorial` (content-forward).
 */
import { createContext, useContext } from 'react';
import type { AccentName, SurfaceTheme } from '@agentis/core';

export type Density = 'comfortable' | 'compact';

export interface ResolvedTheme {
  theme: SurfaceTheme;
  density: Density;
  /** Accent used when a node declares none — charts, progress, sparklines. */
  defaultAccent: AccentName;
  /** Max content width (px) — dashboards/consoles go wide; content surfaces stay readable. */
  contentWidth: number;
}

const PRESETS: Record<SurfaceTheme, Omit<ResolvedTheme, 'theme'>> = {
  console: { density: 'compact', defaultAccent: 'teal', contentWidth: 1680 },
  analytics: { density: 'compact', defaultAccent: 'blue', contentWidth: 1520 },
  product: { density: 'comfortable', defaultAccent: 'purple', contentWidth: 1120 },
  editorial: { density: 'comfortable', defaultAccent: 'accent', contentWidth: 860 },
};

export const DEFAULT_THEME: ResolvedTheme = { theme: 'analytics', density: 'compact', defaultAccent: 'accent', contentWidth: 1520 };

/** Resolve a theme from the root node's optional `theme`/`density` style intent. */
export function resolveTheme(theme?: SurfaceTheme, density?: Density): ResolvedTheme {
  const base: ResolvedTheme = theme ? { theme, ...PRESETS[theme] } : DEFAULT_THEME;
  return density ? { ...base, density } : base;
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

/** Series palette for multi-series charts — distinct, token-aligned hues. */
export const CHART_PALETTE: AccentName[] = ['blue', 'teal', 'purple', 'orange', 'rose', 'lime', 'info', 'success'];

export function seriesColor(index: number, override?: AccentName): string {
  if (override) return accentColor(override);
  const name = CHART_PALETTE[index % CHART_PALETTE.length];
  return accentColor(name);
}
