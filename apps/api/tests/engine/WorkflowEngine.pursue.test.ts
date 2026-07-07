/**
 * WorkflowEngine — Pursuit (`pursue`, COGNITIVE-LOOPING-RFC).
 *
 * The `pursue` node is the forward-reading rename of `converge` with ASSESS +
 * REFLECT on by default. It normalizes to the same engine loop, so this proves:
 *   1. a `pursue` node dispatches + settles end-to-end (rename is real), and
 *   2. REFLECT: on a stall the loop feeds a self-critique forward and takes ONE
 *      extra iteration per pivot before settling `stalled` (pivot, don't quit),
 *      bounded by `maxPivots`.
 * The trigger-only body emits an identical output every pass, so it stalls
 * deterministically — the extra iteration count is a clean, observable proof of
 * the pivot budget.
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
import { SubflowExecutor } from '../../src/services/subflowExecutor.js';
import type { ExtensionRuntime } from '../../src/services/extensionRuntime.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';
import type { WorkflowSpec } from '../../src/services/workflowSpec.js';

let ctx: TestContext;
beforeEach(async () => { ctx = await createTestContext(); });
afterEach(() => ctx.close());

function saveWorkflow(graph: WorkflowGraph, settings: Record<string, unknown> = {}): string {
  const id = randomUUID();
  ctx.db.insert(schema.workflows).values({ id, workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id, title: 'wf', graph, settings }).run();
  return id;
}

function exprSpec(expr: string): WorkflowSpec {
  return { version: 1, objective: 'test objective', acceptance: [{ id: 'c1', claim: 'the objective expr holds', verify: 'expr', expr }], createdAt: new Date().toISOString() };
}

/** Trivial cohort body (trigger only) — each iteration spawns exactly one child run and emits an identical output (→ stalls). */
function bodyWorkflow(): WorkflowGraph {
  return { version: 1, viewport: { x: 0, y: 0, zoom: 1 }, nodes: [{ id: 'T', type: 'trigger', title: 'Manual', position: { x: 0, y: 0 }, config: { kind: 'trigger', triggerType: 'manual' } }], edges: [] } as WorkflowGraph;
}

function buildEngine(scratchpad: ScratchpadService) {
  const ledger = new LedgerService(ctx.db, ctx.bus);
  return new WorkflowEngine({
    db: ctx.db, bus: ctx.bus, logger: ctx.logger,
    ledger, scratchpad,
    activity: new ActivityFeedService(ctx.db, ctx.bus),
    approvals: new ApprovalInboxService(ctx.db, ctx.bus),
    extensions: {} as unknown as ExtensionRuntime,
    adapters: new AdapterManager(ctx.logger),
    subflows: new SubflowExecutor({ db: ctx.db, ledger, scratchpad }),
  });
}

interface PursueOutput {
  converged?: boolean;
  verdict?: string;
  iterations?: number;
  history?: unknown[];
  reflections?: string[];
  pivots?: number;
  deltaTrajectory?: number[];
}

async function runPursue(pursueConfig: Record<string, unknown>, opts: { spec?: WorkflowSpec } = {}): Promise<{ childRuns: number; output: PursueOutput }> {
  const bodyWfId = saveWorkflow(bodyWorkflow());
  const parent = {
    version: 1, viewport: { x: 0, y: 0, zoom: 1 },
    nodes: [
      { id: 'T', type: 'trigger', title: 'Manual', position: { x: 0, y: 0 }, config: { kind: 'trigger', triggerType: 'manual' } },
      { id: 'C', type: 'pursue', title: 'pursue', position: { x: 1, y: 0 }, config: { kind: 'pursue', bodyWorkflowId: bodyWfId, isolation: 'shared', ...pursueConfig } },
    ],
    edges: [{ id: 'e1', source: 'T', target: 'C' }],
  } as unknown as WorkflowGraph;
  const parentWfId = saveWorkflow(parent, opts.spec ? { spec: opts.spec } : {});

  const runId = randomUUID();
  const inputs = {};
  const initialState = buildInitialRunState({ runId, workflowId: parentWfId, graph: parent, inputs });
  ctx.db.insert(schema.workflowRuns).values({ id: runId, workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, workflowId: parentWfId, userId: ctx.user.id, status: 'CREATED', runState: initialState as unknown as object }).run();

  const scratchpad = new ScratchpadService(ctx.bus, ctx.logger);
  const engine = buildEngine(scratchpad);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), 15_000);
    const off = ctx.bus.subscribe((m) => {
      if (m.room === `run:${runId}` && (m.envelope.event === REALTIME_EVENTS.RUN_COMPLETED || m.envelope.event === REALTIME_EVENTS.RUN_FAILED)) { clearTimeout(timer); off(); resolve(); }
    });
    void engine.startRun({ workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, workflowId: parentWfId, userId: ctx.user.id, triggerId: null, inputs, initialState, graph: parent });
  });

  const childRuns = ctx.db.select().from(schema.workflowRuns).where(eq(schema.workflowRuns.parentRunId, runId)).all().length;
  const run = ctx.db.select().from(schema.workflowRuns).where(eq(schema.workflowRuns.id, runId)).get()!;
  const state = run.runState as { nodeStates: Record<string, { outputData?: PursueOutput }> };
  return { childRuns, output: state.nodeStates.C?.outputData ?? {} };
}

