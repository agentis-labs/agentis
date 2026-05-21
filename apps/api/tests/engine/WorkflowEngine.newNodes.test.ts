/**
 * WorkflowEngine — Phase 1+2 of WORKFLOW-REPLAN.
 *
 * Verifies that the new deterministic node kinds (transform, filter, wait,
 * workflow_store) run end-to-end through the real engine, with the variable
 * resolver wired in. Network-dependent kinds (integration, http_request,
 * evaluator) have separate focused tests.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
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
import type { SkillRuntime } from '../../src/services/skillRuntime.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

let ctx: TestContext;
let engine: WorkflowEngine;
let workflowStore: WorkflowStoreService;

beforeEach(async () => {
  ctx = await createTestContext();
  const ledger = new LedgerService(ctx.db, ctx.bus);
  const scratchpad = new ScratchpadService(ctx.bus, ctx.logger);
  const activity = new ActivityFeedService(ctx.db, ctx.bus);
  const approvals = new ApprovalInboxService(ctx.db, ctx.bus);
  const adapters = new AdapterManager(ctx.logger);
  const skills = {} as unknown as SkillRuntime;
  workflowStore = new WorkflowStoreService(ctx.db);
  engine = new WorkflowEngine({
    db: ctx.db,
    bus: ctx.bus,
    logger: ctx.logger,
    ledger,
    scratchpad,
    activity,
    approvals,
    skills,
    adapters,
    workflowStore,
  });
});

afterEach(() => ctx.close());

function seedWorkflow(graph: WorkflowGraph) {
  const wfId = randomUUID();
  ctx.db.insert(schema.workflows).values({
    id: wfId,
    workspaceId: ctx.workspace.id,
    ambientId: ctx.ambient.id,
    userId: ctx.user.id,
    title: 'integration',
    graph,
    settings: {},
  }).run();
  return wfId;
}

async function startAndWait(wfId: string, graph: WorkflowGraph, inputs: Record<string, unknown>): Promise<string> {
  const runId = randomUUID();
  const initialState = buildInitialRunState({ runId, workflowId: wfId, graph, inputs });
  ctx.db.insert(schema.workflowRuns).values({
    id: runId,
    workspaceId: ctx.workspace.id,
    ambientId: ctx.ambient.id,
    workflowId: wfId,
    userId: ctx.user.id,
    status: 'CREATED',
    runState: initialState,
  }).run();
  await engine.startRun({
    workspaceId: ctx.workspace.id,
    ambientId: ctx.ambient.id,
    workflowId: wfId,
    userId: ctx.user.id,
    triggerId: null,
    inputs,
    initialState,
    graph,
  });
  // Wait for the run to terminate. Generous timeout so a loaded CI host
  // doesn't false-fail a run that completes correctly but slowly.
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), 15_000);
    const off = ctx.bus.subscribe((m) => {
      if (m.room === `run:${runId}` && (
        m.envelope.event === REALTIME_EVENTS.RUN_COMPLETED
        || m.envelope.event === REALTIME_EVENTS.RUN_FAILED
      )) {
        clearTimeout(timer);
        off();
        resolve();
      }
    });
  });
  return runId;
}

function loadRun(runId: string) {
  return ctx.db.select().from(schema.workflowRuns).where(eq(schema.workflowRuns.id, runId)).get()!;
}

describe('WorkflowEngine — transform node', () => {
  it('reshapes input via a JS expression', async () => {
    const graph: WorkflowGraph = {
      version: 1,
      viewport: { x: 0, y: 0, zoom: 1 },
      nodes: [
        { id: 'T', type: 'trigger', title: 'Manual', position: { x: 0, y: 0 }, config: { kind: 'trigger', triggerType: 'manual' } },
        {
          id: 'X',
          type: 'transform',
          title: 'Reshape',
          position: { x: 200, y: 0 },
          config: {
            kind: 'transform',
            expression: '({ doubled: input.n * 2, name: input.user.toUpperCase() })',
          },
        },
      ],
      edges: [{ id: 'e1', source: 'T', target: 'X' }],
    };
    const wfId = seedWorkflow(graph);
    const runId = await startAndWait(wfId, graph, { n: 21, user: 'ada' });
    const row = loadRun(runId);
    expect(row.status).toBe('COMPLETED');
    const state = row.runState as { nodeStates: Record<string, { outputData?: Record<string, unknown> }> };
    expect(state.nodeStates.X?.outputData).toEqual({ doubled: 42, name: 'ADA' });
  });

  it('runs deterministically and routes failure through the error edge', async () => {
    const graph: WorkflowGraph = {
      version: 1,
      viewport: { x: 0, y: 0, zoom: 1 },
      nodes: [
        { id: 'T', type: 'trigger', title: 'Manual', position: { x: 0, y: 0 }, config: { kind: 'trigger', triggerType: 'manual' } },
        {
          id: 'X',
          type: 'transform',
          title: 'Boom',
          position: { x: 200, y: 0 },
          config: { kind: 'transform', expression: 'input.no.such.deep' },
        },
        {
          id: 'C',
          type: 'transform',
          title: 'Catch',
          position: { x: 400, y: 0 },
          config: { kind: 'transform', expression: '({ caught: true, msg: input.error.message })' },
        },
      ],
      edges: [
        { id: 'e1', source: 'T', target: 'X' },
        { id: 'e2', source: 'X', target: 'C', type: 'error' },
      ],
    };
    const wfId = seedWorkflow(graph);
    const runId = await startAndWait(wfId, graph, {});
    const row = loadRun(runId);
    // Error edge routed → run completes successfully.
    expect(row.status).toBe('COMPLETED');
    const state = row.runState as { nodeStates: Record<string, { outputData?: Record<string, unknown> }> };
    expect(state.nodeStates.C?.outputData).toMatchObject({ caught: true });
  });
});

describe('WorkflowEngine — filter node', () => {
  it('emits passed=true when the condition holds', async () => {
    const graph: WorkflowGraph = {
      version: 1,
      viewport: { x: 0, y: 0, zoom: 1 },
      nodes: [
        { id: 'T', type: 'trigger', title: 'Manual', position: { x: 0, y: 0 }, config: { kind: 'trigger', triggerType: 'manual' } },
        { id: 'F', type: 'filter', title: 'F', position: { x: 200, y: 0 }, config: { kind: 'filter', condition: 'input.score >= 7' } },
      ],
      edges: [{ id: 'e1', source: 'T', target: 'F' }],
    };
    const wfId = seedWorkflow(graph);
    const runId = await startAndWait(wfId, graph, { score: 8 });
    const state = loadRun(runId).runState as { nodeStates: Record<string, { outputData?: { passed?: boolean } }> };
    expect(state.nodeStates.F?.outputData?.passed).toBe(true);
  });

  it('emits passed=false when it fails', async () => {
    const graph: WorkflowGraph = {
      version: 1,
      viewport: { x: 0, y: 0, zoom: 1 },
      nodes: [
        { id: 'T', type: 'trigger', title: 'Manual', position: { x: 0, y: 0 }, config: { kind: 'trigger', triggerType: 'manual' } },
        { id: 'F', type: 'filter', title: 'F', position: { x: 200, y: 0 }, config: { kind: 'filter', condition: 'input.score >= 7' } },
      ],
      edges: [{ id: 'e1', source: 'T', target: 'F' }],
    };
    const wfId = seedWorkflow(graph);
    const runId = await startAndWait(wfId, graph, { score: 4 });
    const state = loadRun(runId).runState as { nodeStates: Record<string, { outputData?: { passed?: boolean } }> };
    expect(state.nodeStates.F?.outputData?.passed).toBe(false);
  });
});

describe('WorkflowEngine — wait node', () => {
  it('completes after the configured delay', async () => {
    const graph: WorkflowGraph = {
      version: 1,
      viewport: { x: 0, y: 0, zoom: 1 },
      nodes: [
        { id: 'T', type: 'trigger', title: 'Manual', position: { x: 0, y: 0 }, config: { kind: 'trigger', triggerType: 'manual' } },
        { id: 'W', type: 'wait', title: 'Pause', position: { x: 200, y: 0 }, config: { kind: 'wait', delayMs: 80 } },
      ],
      edges: [{ id: 'e1', source: 'T', target: 'W' }],
    };
    const wfId = seedWorkflow(graph);
    const t0 = Date.now();
    const runId = await startAndWait(wfId, graph, {});
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeGreaterThanOrEqual(70);
    const state = loadRun(runId).runState as { nodeStates: Record<string, { status?: string }> };
    expect(state.nodeStates.W?.status).toBe('COMPLETED');
  });
});

describe('WorkflowEngine — workflow_store node', () => {
  it('sets and reads workflow-scoped keys across runs', async () => {
    const graph: WorkflowGraph = {
      version: 1,
      viewport: { x: 0, y: 0, zoom: 1 },
      nodes: [
        { id: 'T', type: 'trigger', title: 'Manual', position: { x: 0, y: 0 }, config: { kind: 'trigger', triggerType: 'manual' } },
        {
          id: 'S',
          type: 'workflow_store',
          title: 'Save',
          position: { x: 200, y: 0 },
          config: {
            kind: 'workflow_store',
            operations: [
              { op: 'set', key: 'lastRun', value: '{{trigger.now}}', outputKey: 'saved' },
              { op: 'increment', key: 'runCount', incrementBy: 1, outputKey: 'count' },
            ],
          },
        },
      ],
      edges: [{ id: 'e1', source: 'T', target: 'S' }],
    };
    const wfId = seedWorkflow(graph);

    await startAndWait(wfId, graph, { now: '2026-05-20T17:00:00Z' });
    expect(workflowStore.get(ctx.workspace.id, wfId, 'lastRun')).toBe('2026-05-20T17:00:00Z');
    expect(workflowStore.get(ctx.workspace.id, wfId, 'runCount')).toBe(1);

    // Run again — the counter survives across runs.
    await sleep(5);
    await startAndWait(wfId, graph, { now: '2026-05-20T17:01:00Z' });
    expect(workflowStore.get(ctx.workspace.id, wfId, 'runCount')).toBe(2);
    expect(workflowStore.get(ctx.workspace.id, wfId, 'lastRun')).toBe('2026-05-20T17:01:00Z');
  });
});

describe('WorkflowEngine — interrupted run recovery', () => {
  function seedInterruptedRun(opts: {
    activeExecutions: Record<string, unknown>;
  }): { wfId: string; runId: string } {
    const graph: WorkflowGraph = {
      version: 1,
      viewport: { x: 0, y: 0, zoom: 1 },
      nodes: [
        { id: 'T', type: 'trigger', title: 'Manual', position: { x: 0, y: 0 }, config: { kind: 'trigger', triggerType: 'manual' } },
        { id: 'W', type: 'wait', title: 'Pause', position: { x: 200, y: 0 }, config: { kind: 'wait', delayMs: 100 } },
        { id: 'X', type: 'transform', title: 'After', position: { x: 400, y: 0 }, config: { kind: 'transform', expression: '({ done: true })', isOutput: true } },
      ],
      edges: [
        { id: 'e1', source: 'T', target: 'W' },
        { id: 'e2', source: 'W', target: 'X' },
      ],
    };
    const wfId = seedWorkflow(graph);
    const runId = randomUUID();
    const state = {
      runId,
      workflowId: wfId,
      status: 'RUNNING',
      readyQueue: [],
      waitingInputs: { X: { requiredInputs: ['W'], receivedInputs: {}, sourceNodeIds: ['W'] } },
      nodeStates: {
        T: { nodeId: 'T', status: 'COMPLETED' },
        W: { nodeId: 'W', status: 'RUNNING' },
        X: { nodeId: 'X', status: 'PENDING' },
      },
      activeExecutions: opts.activeExecutions,
      completedNodeIds: ['T'],
      failedNodeIds: [],
      skippedNodeIds: [],
      graphRevision: 1,
      replanCount: 0,
      lastLedgerSequence: 0,
    };
    ctx.db.insert(schema.workflowRuns).values({
      id: runId,
      workspaceId: ctx.workspace.id,
      ambientId: ctx.ambient.id,
      workflowId: wfId,
      userId: ctx.user.id,
      status: 'RUNNING',
      runState: state,
    }).run();
    return { wfId, runId };
  }

  it('resumes a wait-only interrupted run (timer already elapsed → completes)', async () => {
    const { runId } = seedInterruptedRun({
      activeExecutions: {
        W: { taskId: 'wait:W', nodeId: 'W', executorType: 'wait', executorRef: 'timer:100ms', startedAt: new Date().toISOString(), wakeAt: new Date(Date.now() - 1000).toISOString(), inputData: { from: 'trigger' } },
      },
    });
    const summary = await engine.recoverInterruptedRuns();
    expect(summary.resumed).toBe(1);
    expect(summary.failed).toBe(0);
    // Wait for the resumed run to finish (timer already elapsed → fires immediately).
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout')), 15_000);
      const off = ctx.bus.subscribe((m) => {
        if (m.room === `run:${runId}` && m.envelope.event === REALTIME_EVENTS.RUN_COMPLETED) {
          clearTimeout(timer); off(); resolve();
        }
      });
    });
    const row = loadRun(runId);
    expect(row.status).toBe('COMPLETED');
    const state = row.runState as { completedNodeIds: string[] };
    expect(state.completedNodeIds).toContain('X');
  });

  it('fails a run with non-recoverable external work in flight', async () => {
    const { runId } = seedInterruptedRun({
      activeExecutions: {
        A: { taskId: 'task-1', nodeId: 'A', executorType: 'agent', executorRef: 'agent-xyz', startedAt: new Date().toISOString() },
      },
    });
    const summary = await engine.recoverInterruptedRuns();
    expect(summary.resumed).toBe(0);
    expect(summary.failed).toBe(1);
    expect(loadRun(runId).status).toBe('FAILED');
  });
});

describe('WorkflowEngine — output contract enforcement', () => {
  it('downgrades to COMPLETED_WITH_CONTRACT_VIOLATION when the output is missing a required field', async () => {
    const graph: WorkflowGraph = {
      version: 1,
      viewport: { x: 0, y: 0, zoom: 1 },
      nodes: [
        { id: 'T', type: 'trigger', title: 'Manual', position: { x: 0, y: 0 }, config: { kind: 'trigger', triggerType: 'manual' } },
        {
          id: 'X',
          type: 'transform',
          title: 'Build output',
          position: { x: 200, y: 0 },
          config: { kind: 'transform', expression: '({ name: "alice" })', isOutput: true },
        },
      ],
      edges: [{ id: 'e1', source: 'T', target: 'X' }],
      outputContract: { fields: [
        { key: 'name', type: 'string', required: true },
        { key: 'score', type: 'number', required: true },
      ] },
    } as WorkflowGraph;
    const wfId = seedWorkflow(graph);
    const runId = await startAndWait(wfId, graph, {});
    const row = loadRun(runId);
    expect(row.status).toBe('COMPLETED_WITH_CONTRACT_VIOLATION');
    const state = row.runState as { contractViolations?: string[] };
    expect(state.contractViolations?.some((v) => v.includes('score'))).toBe(true);
  });

  it('completes normally when the output matches the contract', async () => {
    const graph: WorkflowGraph = {
      version: 1,
      viewport: { x: 0, y: 0, zoom: 1 },
      nodes: [
        { id: 'T', type: 'trigger', title: 'Manual', position: { x: 0, y: 0 }, config: { kind: 'trigger', triggerType: 'manual' } },
        {
          id: 'X',
          type: 'transform',
          title: 'Build output',
          position: { x: 200, y: 0 },
          config: { kind: 'transform', expression: '({ name: "alice", score: 87 })', isOutput: true },
        },
      ],
      edges: [{ id: 'e1', source: 'T', target: 'X' }],
      outputContract: { fields: [
        { key: 'name', type: 'string', required: true },
        { key: 'score', type: 'number', required: true },
      ] },
    } as WorkflowGraph;
    const wfId = seedWorkflow(graph);
    const runId = await startAndWait(wfId, graph, {});
    const row = loadRun(runId);
    expect(row.status).toBe('COMPLETED');
  });
});

describe('WorkflowEngine — error edge routing', () => {
  it('does not traverse error edges on success', async () => {
    const graph: WorkflowGraph = {
      version: 1,
      viewport: { x: 0, y: 0, zoom: 1 },
      nodes: [
        { id: 'T', type: 'trigger', title: 'Manual', position: { x: 0, y: 0 }, config: { kind: 'trigger', triggerType: 'manual' } },
        { id: 'X', type: 'transform', title: 'Ok', position: { x: 200, y: 0 }, config: { kind: 'transform', expression: '({ ok: true })' } },
        { id: 'C', type: 'transform', title: 'Catch', position: { x: 400, y: 0 }, config: { kind: 'transform', expression: '({ caught: true })' } },
      ],
      edges: [
        { id: 'e1', source: 'T', target: 'X' },
        { id: 'e2', source: 'X', target: 'C', type: 'error' },
      ],
    };
    const wfId = seedWorkflow(graph);
    const runId = await startAndWait(wfId, graph, {});
    const state = loadRun(runId).runState as { completedNodeIds: string[]; skippedNodeIds: string[] };
    expect(state.completedNodeIds).toContain('X');
    expect(state.completedNodeIds).not.toContain('C');
  });
});
