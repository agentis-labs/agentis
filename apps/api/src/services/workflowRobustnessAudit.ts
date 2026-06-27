/**
 * Workflow Robustness Audit (WORKFLOW-DESIGN-10X Phase 2).
 *
 * The Workflow Design Doctrine (Phase 1) TEACHES the synthesis model to design
 * for failure (gates, fallbacks, state, bounds, rollback). This module ENFORCES
 * it deterministically: it inspects the assembled graph and flags the robustness
 * gaps the doctrine warns about — and auto-repairs the safe ones — so even a
 * naive happy-path draft comes out more robust. It complements preflightAndEnrich
 * (which checks operational validity: credentials, agent binding, terminal node).
 *
 * Checks are intentionally conservative (low false-positive): each maps to a
 * doctrine clause (D1–D6) and only fires on a clear structural omission.
 */

import type { WorkflowGraph, WorkflowNode } from '@agentis/core';
import type { IntentClassification, PreflightWarning } from './creationPipeline.js';

export interface RobustnessAuditResult {
  graph: WorkflowGraph;
  warnings: PreflightWarning[];
  /** Human-readable descriptions of the safe auto-repairs applied to the graph. */
  repairs: string[];
}

/** Default fan-out bound applied to an unbounded batch node (D5). */
const DEFAULT_BATCH_CONCURRENCY = 5;

const DELIVERY_KINDS = new Set(['integration']);
const FETCH_KINDS = new Set(['http_request', 'browser']);
const GUARD_KINDS = new Set(['evaluator', 'checkpoint', 'guardrails']);
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function kindOf(node: WorkflowNode): string {
  return String((node.config as { kind?: unknown } | undefined)?.kind ?? node.type ?? '');
}

/** An externally-visible / irreversible action node: an integration, or an HTTP write. */
function isDeliveryNode(node: WorkflowNode): boolean {
  const cfg = node.config as { kind?: string; method?: unknown } | undefined;
  if (DELIVERY_KINDS.has(kindOf(node))) return true;
  if (kindOf(node) === 'http_request' && typeof cfg?.method === 'string' && WRITE_METHODS.has(cfg.method.toUpperCase())) {
    return true;
  }
  return false;
}

/** Backward reachability: the set of node ids that can reach `targetId` (its ancestors). */
function ancestorsOf(targetId: string, edges: WorkflowGraph['edges']): Set<string> {
  const incoming = new Map<string, string[]>();
  for (const e of edges) {
    (incoming.get(e.target) ?? incoming.set(e.target, []).get(e.target)!).push(e.source);
  }
  const seen = new Set<string>();
  const stack = [...(incoming.get(targetId) ?? [])];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const prev of incoming.get(id) ?? []) stack.push(prev);
  }
  return seen;
}

/**
 * Audit the graph for the doctrine's robustness gaps. Returns warnings (surfaced
 * to the operator and fed to the reviewer) plus a graph with safe auto-repairs
 * applied (currently: bounding an unbounded batch — D5).
 */
