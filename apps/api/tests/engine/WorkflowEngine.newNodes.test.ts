/**
 * WorkflowEngine — Phase 1+2 of WORKFLOW-REPLAN.
 *
 * Verifies that the new deterministic node kinds (transform, filter, wait,
 * workflow_store) run end-to-end through the real engine, with the variable
 * resolver wired in. Network-dependent kinds (integration, http_request,
 * evaluator) have separate focused tests.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { eq } from 'drizzle-orm';
import { REALTIME_EVENTS, type WorkflowGraph } from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import { ConnectorRegistry, type ConnectorModule } from '@agentis/integrations';
import { WorkflowEngine } from '../../src/engine/WorkflowEngine.js';
import { buildInitialRunState } from '../../src/engine/initialRunState.js';
import { LedgerService } from '../../src/services/ledger.js';
import { ScratchpadService } from '../../src/services/scratchpad.js';
import { ActivityFeedService } from '../../src/services/activityFeed.js';
import { ApprovalInboxService } from '../../src/services/approvalInbox.js';
import { AdapterManager } from '../../src/adapters/AdapterManager.js';
import { WorkflowStoreService } from '../../src/services/workflow/workflowStore.js';
import type { ExtensionRuntime } from '../../src/services/extensionRuntime.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

let ctx: TestContext;
let engine: WorkflowEngine;
let workflowStore: WorkflowStoreService;
let approvals: ApprovalInboxService;

const acmeConnector: ConnectorModule = {
  service: 'acme_crm',
  operations: ['create_lead'],
  async execute(opts) {
    return {
      ok: true,
      operation: opts.operation,
      token: opts.credential?.token,
      name: opts.params.name,
    };
  },
};

beforeEach(async () => {
  ctx = await createTestContext();
  const ledger = new LedgerService(ctx.db, ctx.bus);
  const scratchpad = new ScratchpadService(ctx.bus, ctx.logger);
  const activity = new ActivityFeedService(ctx.db, ctx.bus);
  approvals = new ApprovalInboxService(ctx.db, ctx.bus);
  const adapters = new AdapterManager(ctx.logger);
  const skills = {} as unknown as ExtensionRuntime;
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
    connectors: new ConnectorRegistry([acmeConnector]),
    vault: ctx.vault,
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

async function waitForCheckpointApproval(): Promise<{ id: string; title: string; summary: string }> {
  // 10s ceiling (returns the instant the approval lands) — the checkpoint runs a
  // model-backed preview step before creating the approval, so a saturated CI
  // host needs more headroom than the happy-path ~600ms. Matches the generous
  // event-wait budgets used by the sibling engine tests.
  for (let i = 0; i < 500; i += 1) {
    const pending = approvals.list(ctx.workspace.id, 'pending').find((approval) => approval.source === 'checkpoint');
    if (pending) return { id: pending.id, title: pending.title, summary: pending.summary };
    await sleep(20);
  }
  throw new Error('no checkpoint approval created');
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

  it('does not report success when every declared output branch was skipped', async () => {
    const graph: WorkflowGraph = {
      version: 1,
      viewport: { x: 0, y: 0, zoom: 1 },
      nodes: [
        { id: 'T', type: 'trigger', title: 'Manual', position: { x: 0, y: 0 }, config: { kind: 'trigger', triggerType: 'manual' } },
        {
          id: 'P',
          type: 'transform',
          title: 'Produce',
          position: { x: 200, y: 0 },
          config: { kind: 'transform', expression: '({ delivered: true })' },
        },
        {
          id: 'R',
          type: 'return_output',
          title: 'Return result',
          position: { x: 400, y: 0 },
          config: { kind: 'return_output', renderAs: 'json' },
        },
      ],
      edges: [
        { id: 'e1', source: 'T', target: 'P' },
        { id: 'e2', source: 'P', target: 'R', condition: 'false' },
      ],
    };
    const wfId = seedWorkflow(graph);
    const runId = await startAndWait(wfId, graph, {});
    const row = loadRun(runId);
    const state = row.runState as {
      completionFailure?: string;
      nodeStates: Record<string, { status?: string }>;
    };

    expect(row.status).toBe('COMPLETED_WITH_ERRORS');
    expect(state.nodeStates.R?.status).toBe('SKIPPED');
    expect(state.completionFailure).toContain('no declared terminal output');
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
    // Error edge routed → the catch branch ran, but a node ERRORED, so the run
    // is honestly COMPLETED_WITH_ERRORS (not a green "success"): the operator
    // must know it didn't cleanly succeed, and auto-diagnosis fires.
    expect(row.status).toBe('COMPLETED_WITH_ERRORS');
    const state = row.runState as { nodeStates: Record<string, { outputData?: Record<string, unknown>; error?: string }> };
    expect(state.nodeStates.C?.outputData).toMatchObject({ caught: true });
    expect(state.nodeStates.X?.error).toBeTruthy();
  });
});

describe('WorkflowEngine - integration credentials', () => {
  it('uses a workspace integration credential when the node has no explicit credentialId', async () => {
    ctx.db.insert(schema.credentials).values({
      id: randomUUID(),
      workspaceId: ctx.workspace.id,
      ambientId: ctx.ambient.id,
      userId: ctx.user.id,
      name: 'Acme CRM',
      credentialType: 'integration_acme_crm',
      encryptedValue: ctx.vault.encrypt(JSON.stringify({ token: 'workspace-token' })),
    }).run();

    const graph: WorkflowGraph = {
      version: 1,
      viewport: { x: 0, y: 0, zoom: 1 },
      nodes: [
        { id: 'T', type: 'trigger', title: 'Manual', position: { x: 0, y: 0 }, config: { kind: 'trigger', triggerType: 'manual' } },
        {
          id: 'crm',
          type: 'integration',
          title: 'Create lead',
          position: { x: 200, y: 0 },
          config: {
            kind: 'integration',
            integrationId: 'acme_crm',
            operationId: 'create_lead',
            inputs: { name: 'Ada' },
          },
        },
      ],
      edges: [{ id: 'e1', source: 'T', target: 'crm' }],
    };
    const wfId = seedWorkflow(graph);
    const runId = await startAndWait(wfId, graph, {});
    const row = loadRun(runId);
    const state = row.runState as { nodeStates: Record<string, { outputData?: Record<string, unknown> }> };

    expect(row.status).toBe('COMPLETED');
    expect(state.nodeStates.crm?.outputData).toMatchObject({
      ok: true,
      operation: 'create_lead',
      token: 'workspace-token',
      name: 'Ada',
    });
  });

  it('runIntegrationOperation invokes a connector standalone, resolving the vault credential by service (backs agentis.integration.call)', async () => {
    // This is the agent-facing path: an agent inside a task calls a connector
    // directly (e.g. vercel.create_deployment) WITHOUT adding a node — the
    // engine still resolves the workspace-bound secret from the vault, so the
    // agent never handles a token.
    ctx.db.insert(schema.credentials).values({
      id: randomUUID(),
      workspaceId: ctx.workspace.id,
      ambientId: ctx.ambient.id,
      userId: ctx.user.id,
      name: 'Acme CRM',
      credentialType: 'integration_acme_crm',
      encryptedValue: ctx.vault.encrypt(JSON.stringify({ token: 'workspace-token' })),
    }).run();

    const result = await engine.runIntegrationOperation(
      ctx.workspace.id,
      'acme_crm',
      'create_lead',
      { name: 'Grace' },
    );

    expect(result).toMatchObject({ ok: true, operation: 'create_lead', token: 'workspace-token', name: 'Grace' });
  });

  it('runIntegrationOperation rejects an unsupported operation with a helpful error', async () => {
    await expect(engine.runIntegrationOperation(ctx.workspace.id, 'acme_crm', 'not_a_real_op', {}))
      .rejects.toThrow(/not supported by acme_crm/);
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

describe('WorkflowEngine - http_request node', () => {
  it('blocks private targets before issuing a network request', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const graph: WorkflowGraph = {
      version: 1,
      viewport: { x: 0, y: 0, zoom: 1 },
      nodes: [
        { id: 'T', type: 'trigger', title: 'Manual', position: { x: 0, y: 0 }, config: { kind: 'trigger', triggerType: 'manual' } },
        { id: 'H', type: 'http_request', title: 'Private', position: { x: 200, y: 0 }, config: { kind: 'http_request', method: 'GET', url: 'http://127.0.0.1:9/private' } },
      ],
      edges: [{ id: 'e1', source: 'T', target: 'H' }],
    };
    const wfId = seedWorkflow(graph);
    const runId = await startAndWait(wfId, graph, {});
    expect(loadRun(runId).status).toBe('FAILED');
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
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

  it('resumes a run by RE-DISPATCHING in-flight non-wait work (AEJ Proposal 1)', async () => {
    // trigger(done) -> transform(was RUNNING at crash). The old engine failed
    // the whole run; AEJ re-dispatches the in-flight node so the run survives.
    const graph: WorkflowGraph = {
      version: 1,
      viewport: { x: 0, y: 0, zoom: 1 },
      nodes: [
        { id: 'T', type: 'trigger', title: 'Manual', position: { x: 0, y: 0 }, config: { kind: 'trigger', triggerType: 'manual' } },
        { id: 'X', type: 'transform', title: 'Work', position: { x: 200, y: 0 }, config: { kind: 'transform', expression: '({ done: true })', isOutput: true } },
      ],
      edges: [{ id: 'e1', source: 'T', target: 'X' }],
    };
    const wfId = seedWorkflow(graph);
    const runId = randomUUID();
    const state = {
      runId, workflowId: wfId, status: 'RUNNING', readyQueue: [], waitingInputs: {},
      nodeStates: {
        T: { nodeId: 'T', status: 'COMPLETED' },
        X: { nodeId: 'X', status: 'RUNNING', inputData: { from: 'trigger' } },
      },
      activeExecutions: {
        X: { taskId: 'task-x', nodeId: 'X', executorType: 'transform', executorRef: 'transform', startedAt: new Date().toISOString(), inputData: { from: 'trigger' } },
      },
      completedNodeIds: ['T'], failedNodeIds: [], skippedNodeIds: [], graphRevision: 1, replanCount: 0, lastLedgerSequence: 0,
    };
    ctx.db.insert(schema.workflowRuns).values({
      id: runId, workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, workflowId: wfId, userId: ctx.user.id, status: 'RUNNING', runState: state,
    }).run();

    const summary = await engine.recoverInterruptedRuns();
    expect(summary.resumed).toBe(1);
    expect(summary.failed).toBe(0);

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout')), 15_000);
      const off = ctx.bus.subscribe((m) => {
        if (m.room === `run:${runId}` && m.envelope.event === REALTIME_EVENTS.RUN_COMPLETED) {
          clearTimeout(timer); off(); resolve();
        }
      });
    });
    expect(loadRun(runId).status).toBe('COMPLETED');
    expect((loadRun(runId).runState as { completedNodeIds: string[] }).completedNodeIds).toContain('X');
  });

  it('fails only a truly unrecoverable run (no workflow graph to resume against)', async () => {
    const runId = randomUUID();
    ctx.db.insert(schema.workflowRuns).values({
      id: runId, workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, workflowId: null, userId: ctx.user.id, status: 'RUNNING',
      runState: { runId, workflowId: null, status: 'RUNNING', readyQueue: [], waitingInputs: {}, nodeStates: {}, activeExecutions: { A: { taskId: 't', nodeId: 'A', executorType: 'agent', executorRef: 'x', startedAt: new Date().toISOString() } }, completedNodeIds: [], failedNodeIds: [], skippedNodeIds: [], graphRevision: 1, replanCount: 0, lastLedgerSequence: 0 },
    }).run();
    const summary = await engine.recoverInterruptedRuns();
    expect(summary.failed).toBe(1);
    expect(loadRun(runId).status).toBe('FAILED');
  });
});

describe('WorkflowEngine — skip propagation (NP, Proposal 3)', () => {
  it('skips an untaken branch subtree (cascade) and still settles COMPLETED', async () => {
    // S gates two branches: the conditional A-branch is NOT taken (output.go is
    // false) so D1 and its tail D3 must be SKIPPED; the B-branch (D2) runs.
    // Before the fix the untaken branch left D1 blocked → run stuck WAITING.
    const graph: WorkflowGraph = {
      version: 1,
      viewport: { x: 0, y: 0, zoom: 1 },
      nodes: [
        { id: 'T', type: 'trigger', title: 'M', position: { x: 0, y: 0 }, config: { kind: 'trigger', triggerType: 'manual' } },
        { id: 'S', type: 'transform', title: 'Gate', position: { x: 200, y: 0 }, config: { kind: 'transform', expression: '({ go: false })' } },
        { id: 'D1', type: 'transform', title: 'A', position: { x: 400, y: -60 }, config: { kind: 'transform', expression: '({ a: 1 })' } },
        { id: 'D3', type: 'transform', title: 'A tail', position: { x: 600, y: -60 }, config: { kind: 'transform', expression: '({ a: 2 })', isOutput: true } },
        { id: 'D2', type: 'transform', title: 'B', position: { x: 400, y: 60 }, config: { kind: 'transform', expression: '({ b: 1 })', isOutput: true } },
      ],
      edges: [
        { id: 'e1', source: 'T', target: 'S' },
        { id: 'e2', source: 'S', target: 'D1', condition: 'output.go' },
        { id: 'e3', source: 'D1', target: 'D3' },
        { id: 'e4', source: 'S', target: 'D2' },
      ],
    };
    const wfId = seedWorkflow(graph);
    const runId = await startAndWait(wfId, graph, {});
    const row = loadRun(runId);
    expect(row.status).toBe('COMPLETED');
    const state = row.runState as { nodeStates: Record<string, { status: string }> };
    expect(state.nodeStates.D2?.status).toBe('COMPLETED');
    expect(state.nodeStates.D1?.status).toBe('SKIPPED');
    expect(state.nodeStates.D3?.status).toBe('SKIPPED');
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

describe('WorkflowEngine - checkpoint approvals', () => {
  it('previews the gated downstream action before asking for approval (generic, any connector)', async () => {
    const graph: WorkflowGraph = {
      version: 1,
      viewport: { x: 0, y: 0, zoom: 1 },
      nodes: [
        { id: 'T', type: 'trigger', title: 'Manual', position: { x: 0, y: 0 }, config: { kind: 'trigger', triggerType: 'manual' } },
        {
          id: 'prepare_message',
          type: 'transform',
          title: 'Prepare Message',
          position: { x: 200, y: 0 },
          config: {
            kind: 'transform',
            expression: JSON.stringify({
              to: 'me@example.com',
              subject: 'Hi Alex',
              text: 'Hi Alex',
            }),
          },
        },
        {
          id: 'approve_email_send',
          type: 'checkpoint',
          title: 'Approve Email Send',
          position: { x: 400, y: 0 },
          config: { kind: 'checkpoint', approvalMode: 'manual' },
        },
        {
          id: 'send_email',
          type: 'integration',
          title: 'Send Email',
          position: { x: 600, y: 0 },
          config: {
            kind: 'integration',
            integrationId: 'agentmail',
            operationId: 'send_message',
            inputs: {
              to: '{{nodes.prepare_message.to}}',
              subject: '{{nodes.prepare_message.subject}}',
              text: '{{nodes.prepare_message.text}}',
            },
          },
        },
      ],
      edges: [
        { id: 'e1', source: 'T', target: 'prepare_message' },
        { id: 'e2', source: 'prepare_message', target: 'approve_email_send' },
        { id: 'e3', source: 'approve_email_send', target: 'send_email' },
      ],
    };
    const wfId = seedWorkflow(graph);
    const runId = randomUUID();
    const initialState = buildInitialRunState({ runId, workflowId: wfId, graph, inputs: {} });
    ctx.db.insert(schema.workflowRuns).values({
      id: runId,
      workspaceId: ctx.workspace.id,
      ambientId: ctx.ambient.id,
      workflowId: wfId,
      userId: ctx.user.id,
      status: 'CREATED',
      runState: initialState,
    }).run();

    void engine.startRun({
      workspaceId: ctx.workspace.id,
      ambientId: ctx.ambient.id,
      workflowId: wfId,
      userId: ctx.user.id,
      triggerId: null,
      inputs: {},
      initialState,
      graph,
    });

    const approval = await waitForCheckpointApproval();
    // Generic action preview — the engine describes whatever side-effecting node
    // the checkpoint guards (here an integration), connector-agnostic.
    expect(approval.summary).toContain('Send Email (agentmail');
    expect(approval.summary).toContain('to: me@example.com');
    expect(approval.summary).toContain('subject: Hi Alex');
    expect(loadRun(runId).status).toBe('WAITING');
  });
});
