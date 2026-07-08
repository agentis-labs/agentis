/**
 * Run analytics aggregator (§7.1) — the shared engine behind both
 * `GET /v1/workflows/:id/analytics` and `GET /v1/apps/:id/analytics`.
 *
 * Aggregates run history + the audit trail into the signal operators actually
 * want: run counts, success rate, average duration, real **token consumption**,
 * cost, and the per-node failure breakdown. Tokens AND cost are read from a
 * single sink — the terminal `node.completed` audit entry (`tokens_in/out`,
 * `cost_cents`) written by every agent execution path — so the numbers reflect
 * real work regardless of which runtime ran the node.
 *
 * `metered` is true only when real $ cost was recorded; most runtimes here are
 * subscription CLI harnesses where dollar cost is genuinely $0, so callers show
 * tokens as the headline and omit a misleading "$0.000".
 */

import { and, desc, eq, inArray } from 'drizzle-orm';
import type { WorkflowGraph, WorkflowRunState } from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import { collectFailedNodeIds } from './runStateFailures.js';

const SCAN = 200; // recent runs to aggregate, per workflow

/** A workflow to include in the aggregate, with its graph for node-title mapping. */
export interface AnalyticsWorkflow {
  id: string;
  title: string;
  graph: WorkflowGraph;
}

export interface RunAnalyticsNodeFailure {
  nodeId: string;
  title: string;
  failures: number;
  sampleError: string;
}

export interface PerWorkflowAnalytics {
  workflowId: string;
  title: string;
  runs: number;
  successRate: number | null;
  totalTokens: number;
  totalCostCents: number;
}

/** Token spend attributed to one agent (or the agentless System/evaluation bucket). */
export interface PerAgentAnalytics {
  /** The real agent id, or null for system/evaluation spend (dedicated judge model). */
  agentId: string | null;
  name: string;
  tokensIn: number;
  tokensOut: number;
  totalTokens: number;
}

export interface RunAnalytics {
  runs: number;
  byStatus: Record<string, number>;
  successRate: number | null;
  avgDurationMs: number | null;
  avgCostCents: number;
  totalCostCents: number;
  /** Whether real $ cost was recorded (false for subscription runtimes). */
  metered: boolean;
  totalTokensIn: number;
  totalTokensOut: number;
  totalTokens: number;
  avgTokensPerRun: number;
  nodeFailures: RunAnalyticsNodeFailure[];
  /** Per-workflow rollup — single entry for a workflow view, many for an app. */
  perWorkflow: PerWorkflowAnalytics[];
  /** Token spend attributed per agent (+ a System bucket for agentless judge spend). */
  perAgent: PerAgentAnalytics[];
}

/**
 * Aggregate analytics across one or more workflows. Pass a single workflow for
 * the per-workflow monitor; pass every workflow an app owns for the app rollup.
 */
