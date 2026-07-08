/**
 * workflowBlueprint — the BLESSED-graph law (BRAIN-BLUEPRINT-10X).
 *
 * The operator's disaster: a workflow was fixed and production-proven; one run
 * then failed because of a BAD MODEL; self-heal "repaired" the graph and broke
 * the proven structure. Root causes, in code:
 *   1. Self-heal never consulted the proven state (`buildLoop.hardened` /
 *      accomplished production runs) before structural surgery.
 *   2. Nothing classified the failure: a runtime-class error (model down,
 *      quota, auth, spawn) cannot be fixed by ANY graph edit, so reaching for
 *      one is always vandalism.
 *   3. There was no way back: the blessed graph existed only implicitly in an
 *      old run's `graphSnapshot`.
 *
 * This module gives the engine + tools the three missing pieces:
 *   - `classifyRuntimeFailure(error)` — deterministic "this is a runtime/model
 *     problem, not a graph problem" detection.
 *   - `selfHealGuardDecision(...)`   — the pure law self-heal consults BEFORE
 *     planning: runtime-class failures never get graph surgery; a graph whose
 *     hash is blessed (blueprint or hardened) is never autonomously
 *     restructured.
 *   - `findBlessedGraph(db, ...)`    — resolve the blessed bytes (blueprint
 *     stamp → that run's graphSnapshot; fallback: newest ACCOMPLISHED run) so
 *     `agentis.workflow.restore_blueprint` can roll a mangled workflow back.
 */

import { and, desc, eq } from 'drizzle-orm';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { WorkflowGraph, WorkflowRunState } from '@agentis/core';
import { graphContentHash, readBuildLoop } from './workflowCompass.js';

// ── failure classification ───────────────────────────────────────────────────

/**
 * Deterministic runtime-class failure detection. Returns a short human reason
 * when the error is a MODEL/RUNTIME/CREDENTIAL/QUOTA problem — the class no
 * graph edit can fix — or null when it may genuinely be a graph/data fault.
 * Patterns are substrings/regexes over real errors seen in ledgers; keep them
 * conservative: a false null (graph path) is recoverable by the blueprint
 * guard, a false positive would suppress a legitimate structural repair.
 */
export function classifyRuntimeFailure(error: string): string | null {
  const text = (error ?? '').slice(0, 2000);
  const rules: Array<{ re: RegExp; reason: string }> = [
    { re: /model.{0,40}(not.{0,3}found|does not exist|unknown|unavailable|invalid|unsupported)/i, reason: 'the selected model does not exist or is unavailable' },
    { re: /(overloaded|capacity|529|503|service unavailable)/i, reason: 'the model provider is overloaded/unavailable' },
    { re: /(rate.?limit|too many requests|429)/i, reason: 'provider rate limit' },
    { re: /(quota|billing|payment|insufficient credit|credit balance)/i, reason: 'provider quota/billing' },
    { re: /(401|403|unauthorized|forbidden|invalid.{0,10}(api.?key|token)|authentication|credential)/i, reason: 'authentication/credential failure' },
    { re: /(context.{0,10}(length|window)|maximum.{0,10}tokens|prompt is too long)/i, reason: 'model context-length exceeded' },
    { re: /spawn .{0,200}(ENOENT|EACCES)/i, reason: 'the agent runtime binary failed to spawn' },
    { re: /\b(ENOENT|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up)\b/, reason: 'runtime/network failure' },
    { re: /(timed? ?out|deadline exceeded)/i, reason: 'runtime timeout' },
    { re: /runtime.{0,40}(unavailable|not responding|health check)/i, reason: 'the agent runtime is unavailable' },
    { re: /(no (evaluator|chat-capable|runtime)|adapter (offline|unregistered)|gateway.{0,20}(closed|offline))/i, reason: 'no live runtime/adapter for the agent' },
  ];
  for (const rule of rules) {
    if (rule.re.test(text)) return rule.reason;
  }
  return null;
}

// ── the guard law ────────────────────────────────────────────────────────────

export type SelfHealGuardDecision =
  /** Proceed to the normal heal ladder (may propose structural repair). */
  | { allow: true }
  /** Do NOT structurally heal; the honest reason to surface + suggested next step. */
  | { allow: false; class: 'runtime' | 'blueprint_protected'; reason: string };

