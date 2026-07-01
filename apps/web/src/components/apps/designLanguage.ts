/**
 * designLanguage — the look bundles behind an Agentic App surface.
 *
 * A DesignLanguage is a named set of *visual decisions* (radii, card treatment,
 * shadow/elevation, gradient policy, type scale, palette, spacing) expressed as
 * scoped CSS custom properties. The renderer applies one bag to the surface root,
 * and every premium primitive reads `var(--s-*)` from it — so the SAME ViewNode
 * tree renders in genuinely different, all-premium styles.
 *
 * This is the single place those decisions live. Agents never write CSS; they
 * pick a language id (enum, validated in `@agentis/core`), and the operator can
 * override it. All values compose existing `styles.css` tokens, so dark/light and
 * accent theming keep working for free.
 */
import type { CSSProperties } from 'react';
import type { DesignLanguage } from '@agentis/core';

/** The CSS-var bag a language contributes to the surface root, plus policy flags. */
export interface ResolvedDesign {
  id: DesignLanguage;
  label: string;
  /** One-line description for the operator picker. */
  hint: string;
  /** CSS custom properties scoped to the surface root (consumed as `var(--s-*)`). */
  vars: CSSProperties;
  policy: {
    /** Charts render a gradient area fill + end-point marker. */
    gradientCharts: boolean;
    /** KPI tiles + chart series rotate through the multi-hue palette (vs single accent). */
    multiPalette: boolean;
  };
}

/**
 * `--s-*` contract (what primitives read):
 *   --s-radius        card/control corner radius
 *   --s-pad           default panel padding
 *   --s-gap           default stack gap
 *   --s-card-bg       panel background (may be a gradient)
 *   --s-card-border   panel border
 *   --s-card-shadow   panel elevation
 *   --s-kpi-size      hero KPI/metric number size
 *   --s-kpi-bg        KPI tile background
 *   --s-heading-size  section/hero heading size
 *   --s-accent-glow   focus/active glow (used by heroes, agent regions)
 */
const LANGUAGES: Record<DesignLanguage, ResolvedDesign> = {
  // Elevated version of today's dense command center — the safe default.
  operations: {
    id: 'operations',
    label: 'Operations',
    hint: 'Dense command center — elevated, restrained, fast to scan.',
    vars: {
      '--s-radius': '12px',
      '--s-pad': '14px',
      '--s-gap': '12px',
      '--s-card-bg': 'var(--color-surface)',
      '--s-card-border': '1px solid var(--color-line-strong)',
      '--s-card-shadow': 'var(--shadow-card)',
      '--s-kpi-size': '26px',
      '--s-kpi-bg': 'var(--color-surface-2)',
      '--s-heading-size': '16px',
      '--s-accent-glow': 'var(--shadow-glow)',
    } as CSSProperties,
    policy: { gradientCharts: true, multiPalette: false },
  },

  // Glass + ambient glow + gradient accents — the "wow" dashboard (image 4).
  aurora: {
    id: 'aurora',
    label: 'Aurora',
    hint: 'Glass cards, ambient glow, gradient accents — cinematic.',
    vars: {
      '--s-radius': '18px',
      '--s-pad': '20px',
      '--s-gap': '16px',
      '--s-card-bg': 'linear-gradient(160deg, color-mix(in srgb, var(--color-accent) 8%, var(--color-surface)) 0%, var(--color-surface) 70%)',
      '--s-card-border': '1px solid var(--color-glass-border)',
      '--s-card-shadow': 'var(--shadow-floating)',
      '--s-kpi-size': '34px',
      '--s-kpi-bg': 'color-mix(in srgb, var(--color-accent) 6%, var(--color-surface-2))',
      '--s-heading-size': '18px',
      '--s-accent-glow': 'var(--shadow-glow)',
    } as CSSProperties,
    policy: { gradientCharts: true, multiPalette: true },
  },

  // Rounded consumer cards, pastel multi-color tiles, friendly (image 3).
  soft: {
    id: 'soft',
    label: 'Soft',
    hint: 'Rounded consumer cards, colorful tiles, friendly spacing.',
    vars: {
      '--s-radius': '20px',
      '--s-pad': '22px',
      '--s-gap': '18px',
      '--s-card-bg': 'var(--color-surface)',
      '--s-card-border': '1px solid var(--color-line)',
      '--s-card-shadow': '0 10px 30px rgba(0,0,0,0.28)',
      '--s-kpi-size': '32px',
      '--s-kpi-bg': 'var(--color-surface-2)',
      '--s-heading-size': '17px',
      '--s-accent-glow': 'var(--shadow-glow)',
    } as CSSProperties,
    policy: { gradientCharts: true, multiPalette: true },
  },

  // Big type, generous whitespace, restrained color — content-forward.
  editorial: {
    id: 'editorial',
    label: 'Editorial',
    hint: 'Big type, generous whitespace, restrained color.',
    vars: {
      '--s-radius': '8px',
      '--s-pad': '24px',
      '--s-gap': '24px',
      '--s-card-bg': 'transparent',
      '--s-card-border': '1px solid var(--color-line)',
      '--s-card-shadow': 'none',
      '--s-kpi-size': '40px',
      '--s-kpi-bg': 'transparent',
      '--s-heading-size': '22px',
      '--s-accent-glow': 'none',
    } as CSSProperties,
    policy: { gradientCharts: false, multiPalette: false },
  },

  // Dense neon-on-black terminal — tight grid, mono accents.
  console: {
    id: 'console',
    label: 'Console',
    hint: 'Dense neon-on-black terminal — tight grid, ops/SRE.',
    vars: {
      '--s-radius': '6px',
      '--s-pad': '12px',
      '--s-gap': '10px',
      '--s-card-bg': 'var(--color-canvas)',
      '--s-card-border': '1px solid var(--color-line-strong)',
      '--s-card-shadow': 'inset 0 0 0 1px rgba(255,255,255,0.02)',
      '--s-kpi-size': '24px',
      '--s-kpi-bg': 'var(--color-canvas)',
      '--s-heading-size': '14px',
      '--s-accent-glow': 'var(--shadow-glow)',
    } as CSSProperties,
    policy: { gradientCharts: true, multiPalette: true },
  },
};

