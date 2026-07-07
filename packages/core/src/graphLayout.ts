/**
 * Deterministic left-to-right layered layout for workflow graphs.
 *
 * AI-synthesized graphs come with arbitrary, often sprawling node positions —
 * which makes the canvas unreadable and impossible to frame at any zoom. This
 * is a dependency-free Sugiyama-style layout: assign each node to a layer by its
 * longest path from a source, then order nodes within a layer by the barycenter
 * of their parents to reduce edge crossings, and place them on a clean grid.
 *
 * Pure and shape-agnostic: the core routine needs only node ids and edges, so it
 * is shared by the build pipeline (apps/api, on the persisted graph) and the
 * canvas "Tidy" action (apps/web, on React-Flow nodes). Assumes an (almost)
 * acyclic graph — `repairGraph` removes cycles before this runs — but degrades
 * gracefully if a cycle remains.
 */

import type { WorkflowGraph } from './types/workflow.js';

export interface LayoutOptions {
  /** Horizontal distance between layers (node width + gutter). */
  colGap?: number;
  /** Vertical distance between siblings in a layer. */
  rowGap?: number;
  originX?: number;
  originY?: number;
}

export type LayoutPositions = Map<string, { x: number; y: number }>;

export function computeLayeredLayout(
  nodes: ReadonlyArray<{ id: string }>,
  edges: ReadonlyArray<{ source: string; target: string }>,
  opts: LayoutOptions = {},
): LayoutPositions {
  const colGap = opts.colGap ?? 292;
  const rowGap = opts.rowGap ?? 110;
  const originX = opts.originX ?? 0;
  const originY = opts.originY ?? 0;

  const ids = new Set(nodes.map((n) => n.id));
  const outgoing = new Map<string, string[]>();
  const parents = new Map<string, string[]>();
  const indeg = new Map<string, number>();
  for (const n of nodes) {
    outgoing.set(n.id, []);
    parents.set(n.id, []);
    indeg.set(n.id, 0);
  }
  for (const e of edges) {
    if (!ids.has(e.source) || !ids.has(e.target) || e.source === e.target) continue;
    outgoing.get(e.source)!.push(e.target);
    parents.get(e.target)!.push(e.source);
    indeg.set(e.target, (indeg.get(e.target) ?? 0) + 1);
  }

  // Longest-path layering via topological relaxation (Kahn).
  const layer = new Map<string, number>();
  for (const n of nodes) layer.set(n.id, 0);
  const remaining = new Map(indeg);
  const queue = nodes.filter((n) => (remaining.get(n.id) ?? 0) === 0).map((n) => n.id);
  const settled = new Set<string>();
  while (queue.length > 0) {
    const id = queue.shift()!;
    settled.add(id);
    for (const t of outgoing.get(id) ?? []) {
      layer.set(t, Math.max(layer.get(t) ?? 0, (layer.get(id) ?? 0) + 1));
      remaining.set(t, (remaining.get(t) ?? 0) - 1);
      if ((remaining.get(t) ?? 0) === 0) queue.push(t);
    }
  }

  // Group ids by layer, preserving declaration order as the initial ordering.
  const byLayer = new Map<number, string[]>();
  for (const n of nodes) {
    const l = layer.get(n.id) ?? 0;
    const arr = byLayer.get(l) ?? [];
    arr.push(n.id);
    byLayer.set(l, arr);
  }
  const layers = [...byLayer.keys()].sort((a, b) => a - b);

  // Barycenter ordering: left-to-right, so each layer sorts by the average
  // position of its already-placed parents — fewer crossings, tidier columns.
  const indexInLayer = new Map<string, number>();
  for (const l of layers) byLayer.get(l)!.forEach((id, i) => indexInLayer.set(id, i));
  const barycenter = (id: string): number => {
    const ps = parents.get(id) ?? [];
    if (ps.length === 0) return indexInLayer.get(id) ?? 0;
    return ps.reduce((sum, p) => sum + (indexInLayer.get(p) ?? 0), 0) / ps.length;
  };
  for (const l of layers) {
    const arr = byLayer.get(l)!;
    arr.sort((a, b) => barycenter(a) - barycenter(b) || a.localeCompare(b));
    arr.forEach((id, i) => indexInLayer.set(id, i));
  }

  // Place: x by layer (left-to-right), y centered within the layer's column.
  const pos: LayoutPositions = new Map();
  for (const l of layers) {
    const arr = byLayer.get(l)!;
    const columnHeight = (arr.length - 1) * rowGap;
    arr.forEach((id, i) => {
      pos.set(id, { x: originX + l * colGap, y: originY + i * rowGap - columnHeight / 2 });
    });
  }
  return pos;
}

/** Return a copy of the graph with every node repositioned by the layered layout. */
export function layoutWorkflowGraph<G extends WorkflowGraph>(graph: G, opts?: LayoutOptions): G {
  const pos = computeLayeredLayout(graph.nodes, graph.edges, opts);
  return {
    ...graph,
    nodes: graph.nodes.map((n) => {
      const p = pos.get(n.id);
      return p ? { ...n, position: p } : n;
    }),
  };
}
