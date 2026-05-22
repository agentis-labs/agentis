/**
 * WorkflowEngine — `browser` node end-to-end (the "Hello World in a browser" path).
 *
 * trigger → transform (produce HTML) → browser serve_html (real Chromium
 * screenshot) → return_output(renderAs html). Asserts the run completes, an
 * image artifact is persisted, and the HTML flows through to the output.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { REALTIME_EVENTS, type WorkflowGraph } from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import { WorkflowEngine } from '../../src/engine/WorkflowEngine.js';
import { buildInitialRunState } from '../../src/engine/initialRunState.js';
import { LedgerService } from '../../src/services/ledger.js';
import { ScratchpadService } from '../../src/services/scratchpad.js';
import { ActivityFeedService } from '../../src/services/activityFeed.js';
import { ApprovalInboxService } from '../../src/services/approvalInbox.js';
import { AdapterManager } from '../../src/adapters/AdapterManager.js';
import { BrowserPool } from '../../src/services/browserPool.js';
import type { SkillRuntime } from '../../src/services/skillRuntime.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

let ctx: TestContext;
let engine: WorkflowEngine;
let pool: BrowserPool;

beforeEach(async () => {
  ctx = await createTestContext();
  pool = new BrowserPool(ctx.logger);
  engine = new WorkflowEngine({
    db: ctx.db,
    bus: ctx.bus,
    logger: ctx.logger,
    ledger: new LedgerService(ctx.db, ctx.bus),
    scratchpad: new ScratchpadService(ctx.bus, ctx.logger),
    activity: new ActivityFeedService(ctx.db, ctx.bus),
    approvals: new ApprovalInboxService(ctx.db, ctx.bus),
    skills: {} as unknown as SkillRuntime,
    adapters: new AdapterManager(ctx.logger),
    browserPool: pool,
  });
});

afterEach(async () => {
  await pool.shutdown();
  ctx.close();
});

function seedWorkflow(graph: WorkflowGraph) {
  const wfId = randomUUID();
  ctx.db.insert(schema.workflows).values({
    id: wfId, workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id,
    title: 'browser', graph, settings: {},
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
    const timer = setTimeout(() => reject(new Error('timeout')), 180_000);
    const off = ctx.bus.subscribe((m) => {
      if (m.room === `run:${runId}` && (m.envelope.event === REALTIME_EVENTS.RUN_COMPLETED || m.envelope.event === REALTIME_EVENTS.RUN_FAILED)) {
        clearTimeout(timer); off(); resolve();
      }
    });
  });
  return runId;
}

describe('WorkflowEngine — browser node (serve_html)', () => {
  it('renders HTML in Chromium, saves a screenshot artifact, and returns the HTML', async () => {
    const graph: WorkflowGraph = {
      version: 1,
      viewport: { x: 0, y: 0, zoom: 1 },
      nodes: [
        { id: 'T', type: 'trigger', title: 'Manual', position: { x: 0, y: 0 }, config: { kind: 'trigger', triggerType: 'manual' } },
        { id: 'P', type: 'transform', title: 'Produce', position: { x: 200, y: 0 }, config: { kind: 'transform', expression: '({ type: "html", title: "Hi", content: "<h1>Hello World</h1>" })' } },
        { id: 'B', type: 'browser', title: 'Open in Browser', position: { x: 400, y: 0 }, config: { kind: 'browser', operation: 'serve_html', htmlPath: 'content' } },
        { id: 'R', type: 'return_output', title: 'Return Output', position: { x: 600, y: 0 }, config: { kind: 'return_output', renderAs: 'html' } },
      ],
      edges: [
        { id: 'e1', source: 'T', target: 'P' },
        { id: 'e2', source: 'P', target: 'B' },
        { id: 'e3', source: 'B', target: 'R' },
      ],
    };
    const wfId = seedWorkflow(graph);
    const runId = await startAndWait(wfId, graph);
    const row = ctx.db.select().from(schema.workflowRuns).where(eq(schema.workflowRuns.id, runId)).get()!;
    expect(row.status).toBe('COMPLETED');

    // A screenshot artifact (image) was persisted for this run.
    const arts = ctx.db.select().from(schema.artifacts)
      .where(and(eq(schema.artifacts.runId, runId), eq(schema.artifacts.type, 'image')))
      .all();
    expect(arts).toHaveLength(1);
    expect(arts[0]!.content.startsWith('data:image/png;base64,')).toBe(true);

    // The HTML flows through to return_output as the rendered value.
    const state = row.runState as { nodeStates: Record<string, { outputData?: Record<string, unknown> }> };
    const out = state.nodeStates.R?.outputData as { renderAs?: string; value?: { content?: string } };
    expect(out?.renderAs).toBe('html');
    expect(out?.value?.content).toContain('Hello World');
  }, 180_000);
});
