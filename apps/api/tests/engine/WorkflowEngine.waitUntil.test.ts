/**
 * WorkflowEngine — `wait` until an absolute datetime (`untilIso`).
 *
 * A future ISO time waits then resumes; a past time completes instantly; an
 * invalid time fails the node. Enables "send Monday 9am" / SLA-style schedules
 * instead of only a relative `delayMs`.
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
beforeEach(async () => { ctx = await createTestContext(); });
afterEach(() => ctx.close());

async function runWaitUntil(untilIso: string): Promise<{ status: string; elapsedMs: number }> {
  const graph = {
    version: 1,
    viewport: { x: 0, y: 0, zoom: 1 },
    nodes: [
      { id: 'T', type: 'trigger', title: 't', position: { x: 0, y: 0 }, config: { kind: 'trigger', triggerType: 'manual' } },
      { id: 'W', type: 'wait', title: 'w', position: { x: 1, y: 0 }, config: { kind: 'wait', delayMs: 0, untilIso } },
      { id: 'O', type: 'return_output', title: 'o', position: { x: 2, y: 0 }, config: { kind: 'return_output', renderAs: 'json' } },
    ],
    edges: [{ id: 'e1', source: 'T', target: 'W' }, { id: 'e2', source: 'W', target: 'O' }],
  } as unknown as WorkflowGraph;

  const wfId = randomUUID();
  const runId = randomUUID();
  ctx.db.insert(schema.workflows).values({ id: wfId, workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id, title: 'wait-wf', graph, settings: {} }).run();
  ctx.db.insert(schema.workflowRuns).values({ id: runId, workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, workflowId: wfId, userId: ctx.user.id, status: 'CREATED', runState: {} }).run();

  const engine = new WorkflowEngine({
    db: ctx.db, bus: ctx.bus, logger: ctx.logger,
    ledger: new LedgerService(ctx.db, ctx.bus),
    scratchpad: new ScratchpadService(ctx.bus, ctx.logger),
    activity: new ActivityFeedService(ctx.db, ctx.bus),
    approvals: new ApprovalInboxService(ctx.db, ctx.bus),
    extensions: {} as unknown as ExtensionRuntime,
    adapters: new AdapterManager(ctx.logger),
  });

  const terminal = new Promise<string>((resolve) => {
    const off = ctx.bus.subscribe((m) => {
      if (m.room !== `run:${runId}`) return;
      if (m.envelope.event === REALTIME_EVENTS.RUN_COMPLETED) { off(); resolve('COMPLETED'); }
      else if (m.envelope.event === REALTIME_EVENTS.RUN_FAILED) { off(); resolve('FAILED'); }
    });
  });

  const initialState = buildInitialRunState({ runId, workflowId: wfId, graph, inputs: {} });
  const started = Date.now();
  await engine.startRun({ workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, workflowId: wfId, userId: ctx.user.id, triggerId: null, inputs: {}, initialState, graph });
  const status = await terminal;
  const row = ctx.db.select().from(schema.workflowRuns).where(eq(schema.workflowRuns.id, runId)).get()!;
  return { status: row.status ?? status, elapsedMs: Date.now() - started };
}

describe('WorkflowEngine — wait untilIso', () => {
  it('waits until a future timestamp, then resumes to COMPLETED', async () => {
    const future = new Date(Date.now() + 250).toISOString();
    const { status, elapsedMs } = await runWaitUntil(future);
    expect(status).toBe('COMPLETED');
    // It actually waited — not an instant completion.
    expect(elapsedMs).toBeGreaterThanOrEqual(150);
  });

  it('completes instantly for a timestamp already in the past', async () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    const { status, elapsedMs } = await runWaitUntil(past);
    expect(status).toBe('COMPLETED');
    expect(elapsedMs).toBeLessThan(1000);
  });

  it('fails the node on an invalid ISO timestamp', async () => {
    const { status } = await runWaitUntil('not-a-real-date');
    expect(status).toBe('FAILED');
  });
});
