/**
 * Layer 5 §5.1 — Phase human-gate enforcement.
 *
 * A phase with a humanGate pauses before its first node runs (run → WAITING,
 * approval created). Approving releases the held nodes and the run completes;
 * rejecting fails the run.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { eq } from 'drizzle-orm';
import type { WorkflowGraph } from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import { WorkflowEngine } from '../../src/engine/WorkflowEngine.js';
import { buildInitialRunState } from '../../src/engine/initialRunState.js';
import { LedgerService } from '../../src/services/ledger.js';
import { ScratchpadService } from '../../src/services/scratchpad.js';
import { ActivityFeedService } from '../../src/services/activityFeed.js';
import { ApprovalInboxService } from '../../src/services/approvalInbox.js';
import { AdapterManager } from '../../src/adapters/AdapterManager.js';
import type { SkillRuntime } from '../../src/services/skillRuntime.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

let ctx: TestContext;
let engine: WorkflowEngine;
let approvals: ApprovalInboxService;

beforeEach(async () => {
  ctx = await createTestContext();
  approvals = new ApprovalInboxService(ctx.db, ctx.bus);
  engine = new WorkflowEngine({
    db: ctx.db, bus: ctx.bus, logger: ctx.logger,
    ledger: new LedgerService(ctx.db, ctx.bus),
    scratchpad: new ScratchpadService(ctx.bus, ctx.logger),
    activity: new ActivityFeedService(ctx.db, ctx.bus),
    approvals,
    skills: {} as unknown as SkillRuntime,
    adapters: new AdapterManager(ctx.logger),
  });
  // Mirror the bootstrap wiring: approval resolution drives the engine.
  approvals.bindCheckpointHandler(async ({ runId, approvalId, decision }) => {
    await engine.resolveApproval({ runId, approvalId, decision });
  });
});

afterEach(() => ctx.close());

function gatedGraph(): WorkflowGraph {
  return {
    version: 1,
    viewport: { x: 0, y: 0, zoom: 1 },
    nodes: [
      { id: 'T', type: 'trigger', title: 'Manual', position: { x: 0, y: 0 }, config: { kind: 'trigger', triggerType: 'manual' } },
      { id: 'A', type: 'transform', title: 'Gated work', position: { x: 200, y: 0 }, config: { kind: 'transform', expression: '({ ok: true })' } },
      { id: 'R', type: 'return_output', title: 'Return', position: { x: 400, y: 0 }, config: { kind: 'return_output', renderAs: 'json' } },
    ],
    edges: [{ id: 'e1', source: 'T', target: 'A' }, { id: 'e2', source: 'A', target: 'R' }],
    phases: [{ id: 'p1', name: 'Approval Phase', color: '#fff', nodeIds: ['A', 'R'], humanGate: { type: 'approve', message: 'Proceed?' } }],
  } as WorkflowGraph;
}

function startRun(graph: WorkflowGraph): { runId: string } {
  const wfId = randomUUID();
  ctx.db.insert(schema.workflows).values({
    id: wfId, workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id,
    title: 'gate', graph, settings: {},
  }).run();
  const runId = randomUUID();
  const initialState = buildInitialRunState({ runId, workflowId: wfId, graph, inputs: {} });
  ctx.db.insert(schema.workflowRuns).values({
    id: runId, workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, workflowId: wfId,
    userId: ctx.user.id, status: 'CREATED', runState: initialState,
  }).run();
  void engine.startRun({
    workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, workflowId: wfId, userId: ctx.user.id,
    triggerId: null, inputs: {}, initialState, graph,
  });
  return { runId };
}

async function waitForApproval(): Promise<{ id: string }> {
  for (let i = 0; i < 100; i += 1) {
    const pending = approvals.list(ctx.workspace.id, 'pending').find((a) => a.source === 'phase_gate');
    if (pending) return { id: pending.id };
    await sleep(20);
  }
  throw new Error('no approval created');
}

async function waitForStatus(runId: string, status: string): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    if (loadRun(runId).status === status) return;
    await sleep(20);
  }
  throw new Error(`run did not reach ${status} (got ${loadRun(runId).status})`);
}

function loadRun(runId: string) {
  return ctx.db.select().from(schema.workflowRuns).where(eq(schema.workflowRuns.id, runId)).get()!;
}

describe('WorkflowEngine — phase human gate', () => {
  it('pauses the run until approved, then completes', async () => {
    const { runId } = startRun(gatedGraph());
    const approval = await waitForApproval();
    expect(approval.id).toBeTruthy();
    // The gate held the phase: A did not run.
    let state = loadRun(runId).runState as { completedNodeIds: string[]; status: string };
    expect(state.completedNodeIds).not.toContain('A');

    await approvals.resolve({ workspaceId: ctx.workspace.id, approvalId: approval.id, decision: 'approve' });
    await waitForStatus(runId, 'COMPLETED');

    const row = loadRun(runId);
    expect(row.status).toBe('COMPLETED');
    state = row.runState as { completedNodeIds: string[]; status: string };
    expect(state.completedNodeIds).toEqual(expect.arrayContaining(['A', 'R']));
  });

  it('fails the run when the gate is rejected', async () => {
    const { runId } = startRun(gatedGraph());
    const approval = await waitForApproval();
    await approvals.resolve({ workspaceId: ctx.workspace.id, approvalId: approval.id, decision: 'reject' });
    await waitForStatus(runId, 'FAILED');
    expect(loadRun(runId).status).toBe('FAILED');
  });
});
