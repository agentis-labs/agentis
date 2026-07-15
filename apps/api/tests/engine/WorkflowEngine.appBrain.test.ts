/**
 * WorkflowEngine → App Brain.
 *
 * A DETERMINISTIC App — no agent node anywhere in its graph — must still learn from
 * its own runs. This was the hole: every brain-capture call site hangs off an
 * agent/session completion, so an App made of trigger/transform/http nodes could run
 * hundreds of times and deposit nothing. The terminal transition now reports every
 * settled run to the learning loop, which is what makes such an App's Brain fill.
 *
 * The engine's contract here is narrow and that's what these assert: on a terminal
 * run it hands the learning loop the run's identity, its status, and what failed —
 * scoped resolution and lesson composition are AppLearningService's business.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { REALTIME_EVENTS, type WorkflowGraph } from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import { WorkflowEngine } from '../../src/engine/WorkflowEngine.js';
import type { RunSettledInput } from '../../src/services/app/appLearning.js';
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

/** A purely deterministic graph: trigger → transform. Not an agent in sight. */
function deterministicGraph(expression: string): WorkflowGraph {
  return {
    version: 1, viewport: { x: 0, y: 0, zoom: 1 },
    nodes: [
      { id: 'T', type: 'trigger', title: 'Start', position: { x: 0, y: 0 }, config: { kind: 'trigger', triggerType: 'manual' } },
      { id: 'X', type: 'transform', title: 'Build digest', position: { x: 1, y: 0 }, config: { kind: 'transform', expression } },
    ],
    edges: [{ id: 'e1', source: 'T', target: 'X' }],
  } as unknown as WorkflowGraph;
}

/** Run a deterministic App workflow to terminal; return what the engine reported. */
async function runApp(graph: WorkflowGraph): Promise<{ settled: RunSettledInput[]; workflowId: string; runId: string }> {
  const settled: RunSettledInput[] = [];
  const wfId = randomUUID();
  const runId = randomUUID();
  ctx.db.insert(schema.workflows).values({
    id: wfId, workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id,
    title: 'Nightly Digest', graph, settings: {},
  }).run();
  ctx.db.insert(schema.workflowRuns).values({
    id: runId, workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, workflowId: wfId,
    userId: ctx.user.id, status: 'CREATED', runState: {},
  }).run();

  const engine = new WorkflowEngine({
    db: ctx.db, bus: ctx.bus, logger: ctx.logger,
    ledger: new LedgerService(ctx.db, ctx.bus),
    scratchpad: new ScratchpadService(ctx.bus, ctx.logger),
    activity: new ActivityFeedService(ctx.db, ctx.bus),
    approvals: new ApprovalInboxService(ctx.db, ctx.bus),
    extensions: {} as unknown as ExtensionRuntime,
    adapters: new AdapterManager(ctx.logger),
    appBrain: {
      async onRunSettled(input) { settled.push(input); return null; },
    },
  });

  const initialState = buildInitialRunState({ runId, workflowId: wfId, graph, inputs: {} });
  await new Promise<void>((resolve) => {
    const off = ctx.bus.subscribe((m) => {
      if (m.room !== `run:${runId}`) return;
      const { event } = m.envelope;
      if (event === REALTIME_EVENTS.RUN_COMPLETED || event === REALTIME_EVENTS.RUN_FAILED) { off(); resolve(); }
    });
    void engine.startRun({
      workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, workflowId: wfId,
      userId: ctx.user.id, triggerId: null, inputs: {}, initialState, graph,
    });
  });
  return { settled, workflowId: wfId, runId };
}

describe('WorkflowEngine — a deterministic App learns from its runs', () => {
  it('reports a successful run to the learning loop with no agent node in the graph', async () => {
    const { settled, workflowId, runId } = await runApp(deterministicGraph('({ headlines: 3 })'));

    expect(settled).toHaveLength(1);
    expect(settled[0]).toMatchObject({
      workspaceId: ctx.workspace.id,
      workflowId,
      runId,
      workflowTitle: 'Nightly Digest',
      status: 'COMPLETED',
    });
    expect(settled[0]!.failures).toEqual([]);
  });

  it('reports the failing step so the lesson can name the weak point', async () => {
    // A transform that throws → the node hard-fails → the run fails.
    const { settled } = await runApp(deterministicGraph('(() => { throw new Error("feed unreachable"); })()'));

    expect(settled).toHaveLength(1);
    expect(settled[0]!.status).not.toBe('COMPLETED');
    const failures = settled[0]!.failures ?? [];
    expect(failures).toHaveLength(1);
    expect(failures[0]!.nodeId).toBe('X');
    // The TITLE, not the id — a lesson that says "Build digest" is actionable.
    expect(failures[0]!.nodeTitle).toBe('Build digest');
    expect(failures[0]!.error).toContain('feed unreachable');
  });

  it('is optional — an engine with no learning loop wired still runs', async () => {
    // Guards the `this.deps.appBrain &&` gate: every existing engine construction
    // (and every other test file) omits this dep.
    const graph = deterministicGraph('({ ok: true })');
    const wfId = randomUUID();
    const runId = randomUUID();
    ctx.db.insert(schema.workflows).values({
      id: wfId, workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id,
      title: 'No brain', graph, settings: {},
    }).run();
    ctx.db.insert(schema.workflowRuns).values({
      id: runId, workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, workflowId: wfId,
      userId: ctx.user.id, status: 'CREATED', runState: {},
    }).run();
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
    const status = await new Promise<string>((resolve) => {
      const off = ctx.bus.subscribe((m) => {
        if (m.room !== `run:${runId}`) return;
        if (m.envelope.event === REALTIME_EVENTS.RUN_COMPLETED) { off(); resolve('COMPLETED'); }
        else if (m.envelope.event === REALTIME_EVENTS.RUN_FAILED) { off(); resolve('FAILED'); }
      });
      void engine.startRun({
        workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, workflowId: wfId,
        userId: ctx.user.id, triggerId: null, inputs: {}, initialState, graph,
      });
    });
    expect(status).toBe('COMPLETED');
  });
});
