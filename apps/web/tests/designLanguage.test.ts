/**
 * Design languages must be GENUINELY DISTINCT, not one flagship base with
 * cosmetic tweaks. Before this, every `design` id resolved to near-identical
 * `--s-*` vars, so an agent's design choice never changed the look — surfaces
 * rendered flat and samey. These specs lock in real, separable identities
 * (structure + depth) so the agent's `design` choice actually matters.
 */
import { describe, it, expect } from 'vitest';
import { resolveDesign, DEFAULT_DESIGN } from '../src/components/apps/designLanguage';

const vars = (id: Parameters<typeof resolveDesign>[0]) => resolveDesign(id).vars as Record<string, string>;

describe('design languages are distinct', () => {
  it('editorial uses flat tiles while aurora/soft use gradient depth', () => {
    expect(vars('editorial')['--s-kpi-bg']).not.toContain('gradient'); // flat, content-forward
    expect(vars('aurora')['--s-kpi-bg']).toContain('gradient'); // executive depth
    expect(vars('soft')['--s-kpi-bg']).toContain('gradient');
  });

  it('gives each language a genuinely different type scale + rhythm (not a re-skin)', () => {
    const kpi = (id: Parameters<typeof resolveDesign>[0]) => vars(id)['--s-kpi-size'];
    // console is the tightest, editorial the loudest — a real, ordered scale.
    expect(kpi('console')).toBe('24px');
    expect(kpi('aurora')).toBe('40px');
    expect(kpi('editorial')).toBe('42px');
    // At least four distinct numeral sizes across the six languages.
    const sizes = new Set(['agentis', 'operations', 'aurora', 'soft', 'editorial', 'console'].map((id) => kpi(id as never)));
    expect(sizes.size).toBeGreaterThanOrEqual(4);
  });

  it('editorial + operations + console drop the multi-hue palette (single-accent, focused)', () => {
    expect(resolveDesign('editorial').policy.multiPalette).toBe(false);
    expect(resolveDesign('operations').policy.multiPalette).toBe(false);
    expect(resolveDesign('console').policy.multiPalette).toBe(false);
    expect(resolveDesign('aurora').policy.multiPalette).toBe(true);
  });

  it('depth tokens stay appearance-aware (driven by --color-* tokens, no hard-coded hex)', () => {
    const bg = vars(DEFAULT_DESIGN)['--s-kpi-bg'];
    expect(bg).toContain('var(--color-'); // flips with light/dark, never a fixed color
    expect(bg).not.toMatch(/#[0-9a-f]{3,6}/i);
  });
});
