/**
 * ORGAN 3 (UNBREAKABLE-WORKFLOW) + AGENT-PRIMARY POSTURE M1 — the Atomic
 * Evolution core.
 *
 * When an agent (or the operator) proposes a change to a LIVE run's graph, the
 * change must pass the same contracts that guard authoring: it may not introduce
 * a data-coupling break (Organ 1), gut a load-bearing capability (Organ 2), or
 * lower the graph below the green it already had (the monotonic ratchet). This
 * module is the PURE decision — no DB, no commit — so the engine can evaluate a
 * proposed graph against its base and either commit (via the proven
 * `applyGraphPatch`) or hand the agent named regressions to fix and re-propose.
 *
 * The thesis of AGENT-PRIMARY-POSTURE: the contracts are the agent's STEERING,
 * not a cage. A rejection is a typed instruction, not a dead end.
 */

import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { WorkflowGraph, WorkflowNode } from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import { analyzeEdgeCouplings } from '../engine/validateExpressions.js';
import { checkIntentIntegrity, type IntentManifest } from './intentContract.js';

/**
 * Who may commit a graph evolution on a run.
 * - `operator`         — deterministic mode; the agent cannot self-evolve, an
 *   evolution becomes an operator decision (today's posture, kept for audited
 *   pipelines).
 * - `agent_within_green` — the agent commits freely AS LONG AS the green ratchet
 *   holds (no new contract error) and budget permits. The recommended default
 *   for agent-primary Apps.
 * - `agent`            — full autonomy within budget; the ratchet still holds
 *   (we never let an evolution silently corrupt the graph).
 */
export type EvolutionAuthority = 'operator' | 'agent_within_green' | 'agent';

export interface EvolutionRegression {
  code: 'COUPLING_BREAK' | 'CAPABILITY_REMOVED' | 'AUTO_APPROVAL_BYPASS' | 'STRUCTURAL' | 'IMMUTABLE_NODE';
  nodeId?: string;
  message: string;
}

/** The pure verdict: commit-worthy (with non-blocking warnings) or rejected with named regressions. */
export type EvolutionDecision =
  | { ok: true; warnings: string[] }
  | { ok: false; regressions: EvolutionRegression[] };

/** The result the engine returns to the agent tool (or the operator route). */
export type EvolveResult =
  | { committed: true; newRevision: number; contractSummary: string; warnings: string[] }
  | { committed: false; rejected: 'regression' | 'authority' | 'conflict' | 'invalid'; regressions: EvolutionRegression[] };

// ── Contract-error identity: a node+code+identifier tuple, so we can diff the
//    errors on the base graph against the merged graph (the ratchet). An error
//    present on the base is pre-existing (not a regression); a NEW error is. ──

function couplingErrorKeys(graph: WorkflowGraph): Set<string> {
  const keys = new Set<string>();
  for (const issue of analyzeEdgeCouplings(graph)) {
    if (issue.severity !== 'error') continue;
    keys.add(`${issue.nodeId}|${issue.code}|${issue.identifier ?? issue.field}`);
  }
  return keys;
}

/**
 * Evaluate a proposed `merged` graph against its `base` under the green ratchet.
 * PURE — takes both fully-formed graphs (the engine merges the patch first).
 *
 * Rules:
 *  - A coupling error present on `merged` but NOT on `base` is a regression
 *    (the agent's edit broke a data coupling). Pre-existing errors are allowed
 *    to persist — the ratchet is monotonic ("never make it worse"), not "must
 *    already be perfect", so incremental progress on a red graph is not blocked.
 *  - An approval-integrity violation (`|| true` before an irreversible action)
 *    is ALWAYS a hard regression, never allowed in.
 *  - A dropped capability (agent worker / external fetch / integration /
 *    persistence) vs the stored intent manifest is a WARNING surfaced to the
 *    agent — visible, not blocking (gutting is loud, but a genuine intent change
 *    is legitimate). Escalating this to a hard block is the acknowledge-ratchet
 *    follow-up.
 */
export function evaluateEvolution(
  base: WorkflowGraph,
  merged: WorkflowGraph,
  priorManifest?: IntentManifest | null,
): EvolutionDecision {
  const regressions: EvolutionRegression[] = [];
  const warnings: string[] = [];

  // Organ 1 — coupling ratchet: only NEW breaks are regressions.
  const baseErrors = couplingErrorKeys(base);
  for (const issue of analyzeEdgeCouplings(merged)) {
    if (issue.severity !== 'error') continue;
    const key = `${issue.nodeId}|${issue.code}|${issue.identifier ?? issue.field}`;
    if (baseErrors.has(key)) continue; // pre-existing, not caused by this edit
    regressions.push({ code: 'COUPLING_BREAK', nodeId: issue.nodeId, message: issue.message });
  }

  // Organ 2 — intent integrity. Approval-bypass = hard error; capability drop = warning.
  for (const v of checkIntentIntegrity(merged, priorManifest)) {
    if (v.code === 'AUTO_APPROVAL_BYPASS') {
      regressions.push({ code: 'AUTO_APPROVAL_BYPASS', nodeId: v.nodeId, message: v.message });
    } else if (v.code === 'CAPABILITY_REMOVED') {
      warnings.push(v.message);
    }
  }

  return regressions.length > 0 ? { ok: false, regressions } : { ok: true, warnings };
}

