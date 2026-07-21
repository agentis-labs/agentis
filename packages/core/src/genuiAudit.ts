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
import type { ActionRef, DesignLanguage, SurfaceAction, SurfaceTheme, ViewNode } from './types/view.js';

export interface AuditResult {
  view: ViewNode;
  fixes: string[];
}

/** Client-built-in action names usable without a declaration (see useActionInvoker). */
const BUILTIN_ACTIONS = new Set(['navigate', 'setState']);

/** Legacy / removed kinds healed in place (zero-migration upgrades at the seam). */
const KIND_RENAME: Record<string, ViewNode['type']> = {
  AgentConsole: 'ActivityStream',
};

interface Ctx {
  collections: Set<string>;
  fixes: string[];
  panels: number;
  maxPanels: number;
}

/** Nodes that render a panel of collection rows — counted + capped. */
const DATA_PANEL = new Set(['Table', 'Chart', 'DataBoard', 'List', 'Kanban', 'RecordMaster', 'Roadmap']);
/** Nodes whose `bind.collection` must exist (else the panel is dead). */
const REQUIRES_BIND = new Set(['Table', 'Chart', 'DataBoard', 'List', 'Inbox', 'Kanban', 'RecordMaster', 'Roadmap', 'PipelineFlow']);
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
  // 0. Legacy kind → current kind (a stored tree from a removed grammar era).
  const renamed = KIND_RENAME[node.type as string];
  if (renamed) {
    ctx.fixes.push(`migrated legacy ${node.type} to ${renamed}`);
    const legacy = node as { title?: string; style?: ViewNode['style'] };
    node = { type: renamed, ...(legacy.title ? { title: legacy.title } : {}), ...(legacy.style ? { style: legacy.style } : {}) } as ViewNode;
  }

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
    return { ...node, ...normalizedGap(node, ctx.fixes), children: kids } as ViewNode;
  }

  return node;
}

function normalizedGap(node: ViewNode, fixes: string[]): { gap?: number } {
  if (!('gap' in node) || typeof node.gap !== 'number') return {};
  const scale = [8, 12, 16, 20, 24];
  const original = Number.isFinite(node.gap) ? Math.max(0, node.gap) : 16;
  const snapped = scale.reduce((nearest, candidate) => (
    Math.abs(candidate - original) < Math.abs(nearest - original) ? candidate : nearest
  ), scale[0]!);
  if (snapped !== node.gap) fixes.push('normalized layout gap');
  return { gap: snapped };
}

function inferTheme(view: ViewNode): SurfaceTheme {
  const json = JSON.stringify(view);
  if (json.includes('"DataBoard"') || json.includes('"Inbox"') || json.includes('"ChatThread"') || json.includes('"Kanban"') || json.includes('"RecordMaster"') || json.includes('"Roadmap"')) return 'product';
  if (json.includes('"Chart"') || json.includes('"KPIStrip"') || json.includes('"Gauge"') || json.includes('"PipelineFlow"')) return 'analytics';
  return 'operations';
}


function inferDesign(theme: SurfaceTheme): DesignLanguage {
  switch (theme) {
    case 'analytics': return 'aurora';
    case 'product': return 'soft';
    case 'editorial': return 'editorial';
    default: return 'operations';
  }
}

// ── Operability gate — RENDERED ≠ OPERABLE (INTERFACE-OVERHAUL-10X §2.1) ────
// The DB-proven failure mode: an agent declares `run_factory (workflow→…)` and
// authors zero interactive elements — the action is unreachable from any pixel.
// This pass makes that state unrepresentable: every declared workflow action
// gets a control, delete actions get row actions, dead references are stripped,
// and an app that drives workflows always exposes its orchestration panel.

