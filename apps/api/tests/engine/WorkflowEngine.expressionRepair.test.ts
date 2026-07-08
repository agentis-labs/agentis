/**
 * WorkflowEngine — deterministic expression repair (WORKFLOW-RELIABILITY Phase 2,
 * rung 0). A transform that throws on an off-contract reference typo (`inpt`) is
 * repaired in-place (`inpt`→`input`) and retried with ZERO model calls before any
 * self-heal. A reference that is not a confident near-miss still fails honestly.
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

function waitForRunStatus(runId: string, target: 'COMPLETED' | 'FAILED'): Promise<string | null> {
  return new Promise<string>((resolve, reject) => {
    const evt = target === 'COMPLETED' ? REALTIME_EVENTS.RUN_COMPLETED : REALTIME_EVENTS.RUN_FAILED;
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${target}`)), 15_000);
    const off = ctx.bus.subscribe((m) => {
      if (m.room === `run:${runId}` && m.envelope.event === evt) { clearTimeout(timer); off(); resolve(target); }
    });
  }).catch(() => null);
}

async function runTransform(expression: string): Promise<{ status: string; output: unknown; nodeExpression: unknown }> {
  const graph = {
    version: 1,
    viewport: { x: 0, y: 0, zoom: 1 },
    nodes: [
      { id: 'T', type: 'trigger', title: 'trigger', position: { x: 0, y: 0 }, config: { kind: 'trigger', triggerType: 'manual' } },
      { id: 'X', type: 'transform', title: 'shape', position: { x: 100, y: 0 }, config: { kind: 'transform', expression } },
    ],
    edges: [{ id: 'e1', source: 'T', target: 'X' }],
  } as unknown as WorkflowGraph;

  const wfId = randomUUID();
  const runId = randomUUID();
  ctx.db.insert(schema.workflows).values({ id: wfId, workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id, title: 'expr-repair-wf', graph, settings: {} }).run();
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

  const initialState = buildInitialRunState({ runId, workflowId: wfId, graph, inputs: { n: 21 } });
  const done = Promise.race([waitForRunStatus(runId, 'COMPLETED'), waitForRunStatus(runId, 'FAILED')]);
  await engine.startRun({ workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, workflowId: wfId, userId: ctx.user.id, triggerId: null, inputs: { n: 21 }, initialState, graph });
  const status = (await done) ?? 'UNKNOWN';
  const row = ctx.db.select().from(schema.workflowRuns).where(eq(schema.workflowRuns.id, runId)).get()!;
  const state = row.runState as { nodeStates?: Record<string, { outputData?: unknown }> };
  return {
    status: row.status ?? status,
    output: state?.nodeStates?.X?.outputData ?? null,
    nodeExpression: (graph.nodes[1]!.config as { expression?: unknown }).expression,
  };
}

describe('WorkflowEngine — deterministic expression repair (rung 0)', () => {
  it('repairs a near-miss reference typo in a transform and completes (0 tokens)', async () => {
    const res = await runTransform('({ doubled: inpt.n * 2 })');
    expect(res.status).toBe('COMPLETED');
    expect(res.output).toEqual({ doubled: 42 });
    // The live graph node was repaired in place so the fix is durable for the run.
    expect(res.nodeExpression).toBe('({ doubled: input.n * 2 })');
  });

  it('still fails honestly when the reference cannot be confidently repaired', async () => {
    const res = await runTransform('({ x: totallyUnknownThing.value })');
    expect(res.status).toBe('FAILED');
  });
});
