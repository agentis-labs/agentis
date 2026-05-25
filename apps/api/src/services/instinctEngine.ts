/**
 * InstinctEngine — Layer 7 §7.2.
 *
 * Runs after every failed run. Detects when the *same node* has failed with the
 * *same root cause* across enough recent runs to be a pattern, records the
 * learning to MEMORY.md (so future agent calls avoid it), and emits an
 * `INSTINCT_PROPOSED` event the operator can act on. This is the mechanism by
 * which the platform gets more reliable the longer it runs (Principle #6) and a
 * concrete instance of the "autonomy is earned" dial (Principle #13).
 *
 * V1 proposes; it does not auto-patch. Auto-apply via `applyGraphPatch` is the
 * Phase-6 follow-up once confidence scoring is calibrated.
 */

import { and, desc, eq } from 'drizzle-orm';
import { REALTIME_EVENTS, REALTIME_ROOMS, type WorkflowGraph, type WorkflowNode, type WorkflowRunState } from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import { validateWorkflowGraph } from '../engine/validateGraph.js';
import type { EventBus } from '../event-bus.js';
import type { Logger } from '../logger.js';
import type { WorkspaceIntelligenceService } from './workspaceIntelligence.js';

export interface InstinctProposal {
  workspaceId: string;
  workflowId: string;
  nodeId: string;
  rootCause: string;
  occurrences: number;
  confidence: number;
  suggestion: string;
}

const DEFAULT_THRESHOLD = 3;     // failures of the same node+cause to call it a pattern
const SCAN_WINDOW = 25;          // recent runs to scan

export class InstinctEngine {
  constructor(
    private readonly db: AgentisSqliteDb,
    private readonly bus: EventBus,
    private readonly intelligence: WorkspaceIntelligenceService,
    private readonly logger?: Logger,
    private readonly threshold = DEFAULT_THRESHOLD,
  ) {}

  /** Called by the engine after a run reaches FAILED. Best-effort; never throws. */
  async onRunFailed(args: { workspaceId: string; workflowId: string | null; runId: string; state: WorkflowRunState }): Promise<InstinctProposal | null> {
    try {
      return await this.#analyze(args);
    } catch (err) {
      this.logger?.warn('instinct.analyze_failed', { runId: args.runId, err: (err as Error).message });
      return null;
    }
  }

  async #analyze(args: { workspaceId: string; workflowId: string | null; runId: string; state: WorkflowRunState }): Promise<InstinctProposal | null> {
    const { workspaceId, workflowId, state } = args;
    if (!workflowId) return null;
    const failedNodeId = state.failedNodeIds?.[0];
    if (!failedNodeId) return null;
    const error = state.nodeStates?.[failedNodeId]?.error ?? '';
    const rootCause = classifyRootCause(error);

    // Count recent runs of this workflow where the same node failed with the same class.
    const recent = this.db
      .select({ id: schema.workflowRuns.id, runState: schema.workflowRuns.runState })
      .from(schema.workflowRuns)
      .where(and(
        eq(schema.workflowRuns.workspaceId, workspaceId),
        eq(schema.workflowRuns.workflowId, workflowId),
        eq(schema.workflowRuns.status, 'FAILED'),
      ))
      .orderBy(desc(schema.workflowRuns.createdAt))
      .limit(SCAN_WINDOW)
      .all();

    let occurrences = 0;
    for (const r of recent) {
      const st = r.runState as unknown as WorkflowRunState | null;
      const nodeErr = st?.nodeStates?.[failedNodeId]?.error;
      if (nodeErr && classifyRootCause(nodeErr) === rootCause) occurrences += 1;
    }
    if (occurrences < this.threshold) return null;

    const confidence = Math.min(0.99, 0.5 + 0.1 * occurrences);
    const suggestion = suggestionFor(rootCause, failedNodeId);
    const proposal: InstinctProposal = { workspaceId, workflowId, nodeId: failedNodeId, rootCause, occurrences, confidence, suggestion };

    // Persist the learning to MEMORY.md so future agent calls carry it.
    const entry = `[${today()}][uses:0][wf:${workflowId.slice(0, 8)}][conf:${confidence.toFixed(2)}] `
      + `Node "${failedNodeId}" repeatedly fails (${rootCause}, ${occurrences}x). ${suggestion}`;
    await this.intelligence.appendMemory(workspaceId, 'Patterns That Failed', entry).catch(() => {});

