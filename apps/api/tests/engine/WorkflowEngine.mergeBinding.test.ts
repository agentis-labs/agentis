/**
 * WorkflowEngine — explicit merge ↔ parallel binding (`parallelSourceId`).
 *
 * Two parallels feed one merge. The nearest-upstream heuristic would pick P1
 * (merge_keys); an explicit `parallelSourceId: 'P2'` must instead apply P2's
 * policy (collect_all). The two strategies produce structurally different merge
 * output, so the binding is observable deterministically (both branches arrive).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { REALTIME_EVENTS, type WorkflowGraph } from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import { WorkflowEngine } from '../../src/engine/WorkflowEngine.js';
import { buildInitialRunState } from '../../src/engine/initialRunState.js';
import { LedgerService } from '../../src/services/ledger.js';
import { ScratchpadService } from '../../src/services/scratchpad.js';
import { ActivityFeedService } from '../../src/services/activityFeed.js';
import { ApprovalInboxService } from '../../src/services/approvalInbox.js';
import { AdapterManager } from '../../src/adapters/AdapterManager.js';
import type { ExtensionRuntime } from '../../src/services/extensionRuntime.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

let ctx: TestContext;
beforeEach(async () => { ctx = await createTestContext(); });
afterEach(() => ctx.close());

function waitForCompleted(runId: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), 15_000);
    const off = ctx.bus.subscribe((m) => {
      if (m.room === `run:${runId}` && m.envelope.event === REALTIME_EVENTS.RUN_COMPLETED) { clearTimeout(timer); off(); resolve(); }
    });
  });
}

/** Two parallels (P1 merge_keys, P2 collect_all) → merge M; returns M's output. */
async function runDiamond(parallelSourceId?: string): Promise<Record<string, unknown>> {
  const merge: Record<string, unknown> = { kind: 'merge', requiredInputs: 'all' };
  if (parallelSourceId) merge.parallelSourceId = parallelSourceId;
  const graph = {
    version: 1,
    viewport: { x: 0, y: 0, zoom: 1 },
    nodes: [
      { id: 'T', type: 'trigger', title: 't', position: { x: 0, y: 0 }, config: { kind: 'trigger', triggerType: 'manual' } },
      { id: 'P1', type: 'parallel', title: 'p1', position: { x: 1, y: 0 }, config: { kind: 'parallel', waitFor: 'all', onBranchError: 'fail_all', mergeStrategy: 'merge_keys' } },
      { id: 'P2', type: 'parallel', title: 'p2', position: { x: 1, y: 1 }, config: { kind: 'parallel', waitFor: 'all', onBranchError: 'fail_all', mergeStrategy: 'collect_all' } },
      { id: 'A', type: 'transform', title: 'a', position: { x: 2, y: 0 }, config: { kind: 'transform', expression: '({ a: 1 })' } },
      { id: 'B', type: 'transform', title: 'b', position: { x: 2, y: 1 }, config: { kind: 'transform', expression: '({ b: 2 })' } },
      { id: 'M', type: 'merge', title: 'm', position: { x: 3, y: 0 }, config: merge },
    ],
    edges: [
      { id: 'e1', source: 'T', target: 'P1' },
      { id: 'e2', source: 'T', target: 'P2' },
      { id: 'e3', source: 'P1', target: 'A' },
      { id: 'e4', source: 'P2', target: 'B' },
      { id: 'e5', source: 'A', target: 'M' },
      { id: 'e6', source: 'B', target: 'M' },
    ],
  } as unknown as WorkflowGraph;

  const wfId = randomUUID();
  const runId = randomUUID();
  ctx.db.insert(schema.workflows).values({ id: wfId, workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id, title: 'diamond', graph, settings: {} }).run();
  ctx.db.insert(schema.workflowRuns).values({ id: runId, workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, workflowId: wfId, userId: ctx.user.id, status: 'CREATED', runState: {} }).run();

  const engine = new WorkflowEngine({
    db: ctx.db, bus: ctx.bus, logger: ctx.logger,
    ledger: new LedgerService(ctx.db, ctx.bus),
    scratchpad: new ScratchpadService(ctx.bus, ctx.logger),
    activity: new ActivityFeedService(ctx.db, ctx.bus),
    approvals: new ApprovalInboxService(ctx.db, ctx.bus),
    extensions: {} as unknown as ExtensionRuntime,
    adapters: new AdapterManager(ctx.logger),
  });

  const initialState = buildInitialRunState({ runId, workflowId: wfId, graph, inputs: {} });
  const done = waitForCompleted(runId);
  await engine.startRun({ workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, workflowId: wfId, userId: ctx.user.id, triggerId: null, inputs: {}, initialState, graph });
  await done;

  const row = ctx.db.select().from(schema.workflowRuns).where(eq(schema.workflowRuns.id, runId)).get()!;
  const state = row.runState as { nodeStates: Record<string, { outputData?: Record<string, unknown> }> };
  return state.nodeStates.M?.outputData ?? {};
}

describe('WorkflowEngine — merge parallelSourceId binding', () => {
  it('default (no binding) uses the nearest parallel P1 → merge_keys output', async () => {
    const out = await runDiamond();
    // merge_keys shallow-merges branch objects.
    expect(out).toMatchObject({ a: 1, b: 2 });
    expect(Array.isArray((out as { results?: unknown }).results)).toBe(false);
  });

  it('explicit parallelSourceId=P2 overrides the heuristic → collect_all output', async () => {
    const out = await runDiamond('P2');
    // collect_all keeps each branch distinct under `results`.
    const results = (out as { results?: unknown[] }).results;
    expect(Array.isArray(results)).toBe(true);
    expect(results).toHaveLength(2);
    expect(results).toEqual(expect.arrayContaining([{ a: 1 }, { b: 2 }]));
  });
});
