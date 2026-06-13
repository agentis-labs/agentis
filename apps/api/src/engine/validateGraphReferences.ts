/**
 * Static template-reference validation (NATIVE-ADVANCEMENT Proposal 2 / AGTS,
 * reframed for Agentis's real data model).
 *
 * Agentis nodes do NOT pass typed data through edge ports. A node pulls data by
 * reference: any config field may contain `{{nodes.X.path}}`, `{{trigger.*}}`,
 * `{{scratchpad.*}}`, etc., resolved against a snapshot of ALL completed node
 * outputs (see templateResolver.ts). A missing path silently resolves to `''`
 * — which is exactly how garbled/empty input reaches an LLM unnoticed.
 *
 * So the valuable pre-run check is NOT port-to-port type compatibility (there
 * are no typed ports); it is catching references that cannot resolve:
 *   - `dangling_node_ref`  → references a node id that does not exist (ERROR)
 *   - `forward_node_ref`   → references a node that is not a transitive
 *                            predecessor, so it will not have run yet (WARNING)
 *   - `self_ref`           → a node references its own output (WARNING)
 *   - `unknown_namespace`  → head is neither a reserved namespace nor a node id
 *                            (WARNING — likely a typo)
 *
 * This is Weft's "catch it before you run it" spirit, adapted to Agentis DNA.
 * It assumes a valid DAG (validateWorkflowGraph rejects cycles first).
 */

import type { WorkflowGraph } from '@agentis/core';
import { extractTemplateReferences } from './templateResolver.js';

/** Namespaces the resolver understands that are not node references. */
const RESERVED_NAMESPACES = new Set([
  'trigger',
  'nodes',
  'scratchpad',
  'store',
  'workspace',
  'run',
  'loop',
]);

export type ReferenceIssueCode =
  | 'dangling_node_ref'
  | 'forward_node_ref'
  | 'self_ref'
  | 'unknown_namespace';

export interface ReferenceIssue {
  nodeId: string;
  nodeTitle: string;
  /** The raw `{{...}}` expression that is suspect. */
  expression: string;
  severity: 'error' | 'warning';
  code: ReferenceIssueCode;
  message: string;
}

/** For each node, the set of nodes that can reach it (transitive predecessors). */
function buildAncestors(graph: WorkflowGraph): Map<string, Set<string>> {
  const preds = new Map<string, string[]>();
  for (const node of graph.nodes) preds.set(node.id, []);
  for (const edge of graph.edges) {
    if (preds.has(edge.target)) preds.get(edge.target)!.push(edge.source);
  }
  const cache = new Map<string, Set<string>>();
  const visiting = new Set<string>();
  function ancestorsOf(id: string): Set<string> {
    const cached = cache.get(id);
    if (cached) return cached;
    // Cycle guard (graph is a DAG, but stay safe): break recursion.
    if (visiting.has(id)) return new Set();
    visiting.add(id);
    const acc = new Set<string>();
    for (const p of preds.get(id) ?? []) {
      acc.add(p);
      for (const a of ancestorsOf(p)) acc.add(a);
    }
    visiting.delete(id);
    cache.set(id, acc);
    return acc;
  }
  for (const node of graph.nodes) ancestorsOf(node.id);
  return cache;
}

/** Collect every string value inside a node config (recursively). */
function collectStrings(value: unknown, out: string[]): void {
  if (typeof value === 'string') {
    if (value.indexOf('{{') !== -1) out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, out);
    return;
  }
  if (value && typeof value === 'object') {
    for (const v of Object.values(value as Record<string, unknown>)) collectStrings(v, out);
  }
}

/**
 * Validate that every `{{nodes.X...}}` reference resolves to a node that exists
 * and runs before the referencing node. Pure; safe to call before `startRun`.
 */
export function validateGraphReferences(graph: WorkflowGraph): ReferenceIssue[] {
  const issues: ReferenceIssue[] = [];
  const nodeIds = new Set(graph.nodes.map((n) => n.id));
  const ancestors = buildAncestors(graph);
  const titleOf = new Map(graph.nodes.map((n) => [n.id, n.title] as const));

  for (const node of graph.nodes) {
    const strings: string[] = [];
    collectStrings(node.config, strings);
    if (strings.length === 0) continue;

    const ancestorSet = ancestors.get(node.id) ?? new Set<string>();
    // Dedup expressions per node so we don't report the same typo twice.
    const seen = new Set<string>();

    for (const str of strings) {
      for (const ref of extractTemplateReferences(str)) {
        if (seen.has(ref.raw)) continue;
        seen.add(ref.raw);

        // Resolve the target node id, if this is a node reference.
        let targetNodeId: string | null = null;
        if (ref.head === 'nodes') {
          targetNodeId = ref.rest[0] ?? null;
        } else if (!RESERVED_NAMESPACES.has(ref.head) && nodeIds.has(ref.head)) {
          // Permissive bare-id form `{{X.y}}` (templateResolver readPath fallback).
          targetNodeId = ref.head;
        } else if (!RESERVED_NAMESPACES.has(ref.head)) {
          issues.push({
            nodeId: node.id,
            nodeTitle: titleOf.get(node.id) ?? node.id,
            expression: `{{${ref.raw}}}`,
            severity: 'warning',
            code: 'unknown_namespace',
            message: `Reference "{{${ref.raw}}}" starts with "${ref.head}", which is neither a known namespace (${[...RESERVED_NAMESPACES].join(', ')}) nor a node id. Likely a typo — it will resolve to empty at runtime.`,
          });
          continue;
        } else {
          // Reserved namespace (trigger/scratchpad/store/workspace/run/loop): ok.
          continue;
        }

        if (!targetNodeId) continue; // `{{nodes}}` with no id — harmless.

        if (!nodeIds.has(targetNodeId)) {
          issues.push({
            nodeId: node.id,
            nodeTitle: titleOf.get(node.id) ?? node.id,
            expression: `{{${ref.raw}}}`,
            severity: 'error',
            code: 'dangling_node_ref',
            message: `References node "${targetNodeId}", which does not exist. This will resolve to empty input at runtime.`,
          });
          continue;
        }
        if (targetNodeId === node.id) {
          issues.push({
            nodeId: node.id,
            nodeTitle: titleOf.get(node.id) ?? node.id,
            expression: `{{${ref.raw}}}`,
            severity: 'warning',
            code: 'self_ref',
            message: `Node references its own output ("${targetNodeId}"), which is not available while it runs.`,
          });
          continue;
        }
        if (!ancestorSet.has(targetNodeId)) {
          issues.push({
            nodeId: node.id,
            nodeTitle: titleOf.get(node.id) ?? node.id,
            expression: `{{${ref.raw}}}`,
            severity: 'warning',
            code: 'forward_node_ref',
            message: `References node "${targetNodeId}", which is not upstream of this node, so it may not have produced output yet. Connect them (or reorder) to guarantee the value exists.`,
          });
        }
      }
    }
  }

  return issues;
}
