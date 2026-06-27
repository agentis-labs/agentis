/**
 * WorkflowEngine — `aggregate_window` node (masterplan 1.7).
 *
 * Batches events across runs: each run appends to a persistent buffer and HOLDS
 * (no downstream) until the window closes (count/time), then flushes the batch.
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
import { WorkflowStoreService } from '../../src/services/workflowStore.js';
import type { ExtensionRuntime } from '../../src/services/extensionRuntime.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

let ctx: TestContext;
let engine: WorkflowEngine;
let wfId: string;
const graph = {
  version: 1, viewport: { x: 0, y: 0, zoom: 1 },
  nodes: [
    { id: 'T', type: 'trigger', title: 't', position: { x: 0, y: 0 }, config: { kind: 'trigger', triggerType: 'webhook' } },
    { id: 'W', type: 'aggregate_window', title: 'w', position: { x: 1, y: 0 }, config: { kind: 'aggregate_window', maxCount: 3, outputKey: 'batch' } },
    { id: 'O', type: 'return_output', title: 'o', position: { x: 2, y: 0 }, config: { kind: 'return_output', renderAs: 'json' } },
  ],
  edges: [{ id: 'e1', source: 'T', target: 'W' }, { id: 'e2', source: 'W', target: 'O' }],
} as unknown as WorkflowGraph;

beforeEach(async () => {
  ctx = await createTestContext();
  engine = new WorkflowEngine({
    db: ctx.db, bus: ctx.bus, logger: ctx.logger,
    ledger: new LedgerService(ctx.db, ctx.bus),
    scratchpad: new ScratchpadService(ctx.bus, ctx.logger),
    activity: new ActivityFeedService(ctx.db, ctx.bus),
    approvals: new ApprovalInboxService(ctx.db, ctx.bus),
    extensions: {} as unknown as ExtensionRuntime,
    adapters: new AdapterManager(ctx.logger),
    workflowStore: new WorkflowStoreService(ctx.db),
  });
  wfId = randomUUID();
  ctx.db.insert(schema.workflows).values({ id: wfId, workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id, title: 'win-wf', graph, settings: {} }).run();
});
afterEach(() => ctx.close());

async function runOnce(n: number): Promise<{ wHeld: boolean; outRan: boolean; batch: unknown }> {
  const runId = randomUUID();
  ctx.db.insert(schema.workflowRuns).values({ id: runId, workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, workflowId: wfId, userId: ctx.user.id, status: 'CREATED', runState: {} }).run();
  const inputs = { n };
  const initialState = buildInitialRunState({ runId, workflowId: wfId, graph, inputs });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), 15_000);
    const off = ctx.bus.subscribe((m) => {
      if (m.room === `run:${runId}` && (m.envelope.event === REALTIME_EVENTS.RUN_COMPLETED || m.envelope.event === REALTIME_EVENTS.RUN_FAILED)) { clearTimeout(timer); off(); resolve(); }
    });
    void engine.startRun({ workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, workflowId: wfId, userId: ctx.user.id, triggerId: null, inputs, initialState, graph });
  });
  const run = ctx.db.select().from(schema.workflowRuns).where(eq(schema.workflowRuns.id, runId)).get()!;
  const st = run.runState as { nodeStates: Record<string, { status?: string; outputData?: Record<string, unknown> }> };
  return {
    wHeld: st.nodeStates.W?.outputData?.__hold === true,
    outRan: st.nodeStates.O?.status === 'COMPLETED',
    batch: st.nodeStates.W?.outputData?.batch,
  };
}

describe('WorkflowEngine — aggregate_window', () => {
  it('holds until the window fills, then flushes the batch downstream', async () => {
    const r1 = await runOnce(1);
    expect(r1.wHeld).toBe(true);
    expect(r1.outRan).toBe(false); // downstream not fired while buffering

    const r2 = await runOnce(2);
    expect(r2.wHeld).toBe(true);
    expect(r2.outRan).toBe(false);

    const r3 = await runOnce(3);
    expect(r3.wHeld).toBe(false);
    expect(r3.outRan).toBe(true); // window closed → downstream fires
    expect(r3.batch).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);

    // Buffer reset: a 4th run starts a fresh window (holds again).
    const r4 = await runOnce(4);
    expect(r4.wHeld).toBe(true);
    expect(r4.outRan).toBe(false);
  });
});
