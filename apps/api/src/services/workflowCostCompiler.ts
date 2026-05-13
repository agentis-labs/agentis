/**
 * workflowCostCompiler — AGENT-FIRST-ARCHITECTURE.md Plane 4.
 *
 * Pre-run optimizer that classifies every node and computes an estimated
 * spend envelope. Exposes the saved-spend metric that distinguishes
 * deterministic-first execution from naive LLM-mediated orchestration.
 *
 * Cost classes:
 *   deterministic   — skill_task, scratchpad, router (rule-based), merge,
 *                     trigger, subflow, checkpoint
 *   cheap_model     — agent_task with modelClass=small or costTier=cheap
 *   expensive_model — agent_task with modelClass=large/medium or default
 *   unknown         — agent_task with no class hint
 *
 * Saved spend = naive_baseline_cost - estimated_max_cost
 *
 * The compiler is intentionally conservative: estimates are upper bounds,
 * naive baselines apply realistic multipliers. Output is annotation, not
 * truth — the runtime tracks actual spend separately.
 *
 * Spec: docs/AGENT-FIRST-ARCHITECTURE.md §11.5, §15.4.
 */

import type {
  AgentTaskNodeConfig,
  GraphCostShape,
  NodeCostAnnotation,
  NodeCostClass,
  WorkflowGraph,
  WorkflowNode,
} from '@agentis/core';

/** Cost model — calibrated to be conservative; tune from real telemetry over time. */
const COST_MODEL = {
  // Per-call cost in cents.
  deterministic: { min: 0, max: 0 },
  cheap_model: { min: 1, max: 5 },        // small model, ~1k tokens
  expensive_model: { min: 10, max: 60 },  // large model, multi-turn
  unknown: { min: 5, max: 30 },           // assume mid-tier
  // Naive multipliers — what a comparable run would cost without
  // deterministic orchestration. Numbers reflect typical LLM-routed
  // orchestration overhead.
  naiveOrchestrationMultiplier: 2.5,
  naiveRetryMultiplier: 1.5,
} as const;

export class WorkflowCostCompiler {
  /**
   * Classify each node and produce a graph-level cost envelope.
   * Pure function — no side effects, no DB access.
   */
  compile(graph: WorkflowGraph): GraphCostShape {
    const nodes: NodeCostAnnotation[] = [];
    const warnings: string[] = [];
    let minTotal = 0;
    let maxTotal = 0;
    let agentTaskCount = 0;
    let expensiveCount = 0;

    for (const node of graph.nodes) {
      const annotation = this.#classify(node);
      nodes.push(annotation);
      minTotal += annotation.estimatedCostCentsMin;
      maxTotal += annotation.estimatedCostCentsMax;
      if (node.config.kind === 'agent_task') agentTaskCount += 1;
      if (annotation.costClass === 'expensive_model') expensiveCount += 1;
    }

    // Naive baseline: every agent_task in a naive harness costs more (because
    // the model is orchestrating itself). Plus retry overhead since naive
    // harnesses typically retry from the root rather than from the failed
    // node.
    const naiveAgentCost =
      agentTaskCount === 0
        ? 0
        : agentTaskCount *
          ((COST_MODEL.expensive_model.min + COST_MODEL.expensive_model.max) / 2) *
          COST_MODEL.naiveOrchestrationMultiplier *
          COST_MODEL.naiveRetryMultiplier;
    // Plus overhead for routing/merging — these are deterministic in Agentis,
    // but a naive harness pays an LLM call per route decision.
    const routeNodes = graph.nodes.filter(
      (n) => n.config.kind === 'router' || n.config.kind === 'merge',
    ).length;
    const naiveRouteCost =
      routeNodes *
      ((COST_MODEL.cheap_model.min + COST_MODEL.cheap_model.max) / 2);
    const naiveBaselineCents = Math.round(naiveAgentCost + naiveRouteCost);

    const estimatedSavedCents = Math.max(0, naiveBaselineCents - maxTotal);

    if (expensiveCount > 0 && agentTaskCount > 3) {
      warnings.push(
        `Graph contains ${agentTaskCount} agent_task nodes; consider model-tier downgrade for routing-style tasks.`,
      );
    }
    if (graph.nodes.length > 0 && agentTaskCount / graph.nodes.length > 0.6) {
      warnings.push('More than 60% of nodes are agent_task — consider deterministic alternatives where possible.');
    }

    return {
      graphRevision: graph.version ?? 1,
      nodes,
      estimatedTotalCentsMin: minTotal,
      estimatedTotalCentsMax: maxTotal,
      naiveBaselineCents,
      estimatedSavedCents,
      warnings,
    };
  }

  // ── classification ───────────────────────────────────────

  #classify(node: WorkflowNode): NodeCostAnnotation {
    const kind = node.config.kind;
    if (kind === 'agent_task') {
      const cfg = node.config as AgentTaskNodeConfig & {
        runtimePolicy?: { modelClass?: 'small' | 'medium' | 'large'; costTier?: string };
      };
      const modelClass = cfg.runtimePolicy?.modelClass;
      const costTier = cfg.runtimePolicy?.costTier;
      let costClass: NodeCostClass = 'unknown';
      let rationale = 'no model-class hint; assuming mid-tier';
      if (modelClass === 'small' || costTier === 'cheap') {
        costClass = 'cheap_model';
        rationale = `agent_task with ${modelClass ?? costTier} tier`;
      } else if (modelClass === 'large' || costTier === 'power') {
        costClass = 'expensive_model';
        rationale = `agent_task with ${modelClass ?? costTier} tier`;
      } else if (modelClass === 'medium' || costTier === 'balanced') {
        costClass = 'expensive_model';
        rationale = `agent_task with ${modelClass ?? costTier} tier`;
      }
      const range = COST_MODEL[costClass];
      return {
        nodeId: node.id,
        costClass,
        estimatedCostCentsMin: range.min,
        estimatedCostCentsMax: range.max,
        rationale,
      };
    }
    // Everything non-agent is deterministic in Agentis' execution model.
    return {
      nodeId: node.id,
      costClass: 'deterministic',
      estimatedCostCentsMin: 0,
      estimatedCostCentsMax: 0,
      rationale: `node kind '${kind}' is deterministic`,
    };
  }
}
