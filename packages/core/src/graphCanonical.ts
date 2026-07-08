/**
 * Deterministic graph canonicalization (NATIVE-ADVANCEMENT Proposal 6d, rescoped).
 *
 * Produces a stable string for a workflow graph so two representations of the
 * "same" graph hash identically. Cosmetic fields that do not change behaviour
 * (viewport, node positions) are stripped, and object keys are sorted, so a
 * pure drag-on-canvas does NOT change the fingerprint.
 *
 * The fingerprint is used for *divergence detection* â€” telling whether the
 * graph being run is the graph that was saved, and letting the canvas detect
 * unsaved local edits â€” NOT as a security/tamper boundary (a self-hosted
 * instance's threat model does not warrant that; see NATIVE-ADVANCEMENT Q2).
 *
 * This module is pure and browser-safe (no `node:` imports). The actual hash is
 * computed by the caller (apps/api uses node:crypto; the web can use
 * crypto.subtle) over the string returned here.
 */

import type { WorkflowGraph } from './types/workflow.js';

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



