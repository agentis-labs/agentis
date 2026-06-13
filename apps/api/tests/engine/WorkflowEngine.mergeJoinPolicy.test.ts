/**
 * WorkflowEngine — merge node join policies (`requiredInputs`).
 *
 * `MergeNodeConfig.requiredInputs` is declared as `'all' | 'any' | string[]`
 * but historically only `'all'` (AND-join) was honored at runtime — `'any'`
 * (OR-join / race) and the subset form silently behaved like `'all'`. These
 * tests lock in the real join semantics:
 *   - 'all'    → wait for every incoming branch (default AND-join).
 *   - 'any'    → fire on the FIRST branch to arrive (OR-join / first-wins).
 *   - string[] → fire once the explicitly-listed sources have arrived.
 * Plus the latent AND-join hang: a merge fed by both a success edge and a
 * (dropped) error edge used to be able to lose all required inputs yet never
 * get promoted. It must now settle.
 *
 * Timing is made deterministic by slowing one branch with a `wait` node, so the
 * "fast" branch is guaranteed to reach the merge first.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { REALTIME_EVENTS, type WorkflowGraph } from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import { eq } from 'drizzle-orm';
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

beforeEach(async () => {
  ctx = await createTestContext();
});
afterEach(() => ctx.close());

function buildEngine() {
  const ledger = new LedgerService(ctx.db, ctx.bus);
  const scratchpad = new ScratchpadService(ctx.bus, ctx.logger);
  const activity = new ActivityFeedService(ctx.db, ctx.bus);
  const approvals = new ApprovalInboxService(ctx.db, ctx.bus);
  const adapters = new AdapterManager(ctx.logger);
  return new WorkflowEngine({
    db: ctx.db,
    bus: ctx.bus,
    logger: ctx.logger,
    ledger,
    scratchpad,
    activity,
    approvals,
    extensions: {} as unknown as ExtensionRuntime,
    adapters,
  });
}

function seedWorkflow(graph: WorkflowGraph) {
  const wfId = randomUUID();
  const runId = randomUUID();
  ctx.db
    .insert(schema.workflows)
    .values({
      id: wfId,
      workspaceId: ctx.workspace.id,
      ambientId: ctx.ambient.id,
      userId: ctx.user.id,
      title: 'merge-join-wf',
      graph,
      settings: {},
    })
    .run();
  ctx.db
    .insert(schema.workflowRuns)
    .values({
      id: runId,
      workspaceId: ctx.workspace.id,
      ambientId: ctx.ambient.id,
      workflowId: wfId,
      userId: ctx.user.id,
      status: 'CREATED',
      runState: {},
    })
    .run();
  return { wfId, runId };
}

function waitForRunStatus(runId: string, target: 'COMPLETED' | 'FAILED'): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const evt =
      target === 'COMPLETED' ? REALTIME_EVENTS.RUN_COMPLETED : REALTIME_EVENTS.RUN_FAILED;
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${target} on ${runId}`)), 15_000);
    const off = ctx.bus.subscribe((m) => {
      if (m.room === `run:${runId}` && m.envelope.event === evt) {
        clearTimeout(timer);
        off();
        resolve();
      }
    });
  });
}

async function run(graph: WorkflowGraph) {
  const { wfId, runId } = seedWorkflow(graph);
  const engine = buildEngine();
  const initialState = buildInitialRunState({ runId, workflowId: wfId, graph, inputs: {} });
  await engine.startRun({
    workspaceId: ctx.workspace.id,
    ambientId: ctx.ambient.id,
    workflowId: wfId,
    userId: ctx.user.id,
    triggerId: null,
    inputs: {},
    initialState,
    graph,
  });
  await waitForRunStatus(runId, 'COMPLETED');
  const row = ctx.db.select().from(schema.workflowRuns).where(eq(schema.workflowRuns.id, runId)).get()!;
  return row.runState as {
    completedNodeIds: string[];
    nodeStates: Record<string, { status: string; outputData?: Record<string, unknown> }>;
    waitingInputs: Record<string, unknown>;
  };
}

/**
 * Graph: T → A(fast transform {fast:true}) → C
 *        T → B(wait → transform {slow:true}) → C
 * The `wait` guarantees A reaches C strictly before B.
 */
