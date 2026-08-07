/**
 * Deterministic graph canonicalization (NATIVE-ADVANCEMENT Proposal 6d, rescoped).
 *
 * Produces a stable string for a workflow graph so two representations of the
 * "same" graph hash identically. Cosmetic fields that do not change behaviour
 * (viewport, node positions) are stripped, and object keys are sorted, so a
 * pure drag-on-canvas does NOT change the fingerprint.
 *
 * The fingerprint is used for *divergence detection* — telling whether the
 * graph being run is the graph that was saved, and letting the canvas detect
 * unsaved local edits — NOT as a security/tamper boundary (a self-hosted
 * instance's threat model does not warrant that; see NATIVE-ADVANCEMENT Q2).
 *
 * This module is pure and browser-safe (no `node:` imports). The actual hash is
 * computed by the caller (apps/api uses node:crypto; the web can use
 * crypto.subtle) over the string returned here.
 */

import type { WorkflowGraph } from './types/workflow.js';

export interface GraphIdentityRepair {
  kind: 'edge_id_assigned' | 'edge_id_deduplicated';
  edgeIndex: number;
  previousId?: string;
  id: string;
  message: string;
}

function edgeIdentityPart(value: unknown): string {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return (normalized || 'default')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'default';
}

/** Repair missing/duplicate edge ids before strict graph validation. */
export function repairWorkflowGraphIdentity(
  graph: WorkflowGraph | (Omit<WorkflowGraph, 'edges'> & { edges: Array<Record<string, unknown>> }),
): { graph: WorkflowGraph; repairs: GraphIdentityRepair[] } {
  const repairs: GraphIdentityRepair[] = [];
  const used = new Set<string>();
  const occurrences = new Map<string, number>();
  const edges = (graph.edges ?? []).map((rawEdge, edgeIndex) => {
    const edge = rawEdge as unknown as Record<string, unknown>;
    const previousId = typeof edge.id === 'string' ? edge.id.trim() : '';
    const semanticBase = [
      'edge',
      edgeIdentityPart(edge.source),
      edgeIdentityPart(edge.sourceHandle),
      edgeIdentityPart(edge.target),
      edgeIdentityPart(edge.targetHandle),
      edgeIdentityPart(edge.type),
    ].join('-');
    const occurrence = (occurrences.get(semanticBase) ?? 0) + 1;
    occurrences.set(semanticBase, occurrence);
    let id = previousId;
    let kind: GraphIdentityRepair['kind'] | null = null;
    if (!id) {
      id = occurrence === 1 ? semanticBase : `${semanticBase}-${occurrence}`;
      kind = 'edge_id_assigned';
    } else if (used.has(id)) {
      let suffix = occurrence;
      let candidate = `${semanticBase}-${suffix}`;
      while (used.has(candidate)) candidate = `${semanticBase}-${++suffix}`;
      id = candidate;
      kind = 'edge_id_deduplicated';
    }
    used.add(id);
    if (kind) {
      repairs.push({
        kind,
        edgeIndex,
        ...(previousId ? { previousId } : {}),
        id,
        message: previousId
          ? `Replaced duplicate edge id '${previousId}' with stable id '${id}'.`
          : `Assigned stable id '${id}' to edge ${edgeIndex + 1}.`,
      });
    }
    return { ...edge, id };
  });
  return { graph: { ...graph, edges } as WorkflowGraph, repairs };
}

/** Recursively sort object keys so JSON.stringify is order-independent. */
function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortValue((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/**
 * Canonical, behaviour-significant JSON string for a graph. Stable across:
 *  - viewport / node-position changes (cosmetic, stripped)
 *  - key ordering (sorted)
 *  - node / edge array ordering (sorted by id)
 */
export function canonicalizeGraph(graph: WorkflowGraph): string {
  const nodes = [...(graph.nodes ?? [])]
    .map((n) => ({
      id: n.id,
      type: n.type,
      title: n.title,
      config: n.config,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));

  const edges = [...(graph.edges ?? [])]
    .map((e) => ({
      id: e.id,
      source: e.source,
      sourceHandle: e.sourceHandle ?? null,
      target: e.target,
      targetHandle: e.targetHandle ?? null,
      condition: e.condition ?? null,
      type: e.type ?? 'default',
    }))
    .sort((a, b) => a.id.localeCompare(b.id));

  const canonical = {
    version: graph.version,
    nodes,
    edges,
    inputContract: graph.inputContract ?? null,
    outputContract: graph.outputContract ?? null,
    phases: graph.phases ?? null,
  };

  return JSON.stringify(sortValue(canonical));
}



