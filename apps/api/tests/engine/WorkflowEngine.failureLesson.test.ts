/**
 * WorkflowEngine — learn from an instructive node failure (COGNITIVE-LOOPING
 * "fail-forward, don't dead-end"). The engine emits every hard node failure via
 * `recordFailureLesson`; the wiring turns instructive ones into playbook lessons
 * that build_workflow recalls. Here we prove the engine actually emits it with
 * the failing node's error + identity.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { REALTIME_EVENTS, type WorkflowGraph } from '@agentis/core';
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
afterEach(() => ctx.close());

interface LessonCall { workspaceId: string; workflowId: string; nodeId: string; nodeTitle: string; error: string; agentId: string | null }

it('emits recordFailureLesson with the failing node + error on a hard failure', async () => {
  const lessons: LessonCall[] = [];
  const graph = {
    version: 1, viewport: { x: 0, y: 0, zoom: 1 },
    nodes: [
      { id: 'T', type: 'trigger', title: 'Manual', position: { x: 0, y: 0 }, config: { kind: 'trigger', triggerType: 'manual' } },
      { id: 'G', type: 'stop_error', title: 'ICP Guard', position: { x: 1, y: 0 }, config: { kind: 'stop_error', errorMessage: 'BLOCKED_UNRESOLVED_BIO_LINK: bio link must be resolved before ICP' } },
    ],
    edges: [{ id: 'e1', source: 'T', target: 'G' }],
  } as unknown as WorkflowGraph;

  const wfId = randomUUID();
  ctx.db.insert(schema.workflows).values({ id: wfId, workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id, title: 'Fashion Store', graph, settings: {} }).run();
  const runId = randomUUID();
  const initialState = buildInitialRunState({ runId, workflowId: wfId, graph, inputs: {} });
  ctx.db.insert(schema.workflowRuns).values({ id: runId, workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, workflowId: wfId, userId: ctx.user.id, status: 'CREATED', runState: initialState as unknown as object }).run();

  const ledger = new LedgerService(ctx.db, ctx.bus);
  const engine = new WorkflowEngine({
    db: ctx.db, bus: ctx.bus, logger: ctx.logger,
    ledger, scratchpad: new ScratchpadService(ctx.bus, ctx.logger),
    activity: new ActivityFeedService(ctx.db, ctx.bus),
    approvals: new ApprovalInboxService(ctx.db, ctx.bus),
    extensions: {} as unknown as ExtensionRuntime,
    adapters: new AdapterManager(ctx.logger),
    recordFailureLesson: (a) => { lessons.push(a); },
  });

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), 15_000);
    const off = ctx.bus.subscribe((m) => {
      if (m.room === `run:${runId}` && (m.envelope.event === REALTIME_EVENTS.RUN_FAILED || m.envelope.event === REALTIME_EVENTS.RUN_COMPLETED)) { clearTimeout(timer); off(); resolve(); }
    });
    void engine.startRun({ workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, workflowId: wfId, userId: ctx.user.id, triggerId: null, inputs: {}, initialState, graph });
  });

  const call = lessons.find((l) => l.nodeId === 'G');
  expect(call).toBeDefined();
  expect(call!.error).toContain('BLOCKED_UNRESOLVED_BIO_LINK');
  expect(call!.nodeTitle).toBe('ICP Guard');
  expect(call!.workflowId).toBe(wfId);
  expect(call!.workspaceId).toBe(ctx.workspace.id);
});
