/**
 * WorkflowEngine — per-node dispatch ceiling (masterplan 1.4 infinite-cycle backstop).
 *
 * A node that keeps getting re-dispatched (here via a retryPolicy that always
 * fails) is capped: once it exceeds the ceiling the RUN fails, so unbounded
 * re-dispatch (author cycle / runaway self-heal / planner loop) can't burn
 * limitless cost.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { REALTIME_EVENTS, type WorkflowGraph } from '@agentis/core';
import type { ConnectorRegistry } from '@agentis/integrations';
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
const original = process.env.AGENTIS_NODE_DISPATCH_CEILING;
beforeEach(async () => { ctx = await createTestContext(); });
afterEach(() => {
  ctx.close();
  if (original === undefined) delete process.env.AGENTIS_NODE_DISPATCH_CEILING;
  else process.env.AGENTIS_NODE_DISPATCH_CEILING = original;
});

describe('WorkflowEngine — node dispatch ceiling', () => {
  it('fails the run once a node exceeds the dispatch ceiling', async () => {
    process.env.AGENTIS_NODE_DISPATCH_CEILING = '3';
    let calls = 0;
    const connectors = {
      has: (id: string) => id === 'mock',
      execute: async () => { calls += 1; throw new Error('always fails'); },
    } as unknown as ConnectorRegistry;

    const graph = {
      version: 1, viewport: { x: 0, y: 0, zoom: 1 },
      nodes: [
        { id: 'T', type: 'trigger', title: 't', position: { x: 0, y: 0 }, config: { kind: 'trigger', triggerType: 'manual' } },
        // retryPolicy keeps re-dispatching the node; the ceiling (3) trips first.
        { id: 'I', type: 'integration', title: 'i', position: { x: 1, y: 0 }, config: { kind: 'integration', integrationId: 'mock', operationId: 'do', inputs: {} }, retryPolicy: { maxAttempts: 20, backoffMs: 1 } },
      ],
      edges: [{ id: 'e1', source: 'T', target: 'I' }],
    } as unknown as WorkflowGraph;

    const wfId = randomUUID();
    const runId = randomUUID();
    ctx.db.insert(schema.workflows).values({ id: wfId, workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id, title: 'wf', graph, settings: {} }).run();
    ctx.db.insert(schema.workflowRuns).values({ id: runId, workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, workflowId: wfId, userId: ctx.user.id, status: 'CREATED', runState: {} }).run();

    const engine = new WorkflowEngine({
      db: ctx.db, bus: ctx.bus, logger: ctx.logger,
      ledger: new LedgerService(ctx.db, ctx.bus),
      scratchpad: new ScratchpadService(ctx.bus, ctx.logger),
      activity: new ActivityFeedService(ctx.db, ctx.bus),
      approvals: new ApprovalInboxService(ctx.db, ctx.bus),
      extensions: {} as unknown as ExtensionRuntime,
      adapters: new AdapterManager(ctx.logger),
      connectors,
    });

    const initialState = buildInitialRunState({ runId, workflowId: wfId, graph, inputs: {} });
    await new Promise<void>((resolve) => {
      const off = ctx.bus.subscribe((m) => {
        if (m.room === `run:${runId}` && m.envelope.event === REALTIME_EVENTS.RUN_FAILED) { off(); resolve(); }
      });
      void engine.startRun({ workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, workflowId: wfId, userId: ctx.user.id, triggerId: null, inputs: {}, initialState, graph });
    });
    // Let any already-scheduled retry timers fire (they re-trip the ceiling, no-op).
    await new Promise((r) => setTimeout(r, 50));

    const run = ctx.db.select().from(schema.workflowRuns).where(eq(schema.workflowRuns.id, runId)).get()!;
    expect(run.status).toBe('FAILED');
    // The connector ran only up to the ceiling (3), not the full 20 retry attempts.
    expect(calls).toBe(3);
  });
});
