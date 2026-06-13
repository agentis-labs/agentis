/**
 * Tier-3 Workspace KV (§4.1) + Audit Trail (§5.4).
 *
 * Verifies workspace_store set/increment persistence across runs, the
 * `{{workspace.kv.*}}` interpolation namespace, and that the engine records an
 * audit trail (run + node lifecycle).
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
import { WorkspaceStoreService } from '../../src/services/workspaceStore.js';
import { AuditTrailService } from '../../src/services/auditTrail.js';
import type { ExtensionRuntime } from '../../src/services/extensionRuntime.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

let ctx: TestContext;
let engine: WorkflowEngine;
let workspaceStore: WorkspaceStoreService;
let audit: AuditTrailService;

beforeEach(async () => {
  ctx = await createTestContext();
  workspaceStore = new WorkspaceStoreService(ctx.db);
  audit = new AuditTrailService(ctx.db, ctx.logger);
  engine = new WorkflowEngine({
    db: ctx.db,
    bus: ctx.bus,
    logger: ctx.logger,
    ledger: new LedgerService(ctx.db, ctx.bus),
    scratchpad: new ScratchpadService(ctx.bus, ctx.logger),
    activity: new ActivityFeedService(ctx.db, ctx.bus),
    approvals: new ApprovalInboxService(ctx.db, ctx.bus),
    skills: {} as unknown as ExtensionRuntime,
    adapters: new AdapterManager(ctx.logger),
    workspaceStore,
    audit,
  });
});

afterEach(() => ctx.close());

function seedWorkflow(graph: WorkflowGraph) {
  const wfId = randomUUID();
  ctx.db.insert(schema.workflows).values({
    id: wfId, workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id,
    title: 'tier3', graph, settings: {},
  }).run();
  return wfId;
}

async function startAndWait(wfId: string, graph: WorkflowGraph): Promise<string> {
  const runId = randomUUID();
  const initialState = buildInitialRunState({ runId, workflowId: wfId, graph, inputs: {} });
  ctx.db.insert(schema.workflowRuns).values({
    id: runId, workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, workflowId: wfId,
    userId: ctx.user.id, status: 'CREATED', runState: initialState,
  }).run();
  await engine.startRun({
    workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, workflowId: wfId, userId: ctx.user.id,
    triggerId: null, inputs: {}, initialState, graph,
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), 15_000);
    const off = ctx.bus.subscribe((m) => {
      if (m.room === `run:${runId}` && (m.envelope.event === REALTIME_EVENTS.RUN_COMPLETED || m.envelope.event === REALTIME_EVENTS.RUN_FAILED)) {
        clearTimeout(timer); off(); resolve();
      }
    });
  });
  return runId;
}

describe('WorkflowEngine — Tier-3 workspace_store + {{workspace.kv.*}}', () => {
  it('persists workspace KV across runs and interpolates it downstream', async () => {
    const graph: WorkflowGraph = {
      version: 1,
      viewport: { x: 0, y: 0, zoom: 1 },
      nodes: [
        { id: 'T', type: 'trigger', title: 'Manual', position: { x: 0, y: 0 }, config: { kind: 'trigger', triggerType: 'manual' } },
        { id: 'S1', type: 'workspace_store', title: 'Set', position: { x: 200, y: 0 }, config: { kind: 'workspace_store', operations: [
          { op: 'set', key: 'greeting', value: 'hi' },
          { op: 'increment', key: 'runs', incrementBy: 1, outputKey: 'runs' },
        ] } },
        { id: 'S2', type: 'workspace_store', title: 'Echo', position: { x: 400, y: 0 }, config: { kind: 'workspace_store', operations: [
          { op: 'set', key: 'echoed', value: '{{workspace.kv.greeting}}' },
        ] } },
      ],
      edges: [
        { id: 'e1', source: 'T', target: 'S1' },
        { id: 'e2', source: 'S1', target: 'S2' },
      ],
    };
    const wfId = seedWorkflow(graph);

    await startAndWait(wfId, graph);
    expect(workspaceStore.get(ctx.workspace.id, 'greeting')).toBe('hi');
    expect(workspaceStore.get(ctx.workspace.id, 'runs')).toBe(1);
    // {{workspace.kv.greeting}} resolved at S2's dispatch (after S1 committed).
    expect(workspaceStore.get(ctx.workspace.id, 'echoed')).toBe('hi');

    await sleep(5);
    await startAndWait(wfId, graph);
    expect(workspaceStore.get(ctx.workspace.id, 'runs')).toBe(2); // survives across runs
  });
});

describe('WorkflowEngine — audit trail', () => {
  it('records run + node lifecycle entries', async () => {
    const graph: WorkflowGraph = {
      version: 1,
      viewport: { x: 0, y: 0, zoom: 1 },
      nodes: [
        { id: 'T', type: 'trigger', title: 'Manual', position: { x: 0, y: 0 }, config: { kind: 'trigger', triggerType: 'manual' } },
        { id: 'X', type: 'transform', title: 'Shape', position: { x: 200, y: 0 }, config: { kind: 'transform', expression: '({ ok: true })' } },
      ],
      edges: [{ id: 'e1', source: 'T', target: 'X' }],
    };
    const wfId = seedWorkflow(graph);
    const runId = await startAndWait(wfId, graph);

    const entries = audit.list(ctx.workspace.id, runId);
    const actions = entries.map((e) => e.action);
    expect(actions).toContain('run.started');
    expect(actions).toContain('node.completed');
    expect(actions).toContain('run.completed');
    // node.completed for the transform node is attributed to the engine (system).
    const xDone = entries.find((e) => e.nodeId === 'X' && e.action === 'node.completed');
    expect(xDone?.actorType).toBe('system');
  });
});
