/**
 * autoLayout — tidies React-Flow nodes with the shared layered layout from
 * @agentis/core, so the canvas "Tidy" action and the build pipeline produce the
 * exact same arrangement. Pure: returns a new node array with fresh positions.
 */

import type { Edge, Node } from '@xyflow/react';
import { computeLayeredLayout, type LayoutOptions } from '@agentis/core';

export function autoLayout(nodes: Node[], edges: Edge[], opts?: LayoutOptions): Node[] {
  if (nodes.length === 0) return nodes;
  const positions = computeLayeredLayout(
    nodes.map((n) => ({ id: n.id })),
    edges.map((e) => ({ source: e.source, target: e.target })),
    opts,
  );
  return nodes.map((n) => {
    const p = positions.get(n.id);
    return p ? { ...n, position: p } : n;
  });
}
