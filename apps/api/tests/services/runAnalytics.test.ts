/**
 * runAnalytics aggregator tests — the engine behind the workflow/app Analytics
 * tabs. Verifies the fix for "tokens always 0": token consumption is summed from
 * the audit sink (`tokens_in/out` on terminal node entries), cost drives the
 * `metered` flag, and the per-workflow rollup splits totals correctly.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { schema } from '@agentis/db/sqlite';
import { aggregateRunAnalytics } from '../../src/services/run/runAnalytics.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

function seedWorkflow(ctx: TestContext, title: string, nodeId: string): string {
  const id = randomUUID();
  ctx.db.insert(schema.workflows).values({
    id,
    workspaceId: ctx.workspace.id,
    userId: ctx.user.id,
    title,
    graph: { nodes: [{ id: nodeId, type: 'agent_task', title: `${title} step`, config: { kind: 'agent_task' } }], edges: [] },
  }).run();
  return id;
}

function seedRun(ctx: TestContext, workflowId: string, status: string): string {
  const id = randomUUID();
  const started = '2026-06-29T10:00:00.000Z';
  const completed = '2026-06-29T10:00:10.000Z'; // 10s
  ctx.db.insert(schema.workflowRuns).values({
    id,
    workspaceId: ctx.workspace.id,
    workflowId,
    userId: ctx.user.id,
    status,
    runState: { nodeStates: {} },
    startedAt: started,
    completedAt: completed,
  }).run();
  return id;
}

function seedNodeAudit(ctx: TestContext, runId: string, opts: { tokensIn?: number; tokensOut?: number; costCents?: number; agentId?: string | null }): void {
  const agentId = opts.agentId === undefined ? 'agent-1' : opts.agentId;
  ctx.db.insert(schema.auditEntries).values({
    id: randomUUID(),
    workspaceId: ctx.workspace.id,
    runId,
    action: 'node.completed',
    actorType: agentId ? 'agent' : 'system',
    actorId: agentId ?? 'engine',
    agentId,
    tokensIn: opts.tokensIn ?? null,
    tokensOut: opts.tokensOut ?? null,
    costCents: opts.costCents ?? null,
    at: '2026-06-29T10:00:10.000Z',
  }).run();
}

function seedAgent(ctx: TestContext, name: string): string {
  const id = randomUUID();
  ctx.db.insert(schema.agents).values({
    id,
    workspaceId: ctx.workspace.id,
    userId: ctx.user.id,
    name,
    adapterType: 'http',
  }).run();
  return id;
}

describe('aggregateRunAnalytics', () => {
  let ctx: TestContext;
  beforeEach(async () => { ctx = await createTestContext(); });
  afterEach(() => { ctx.close(); });

  it('sums token consumption from the audit sink and stays non-metered without cost', () => {
    const wf = seedWorkflow(ctx, 'Fashion Store Factory', 'n1');
    const r1 = seedRun(ctx, wf, 'COMPLETED');
    const r2 = seedRun(ctx, wf, 'COMPLETED_WITH_ERRORS');
    seedNodeAudit(ctx, r1, { tokensIn: 1000, tokensOut: 400 });
    seedNodeAudit(ctx, r2, { tokensIn: 600, tokensOut: 200 });

    const a = aggregateRunAnalytics(ctx.db, ctx.workspace.id, [
      { id: wf, title: 'Fashion Store Factory', graph: { nodes: [], edges: [] } },
    ]);

    expect(a.runs).toBe(2);
    expect(a.totalTokensIn).toBe(1600);
    expect(a.totalTokensOut).toBe(600);
    expect(a.totalTokens).toBe(2200);
    expect(a.avgTokensPerRun).toBe(1100);
    // One COMPLETED, one COMPLETED_WITH_ERRORS (terminal, not success).
    expect(a.successRate).toBe(0.5);
    expect(a.avgDurationMs).toBe(10_000);
    // No cost recorded → subscription runtime, not metered.
    expect(a.metered).toBe(false);
    expect(a.totalCostCents).toBe(0);
  });

  it('flags metered when real cost is recorded', () => {
    const wf = seedWorkflow(ctx, 'Metered flow', 'n1');
    const r1 = seedRun(ctx, wf, 'COMPLETED');
    seedNodeAudit(ctx, r1, { tokensIn: 100, tokensOut: 50, costCents: 25 });

    const a = aggregateRunAnalytics(ctx.db, ctx.workspace.id, [
      { id: wf, title: 'Metered flow', graph: { nodes: [], edges: [] } },
    ]);
    expect(a.metered).toBe(true);
    expect(a.totalCostCents).toBe(25);
  });

  it('attributes token spend per agent and buckets agentless (evaluator) spend under System', () => {
    const wf = seedWorkflow(ctx, 'Attributed flow', 'n1');
    const analyst = seedAgent(ctx, 'Research Analyst');
    const r1 = seedRun(ctx, wf, 'COMPLETED');
    // Two agent-attributed node entries + one agentless (dedicated evaluator model).
    seedNodeAudit(ctx, r1, { tokensIn: 1000, tokensOut: 300, agentId: analyst });
    seedNodeAudit(ctx, r1, { tokensIn: 500, tokensOut: 100, agentId: analyst });
    seedNodeAudit(ctx, r1, { tokensIn: 200, tokensOut: 60, agentId: null });

    const a = aggregateRunAnalytics(ctx.db, ctx.workspace.id, [
      { id: wf, title: 'Attributed flow', graph: { nodes: [], edges: [] } },
    ]);

    expect(a.perAgent).toHaveLength(2);
    // Sorted by spend: the analyst leads, the System bucket trails.
    expect(a.perAgent[0]).toMatchObject({ agentId: analyst, name: 'Research Analyst', totalTokens: 1900 });
    expect(a.perAgent[1]).toMatchObject({ agentId: null, name: 'System · evaluation', totalTokens: 260 });
    // Every token is attributed — the per-agent split reconciles with the total.
    expect(a.perAgent.reduce((s, r) => s + r.totalTokens, 0)).toBe(a.totalTokens);
  });

  it('rolls up across an app\'s workflows with a per-workflow split', () => {
    const wfA = seedWorkflow(ctx, 'Workflow A', 'a1');
    const wfB = seedWorkflow(ctx, 'Workflow B', 'b1');
    seedNodeAudit(ctx, seedRun(ctx, wfA, 'COMPLETED'), { tokensIn: 800, tokensOut: 200 });
    seedNodeAudit(ctx, seedRun(ctx, wfB, 'COMPLETED'), { tokensIn: 100, tokensOut: 100 });

    const a = aggregateRunAnalytics(ctx.db, ctx.workspace.id, [
      { id: wfA, title: 'Workflow A', graph: { nodes: [], edges: [] } },
      { id: wfB, title: 'Workflow B', graph: { nodes: [], edges: [] } },
    ]);

    expect(a.runs).toBe(2);
    expect(a.totalTokens).toBe(1200);
    expect(a.perWorkflow).toHaveLength(2);
    // Sorted by token consumption, descending.
    expect(a.perWorkflow[0]?.title).toBe('Workflow A');
    expect(a.perWorkflow[0]?.totalTokens).toBe(1000);
    expect(a.perWorkflow[1]?.totalTokens).toBe(200);
  });
});
