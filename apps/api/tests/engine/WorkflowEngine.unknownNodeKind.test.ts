/**
 * Regression: a node whose `kind` is not a supported execution kind must fail
 * the run LOUDLY at start — never dispatch and hang. `validateWorkflowGraph`
 * (allowlist-gated) is the enforced guard at every entry point (startRun,
 * applyGraphPatch, evolveGraph), so an unsupported kind is rejected before it
 * can reach `#dispatchNode`. The `default:` case added to that switch is the
 * defense-in-depth backstop for allowlist/dispatch drift (a kind that passes
 * the allowlist but has no handler) — it turns a would-be silent hang into a
 * clean node failure. This test locks in the enforced "never a silent hang"
 * guarantee at the layer that actually enforces it.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { type WorkflowGraph } from '@agentis/core';
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
afterEach(() => { ctx.close(); });

describe('WorkflowEngine unknown node kind', () => {
  it('rejects an unsupported node kind at run start (never dispatches → never hangs)', async () => {
    const graph: WorkflowGraph = {
      version: 1,
      viewport: { x: 0, y: 0, zoom: 1 },
      nodes: [
        { id: 'trigger', type: 'trigger', title: 'Manual', position: { x: 0, y: 0 }, config: { kind: 'trigger', triggerType: 'manual' } },
        // A kind that matches no supported execution kind and no dispatch handler.
        { id: 'mystery', type: 'mystery', title: 'Mystery', position: { x: 200, y: 0 }, config: { kind: 'totally_unknown_kind_xyz' } } as WorkflowGraph['nodes'][number],
      ],
      edges: [{ id: 't-m', source: 'trigger', target: 'mystery' }],
    };
    const { workflowId, initialState } = persistWorkflow(graph);

    await expect(makeEngine().startRun({
      workspaceId: ctx.workspace.id,
      ambientId: ctx.ambient.id,
      workflowId,
      userId: ctx.user.id,
      triggerId: null,
      inputs: {},
      initialState,
      graph,
    })).rejects.toThrow(/unsupported kind 'totally_unknown_kind_xyz'/);
  });
});

function makeEngine(): WorkflowEngine {
  return new WorkflowEngine({
    db: ctx.db,
    bus: ctx.bus,
    logger: ctx.logger,
    ledger: new LedgerService(ctx.db, ctx.bus),
    scratchpad: new ScratchpadService(ctx.bus, ctx.logger),
    activity: new ActivityFeedService(ctx.db, ctx.bus),
    approvals: new ApprovalInboxService(ctx.db, ctx.bus),
    extensions: {} as unknown as ExtensionRuntime,
    adapters: new AdapterManager(ctx.logger),
  });
}

function persistWorkflow(graph: WorkflowGraph): {
  workflowId: string;
  runId: string;
  initialState: ReturnType<typeof buildInitialRunState>;
} {
  const workflowId = randomUUID();
  const runId = randomUUID();
  const initialState = buildInitialRunState({ runId, workflowId, graph, inputs: {} });
  ctx.db.insert(schema.workflows).values({
    id: workflowId,
    workspaceId: ctx.workspace.id,
    ambientId: ctx.ambient.id,
    userId: ctx.user.id,
    title: 'Unknown node kind',
    graph,
    settings: {},
  }).run();
  ctx.db.insert(schema.workflowRuns).values({
    id: runId,
    workspaceId: ctx.workspace.id,
    ambientId: ctx.ambient.id,
    workflowId,
    userId: ctx.user.id,
    status: 'CREATED',
    runState: initialState,
  }).run();
  return { workflowId, runId, initialState };
}