/**
 * The law self-heal consults before ANY model-driven planning:
 *   1. A runtime-class failure never gets graph surgery — the graph is not the
 *      problem. Surface the runtime reason; retry/reroute/fix credentials.
 *   2. A graph whose current hash is BLESSED (blueprint and/or hardened stamp)
 *      is never autonomously restructured — it is production-proven. The
 *      operator (or a deliberate patch) may change it; an automatic repair
 *      reacting to one failed run may not.
 */
export function selfHealGuardDecision(args: {
  error: string;
  currentGraphHash: string;
  blueprintHash?: string | null;
  hardenedHash?: string | null;
}): SelfHealGuardDecision {
  const runtimeReason = classifyRuntimeFailure(args.error);
  if (runtimeReason) {
    return {
      allow: false,
      class: 'runtime',
      reason: `This failure is runtime-class (${runtimeReason}) — no graph edit can fix it, so the workflow graph was left untouched. Fix the model/runtime/credential (or retry), and re-run.`,
    };
  }
  const blessed = (args.blueprintHash && args.blueprintHash === args.currentGraphHash)
    || (args.hardenedHash && args.hardenedHash === args.currentGraphHash);
  if (blessed) {
    return {
      allow: false,
      class: 'blueprint_protected',
      reason:
        'This graph is production-proven (blessed blueprint) — autonomous structural repair is blocked so one bad run cannot vandalize a working workflow. '
        + 'Diagnose the run (agentis.run.diagnose); if the graph truly needs a change, patch it deliberately (agentis.build_workflow with patchDraft), '
        + 'and if a previous repair already mangled it, roll back with agentis.workflow.restore_blueprint.',
    };
  }
  return { allow: true };
}

// ── blessed-graph resolution ─────────────────────────────────────────────────

export interface BlessedGraph {
  graph: WorkflowGraph;
  graphHash: string;
  runId: string;
  /** Where the blessed bytes came from. */
  source: 'blueprint_stamp' | 'latest_accomplished_run' | 'explicit_run';
}

/**
 * Resolve the blessed graph bytes for a workflow: the graphSnapshot of the run
 * the blueprint stamp points at, else the newest run whose verdict was
 * ACCOMPLISHED. Returns null when the workflow has never accomplished.
 */
export function findBlessedGraph(db: AgentisSqliteDb, workspaceId: string, workflowId: string): BlessedGraph | null {
  const wf = db
    .select({ settings: schema.workflows.settings })
    .from(schema.workflows)
    .where(and(eq(schema.workflows.id, workflowId), eq(schema.workflows.workspaceId, workspaceId)))
    .get();
  if (!wf) return null;
  const blueprint = readBuildLoop(wf.settings).blueprint;

  // 1) The stamped run — exact provenance.
  if (blueprint?.runId) {
    const run = db
      .select({ id: schema.workflowRuns.id, graphSnapshot: schema.workflowRuns.graphSnapshot })
      .from(schema.workflowRuns)
      .where(and(eq(schema.workflowRuns.id, blueprint.runId), eq(schema.workflowRuns.workspaceId, workspaceId)))
      .get();
    const graph = (run?.graphSnapshot ?? null) as WorkflowGraph | null;
    if (graph && Array.isArray(graph.nodes) && graph.nodes.length > 0) {
      return { graph, graphHash: graphContentHash(graph), runId: run!.id, source: 'blueprint_stamp' };
    }
  }

  // 2) Fallback — newest run with an ACCOMPLISHED verdict and a usable snapshot.
  const rows = db
    .select({ id: schema.workflowRuns.id, runState: schema.workflowRuns.runState, graphSnapshot: schema.workflowRuns.graphSnapshot })
    .from(schema.workflowRuns)
    .where(and(eq(schema.workflowRuns.workflowId, workflowId), eq(schema.workflowRuns.workspaceId, workspaceId)))
    .orderBy(desc(schema.workflowRuns.createdAt))
    .limit(100)
    .all();
  for (const row of rows) {
    const verdict = (row.runState as (WorkflowRunState & { verdict?: { outcome?: string } }) | null)?.verdict;
    if (verdict?.outcome !== 'accomplished') continue;
    const graph = (row.graphSnapshot ?? null) as WorkflowGraph | null;
    if (graph && Array.isArray(graph.nodes) && graph.nodes.length > 0) {
      return { graph, graphHash: graphContentHash(graph), runId: row.id, source: 'latest_accomplished_run' };
    }
  }
  return null;
}