    this.bus.publish(REALTIME_ROOMS.workspace(workspaceId), REALTIME_EVENTS.INSTINCT_PROPOSED, proposal);
    this.logger?.info('instinct.proposed', { workspaceId, workflowId, nodeId: failedNodeId, rootCause, occurrences });
    return proposal;
  }

  /**
   * Apply an instinct (operator-approved) to the workflow's stored graph so future
   * runs benefit (§7.2 "When approved: the engine patches the workflow graph").
   * Config-only fixes (retry/timeout) mutate the node; `context_too_long` inserts a
   * truncation transform before the node and rewires its inbound edges. Returns
   * whether a patch was applied. Records the fix to MEMORY's effective patterns.
   */
  async applyInstinct(args: { workspaceId: string; workflowId: string; nodeId: string; rootCause: string }): Promise<{ applied: boolean; reason?: string }> {
    const wf = this.db.select().from(schema.workflows)
      .where(and(eq(schema.workflows.id, args.workflowId), eq(schema.workflows.workspaceId, args.workspaceId)))
      .get();
    if (!wf) return { applied: false, reason: 'workflow not found' };
    const graph = wf.graph as unknown as WorkflowGraph;
    const node = graph.nodes.find((n) => n.id === args.nodeId);
    if (!node) return { applied: false, reason: `node ${args.nodeId} not found` };

    let next: WorkflowGraph;
    if (args.rootCause === 'rate_limit' || args.rootCause === 'timeout') {
      next = mutateNodeForReliability(graph, node, args.rootCause);
    } else if (args.rootCause === 'context_too_long') {
      next = insertTruncationBefore(graph, node);
    } else {
      return { applied: false, reason: `no auto-patch for root cause '${args.rootCause}'` };
    }

    try {
      validateWorkflowGraph(next, { currentWorkflowId: args.workflowId });
    } catch (err) {
      return { applied: false, reason: `patch invalid: ${(err as Error).message}` };
    }
    this.db.update(schema.workflows)
      .set({ graph: next as unknown as object, updatedAt: new Date().toISOString() })
      .where(eq(schema.workflows.id, args.workflowId))
      .run();

    await this.intelligence.appendMemory(args.workspaceId, 'Effective Patterns',
      `[${today()}][uses:0][wf:${args.workflowId.slice(0, 8)}][conf:0.80] Auto-patched "${args.nodeId}" for ${args.rootCause} — verify next run.`,
    ).catch(() => {});
    this.logger?.info('instinct.applied', { ...args });
    return { applied: true };
  }
}

/** Add retry/timeout hardening to a node's config (config-only, no edge surgery). */
function mutateNodeForReliability(graph: WorkflowGraph, node: WorkflowNode, rootCause: string): WorkflowGraph {
  return {
    ...graph,
    nodes: graph.nodes.map((n) => {
      if (n.id !== node.id) return n;
      const cfg = { ...(n.config as unknown as Record<string, unknown>) };
      if (cfg.kind === 'http_request') {
        cfg.maxRetries = Math.max(Number(cfg.maxRetries ?? 0), 3);
        cfg.retryOn = Array.isArray(cfg.retryOn) ? cfg.retryOn : [429, 503];
        if (rootCause === 'timeout') cfg.timeoutMs = Math.max(Number(cfg.timeoutMs ?? 0), 60_000);
      } else {
        cfg.retryPolicy = { selfHeal: true, maxSelfHealAttempts: 2 };
      }
      return { ...n, config: cfg as unknown as WorkflowNode['config'] };
    }),
  };
}

/** Insert a truncation transform before `node` and rewire its inbound edges. */
function insertTruncationBefore(graph: WorkflowGraph, node: WorkflowNode): WorkflowGraph {
  const truncId = `instinct_truncate_${node.id}`;
  if (graph.nodes.some((n) => n.id === truncId)) return graph; // already patched
  const truncNode: WorkflowNode = {
    id: truncId,
    type: 'transform',
    title: 'Truncate (instinct)',
    position: { x: Math.max(0, node.position.x - 220), y: node.position.y },
    config: {
      kind: 'transform',
      // Cap any array-valued input field to the top 20 items to avoid context overflow.
      expression: 'Object.fromEntries(Object.entries(input).map(([k, v]) => [k, Array.isArray(v) ? v.slice(0, 20) : v]))',
    },
  };
  const edges = graph.edges.map((e) => (e.target === node.id ? { ...e, target: truncId } : e));
  edges.push({ id: `edge_${truncId}_${node.id}`, source: truncId, target: node.id });
  return { ...graph, nodes: [...graph.nodes, truncNode], edges };
}

/** Bucket an error message into a coarse root-cause class for pattern matching. */
function classifyRootCause(error: string): string {
  const e = error.toLowerCase();
  if (/context|too long|token|18000|exceed/.test(e)) return 'context_too_long';
  if (/rate.?limit|429|403/.test(e)) return 'rate_limit';
  if (/timeout|timed out|etimedout/.test(e)) return 'timeout';
  if (/credential|unauthor|401|auth/.test(e)) return 'auth';
  if (/not found|404|missing/.test(e)) return 'not_found';
  if (/parse|json|invalid/.test(e)) return 'parse_error';
  return 'generic_failure';
}

function suggestionFor(rootCause: string, nodeId: string): string {
  switch (rootCause) {
    case 'context_too_long': return `Add a Transform before "${nodeId}" to truncate the input (e.g. top 20 items).`;
    case 'rate_limit': return `Add retry + backoff (3 attempts, 2s initial) to "${nodeId}".`;
    case 'timeout': return `Raise the timeout on "${nodeId}" or split its work into smaller steps.`;
    case 'auth': return `Check the credential bound to "${nodeId}" — it may be missing or expired.`;
    case 'parse_error': return `Add an evaluator/guardrails gate after "${nodeId}" to enforce output shape.`;
    default: return `Review "${nodeId}" — it has failed repeatedly with the same root cause.`;
  }
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}