function fastSlowMergeGraph(mergeRequiredInputs: 'all' | 'any' | string[]): WorkflowGraph {
  return {
    version: 1,
    viewport: { x: 0, y: 0, zoom: 1 },
    nodes: [
      { id: 'T', type: 'trigger', title: 'trigger', position: { x: 0, y: 0 }, config: { kind: 'trigger', triggerType: 'manual' } },
      { id: 'A', type: 'transform', title: 'fast', position: { x: 100, y: 0 }, config: { kind: 'transform', expression: '({ fast: true })' } },
      { id: 'Bw', type: 'wait', title: 'delay', position: { x: 100, y: 100 }, config: { kind: 'wait', delayMs: 400 } },
      { id: 'B', type: 'transform', title: 'slow', position: { x: 150, y: 100 }, config: { kind: 'transform', expression: '({ slow: true })' } },
      { id: 'C', type: 'merge', title: 'join', position: { x: 250, y: 50 }, config: { kind: 'merge', requiredInputs: mergeRequiredInputs } },
    ],
    edges: [
      { id: 'e1', source: 'T', target: 'A' },
      { id: 'e2', source: 'T', target: 'Bw' },
      { id: 'e3', source: 'Bw', target: 'B' },
      { id: 'e4', source: 'A', target: 'C' },
      { id: 'e5', source: 'B', target: 'C' },
    ],
  };
}

describe('WorkflowEngine — merge join policies', () => {
  it("'all' (AND-join) waits for every branch and merges both payloads", async () => {
    const state = await run(fastSlowMergeGraph('all'));
    expect(state.nodeStates.C?.status).toBe('COMPLETED');
    // Both branches contributed to the merge output.
    expect(state.nodeStates.C?.outputData).toMatchObject({ fast: true, slow: true });
    expect(Object.keys(state.waitingInputs)).toHaveLength(0);
  });

  it("'any' (OR-join) fires on the FIRST arriving branch and ignores the slow one", async () => {
    const state = await run(fastSlowMergeGraph('any'));
    expect(state.nodeStates.C?.status).toBe('COMPLETED');
    // The fast branch won the race — the merge fired with ONLY its payload.
    expect(state.nodeStates.C?.outputData).toMatchObject({ fast: true });
    expect(state.nodeStates.C?.outputData?.slow).toBeUndefined();
    // Run still settles cleanly once the slow branch also reaches terminal.
    expect(state.completedNodeIds).toContain('B');
    expect(Object.keys(state.waitingInputs)).toHaveLength(0);
  });

  it("subset join (string[]) waits for the SPECIFIC listed source even if another arrives first", async () => {
    // Only the slow branch ('B') is listed, so the fast branch arriving first
    // must NOT satisfy the gate — the merge waits for B specifically.
    const state = await run(fastSlowMergeGraph(['B']));
    expect(state.nodeStates.C?.status).toBe('COMPLETED');
    // Waited for B → both payloads present (A was buffered while we waited).
    expect(state.nodeStates.C?.outputData).toMatchObject({ fast: true, slow: true });
    expect(Object.keys(state.waitingInputs)).toHaveLength(0);
  });

  it('does not hang when a merge is fed by both a success edge and a (dropped) error edge', async () => {
    // T → A(fast {fast:true}) ─────────────► C
    // T → Bw(wait) → B(success) ──error──►  C   (B succeeds, so the catch edge
    // never fires; C must still be promoted from A's input, not hang forever.)
    const graph: WorkflowGraph = {
      version: 1,
      viewport: { x: 0, y: 0, zoom: 1 },
      nodes: [
        { id: 'T', type: 'trigger', title: 'trigger', position: { x: 0, y: 0 }, config: { kind: 'trigger', triggerType: 'manual' } },
        { id: 'A', type: 'transform', title: 'fast', position: { x: 100, y: 0 }, config: { kind: 'transform', expression: '({ fast: true })' } },
        { id: 'Bw', type: 'wait', title: 'delay', position: { x: 100, y: 100 }, config: { kind: 'wait', delayMs: 400 } },
        { id: 'B', type: 'transform', title: 'ok', position: { x: 150, y: 100 }, config: { kind: 'transform', expression: '({ ok: true })' } },
        { id: 'C', type: 'merge', title: 'join', position: { x: 250, y: 50 }, config: { kind: 'merge', requiredInputs: 'all' } },
      ],
      edges: [
        { id: 'e1', source: 'T', target: 'A' },
        { id: 'e2', source: 'T', target: 'Bw' },
        { id: 'e3', source: 'Bw', target: 'B' },
        { id: 'e4', source: 'A', target: 'C' },
        { id: 'e5', source: 'B', target: 'C', type: 'error' },
      ],
    };
    const state = await run(graph);
    expect(state.nodeStates.C?.status).toBe('COMPLETED');
    // The success edge fed C; the catch edge was correctly dropped.
    expect(state.nodeStates.C?.outputData).toMatchObject({ fast: true });
    expect(Object.keys(state.waitingInputs)).toHaveLength(0);
  });
});
