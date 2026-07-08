/**
 * agentis.run.replay — the child run must be a REAL persisted run.
 *
 * The handler used to call engine.startRun without inserting the workflow_runs
 * row (startRun only UPDATEs), so replays ran as ghosts: run.status/run.inspect
 * returned found:false and run history never listed them.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { WorkflowGraph, WorkflowRunState } from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import { WorkflowEngine } from '../../src/engine/WorkflowEngine.js';
import { PartialReplayService } from '../../src/services/partialReplay.js';
import { LedgerService } from '../../src/services/ledger.js';
import { ScratchpadService } from '../../src/services/scratchpad.js';
import { ActivityFeedService } from '../../src/services/activityFeed.js';
import { ApprovalInboxService } from '../../src/services/approvalInbox.js';
import { AdapterManager } from '../../src/adapters/AdapterManager.js';
import { AgentisToolRegistry } from '../../src/services/agentisToolRegistry.js';
import { registerRunTools } from '../../src/services/agentisToolHandlers/run.js';
import type { ToolHandlerDeps } from '../../src/services/agentisToolHandlers/deps.js';
import type { ExtensionRuntime } from '../../src/services/extensionRuntime.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

let ctx: TestContext;
let registry: AgentisToolRegistry;

beforeEach(async () => {
  ctx = await createTestContext();
  const ledger = new LedgerService(ctx.db, ctx.bus);
  const engine = new WorkflowEngine({
    db: ctx.db, bus: ctx.bus, logger: ctx.logger,
    ledger,
    scratchpad: new ScratchpadService(ctx.bus, ctx.logger),
    activity: new ActivityFeedService(ctx.db, ctx.bus),
    approvals: new ApprovalInboxService(ctx.db, ctx.bus),
    extensions: {} as unknown as ExtensionRuntime,
    adapters: new AdapterManager(ctx.logger),
  });
  registry = new AgentisToolRegistry({ logger: ctx.logger });
  registerRunTools(registry, {
    db: ctx.db, logger: ctx.logger, bus: ctx.bus, engine,
    adapters: {} as ToolHandlerDeps['adapters'],
    ledger,
    scratchpad: {} as ToolHandlerDeps['scratchpad'],
    approvals: { list: () => [] } as unknown as ToolHandlerDeps['approvals'],
    activity: {} as ToolHandlerDeps['activity'],
    replay: new PartialReplayService(ctx.db),
  } as ToolHandlerDeps);
});

afterEach(() => ctx.close());

const toolCtx = () => ({ workspaceId: ctx.workspace.id, userId: ctx.user.id, ambientId: ctx.ambient.id, caller: 'chat' as const });

/** Seed a COMPLETED source run over A → B → C (merge passthrough nodes). */
function seedSourceRun(): { runId: string } {
  const graph: WorkflowGraph = {
    version: 1,
    viewport: { x: 0, y: 0, zoom: 1 },
    nodes: [
      { id: 'A', type: 'trigger', title: 'A', position: { x: 0, y: 0 }, config: { kind: 'trigger', triggerType: 'manual' } },
      { id: 'B', type: 'merge', title: 'B', position: { x: 100, y: 0 }, config: { kind: 'merge', requiredInputs: 'all' } },
      { id: 'C', type: 'merge', title: 'C', position: { x: 200, y: 0 }, config: { kind: 'merge', requiredInputs: 'all' } },
    ],
    edges: [
      { id: 'e1', source: 'A', target: 'B' },
      { id: 'e2', source: 'B', target: 'C' },
    ],
  };
  const wfId = randomUUID();
  const runId = randomUUID();
  ctx.db.insert(schema.workflows).values({
    id: wfId, workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id,
    title: 'replay-src', graph, settings: {},
  }).run();
  const nodeStates: Record<string, unknown> = {
    A: { nodeId: 'A', status: 'COMPLETED', outputData: { started: true } },
    B: { nodeId: 'B', status: 'COMPLETED', outputData: { fromB: 1 } },
    C: { nodeId: 'C', status: 'COMPLETED', outputData: { fromC: 2 } },
  };
  const state: WorkflowRunState = {
    runId, workflowId: wfId, status: 'COMPLETED',
    readyQueue: [], waitingInputs: {}, nodeStates: nodeStates as never,
    activeExecutions: {}, completedNodeIds: ['A', 'B', 'C'], failedNodeIds: [], skippedNodeIds: [],
    graphRevision: 1, replanCount: 0, lastLedgerSequence: 0,
  };
  ctx.db.insert(schema.workflowRuns).values({
    id: runId, workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, workflowId: wfId,
    userId: ctx.user.id, status: 'COMPLETED', runState: state as unknown as object, replanCount: 0,
  }).run();
  return { runId };
}

describe('agentis.run.replay — persisted child run', () => {
  it('the replay child is immediately inspectable: a real row exists and run.status finds it', async () => {
    const { runId: sourceRunId } = seedSourceRun();

    const replay = await registry.execute(
      { id: '', toolId: 'agentis.run.replay', arguments: { sourceRunId, mode: 'replay-from-node', targetNodeId: 'C' } },
      toolCtx(),
    );
    expect(replay.ok).toBe(true);
    const out = replay.output as { runId: string; parentRunId: string; compass?: { next: Array<{ tool: string }> } };
    expect(out.runId).toBeTruthy();
    expect(out.parentRunId).toBe(sourceRunId);
    expect(out.compass?.next[0]?.tool).toBe('agentis.run.await');

    // The row exists in the DB (this is what used to be missing entirely)…
    const row = ctx.db.select().from(schema.workflowRuns).where(eq(schema.workflowRuns.id, out.runId)).get();
    expect(row).toBeTruthy();
    expect(row!.parentRunId).toBe(sourceRunId);

    // …and the observation tools find it.
    const status = await registry.execute(
      { id: '', toolId: 'agentis.run.status', arguments: { runId: out.runId } },
      toolCtx(),
    );
    expect(status.ok).toBe(true);
    expect((status.output as { found: boolean }).found).toBe(true);

    // Run history lists the child too.
    const query = await registry.execute(
      { id: '', toolId: 'agentis.run.query', arguments: { limit: 20 } },
      toolCtx(),
    );
    const runs = (query.output as { runs: Array<{ id: string }> }).runs;
    expect(runs.some((r) => r.id === out.runId)).toBe(true);

    // Let the child run reach a terminal DB status before teardown, so its
    // async persists never race the sqlite close.
    for (let i = 0; i < 100; i += 1) {
      const child = ctx.db.select().from(schema.workflowRuns).where(eq(schema.workflowRuns.id, out.runId)).get();
      const s = child?.status ?? '';
      if (s && s !== 'CREATED' && s !== 'RUNNING' && s !== 'WAITING') break;
      await new Promise((r) => setTimeout(r, 50));
    }
  });
});