describe('WorkflowEngine — Pursuit (pursue)', () => {
  it('dispatches a `pursue` node end-to-end and settles goal_met', async () => {
    // doneWhen is the forward-reading rename of continuation. Continue while
    // iteration < 2 → iterations 0,1,2 then done.
    const { childRuns, output } = await runPursue({
      doneWhen: { type: 'deterministic', expr: 'iteration < 2' },
      maxIterations: 8,
    });
    expect(childRuns).toBe(3);
    expect(output.verdict).toBe('goal_met');
    expect(output.converged).toBe(true);
    expect(output.iterations).toBe(3);
  });

  it('maxPivots:0 → stops at the first stall (converge parity)', async () => {
    const { childRuns, output } = await runPursue({
      doneWhen: { type: 'deterministic', expr: 'true' },
      maxIterations: 8,
      stopWhenStalled: { after: 2 },
      maxPivots: 0,
    });
    expect(output.verdict).toBe('stalled');
    expect(childRuns).toBe(2);
    expect(output.iterations).toBe(2);
  });

  it('REFLECT: maxPivots:1 takes exactly ONE extra iteration and records one reflection', async () => {
    const { childRuns, output } = await runPursue({
      doneWhen: { type: 'deterministic', expr: 'true' },
      maxIterations: 8,
      stopWhenStalled: { after: 2 },
      maxPivots: 1,
    });
    expect(output.verdict).toBe('stalled');
    expect(childRuns).toBe(3); // one pivot iteration beyond the parity baseline of 2
    expect(output.iterations).toBe(3);
    expect(output.reflections).toHaveLength(1);
    expect(output.pivots).toBe(1);
  });

  it('REFLECT is bounded: maxPivots:2 takes exactly TWO extra iterations, then settles stalled', async () => {
    const { childRuns, output } = await runPursue({
      doneWhen: { type: 'deterministic', expr: 'true' },
      maxIterations: 8,
      stopWhenStalled: { after: 2 },
      maxPivots: 2,
    });
    expect(output.verdict).toBe('stalled');
    expect(childRuns).toBe(4); // two pivot iterations beyond the baseline of 2
    expect(output.reflections).toHaveLength(2);
  });

  it('P1 — doneWhen:objective settles goal_met when the workflow spec is satisfied', async () => {
    // The done-check IS the workflow's Objective. A trivially-true acceptance
    // expr → the verdict is `accomplished` on the first pass → goal_met.
    const { childRuns, output } = await runPursue(
      { doneWhen: { type: 'objective' }, maxIterations: 8 },
      { spec: exprSpec('true') },
    );
    expect(output.verdict).toBe('goal_met');
    expect(output.converged).toBe(true);
    expect(childRuns).toBe(1);
  });

  it('P1 — an unmet objective drives REFLECT with the acceptance deficiency, then settles stalled', async () => {
    // The body never produces `ready`, so the world-check keeps failing. The
    // Pursuit measures 0 progress, reflects once (carrying the failed check as
    // its critique), then settles honestly — never a fake green.
    const { output } = await runPursue(
      { doneWhen: { type: 'objective' }, maxIterations: 8, stopWhenStalled: { after: 2 }, maxPivots: 1 },
      { spec: exprSpec('output.ready == true') },
    );
    expect(output.verdict).toBe('stalled');
    expect(output.reflections).toHaveLength(1);
    expect(output.reflections?.[0]).toMatch(/output\.ready/); // the world-check deficiency fed the reflection
  });
});
