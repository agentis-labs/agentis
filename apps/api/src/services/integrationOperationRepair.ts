/**
 * Integration operation normalization (general, all connectors).
 *
 * Synthesis frequently emits an `operationId` that doesn't match what the
 * connector actually supports (e.g. `send_email` for AgentMail, whose real
 * operation is `send_message`). At run time the connector throws
 * "operation 'X' is not supported by Y" — the workflow looks built but can't
 * run. This module makes integration nodes conform to each connector's real
 * operation catalog, for EVERY integration — never one connector at a time.
 *
 * Strategy (conservative — never silently picks a *wrong* action):
 *   - already valid → keep.
 *   - connector has exactly one operation → use it.
 *   - else pick the supported operation with the best token overlap with the
 *     requested name (e.g. `send_email` → `send_message`, both share `send`);
 *     require a real overlap, otherwise leave it untouched (so `validate` can
 *     flag it for the operator instead of guessing).
 */

import type { WorkflowGraph } from '@agentis/core';

export interface OperationCatalog {
  /** integration slug (lowercase) → supported operation names. */
  [slug: string]: string[];
}

export interface OperationRepair {
  nodeId: string;
  integration: string;
  from: string;
  to: string;
}

export interface OperationIssue {
  nodeId: string;
  nodeTitle: string;
  integration: string;
  operation: string;
  supported: string[];
}

function tokens(name: string): Set<string> {
  return new Set(name.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
}

/** Best supported operation for a requested one, or null if no confident match. */
export function bestOperationMatch(requested: string, supported: string[]): string | null {
  if (supported.length === 0) return null;
  if (supported.includes(requested)) return requested;
  if (supported.length === 1) return supported[0]!;
  const want = tokens(requested);
  let best: { op: string; score: number } | null = null;
  for (const op of supported) {
    const have = tokens(op);
    let overlap = 0;
    for (const t of want) if (have.has(t)) overlap += 1;
    if (overlap > 0 && (!best || overlap > best.score)) best = { op, score: overlap };
  }
  return best?.op ?? null;
}

/**
 * Rewrite invalid integration `operationId`s in place against the catalog.
 * Returns a new graph + the list of repairs (for the build's repair log).
 * Integrations with no known catalog entry are left untouched (flagged by
 * {@link validateIntegrationOperations}).
 */
export function repairIntegrationOperations(
  graph: WorkflowGraph,
  catalog: OperationCatalog,
): { graph: WorkflowGraph; repairs: OperationRepair[] } {
  const repairs: OperationRepair[] = [];
  const nodes = graph.nodes.map((node) => {
    const cfg = node.config as Record<string, unknown> & { kind?: string };
    if (cfg.kind !== 'integration') return node;
    const slug = String(cfg.integrationId ?? '').toLowerCase();
    const supported = catalog[slug];
    const op = String(cfg.operationId ?? '');
    if (!slug || !supported || supported.length === 0 || !op) return node;
    if (supported.includes(op)) return node;
    const fixed = bestOperationMatch(op, supported);
    if (!fixed || fixed === op) return node;
    repairs.push({ nodeId: node.id, integration: slug, from: op, to: fixed });
    return { ...node, config: { ...cfg, operationId: fixed } } as typeof node;
  });
  return { graph: { ...graph, nodes }, repairs };
}

/** Integration nodes whose operation still isn't valid for the connector. */
export function validateIntegrationOperations(
  graph: WorkflowGraph,
  catalog: OperationCatalog,
): OperationIssue[] {
  const issues: OperationIssue[] = [];
  for (const node of graph.nodes) {
    const cfg = node.config as Record<string, unknown> & { kind?: string };
    if (cfg.kind !== 'integration') continue;
    const slug = String(cfg.integrationId ?? '').toLowerCase();
    const supported = catalog[slug];
    const op = String(cfg.operationId ?? '');
    if (!slug || !supported || supported.length === 0) continue;
    if (op && !supported.includes(op)) {
      issues.push({ nodeId: node.id, nodeTitle: node.title || node.id, integration: slug, operation: op, supported });
    }
  }
  return issues;
}
