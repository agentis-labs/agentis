/**
 * genuiAudit — the deterministic layout floor (GENUI-QUALITY-FLOOR plan).
 *
 * `repairSurface` walks an agent-authored `ViewNode` tree and auto-fixes the
 * anti-patterns that make agent output look broken — clamps absurd Split ratios,
 * strips data panels bound to collections that don't exist, caps how many data
 * panels a sparse app gets (no "No records" sprawl), removes garbled image-banner
 * headers, drops empty containers, and guarantees a root theme. Pure, model-free,
 * idempotent — runs at the render seam so EVERY surface (scaffold, model, or
 * hand-authored via ui_render) passes through it. Mirrors the workflow robustness
 * auditor pattern.
 */
import type { SurfaceTheme, ViewNode } from './types/view.js';

export interface AuditResult {
  view: ViewNode;
  fixes: string[];
}

interface Ctx {
  collections: Set<string>;
  fixes: string[];
  panels: number;
  maxPanels: number;
}

/** Nodes that render a panel of collection rows — counted + capped. */
const DATA_PANEL = new Set(['Table', 'Chart', 'DataBoard', 'List']);
/** Nodes whose `bind.collection` must exist (else the panel is dead). */
const REQUIRES_BIND = new Set(['Table', 'Chart', 'DataBoard', 'List', 'Inbox']);
/** Layout containers that are pointless when empty. */
const LAYOUT = new Set(['Stack', 'Row', 'Grid', 'Card', 'Section', 'Toolbar']);

function isImageish(node: ViewNode): boolean {
  if (node.type === 'Image') return true;
  if (node.type === 'Card' && Array.isArray(node.children) && node.children.length === 1 && node.children[0]?.type === 'Image') return true;
  return false;
}

function hasChildren(node: ViewNode): node is ViewNode & { children: ViewNode[] } {
  return 'children' in node && Array.isArray((node as { children?: unknown }).children);
}

function repair(node: ViewNode, ctx: Ctx, depth: number): ViewNode | null {
  // 1. Garbled image-banner header — a row/grid/stack that is mostly images. Drop it.
  if ((node.type === 'Row' || node.type === 'Grid' || node.type === 'Stack') && Array.isArray(node.children) && node.children.length >= 2) {
    const imgs = node.children.filter(isImageish).length;
    if (imgs >= 2 && imgs * 2 >= node.children.length) {
      ctx.fixes.push('removed image-banner header');
      return null;
    }
  }

  // 2. Data panel bound to a collection that doesn't exist → dead panel, drop it.
  if (REQUIRES_BIND.has(node.type) && 'bind' in node && node.bind && ctx.collections.size > 0 && !ctx.collections.has(node.bind.collection)) {
    ctx.fixes.push(`removed ${node.type} bound to unknown collection "${node.bind.collection}"`);
    return null;
  }

  // 3. Cap the number of data panels so a sparse app doesn't sprawl with empty tables.
  if (DATA_PANEL.has(node.type)) {
    ctx.panels += 1;
    if (ctx.panels > ctx.maxPanels) {
      ctx.fixes.push('capped excess data panels');
      return null;
    }
  }

  // 4. Split — clamp the ratio so neither side is a sliver; collapse if a side dies.
  if (node.type === 'Split') {
    const left = repair(node.left, ctx, depth + 1);
    const right = repair(node.right, ctx, depth + 1);
    if (!left && !right) return null;
    if (!left) return right;
    if (!right) return left;
    let ratio = node.ratio;
    if (ratio != null && (ratio < 1 || ratio > 2.5)) {
      ratio = Math.min(2.5, Math.max(1, ratio));
      ctx.fixes.push('clamped Split ratio');
    }
    return { ...node, ...(ratio != null ? { ratio } : {}), left, right };
  }

  // 5. Tabs / Accordion — recurse into their panels; drop empty tabs/sections.
  if (node.type === 'Tabs') {
    const tabs = node.tabs
      .map((t) => ({ ...t, children: t.children.map((c) => repair(c, ctx, depth + 1)).filter((x): x is ViewNode => x != null) }))
      .filter((t) => t.children.length > 0);
    return tabs.length > 0 ? { ...node, tabs } : null;
  }
  if (node.type === 'Accordion') {
    const sections = node.sections
      .map((s) => ({ ...s, children: s.children.map((c) => repair(c, ctx, depth + 1)).filter((x): x is ViewNode => x != null) }))
      .filter((s) => s.children.length > 0);
    return sections.length > 0 ? { ...node, sections } : null;
  }

  // 5b. AgentRegion — a stable, intentionally-empty slot. Repair its performed
  //     child if present, but NEVER drop the slot (an empty region is valid).
  if (node.type === 'AgentRegion') {
    const child = node.child ? repair(node.child, ctx, depth + 1) : null;
    return child ? { ...node, child } : { ...node, child: undefined };
  }

  // 6. Containers with a children[] — recurse, then drop if everything inside died.
  if (hasChildren(node)) {
    const kids = node.children.map((c) => repair(c, ctx, depth + 1)).filter((x): x is ViewNode => x != null);
    if (kids.length === 0 && LAYOUT.has(node.type)) {
      ctx.fixes.push('dropped empty container');
      return null;
    }
    return { ...node, children: kids } as ViewNode;
  }

  return node;
}

function inferTheme(view: ViewNode): SurfaceTheme {
  const json = JSON.stringify(view);
  if (json.includes('"DataBoard"') || json.includes('"Inbox"') || json.includes('"ChatThread"')) return 'product';
  if (json.includes('"Chart"') || json.includes('"KPIStrip"') || json.includes('"Gauge"')) return 'analytics';
  return 'console';
}

/**
 * Repair an agent-authored surface so it meets the layout floor. Idempotent.
 * `collections` is the list of the app's real collection names (for bind validation).
 */
export function repairSurface(view: ViewNode | null | undefined, opts: { collections?: string[] } = {}): AuditResult {
  const collections = new Set(opts.collections ?? []);
  const ctx: Ctx = { collections, fixes: [], panels: 0, maxPanels: Math.max(4, collections.size * 2) };

  let out = view ? repair(view, ctx, 0) : null;
  if (!out) out = { type: 'Stack', gap: 16, children: [] };

  // Guarantee a root theme so the surface is always coherently styled.
  if (!out.style?.theme) {
    out = { ...out, style: { ...out.style, theme: inferTheme(out) } } as ViewNode;
    ctx.fixes.push('set root theme');
  }

  return { view: out, fixes: ctx.fixes };
}
