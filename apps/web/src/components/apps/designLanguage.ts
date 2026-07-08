
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
 * `--s-*` contract (structure only â€” paint comes from `.s-surface`'s `--app-*`):
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
 * TYPE SCALE DOCTRINE (frontend-design skill): the scale must JUMP â€” 11px
 * tracked labels â†’ 13.5px body â†’ 15px titles â†’ 26px page titles â†’ 32-40px
 * numerals. Color belongs to DATA (status pills, charts, pulses); chrome quiet.
 */
const FLAGSHIP_VARS: CSSProperties = {
  '--s-radius': '14px',
  '--s-pad': '20px',
  '--s-gap': '14px',
  '--s-card-bg': 'var(--app-card-bg)',
  '--s-card-border': 'var(--app-card-border)',
  '--s-card-shadow': 'var(--app-card-shadow)',
  '--s-kpi-bg': 'var(--app-tile-bg)',
  '--s-kpi-size': '32px',
  '--s-heading-size': '26px',
  '--s-title-size': '15px',
  '--s-body-size': '13.5px',
  '--s-accent-glow': 'var(--shadow-glow)',
} as CSSProperties;

interface VariantDef {
  label: string;
  hint: string;
  /** Structural overrides layered over the flagship bundle. */
  vars?: CSSProperties;
  policy?: Partial<ResolvedDesign['policy']>;
}

const VARIANTS: Record<DesignLanguage, VariantDef> = {
  agentis: {
    label: 'Agentis',
    hint: 'The flagship system â€” premium cards, real type scale, light & dark.',
  },
  // Legacy ids â†’ structural variants of the flagship (zero-migration upgrades).
  operations: {
    label: 'Operations (variant)',
    hint: 'Flagship structure, single-accent charts â€” dense command centers.',
    policy: { multiPalette: false },
  },
  aurora: {
    label: 'Aurora (variant)',
    hint: 'Bigger numerals, rounder cards â€” executive dashboards.',
    vars: { '--s-radius': '16px', '--s-pad': '22px', '--s-kpi-size': '38px', '--s-heading-size': '28px' } as CSSProperties,
  },
  soft: {
    label: 'Soft (variant)',
    hint: 'Rounder, friendlier spacing â€” consumer/CRM products.',
    vars: { '--s-radius': '18px', '--s-pad': '22px', '--s-gap': '16px', '--s-body-size': '14px' } as CSSProperties,
  },
  editorial: {
    label: 'Editorial (variant)',
    hint: 'Big type, generous whitespace, flat color â€” content & reports.',
    vars: { '--s-radius': '10px', '--s-pad': '26px', '--s-gap': '22px', '--s-kpi-size': '40px', '--s-heading-size': '30px', '--s-title-size': '16px', '--s-body-size': '15px' } as CSSProperties,
    policy: { gradientCharts: false, multiPalette: false },
  },
  console: {
    label: 'Console (variant)',
    hint: 'Tight grid, compact scale â€” ops/SRE monitors.',
    vars: { '--s-radius': '10px', '--s-pad': '14px', '--s-gap': '10px', '--s-kpi-size': '26px', '--s-heading-size': '20px', '--s-title-size': '13.5px', '--s-body-size': '12.5px' } as CSSProperties,
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



