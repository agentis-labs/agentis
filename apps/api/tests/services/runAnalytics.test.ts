/**
 * runAnalytics aggregator tests — the engine behind the workflow/app Analytics
 * tabs. Verifies the fix for "tokens always 0": token consumption is summed from
 * the audit sink (`tokens_in/out` on terminal node entries), cost drives the
 * `metered` flag, and the per-workflow rollup splits totals correctly.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { schema } from '@agentis/db/sqlite';
import { aggregateRunAnalytics, workflowDurationStats, humanDuration } from '../../src/services/run/runAnalytics.js';
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
    const wf = seedWorkflow(ctx, 'Catalog Launch Workflow', 'n1');
    const r1 = seedRun(ctx, wf, 'COMPLETED');
    const r2 = seedRun(ctx, wf, 'COMPLETED_WITH_ERRORS');
    seedNodeAudit(ctx, r1, { tokensIn: 1000, tokensOut: 400 });
    seedNodeAudit(ctx, r2, { tokensIn: 600, tokensOut: 200 });

    const a = aggregateRunAnalytics(ctx.db, ctx.workspace.id, [
      { id: wf, title: 'Catalog Launch Workflow', graph: { nodes: [], edges: [] } },
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

  it('counts contract-violating terminal runs as failures, never successes', () => {
    const wf = seedWorkflow(ctx, 'Contract gate', 'n1');
    seedRun(ctx, wf, 'COMPLETED');
    seedRun(ctx, wf, 'COMPLETED_WITH_CONTRACT_VIOLATION');
    const analytics = aggregateRunAnalytics(ctx.db, ctx.workspace.id, [
      { id: wf, title: 'Contract gate', graph: { nodes: [], edges: [] } },
    ]);
    expect(analytics.runs).toBe(2);
    expect(analytics.successRate).toBe(0.5);
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

describe('workflowDurationStats (temporal self-model)', () => {
  let ctx: TestContext;
  beforeEach(async () => { ctx = await createTestContext(); });
  afterEach(() => { ctx.close(); });

  function seedRunDur(workflowId: string, status: string, durationMs: number): void {
    const start = Date.parse('2026-06-29T10:00:00.000Z');
    ctx.db.insert(schema.workflowRuns).values({
      id: randomUUID(),
      workspaceId: ctx.workspace.id,
      workflowId,
      userId: ctx.user.id,
      status,
      runState: { nodeStates: {} },
      startedAt: new Date(start).toISOString(),
      completedAt: new Date(start + durationMs).toISOString(),
    }).run();
  }

  it('returns null when there are too few finished samples to be honest', () => {
    const wf = seedWorkflow(ctx, 'New workflow', 'n1');
    seedRunDur(wf, 'COMPLETED', 5_000);
    seedRunDur(wf, 'COMPLETED', 7_000);
    expect(workflowDurationStats(ctx.db, ctx.workspace.id, wf)).toBeNull();
  });

  it('computes p50 / p95 / avg over finished runs and a human summary', () => {
    const wf = seedWorkflow(ctx, 'Seasoned workflow', 'n1');
    for (const d of [2_000, 4_000, 6_000, 8_000, 10_000]) seedRunDur(wf, 'COMPLETED', d);
    const stats = workflowDurationStats(ctx.db, ctx.workspace.id, wf);
    expect(stats).not.toBeNull();
    expect(stats!.sampleCount).toBe(5);
    expect(stats!.p50Ms).toBe(6_000);
    expect(stats!.p95Ms).toBe(10_000);
    expect(stats!.avgMs).toBe(6_000);
    expect(stats!.summary).toBe('typically ~6s (p95 ~10s) over 5 runs');
  });

  it('excludes CANCELLED runs (aborted early → misleadingly short)', () => {
    const wf = seedWorkflow(ctx, 'Cancels workflow', 'n1');
    for (const d of [30_000, 32_000, 34_000]) seedRunDur(wf, 'COMPLETED', d);
    seedRunDur(wf, 'CANCELLED', 10); // must not drag the estimate down
    const stats = workflowDurationStats(ctx.db, ctx.workspace.id, wf);
    expect(stats!.sampleCount).toBe(3);
    expect(stats!.p50Ms).toBe(32_000);
  });

  it('humanDuration renders compact units', () => {
    expect(humanDuration(45_000)).toBe('45s');
    expect(humanDuration(4 * 60_000)).toBe('4m');
    expect(humanDuration(130 * 60_000)).toBe('2h 10m');
    expect(humanDuration(120 * 60_000)).toBe('2h');
  });
});
