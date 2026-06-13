/**
 * Workspace analytics (§7.1) — `GET /v1/workflows/:id/analytics`.
 *
 * Aggregates run history + the audit trail into the per-workflow signal operators
 * actually want: run counts, success rate, average duration + cost, and the
 * per-node failure breakdown that feeds optimization suggestions. Mounted at
 * `/v1/workflows`.
 */

import { Hono } from 'hono';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { AgentisError, type WorkflowGraph, type WorkflowRunState } from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { AuthService } from '../services/auth.js';
import { requireAuth } from '../middleware/auth.js';
import { getWorkspace, requireWorkspace } from '../middleware/workspace.js';
import { collectFailedNodeIds } from '../services/runStateFailures.js';

const SCAN = 200; // recent runs to aggregate

export function buildAnalyticsRoutes(deps: { db: AgentisSqliteDb; auth: AuthService }) {
  const app = new Hono();
  app.use('*', requireAuth(deps), requireWorkspace(deps));

  app.get('/:id/analytics', (c) => {
    const ws = getWorkspace(c);
    const id = c.req.param('id');
    const wf = deps.db.select().from(schema.workflows)
      .where(and(eq(schema.workflows.id, id), eq(schema.workflows.workspaceId, ws.workspaceId))).get();
    if (!wf) throw new AgentisError('RESOURCE_NOT_FOUND', `Workflow ${id} not found`);

    const runs = deps.db.select().from(schema.workflowRuns)
      .where(and(eq(schema.workflowRuns.workflowId, id), eq(schema.workflowRuns.workspaceId, ws.workspaceId)))
      .orderBy(desc(schema.workflowRuns.createdAt))
      .limit(SCAN)
      .all();

    const byStatus: Record<string, number> = {};
    let durSum = 0; let durN = 0;
    const nodeFailures = new Map<string, { count: number; sample: string }>();
    for (const r of runs) {
      byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
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

    const terminal = (byStatus.COMPLETED ?? 0) + (byStatus.COMPLETED_WITH_CONTRACT_VIOLATION ?? 0)
      + (byStatus.COMPLETED_WITH_ERRORS ?? 0) + (byStatus.FAILED ?? 0) + (byStatus.CANCELLED ?? 0);
    // COMPLETED_WITH_ERRORS is terminal but NOT a success (a node errored).
    const succeeded = (byStatus.COMPLETED ?? 0) + (byStatus.COMPLETED_WITH_CONTRACT_VIOLATION ?? 0);

    // Cost from the audit trail (sum of recorded node costs across these runs).
    const runIds = runs.map((r) => r.id);
    let costSum = 0;
    if (runIds.length > 0) {
      const audit = deps.db.select({ runId: schema.auditEntries.runId, costCents: schema.auditEntries.costCents })
        .from(schema.auditEntries)
        .where(and(eq(schema.auditEntries.workspaceId, ws.workspaceId), inArray(schema.auditEntries.runId, runIds)))
        .all();
      for (const a of audit) costSum += a.costCents ?? 0;
    }

    const graph = wf.graph as WorkflowGraph;
    const nodeTitle = new Map((graph.nodes ?? []).map((n) => [n.id, n.title] as const));

    return c.json({
      workflowId: id,
      runs: runs.length,
      byStatus,
      successRate: terminal > 0 ? Number((succeeded / terminal).toFixed(3)) : null,
      avgDurationMs: durN > 0 ? Math.round(durSum / durN) : null,
      avgCostCents: runs.length > 0 ? Number((costSum / runs.length).toFixed(2)) : 0,
      totalCostCents: costSum,
      nodeFailures: [...nodeFailures.entries()]
        .map(([nodeId, v]) => ({ nodeId, title: nodeTitle.get(nodeId) ?? nodeId, failures: v.count, sampleError: v.sample }))
        .sort((a, b) => b.failures - a.failures),
    });
  });

  return app;
}
