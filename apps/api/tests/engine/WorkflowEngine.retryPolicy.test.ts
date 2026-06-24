/**
 * WorkflowEngine — generic per-node retryPolicy.
 *
 * A non-agent node (here an `integration`) with a retryPolicy is re-dispatched on
 * transient failure BEFORE error-edge routing: it succeeds if a later attempt
 * works, exhausts at maxAttempts then fails, and without a policy fails on the
 * first error.
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
beforeEach(async () => { ctx = await createTestContext(); });
afterEach(() => ctx.close());

/** A connector whose `execute` runs `behavior(callCount)` — throw to fail, return to pass. */
function mockConnectors(behavior: (call: number) => Record<string, unknown>): { reg: ConnectorRegistry; calls: () => number } {
  let calls = 0;
  const reg = {
    has: (id: string) => id === 'mock',
    execute: async () => { calls += 1; return behavior(calls); },
  } as unknown as ConnectorRegistry;
  return { reg, calls: () => calls };
}

function waitForRunStatus(runId: string, target: 'COMPLETED' | 'FAILED'): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const evt = target === 'COMPLETED' ? REALTIME_EVENTS.RUN_COMPLETED : REALTIME_EVENTS.RUN_FAILED;
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${target}`)), 15_000);
    const off = ctx.bus.subscribe((m) => {
      if (m.room === `run:${runId}` && m.envelope.event === evt) { clearTimeout(timer); off(); resolve(); }
    });
  });
}

async function runIntegration(opts: {
  connectors: ConnectorRegistry;
  retryPolicy?: { maxAttempts: number; backoffMs?: number };
}): Promise<{ runId: string; retries: number; status: string }> {
  const node: Record<string, unknown> = {
    id: 'I', type: 'integration', title: 'call', position: { x: 100, y: 0 },
    config: { kind: 'integration', integrationId: 'mock', operationId: 'do', inputs: {} },
  };
  if (opts.retryPolicy) node.retryPolicy = opts.retryPolicy;
  const graph = {
    version: 1,
    viewport: { x: 0, y: 0, zoom: 1 },
    nodes: [
      { id: 'T', type: 'trigger', title: 'trigger', position: { x: 0, y: 0 }, config: { kind: 'trigger', triggerType: 'manual' } },
      node,
    ],
    edges: [{ id: 'e1', source: 'T', target: 'I' }],
  } as unknown as WorkflowGraph;

  const wfId = randomUUID();
  const runId = randomUUID();
  ctx.db.insert(schema.workflows).values({ id: wfId, workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id, title: 'retry-wf', graph, settings: {} }).run();
  ctx.db.insert(schema.workflowRuns).values({ id: runId, workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, workflowId: wfId, userId: ctx.user.id, status: 'CREATED', runState: {} }).run();

  let retries = 0;
  const off = ctx.bus.subscribe((m) => {
    if (m.room === `run:${runId}` && m.envelope.event === REALTIME_EVENTS.NODE_RETRY_SCHEDULED) retries += 1;
  });

  const engine = new WorkflowEngine({
    db: ctx.db, bus: ctx.bus, logger: ctx.logger,
    ledger: new LedgerService(ctx.db, ctx.bus),
    scratchpad: new ScratchpadService(ctx.bus, ctx.logger),
    activity: new ActivityFeedService(ctx.db, ctx.bus),
    approvals: new ApprovalInboxService(ctx.db, ctx.bus),
    extensions: {} as unknown as ExtensionRuntime,
    adapters: new AdapterManager(ctx.logger),
    connectors: opts.connectors,
  });

  const initialState = buildInitialRunState({ runId, workflowId: wfId, graph, inputs: {} });
  const completed = waitForRunStatus(runId, 'COMPLETED').then(() => 'COMPLETED').catch(() => null);
  const failed = waitForRunStatus(runId, 'FAILED').then(() => 'FAILED').catch(() => null);
  await engine.startRun({ workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, workflowId: wfId, userId: ctx.user.id, triggerId: null, inputs: {}, initialState, graph });
  const status = (await Promise.race([completed, failed])) ?? 'UNKNOWN';
  off();
  const row = ctx.db.select().from(schema.workflowRuns).where(eq(schema.workflowRuns.id, runId)).get()!;
  return { runId, retries, status: row.status ?? status };
}

describe('WorkflowEngine — generic retryPolicy', () => {
  it('retries a transient failure and succeeds on a later attempt', async () => {
    const { reg, calls } = mockConnectors((call) => {
      if (call === 1) throw new Error('transient 503 upstream');
      return { ok: true };
    });
    const res = await runIntegration({ connectors: reg, retryPolicy: { maxAttempts: 2, backoffMs: 5 } });
    expect(calls()).toBe(2);     // failed once, retried once, succeeded
    expect(res.retries).toBe(1); // one NODE_RETRY_SCHEDULED
    expect(res.status).toBe('COMPLETED');
  });

  it('exhausts maxAttempts then fails the run', async () => {
    const { reg, calls } = mockConnectors(() => { throw new Error('always 500'); });
    const res = await runIntegration({ connectors: reg, retryPolicy: { maxAttempts: 2, backoffMs: 5 } });
    expect(calls()).toBe(3);     // initial + 2 retries
    expect(res.retries).toBe(2);
    expect(res.status).toBe('FAILED');
  });

  it('without a retryPolicy, fails on the first error (no retries)', async () => {
    const { reg, calls } = mockConnectors(() => { throw new Error('boom'); });
    const res = await runIntegration({ connectors: reg });
    expect(calls()).toBe(1);
    expect(res.retries).toBe(0);
    expect(res.status).toBe('FAILED');
  });
});
