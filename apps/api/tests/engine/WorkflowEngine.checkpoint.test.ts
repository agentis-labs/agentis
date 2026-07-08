/**
 * WorkflowEngine — checkpoint `auto_after_timeout`.
 *
 * A checkpoint with approvalMode 'auto_after_timeout' must resume the run on its
 * own after timeoutMs, with NO operator decision — going through the same
 * ApprovalInboxService.resolve path an operator would, so the approval row is
 * marked resolved and the run completes.
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
import type { ExtensionRuntime } from '../../src/services/extensionRuntime.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

let ctx: TestContext;

beforeEach(async () => {
  ctx = await createTestContext();
});
afterEach(() => ctx.close());

function waitForRunStatus(runId: string, target: 'COMPLETED' | 'FAILED'): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const evt = target === 'COMPLETED' ? REALTIME_EVENTS.RUN_COMPLETED : REALTIME_EVENTS.RUN_FAILED;
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${target}`)), 15_000);
    const off = ctx.bus.subscribe((m) => {
      if (m.room === `run:${runId}` && m.envelope.event === evt) {
        clearTimeout(timer);
        off();
        resolve();
      }
    });
  });
}

describe('WorkflowEngine — checkpoint auto_after_timeout', () => {
  it('auto-approves and resumes the run after the timeout, with no operator action', async () => {
    const graph: WorkflowGraph = {
      version: 1,
      viewport: { x: 0, y: 0, zoom: 1 },
      nodes: [
        { id: 'T', type: 'trigger', title: 'trigger', position: { x: 0, y: 0 }, config: { kind: 'trigger', triggerType: 'manual' } },
        { id: 'CP', type: 'checkpoint', title: 'gate', position: { x: 100, y: 0 }, config: { kind: 'checkpoint', approvalMode: 'auto_after_timeout', timeoutMs: 50 } },
        { id: 'OUT', type: 'return_output', title: 'out', position: { x: 200, y: 0 }, config: { kind: 'return_output', renderAs: 'json' } },
      ],
      edges: [
        { id: 'e1', source: 'T', target: 'CP' },
        { id: 'e2', source: 'CP', target: 'OUT' },
      ],
    };

    const wfId = randomUUID();
    const runId = randomUUID();
    ctx.db.insert(schema.workflows).values({
      id: wfId, workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id, title: 'cp-wf', graph, settings: {},
    }).run();
    ctx.db.insert(schema.workflowRuns).values({
      id: runId, workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, workflowId: wfId, userId: ctx.user.id, status: 'CREATED', runState: {},
    }).run();

    const approvals = new ApprovalInboxService(ctx.db, ctx.bus);
    const engine = new WorkflowEngine({
      db: ctx.db,
      bus: ctx.bus,
      logger: ctx.logger,
      ledger: new LedgerService(ctx.db, ctx.bus),
      scratchpad: new ScratchpadService(ctx.bus, ctx.logger),
      activity: new ActivityFeedService(ctx.db, ctx.bus),
      approvals,
      extensions: {} as unknown as ExtensionRuntime,
      adapters: new AdapterManager(ctx.logger),
    });
    // Wire the resume path exactly as bootstrap does.
    approvals.bindCheckpointHandler(async ({ runId: rid, approvalId, decision }) => {
      await engine.resolveApproval({ runId: rid, approvalId, decision });
    });

    const initialState = buildInitialRunState({ runId, workflowId: wfId, graph, inputs: { seed: 'go' } });
    const done = waitForRunStatus(runId, 'COMPLETED');
    await engine.startRun({
      workspaceId: ctx.workspace.id,
      ambientId: ctx.ambient.id,
      workflowId: wfId,
      userId: ctx.user.id,
      triggerId: null,
      inputs: { seed: 'go' },
      initialState,
      graph,
    });

    // No operator decision is ever made — the timer must drive completion.
    await done;

    const row = ctx.db.select().from(schema.workflowRuns).where(eq(schema.workflowRuns.id, runId)).get()!;
    expect(row.status).toBe('COMPLETED');
    // The approval row was resolved by the auto-timeout, not left dangling.
    const approvalRows = ctx.db.select().from(schema.approvalRequests).where(eq(schema.approvalRequests.runId, runId)).all();
    expect(approvalRows).toHaveLength(1);
    expect(approvalRows[0]!.status).toBe('approved');
    expect(approvalRows[0]!.resolutionReason).toMatch(/auto-approved/i);
  });
});