export function aggregateRunAnalytics(
  db: AgentisSqliteDb,
  workspaceId: string,
  workflows: AnalyticsWorkflow[],
): RunAnalytics {
  const nodeTitle = new Map<string, string>();
  for (const wf of workflows) {
    for (const node of wf.graph.nodes ?? []) nodeTitle.set(node.id, node.title ?? node.id);
  }

  // Recent runs across all workflows; remember which workflow each run belongs to.
  const runWorkflow = new Map<string, string>();
  const byStatus: Record<string, number> = {};
  const nodeFailures = new Map<string, { count: number; sample: string }>();
  const perWf = new Map<string, { runs: number; succeeded: number; terminal: number; tokens: number; cost: number }>();
  let durSum = 0;
  let durN = 0;
  let totalRuns = 0;

  for (const wf of workflows) {
    perWf.set(wf.id, { runs: 0, succeeded: 0, terminal: 0, tokens: 0, cost: 0 });
    const runs = db.select().from(schema.workflowRuns)
      .where(and(eq(schema.workflowRuns.workflowId, wf.id), eq(schema.workflowRuns.workspaceId, workspaceId)))
      .orderBy(desc(schema.workflowRuns.createdAt))
      .limit(SCAN)
      .all();
    totalRuns += runs.length;
    const bucket = perWf.get(wf.id)!;
    bucket.runs = runs.length;
    for (const r of runs) {
      runWorkflow.set(r.id, wf.id);
      byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
      if (isTerminal(r.status)) {
        bucket.terminal += 1;
        if (isSuccess(r.status)) bucket.succeeded += 1;
      }
      if (r.startedAt && r.completedAt) {
        const d = new Date(r.completedAt).getTime() - new Date(r.startedAt).getTime();
        if (Number.isFinite(d) && d >= 0) { durSum += d; durN += 1; }
      }
      if (r.status === 'FAILED' || r.status === 'COMPLETED_WITH_ERRORS') {
        const st = r.runState as unknown as WorkflowRunState | null;
        for (const nid of collectFailedNodeIds(st)) {
          const prev = nodeFailures.get(nid) ?? { count: 0, sample: '' };
          prev.count += 1;
          if (!prev.sample) prev.sample = String(st?.nodeStates?.[nid]?.error ?? '').slice(0, 160);
          nodeFailures.set(nid, prev);
        }
      }
    }
  }

  // Tokens + cost from the audit sink, bucketed back to each run's workflow AND
  // to the agent that spent them (agent_id on the terminal node.completed entry).
  let costSum = 0;
  let totalTokensIn = 0;
  let totalTokensOut = 0;
  const perAgentAcc = new Map<string | null, { tokensIn: number; tokensOut: number }>();
  const runIds = [...runWorkflow.keys()];
  if (runIds.length > 0) {
    const audit = db.select({
      runId: schema.auditEntries.runId,
      agentId: schema.auditEntries.agentId,
      costCents: schema.auditEntries.costCents,
      tokensIn: schema.auditEntries.tokensIn,
      tokensOut: schema.auditEntries.tokensOut,
    })
      .from(schema.auditEntries)
      .where(and(eq(schema.auditEntries.workspaceId, workspaceId), inArray(schema.auditEntries.runId, runIds)))
      .all();
    for (const a of audit) {
      const cost = a.costCents ?? 0;
      const tIn = a.tokensIn ?? 0;
      const tOut = a.tokensOut ?? 0;
      const tokens = tIn + tOut;
      costSum += cost;
      totalTokensIn += tIn;
      totalTokensOut += tOut;
      const wfId = runWorkflow.get(a.runId);
      const bucket = wfId ? perWf.get(wfId) : undefined;
      if (bucket) { bucket.cost += cost; bucket.tokens += tokens; }
      // Attribute token spend to its agent (null = System/evaluation bucket).
      if (tokens > 0) {
        const key = a.agentId ?? null;
        const acc = perAgentAcc.get(key) ?? { tokensIn: 0, tokensOut: 0 };
        acc.tokensIn += tIn;
        acc.tokensOut += tOut;
        perAgentAcc.set(key, acc);
      }
    }
  }

  // Resolve agent display names for the per-agent rollup in one query.
  const agentIds = [...perAgentAcc.keys()].filter((k): k is string => k != null);
  const agentName = new Map<string, string>();
  if (agentIds.length > 0) {
    for (const row of db.select({ id: schema.agents.id, name: schema.agents.name })
      .from(schema.agents)
      .where(and(eq(schema.agents.workspaceId, workspaceId), inArray(schema.agents.id, agentIds)))
      .all()) {
      agentName.set(row.id, row.name);
    }
  }
  const perAgent: PerAgentAnalytics[] = [...perAgentAcc.entries()]
    .map(([agentId, v]) => ({
      agentId,
      name: agentId ? (agentName.get(agentId) ?? 'Unknown agent') : 'System · evaluation',
      tokensIn: v.tokensIn,
      tokensOut: v.tokensOut,
      totalTokens: v.tokensIn + v.tokensOut,
    }))
    .sort((a, b) => b.totalTokens - a.totalTokens);

  const totalTokens = totalTokensIn + totalTokensOut;
  const terminal = [...perWf.values()].reduce((sum, b) => sum + b.terminal, 0);
  const succeeded = [...perWf.values()].reduce((sum, b) => sum + b.succeeded, 0);

  const perWorkflow: PerWorkflowAnalytics[] = workflows.map((wf) => {
    const b = perWf.get(wf.id)!;
    return {
      workflowId: wf.id,
      title: wf.title,
      runs: b.runs,
      successRate: b.terminal > 0 ? Number((b.succeeded / b.terminal).toFixed(3)) : null,
      totalTokens: b.tokens,
      totalCostCents: b.cost,
    };
  }).sort((a, b) => b.totalTokens - a.totalTokens);

  return {
    runs: totalRuns,
    byStatus,
    successRate: terminal > 0 ? Number((succeeded / terminal).toFixed(3)) : null,
    avgDurationMs: durN > 0 ? Math.round(durSum / durN) : null,
    avgCostCents: totalRuns > 0 ? Number((costSum / totalRuns).toFixed(2)) : 0,
    totalCostCents: costSum,
    metered: costSum > 0,
    totalTokensIn,
    totalTokensOut,
    totalTokens,
    avgTokensPerRun: totalRuns > 0 ? Math.round(totalTokens / totalRuns) : 0,
    nodeFailures: [...nodeFailures.entries()]
      .map(([nodeId, v]) => ({ nodeId, title: nodeTitle.get(nodeId) ?? nodeId, failures: v.count, sampleError: v.sample }))
      .sort((a, b) => b.failures - a.failures),
    perWorkflow,
    perAgent,
  };
}

// COMPLETED_WITH_ERRORS is terminal but NOT a success (a node errored).
function isTerminal(status: string): boolean {
  return status === 'COMPLETED' || status === 'COMPLETED_WITH_CONTRACT_VIOLATION'
    || status === 'COMPLETED_WITH_ERRORS' || status === 'FAILED' || status === 'CANCELLED';
}

function isSuccess(status: string): boolean {
  return status === 'COMPLETED' || status === 'COMPLETED_WITH_CONTRACT_VIOLATION';
}