// ── Outward / irreversible action detection (mirrors workflowRobustnessAudit's
//    conservative classifier: an integration, or an HTTP write). A new outward
//    node is the one evolution that must not auto-commit under `agent_within_green`
//    — it goes to the operator (or full-autonomy `agent`). ──────────────────────

const OUTWARD_KINDS = new Set(['integration']);
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function isOutwardNode(node: WorkflowNode): boolean {
  const cfg = node.config as { kind?: string; method?: unknown } | undefined;
  const kind = String(cfg?.kind ?? node.type ?? '');
  if (OUTWARD_KINDS.has(kind)) return true;
  return kind === 'http_request' && typeof cfg?.method === 'string' && WRITE_METHODS.has(cfg.method.toUpperCase());
}

/** The first outward node in a list, or null — used to gate agent_within_green evolutions. */
export function firstOutwardNode(nodes: WorkflowNode[]): WorkflowNode | null {
  return nodes.find(isOutwardNode) ?? null;
}

/** A compact, typed contract summary of a graph — the "global tier" the agent reasons over (Organ 5). */
export function summarizeContract(graph: WorkflowGraph): string {
  const nodes = graph.nodes
    .map((n) => {
      const kind = String((n.config as { kind?: string } | undefined)?.kind ?? n.type ?? '');
      const outKeys = Array.isArray((n.config as { outputKeys?: unknown }).outputKeys)
        ? ((n.config as { outputKeys?: string[] }).outputKeys ?? [])
        : [];
      return `${n.id}:${kind}${outKeys.length ? `→{${outKeys.join(',')}}` : ''}`;
    })
    .join('  ');
  const edges = graph.edges.map((e) => `${e.source}→${e.target}`).join(' ');
  return `nodes[${graph.nodes.length}]: ${nodes}\nedges[${graph.edges.length}]: ${edges}`;
}

// ── Authority resolution: per-workflow override → workspace default. ──────────

export interface EvolutionConfig {
  /** Workspace default authority for runs that don't pin their own. */
  defaultAuthority: EvolutionAuthority;
}

export const DEFAULT_EVOLUTION: EvolutionConfig = {
  // Deterministic-default is expressed per-App (a workflow that opts into
  // agent-primary pins its own authority). The WORKSPACE default, once a
  // workflow is agent-primary, is the guarded mode.
  defaultAuthority: 'agent_within_green',
};

const KV_KEY = 'evolution.config';

export function getEvolutionConfig(db: AgentisSqliteDb, workspaceId: string): EvolutionConfig {
  try {
    const row = db
      .select({ value: schema.workspaceKv.value })
      .from(schema.workspaceKv)
      .where(and(eq(schema.workspaceKv.workspaceId, workspaceId), eq(schema.workspaceKv.key, KV_KEY)))
      .get();
    const v = row?.value as Partial<EvolutionConfig> | undefined;
    return { defaultAuthority: normalizeAuthority(v?.defaultAuthority) ?? DEFAULT_EVOLUTION.defaultAuthority };
  } catch {
    return { ...DEFAULT_EVOLUTION };
  }
}

export function setEvolutionConfig(db: AgentisSqliteDb, workspaceId: string, patch: Partial<EvolutionConfig>): EvolutionConfig {
  const current = getEvolutionConfig(db, workspaceId);
  const next: EvolutionConfig = {
    defaultAuthority: normalizeAuthority(patch.defaultAuthority) ?? current.defaultAuthority,
  };
  const now = new Date().toISOString();
  const existing = db
    .select({ id: schema.workspaceKv.id })
    .from(schema.workspaceKv)
    .where(and(eq(schema.workspaceKv.workspaceId, workspaceId), eq(schema.workspaceKv.key, KV_KEY)))
    .get();
  if (existing) {
    db.update(schema.workspaceKv).set({ value: next, updatedAt: now }).where(eq(schema.workspaceKv.id, existing.id)).run();
  } else {
    db.insert(schema.workspaceKv).values({ id: randomUUID(), workspaceId, key: KV_KEY, value: next, createdAt: now, updatedAt: now }).run();
  }
  return next;
}

export function normalizeAuthority(v: unknown): EvolutionAuthority | undefined {
  return v === 'operator' || v === 'agent_within_green' || v === 'agent' ? v : undefined;
}

/** A workflow's run mode. `deterministic` = frozen graph (operator authority); `agent_primary` = the agent owns the plan. */
export type ExecutionMode = 'deterministic' | 'agent_primary';

export function normalizeExecutionMode(v: unknown): ExecutionMode | undefined {
  return v === 'deterministic' || v === 'agent_primary' ? v : undefined;
}

/**
 * Resolve the effective authority for a run. Precedence:
 *  1. an explicit per-workflow `evolutionAuthority` pin (most specific),
 *  2. the `executionMode` sugar (`deterministic` → operator; `agent_primary` →
 *     the workspace default authority),
 *  3. the workspace default.
 */
export function resolveEvolutionAuthority(
  db: AgentisSqliteDb,
  workspaceId: string,
  settings: { evolutionAuthority?: unknown; executionMode?: unknown } | unknown,
): EvolutionAuthority {
  const s = (settings && typeof settings === 'object' ? settings : { evolutionAuthority: settings }) as {
    evolutionAuthority?: unknown; executionMode?: unknown;
  };
  const pinned = normalizeAuthority(s.evolutionAuthority);
  if (pinned) return pinned;
  if (normalizeExecutionMode(s.executionMode) === 'deterministic') return 'operator';
  return getEvolutionConfig(db, workspaceId).defaultAuthority;
}