function humanizeAction(name: string): string {
  const spaced = name.replace(/[_-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** Every action name any interactive element references, anywhere in the tree. */
function collectReferencedActions(node: unknown, out: Set<string>): void {
  if (Array.isArray(node)) { node.forEach((n) => collectReferencedActions(n, out)); return; }
  if (!node || typeof node !== 'object') return;
  const obj = node as Record<string, unknown>;
  const ref = obj as Partial<ActionRef>;
  if (typeof ref.action === 'string' && ref.action.length > 0 && !('type' in obj)) {
    out.add(ref.action);
  }
  for (const value of Object.values(obj)) collectReferencedActions(value, out);
}

/** Drop interactive elements whose action is not declared (they would 404 on click). */
function stripDeadInteractives(node: ViewNode, declared: Set<string>, fixes: string[]): ViewNode | null {
  const known = (name: string) => declared.has(name) || BUILTIN_ACTIONS.has(name);
  if (node.type === 'Button' && !known(node.action.action)) {
    fixes.push(`removed button bound to undeclared action "${node.action.action}"`);
    return null;
  }
  if (node.type === 'Form' && !known(node.submit.action)) {
    fixes.push(`removed form bound to undeclared action "${node.submit.action}"`);
    return null;
  }
  if (node.type === 'Table' && node.rowActions?.some((a) => !known(a.action))) {
    const kept = node.rowActions.filter((a) => known(a.action));
    fixes.push('removed undeclared row actions');
    return { ...node, rowActions: kept.length > 0 ? kept : undefined } as ViewNode;
  }
  if (node.type === 'Kanban') {
    let next = node;
    if (next.update && !known(next.update.action)) {
      fixes.push(`kanban drag disabled: undeclared action "${next.update.action}"`);
      next = { ...next, update: undefined };
    }
    if (next.cardActions?.some((a) => !known(a.action))) {
      const kept = next.cardActions.filter((a) => known(a.action));
      fixes.push('removed undeclared kanban card actions');
      next = { ...next, cardActions: kept.length > 0 ? kept : undefined };
    }
    if (next.contextActions?.some((a) => !known(a.action))) {
      const kept = next.contextActions.filter((a) => known(a.action));
      fixes.push('removed undeclared kanban context actions');
      next = { ...next, contextActions: kept.length > 0 ? kept : undefined };
    }
    return next;
  }
  if (node.type === 'RecordMaster' && node.recordActions?.some((a) => !known(a.action))) {
    const kept = node.recordActions.filter((a) => known(a.action));
    fixes.push('removed undeclared record actions');
    return { ...node, recordActions: kept.length > 0 ? kept : undefined } as ViewNode;
  }
  if (node.type === 'Hero' && node.actions?.some((a) => !known(a.action))) {
    const kept = node.actions.filter((a) => known(a.action));
    fixes.push('removed undeclared header actions');
    return { ...node, actions: kept.length > 0 ? kept : undefined } as ViewNode;
  }
  // Recurse containers.
  if (node.type === 'Split') {
    const left = stripDeadInteractives(node.left, declared, fixes);
    const right = stripDeadInteractives(node.right, declared, fixes);
    if (!left && !right) return null;
    if (!left) return right;
    if (!right) return left;
    return { ...node, left, right };
  }
  if (node.type === 'Tabs') {
    const tabs = node.tabs.map((t) => ({ ...t, children: t.children.map((c) => stripDeadInteractives(c, declared, fixes)).filter((x): x is ViewNode => x != null) }));
    return { ...node, tabs };
  }
  if (node.type === 'Accordion') {
    const sections = node.sections.map((s) => ({ ...s, children: s.children.map((c) => stripDeadInteractives(c, declared, fixes)).filter((x): x is ViewNode => x != null) }));
    return { ...node, sections };
  }
  if (hasChildren(node)) {
    return { ...node, children: node.children.map((c) => stripDeadInteractives(c, declared, fixes)).filter((x): x is ViewNode => x != null) } as ViewNode;
  }
  return node;
}

function findFirst(node: ViewNode, type: ViewNode['type']): boolean {
  if (node.type === type) return true;
  if (node.type === 'Split') return findFirst(node.left, type) || findFirst(node.right, type);
  if (node.type === 'Tabs') return node.tabs.some((t) => t.children.some((c) => findFirst(c, type)));
  if (node.type === 'Accordion') return node.sections.some((s) => s.children.some((c) => findFirst(c, type)));
  if (hasChildren(node)) return node.children.some((c) => findFirst(c, type));
  return false;
}

/** Wire declared-but-unreachable workflow actions into the page header (or a toolbar). */
function wireOrphanWorkflowActions(root: ViewNode, orphans: SurfaceAction[], fixes: string[]): ViewNode {
  if (orphans.length === 0) return root;
  const refs: ActionRef[] = orphans.map((a) => ({ action: a.name }));
  // Root with children: append to the first Hero's action bar, else prepend a toolbar.
  if (hasChildren(root)) {
    const heroIdx = root.children.findIndex((c) => c.type === 'Hero');
    if (heroIdx >= 0) {
      const hero = root.children[heroIdx] as Extract<ViewNode, { type: 'Hero' }>;
      const children = [...root.children];
      children[heroIdx] = { ...hero, actions: [...(hero.actions ?? []), ...refs] } as ViewNode;
      fixes.push(`wired ${orphans.length} workflow action(s) into the page header`);
      return { ...root, children } as ViewNode;
    }
    const toolbar: ViewNode = {
      type: 'Toolbar',
      children: orphans.map((a) => ({ type: 'Button', label: humanizeAction(a.name), action: { action: a.name }, variant: 'primary' } as ViewNode)),
    };
    fixes.push(`added an action bar for ${orphans.length} unreachable workflow action(s)`);
    return { ...root, children: [toolbar, ...root.children] } as ViewNode;
  }
  // Root without a children[] (Split/Tabs/…): wrap it, moving root-only style up.
  const { style, ...rest } = root as ViewNode & { style?: ViewNode['style'] };
  fixes.push(`added an action bar for ${orphans.length} unreachable workflow action(s)`);
  return {
    type: 'Stack',
    gap: 16,
    ...(style ? { style } : {}),
    children: [
      { type: 'Toolbar', children: orphans.map((a) => ({ type: 'Button', label: humanizeAction(a.name), action: { action: a.name }, variant: 'primary' } as ViewNode)) },
      rest as ViewNode,
    ],
  } as ViewNode;
}

/** Give tables of a collection with a declared delete action a per-row delete. */
function wireRowDeletes(node: ViewNode, deletesByCollection: Map<string, string>, fixes: string[]): ViewNode {
  if (node.type === 'Table') {
    const actionName = deletesByCollection.get(node.bind.collection);
    if (actionName && !node.rowActions?.some((a) => a.action === actionName)) {
      fixes.push(`wired row delete (${actionName}) on ${node.bind.collection} table`);
      return { ...node, rowActions: [...(node.rowActions ?? []), { action: actionName, args: { id: { $row: 'id' } } }] } as ViewNode;
    }
    return node;
  }
  if (node.type === 'Split') {
    return { ...node, left: wireRowDeletes(node.left, deletesByCollection, fixes), right: wireRowDeletes(node.right, deletesByCollection, fixes) };
  }
  if (node.type === 'Tabs') {
    return { ...node, tabs: node.tabs.map((t) => ({ ...t, children: t.children.map((c) => wireRowDeletes(c, deletesByCollection, fixes)) })) };
  }
  if (node.type === 'Accordion') {
    return { ...node, sections: node.sections.map((s) => ({ ...s, children: s.children.map((c) => wireRowDeletes(c, deletesByCollection, fixes)) })) };
  }
  if (hasChildren(node)) {
    return { ...node, children: node.children.map((c) => wireRowDeletes(c, deletesByCollection, fixes)) } as ViewNode;
  }
  return node;
}

/**
 * Wire a Kanban's drag to a declared "<collection>.update" data action when the
 * agent left `update` off. A board you can't drag is the "static kanban" defect —
 * `draggable = Boolean(node.update)` at the renderer, so an unwired board is inert.
 * (LIVING-INTERFACES-COCKPIT-10X §6.) Only fills a MISSING update; a present-but-
 * undeclared one was already stripped upstream, and this then re-wires it correctly.
 */
function wireKanbanUpdates(node: ViewNode, updatesByCollection: Map<string, string>, fixes: string[]): ViewNode {
  if (node.type === 'Kanban') {
    if (!node.update) {
      const actionName = updatesByCollection.get(node.bind.collection);
      if (actionName) {
        fixes.push(`wired kanban drag (${actionName}) on ${node.bind.collection} board`);
        return { ...node, update: { action: actionName } } as ViewNode;
      }
    }
    return node;
  }
  if (node.type === 'Split') {
    return { ...node, left: wireKanbanUpdates(node.left, updatesByCollection, fixes), right: wireKanbanUpdates(node.right, updatesByCollection, fixes) };
  }
  if (node.type === 'Tabs') {
    return { ...node, tabs: node.tabs.map((t) => ({ ...t, children: t.children.map((c) => wireKanbanUpdates(c, updatesByCollection, fixes)) })) };
  }
  if (node.type === 'Accordion') {
    return { ...node, sections: node.sections.map((s) => ({ ...s, children: s.children.map((c) => wireKanbanUpdates(c, updatesByCollection, fixes)) })) };
  }
  if (hasChildren(node)) {
    return { ...node, children: node.children.map((c) => wireKanbanUpdates(c, updatesByCollection, fixes)) } as ViewNode;
  }
  return node;
}

function auditOperability(root: ViewNode, actions: SurfaceAction[], fixes: string[]): ViewNode {
  let out = root;
  const declared = new Set(actions.map((a) => a.name));

  // A) Strip interactive elements whose action does not exist (would 404 on click).
  out = stripDeadInteractives(out, declared, fixes) ?? { type: 'Stack', gap: 16, children: [] };

  // B) Every declared workflow action must be reachable from some pixel.
  const referenced = new Set<string>();
  collectReferencedActions(out, referenced);
  const orphanWorkflows = actions.filter((a) => a.kind === 'workflow' && !referenced.has(a.name));
  out = wireOrphanWorkflowActions(out, orphanWorkflows, fixes);

  // C) Declared data deletes get a per-row control on the matching table.
  const deletes = new Map<string, string>();
  for (const a of actions) {
    if (a.kind !== 'data') continue;
    const [collection, op] = a.target.split('.');
    if (collection && op === 'delete') deletes.set(collection, a.name);
  }
  if (deletes.size > 0) out = wireRowDeletes(out, deletes, fixes);

  // C2) A Kanban over a collection with a declared "<collection>.update" gets its
  //     drag wired — a board is meant to be dragged, so wire it by construction.
  const updates = new Map<string, string>();
  for (const a of actions) {
    if (a.kind !== 'data') continue;
    const [collection, op] = a.target.split('.');
    if (collection && op === 'update') updates.set(collection, a.name);
  }
  if (updates.size > 0) out = wireKanbanUpdates(out, updates, fixes);

  // D) An app that drives workflows always exposes its control plane AND its
  //    LIVE rail. A workflow-driving app is an operational unit, not a static
  //    screen — the operator must always be able to (1) control the workflows
  //    and (2) FOLLOW them in realtime: watch runs pulse and cancel/pause them,
  //    and watch the agent think. The control plane (OrchestrationPanel) was
  //    already guaranteed; the live rail (RunMonitor + AgentFeed) was not, so an
  //    app the model didn't explicitly wire with a rail rendered "dead" even
  //    though the runtime blocks stream live. Guarantee both. (LIVING-INTERFACES-
  //    COCKPIT-10X §5 — every app follows realtime by construction.)
  const drivesWorkflows = actions.some((a) => a.kind === 'workflow');
  if (drivesWorkflows && hasChildren(out)) {
    const additions: ViewNode[] = [];
    const hasControl = findFirst(out, 'OrchestrationPanel') || findFirst(out, 'WorkflowControl') || findFirst(out, 'RunMonitor');
    if (!hasControl) {
      additions.push({ type: 'OrchestrationPanel' } as ViewNode);
      fixes.push('added the orchestration panel (app drives workflows)');
    }
    // The realtime rail: live runs (with control) beside the agent's streamed
    // reasoning. Skip only if the surface already surfaces run activity itself.
    if (!findFirst(out, 'RunMonitor') && !findFirst(out, 'AgentFeed')) {
      additions.push({
        type: 'Grid',
        columns: 2,
        gap: 16,
        children: [{ type: 'RunMonitor' } as ViewNode, { type: 'AgentFeed' } as ViewNode],
      } as ViewNode);
      fixes.push('added the realtime rail (live run monitor + agent thought feed)');
    }
    if (additions.length > 0) {
      const heroIdx = out.children.findIndex((c) => c.type === 'Hero');
      const children = [...out.children];
      children.splice(heroIdx >= 0 ? heroIdx + 1 : 0, 0, ...additions);
      out = { ...out, children } as ViewNode;
    }
  }

  return out;
}

/**
 * Repair an agent-authored surface so it meets the layout floor AND the
 * operability contract. Idempotent. `collections` = the app's real collection
 * names (bind validation); `actions` = the surface's declared actions (the
 * operability gate wires/strips against them).
 */
export function repairSurface(
  view: ViewNode | null | undefined,
  opts: { collections?: string[]; actions?: SurfaceAction[] } = {},
): AuditResult {
  const collections = new Set(opts.collections ?? []);
  const ctx: Ctx = { collections, fixes: [], panels: 0, maxPanels: Math.max(4, collections.size * 2) };

  let out = view ? repair(view, ctx, 0) : null;
  if (!out) out = { type: 'Stack', gap: 16, children: [] };

  // Operability gate — only when the caller supplied the declared actions.
  if (opts.actions) out = auditOperability(out, opts.actions, ctx.fixes);

  // Guarantee a root theme so the surface is always coherently styled.
  out = ensureViewNodeIds(out);

  if (!out.style?.theme) {
    out = { ...out, style: { ...out.style, theme: inferTheme(out) } } as ViewNode;
    ctx.fixes.push('set root theme');
  }

  // Guarantee a premium design language so no surface renders flat — inferred
  // from the (now-guaranteed) theme. Honors any language the model already chose.
  if (!out.style?.design) {
    const theme = out.style?.theme ?? inferTheme(out);
    out = { ...out, style: { ...out.style, design: inferDesign(theme) } } as ViewNode;
    ctx.fixes.push('set root design language');
  }

  return { view: out, fixes: ctx.fixes };
}

/** Persist stable semantic targets so agents can edit/delete without fragile paths. */
export function ensureViewNodeIds(root: ViewNode): ViewNode {
  const used = new Set<string>();
  const claim = (node: ViewNode, path: string): string => {
    const preferred = node.nodeId?.trim();
    let candidate = preferred || `node.${node.type.toLowerCase()}.${path || 'root'}`;
    let suffix = 2;
    while (used.has(candidate)) candidate = `${preferred || `node.${node.type.toLowerCase()}.${path || 'root'}`}.${suffix++}`;
    used.add(candidate);
    return candidate;
  };
  const walk = (node: ViewNode, path: string): ViewNode => {
    const nodeId = claim(node, path);
    if (node.type === 'Split') return { ...node, nodeId, left: walk(node.left, `${path}.left`), right: walk(node.right, `${path}.right`) };
    if (node.type === 'Tabs') return { ...node, nodeId, tabs: node.tabs.map((tab, ti) => ({ ...tab, children: tab.children.map((child, ci) => walk(child, `${path}.tabs.${ti}.${ci}`)) })) };
    if (node.type === 'Accordion') return { ...node, nodeId, sections: node.sections.map((section, si) => ({ ...section, children: section.children.map((child, ci) => walk(child, `${path}.sections.${si}.${ci}`)) })) };
    if (node.type === 'List') return { ...node, nodeId, item: walk(node.item, `${path}.item`) };
    if (node.type === 'AgentRegion' && node.child) return { ...node, nodeId, child: walk(node.child, `${path}.child`) };
    if (hasChildren(node)) return { ...node, nodeId, children: node.children.map((child, index) => walk(child, `${path}.${index}`)) } as ViewNode;
    return { ...node, nodeId } as ViewNode;
  };
  return walk(root, 'root');
}



