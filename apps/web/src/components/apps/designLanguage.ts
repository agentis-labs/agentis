
import type { CSSProperties } from 'react';
import type { DesignLanguage } from '@agentis/core';

/** The CSS-var bag a language contributes to the surface root, plus policy flags. */
export interface ResolvedDesign {
  id: DesignLanguage;
  label: string;
  
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
 * `--s-*` contract (structure only — paint comes from `.s-surface`'s `--app-*`):
 *   --s-radius        card/control corner radius
 *   --s-pad           default panel padding
 *   --s-gap           default stack/grid gap
 *   --s-kpi-size      KPI numeral size (the scale's loudest step; auto-fit shrinks it)
 *   --s-heading-size  page-title size
 *   --s-title-size    panel/section title size
 *   --s-body-size     row/body copy size
 *   --s-card-bg / --s-card-border / --s-card-shadow / --s-kpi-bg
 *                     delegate to the appearance-aware `--app-*` paint tokens
 *   --s-accent-glow   focus/active glow
 *
 * TYPE SCALE DOCTRINE (frontend-design skill): the scale must JUMP — 11px
 * tracked labels → 13.5px body → 15px titles → 26px page titles → 32-40px
 * numerals. Color belongs to DATA (status pills, charts, pulses); chrome quiet.
 */
/** Appearance-aware depth: a KPI/metric tile gets a subtle top-lit gradient so it
 *  reads as a raised surface in BOTH light and dark (the `--color-*` tokens flip).
 *  This is the monochrome-safe way to add depth — no coloring the chrome. */
const TILE_DEPTH = 'linear-gradient(180deg, var(--color-surface-2), var(--color-surface))';
const TILE_FLAT = 'var(--color-surface)';

const FLAGSHIP_VARS: CSSProperties = {
  '--s-radius': '12px',
  '--s-pad': '20px',
  '--s-gap': '16px',
  '--s-card-bg': 'var(--app-card-bg)',
  '--s-card-border': 'var(--app-card-border)',
  '--s-card-shadow': 'var(--app-card-shadow)',
  // Tiles lift off the page with a subtle gradient (depth, not decoration).
  '--s-kpi-bg': TILE_DEPTH,
  // Type scale that JUMPS: 11 label → 13.5 body → 15 title → 27 page → 34 numeral.
  '--s-kpi-size': '34px',
  '--s-heading-size': '27px',
  '--s-title-size': '15px',
  '--s-body-size': '13.5px',
  '--s-accent-glow': 'var(--shadow-glow)',
} as CSSProperties;

interface VariantDef {
  label: string;
  hint: string;
  /** Structural + depth overrides layered over the flagship bundle. Each variant
   *  is a genuinely distinct look (radius/scale/density/depth), not a re-skin. */
  vars?: CSSProperties;
  policy?: Partial<ResolvedDesign['policy']>;
}

const VARIANTS: Record<DesignLanguage, VariantDef> = {
  agentis: {
    label: 'Agentis',
    hint: 'The flagship system — premium cards, real type scale, subtle depth, light & dark.',
  },
  // Dense command center — single accent, tight rhythm, flat tiles (readability
  // over flourish). For ops consoles / control planes.
  operations: {
    label: 'Operations',
    hint: 'Dense command center — single accent, tight rhythm, flat tiles.',
    vars: { '--s-radius': '10px', '--s-pad': '16px', '--s-gap': '12px', '--s-kpi-bg': TILE_FLAT, '--s-kpi-size': '28px', '--s-heading-size': '22px', '--s-title-size': '14px', '--s-body-size': '13px' } as CSSProperties,
    policy: { multiPalette: false },
  },
  // Executive analytics — loud numerals, rounder cards, gradient tiles + colored
  // KPI edges + gradient charts. The "big dashboard" look.
  aurora: {
    label: 'Aurora',
    hint: 'Executive analytics — loud numerals, rounder cards, gradient tiles, colorful charts.',
    vars: { '--s-radius': '16px', '--s-pad': '22px', '--s-gap': '18px', '--s-kpi-bg': TILE_DEPTH, '--s-kpi-size': '40px', '--s-heading-size': '30px', '--s-title-size': '16px' } as CSSProperties,
  },
  // Consumer / CRM — friendlier, rounder, roomier, gentler numerals.
  soft: {
    label: 'Soft',
    hint: 'Consumer / CRM — rounder, roomier, friendly numerals.',
    vars: { '--s-radius': '18px', '--s-pad': '22px', '--s-gap': '18px', '--s-kpi-bg': TILE_DEPTH, '--s-kpi-size': '32px', '--s-heading-size': '26px', '--s-title-size': '15px', '--s-body-size': '14px' } as CSSProperties,
  },
  // Content-forward — big flat type, generous whitespace, NO tile depth, single
  // accent, flat charts. Reports & briefings.
  editorial: {
    label: 'Editorial',
    hint: 'Content-forward — big flat type, generous whitespace, flat color.',
    vars: { '--s-radius': '10px', '--s-pad': '26px', '--s-gap': '24px', '--s-kpi-bg': TILE_FLAT, '--s-kpi-size': '42px', '--s-heading-size': '32px', '--s-title-size': '17px', '--s-body-size': '15px' } as CSSProperties,
    policy: { gradientCharts: false, multiPalette: false },
  },
  // Ops / SRE monitor — sharp corners, compact grid, tight type, flat tiles,
  // single accent. A wall of live signals.
  console: {
    label: 'Console',
    hint: 'Ops / SRE monitor — sharp corners, compact grid, tight scale.',
    vars: { '--s-radius': '8px', '--s-pad': '13px', '--s-gap': '10px', '--s-kpi-bg': TILE_FLAT, '--s-kpi-size': '24px', '--s-heading-size': '19px', '--s-title-size': '13px', '--s-body-size': '12.5px' } as CSSProperties,
    policy: { multiPalette: false },
  },
};

export const DEFAULT_DESIGN: DesignLanguage = 'agentis';

function build(id: DesignLanguage): ResolvedDesign {
  const variant = VARIANTS[id] ?? VARIANTS[DEFAULT_DESIGN];
  return {
    id,
    label: variant.label,
    hint: variant.hint,
    vars: { ...FLAGSHIP_VARS, ...variant.vars } as CSSProperties,
    policy: { gradientCharts: true, multiPalette: true, ...variant.policy },
  };
}

export const DESIGN_LANGUAGES: ResolvedDesign[] = (Object.keys(VARIANTS) as DesignLanguage[]).map(build);

export function resolveDesign(id?: DesignLanguage): ResolvedDesign {
  return build(id && VARIANTS[id] ? id : DEFAULT_DESIGN);
}



