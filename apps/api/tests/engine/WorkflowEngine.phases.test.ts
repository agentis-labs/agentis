/**
 * Layer 5 — Phases as execution primitives: budget governance + SLA tracking.
 *
 * Budget overrun halts the run (FAILED + BUDGET_PHASE_EXCEEDED). SLA breach
 * emits PHASE_SLA_BREACHED but the run still completes.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
import type { SkillRuntime } from '../../src/services/skillRuntime.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

let ctx: TestContext;
let engine: WorkflowEngine;

beforeEach(async () => {
  ctx = await createTestContext();
  engine = new WorkflowEngine({
    db: ctx.db, bus: ctx.bus, logger: ctx.logger,
    ledger: new LedgerService(ctx.db, ctx.bus),
    scratchpad: new ScratchpadService(ctx.bus, ctx.logger),
    activity: new ActivityFeedService(ctx.db, ctx.bus),
    approvals: new ApprovalInboxService(ctx.db, ctx.bus),
    skills: {} as unknown as SkillRuntime,
    adapters: new AdapterManager(ctx.logger),
  });
});

afterEach(() => ctx.close());

function seedWorkflow(graph: WorkflowGraph) {
  const wfId = randomUUID();
  ctx.db.insert(schema.workflows).values({
    id: wfId, workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id,
    title: 'phases', graph, settings: {},
  }).run();
  return wfId;
}

function run(wfId: string, graph: WorkflowGraph, events: string[]): Promise<string> {
  const runId = randomUUID();
  const initialState = buildInitialRunState({ runId, workflowId: wfId, graph, inputs: {} });
  ctx.db.insert(schema.workflowRuns).values({
    id: runId, workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, workflowId: wfId,
    userId: ctx.user.id, status: 'CREATED', runState: initialState,
  }).run();
  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), 15_000);
    const off = ctx.bus.subscribe((m) => {
      if (m.room === `run:${runId}`) {
        events.push(m.envelope.event);
        if (m.envelope.event === REALTIME_EVENTS.RUN_COMPLETED || m.envelope.event === REALTIME_EVENTS.RUN_FAILED) {
          clearTimeout(timer); off(); resolve(runId);
        }
      }
    });
    void engine.startRun({
      workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, workflowId: wfId, userId: ctx.user.id,
      triggerId: null, inputs: {}, initialState, graph,
    });
  });
}

function loadRun(runId: string) {
  return ctx.db.select().from(schema.workflowRuns).where(eq(schema.workflowRuns.id, runId)).get()!;
}

describe('WorkflowEngine — phase budget governance', () => {
  it('halts the run when a phase exceeds its budget', async () => {
    const graph: WorkflowGraph = {
      version: 1,
      viewport: { x: 0, y: 0, zoom: 1 },
      nodes: [
        { id: 'T', type: 'trigger', title: 'Manual', position: { x: 0, y: 0 }, config: { kind: 'trigger', triggerType: 'manual' } },
        { id: 'A', type: 'transform', title: 'Pricey', position: { x: 200, y: 0 }, config: { kind: 'transform', expression: '({ ok: 1 })', estimatedCostCents: 50 } },
        { id: 'B', type: 'transform', title: 'After', position: { x: 400, y: 0 }, config: { kind: 'transform', expression: '({ ok: 2 })' } },
      ],
      edges: [{ id: 'e1', source: 'T', target: 'A' }, { id: 'e2', source: 'A', target: 'B' }],
      phases: [{ id: 'p1', name: 'Pricey Phase', color: '#fff', nodeIds: ['A', 'B'], budgetCents: 10 }],
    } as WorkflowGraph;
    const wfId = seedWorkflow(graph);
    const events: string[] = [];
    const runId = await run(wfId, graph, events);
    expect(loadRun(runId).status).toBe('FAILED');
    expect(events).toContain(REALTIME_EVENTS.BUDGET_PHASE_EXCEEDED);
    // B never ran — halted before fan-out.
    const state = loadRun(runId).runState as { completedNodeIds: string[] };
    expect(state.completedNodeIds).not.toContain('B');
  });
});

describe('WorkflowEngine — phase SLA tracking', () => {
  it('emits PHASE_SLA_BREACHED but still completes the run', async () => {
    const graph: WorkflowGraph = {
      version: 1,
      viewport: { x: 0, y: 0, zoom: 1 },
      nodes: [
        { id: 'T', type: 'trigger', title: 'Manual', position: { x: 0, y: 0 }, config: { kind: 'trigger', triggerType: 'manual' } },
        { id: 'W', type: 'wait', title: 'Slow', position: { x: 200, y: 0 }, config: { kind: 'wait', delayMs: 120 } },
      ],
      edges: [{ id: 'e1', source: 'T', target: 'W' }],
      phases: [{ id: 'p1', name: 'Slow Phase', color: '#fff', nodeIds: ['W'], slaDurationMs: 20 }],
    } as WorkflowGraph;
    const wfId = seedWorkflow(graph);
    const events: string[] = [];
    const runId = await run(wfId, graph, events);
    expect(loadRun(runId).status).toBe('COMPLETED');
    expect(events).toContain(REALTIME_EVENTS.PHASE_SLA_BREACHED);
    expect(events).toContain(REALTIME_EVENTS.PHASE_STARTED);
  });
});