export function auditWorkflowRobustness(
  graph: WorkflowGraph,
  classification: Pick<IntentClassification, 'triggerType' | 'archetype'> & Partial<Pick<IntentClassification, 'robustness'>>,
): RobustnessAuditResult {
  const warnings: PreflightWarning[] = [];
  const repairs: string[] = [];
  const nodes = graph.nodes.map((n) => ({ ...n, config: { ...(n.config as unknown as Record<string, unknown>) } })) as unknown as WorkflowNode[];
  const kinds = nodes.map(kindOf);

  const has = (kind: string) => kinds.includes(kind);
  const recurring = classification.triggerType === 'cron' || classification.triggerType === 'persistent_listener';

  // ── D4: recurring workflow that accumulates work but keeps no state → no dedup,
  //        re-processes everything every run. Iron Rule 13, now enforced. ──
  if (recurring && !has('workflow_store') && nodes.length > 1) {
    warnings.push({
      code: 'MISSING_STATE',
      message:
        'This runs on a schedule/listener but has no workflow_store node — it will re-process the same items every run. '
        + 'Add a workflow_store "get" near the start (a seen-set / last cursor) and a "set" near the end so each run only handles what is new.',
    });
  }

  // ── D7: the request reads as open-ended ("iterate until done", refine/critique,
  //        multi-agent convergence) but the graph has no `converge` node — it will
  //        run once or rely on a brittle fixed-N evaluator retry that carries no
  //        state between tries. Fires only on the explicit iterative signal. ──
  if (classification.robustness?.iterative && !has('converge') && nodes.length > 1) {
    warnings.push({
      code: 'MISSING_CONVERGENCE',
      message:
        'This goal is open-ended (iterate until done / refine / multi-agent convergence) but has no converge node. '
        + 'A converge node re-runs a cohort sub-workflow each iteration, carries state across iterations on the blackboard, '
        + 'and stops on goal/stall/budget with an honest verdict — far more robust than a fixed-N evaluator retry. '
        + 'Retrieve the convergence-loop pattern with agentis.workflow.patterns.',
    });
  }

  // ── D5: a batch node with no concurrency bound fans out unbounded. Safe to
  //        repair by setting a sensible default cap. ──
  for (const node of nodes) {
    const cfg = node.config as unknown as Record<string, unknown>;
    const kind = kindOf(node);
    if (kind === 'loop') {
      const bound = Number(cfg.maxConcurrency);
      if (!Number.isFinite(bound) || bound <= 0) {
        cfg.maxConcurrency = DEFAULT_BATCH_CONCURRENCY;
        repairs.push(`Bounded "${node.title}" loop to maxConcurrency=${DEFAULT_BATCH_CONCURRENCY} (was unbounded).`);
      }
    } else if (kind === 'agent_swarm' || kind === 'dynamic_swarm') {
      const bound = Number(cfg.maxParallel);
      if (!Number.isFinite(bound) || bound <= 0) {
        cfg.maxParallel = DEFAULT_BATCH_CONCURRENCY;
        repairs.push(`Bounded "${node.title}" swarm to maxParallel=${DEFAULT_BATCH_CONCURRENCY} (was unbounded).`);
      }
    }
  }

  // ── D1: a router that has fewer than two outgoing edges is a decision with no
  //        alternative branch — usually the missing reject/fallback path. ──
  const outDegree = new Map<string, number>();
  for (const e of graph.edges) outDegree.set(e.source, (outDegree.get(e.source) ?? 0) + 1);
  for (const node of nodes) {
    if (kindOf(node) === 'router' && (outDegree.get(node.id) ?? 0) < 2) {
      warnings.push({
        code: 'SINGLE_BRANCH_ROUTER',
        nodeId: node.id,
        message: `${node.title}: a router with one branch is a decision with no alternative — add the reject/fallback branch (e.g. loop back or stop) so a failed condition has somewhere to go.`,
      });
    }
  }

  // ── D2: an irreversible/external action with no gate (evaluator/checkpoint/
  //        guardrails) anywhere upstream. Gated to non-trivial graphs to avoid
  //        nagging on a simple "email me" automation. ──
  if (classification.archetype === 'orchestrated' || classification.archetype === 'enterprise' || nodes.length >= 6) {
    const guardIds = new Set(nodes.filter((n) => GUARD_KINDS.has(kindOf(n))).map((n) => n.id));
    if (guardIds.size === 0) {
      const delivery = nodes.find(isDeliveryNode);
      if (delivery) {
        warnings.push({
          code: 'MISSING_DELIVERY_GUARD',
          nodeId: delivery.id,
          message: `${delivery.title}: an external/irreversible action runs with no evaluator or approval checkpoint before it. Add a gate (evaluator for unattended runs, checkpoint for human approval) so a bad result isn't published/sent.`,
        });
      } else {
        // No guard nodes at all in a non-trivial graph is itself worth flagging.
        const anyDelivery = nodes.some(isDeliveryNode);
        if (anyDelivery) {
          warnings.push({ code: 'MISSING_DELIVERY_GUARD', message: 'No evaluator/checkpoint guards any delivery step — add one before external actions.' });
        }
      }
    }
  }

  // ── D3: multiple external fetches and zero failure handling (no evaluator/
  //        guardrails verifying results). A single coarse advisory, not per-node. ──
  const fetchCount = nodes.filter((n) => FETCH_KINDS.has(kindOf(n))).length;
  const hasFailureHandling = nodes.some((n) => GUARD_KINDS.has(kindOf(n)));
  if (fetchCount >= 2 && !hasFailureHandling) {
    warnings.push({
      code: 'NO_FAILURE_HANDLING',
      message:
        `${fetchCount} external fetch/scrape steps have no failure handling. Flaky sources (rate limits, empty responses, bad encodings) will silently become empty input. `
        + 'Add an evaluator to verify each fetched artifact is usable before the workflow depends on it, and a fallback path for the common failure.',
    });
  }

  return { graph: { ...graph, nodes }, warnings, repairs };
}