export const DESIGN_LANGUAGES: ResolvedDesign[] = Object.values(LANGUAGES);
export const DEFAULT_DESIGN: DesignLanguage = 'operations';

/**
 * Monochrome brand base — applied to EVERY App surface root (under each design
 * language). App Interfaces use ghost-white highlights on the near-black canvas
 * (a Linear/Vercel monochrome aesthetic), not the platform's emerald accent. These
 * overrides are scoped to the surface subtree via the inline `--s-*`/`--color-*` vars
 * on the root, so the rest of the platform (home, canvas, chrome) is untouched.
 *
 * The brand accent + positive/success emphasis go monochrome; genuine *status* hues
 * (danger red, warning amber, info blue) keep their meaning. Because the design
 * languages compose `var(--color-accent)` / `var(--shadow-glow)`, re-pointing those
 * here re-skins all five languages at once — aurora's accent-tinted glass becomes a
 * soft white sheen, KPI tints go monochrome, focus glows turn white.
 */
const MONOCHROME_BASE_VARS: CSSProperties = {
  '--color-accent': '#e8eaee',
  '--color-accent-hover': '#ffffff',
  '--color-accent-soft': 'rgba(255,255,255,0.08)',
  '--color-accent-muted': 'rgba(255,255,255,0.18)',
  '--color-on-accent': '#08090b',
  '--color-success': '#e8eaee',
  '--color-success-soft': 'rgba(255,255,255,0.08)',
  '--shadow-glow': '0 0 0 1px rgba(255,255,255,0.16), 0 0 22px rgba(255,255,255,0.06)',
} as CSSProperties;

export function resolveDesign(id?: DesignLanguage): ResolvedDesign {
  const lang = LANGUAGES[id ?? DEFAULT_DESIGN] ?? LANGUAGES[DEFAULT_DESIGN];
  // Merge the monochrome base UNDER the language vars: the base provides the
  // `--color-*`/glow overrides the language's `--s-*` values resolve against, while
  // any explicit `--s-*` the language sets still wins.
  return { ...lang, vars: { ...MONOCHROME_BASE_VARS, ...lang.vars } };
}
