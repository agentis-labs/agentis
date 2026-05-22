/**
 * WorkflowEngine — Output Surface nodes (WORKFLOW-10X-MASTERPLAN Layer 6).
 *
 * Verifies `return_output` (declares the rendered result + renderAs hint) and
 * `artifact_save` (persists a value to the artifacts store) run end-to-end.
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
import { WorkflowStoreService } from '../../src/services/workflowStore.js';
import type { SkillRuntime } from '../../src/services/skillRuntime.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

let ctx: TestContext;
let engine: WorkflowEngine;

beforeEach(async () => {
  ctx = await createTestContext();
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
    workflowStore: new WorkflowStoreService(ctx.db),
  });
});

afterEach(() => ctx.close());

function seedWorkflow(graph: WorkflowGraph) {
  const wfId = randomUUID();
  ctx.db.insert(schema.workflows).values({
    id: wfId,
    workspaceId: ctx.workspace.id,
    ambientId: ctx.ambient.id,
    userId: ctx.user.id,
    title: 'output-surface',
    graph,
    settings: {},
  }).run();
  return wfId;
}

async function startAndWait(wfId: string, graph: WorkflowGraph, inputs: Record<string, unknown>): Promise<string> {
  const runId = randomUUID();
  const initialState = buildInitialRunState({ runId, workflowId: wfId, graph, inputs });
  ctx.db.insert(schema.workflowRuns).values({
    id: runId,
    workspaceId: ctx.workspace.id,
    ambientId: ctx.ambient.id,
    workflowId: wfId,
    userId: ctx.user.id,
    status: 'CREATED',
    runState: initialState,
  }).run();
  await engine.startRun({
    workspaceId: ctx.workspace.id,
    ambientId: ctx.ambient.id,
    workflowId: wfId,
    userId: ctx.user.id,
    triggerId: null,
    inputs,
    initialState,
    graph,
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), 15_000);
    const off = ctx.bus.subscribe((m) => {
      if (m.room === `run:${runId}` && (
        m.envelope.event === REALTIME_EVENTS.RUN_COMPLETED
        || m.envelope.event === REALTIME_EVENTS.RUN_FAILED
      )) {
        clearTimeout(timer);
        off();
        resolve();
      }
    });
  });
  return runId;
}

function loadRun(runId: string) {
  return ctx.db.select().from(schema.workflowRuns).where(eq(schema.workflowRuns.id, runId)).get()!;
}

describe('WorkflowEngine — return_output node', () => {
  it('tags the resolved value with its renderAs viewer hint', async () => {
    const graph: WorkflowGraph = {
      version: 1,
      viewport: { x: 0, y: 0, zoom: 1 },
      nodes: [
        { id: 'T', type: 'trigger', title: 'Manual', position: { x: 0, y: 0 }, config: { kind: 'trigger', triggerType: 'manual' } },
        {
          id: 'P',
          type: 'transform',
          title: 'Produce',
          position: { x: 200, y: 0 },
          config: { kind: 'transform', expression: '({ type: "html", title: "Hi", content: "<h1>Hello World</h1>" })' },
        },
        {
          id: 'R',
          type: 'return_output',
          title: 'Return Output',
          position: { x: 400, y: 0 },
          config: { kind: 'return_output', renderAs: 'html', title: 'Greeting' },
        },
      ],
      edges: [
        { id: 'e1', source: 'T', target: 'P' },
        { id: 'e2', source: 'P', target: 'R' },
      ],
    };
    const wfId = seedWorkflow(graph);
    const runId = await startAndWait(wfId, graph, {});
    const row = loadRun(runId);
    expect(row.status).toBe('COMPLETED');
    const state = row.runState as { nodeStates: Record<string, { outputData?: Record<string, unknown> }> };
    const out = state.nodeStates.R?.outputData as { renderAs?: string; title?: string; value?: { content?: string } };
    expect(out?.renderAs).toBe('html');
    expect(out?.title).toBe('Greeting');
    expect(out?.value?.content).toContain('Hello World');
  });
});

describe('WorkflowEngine — artifact_save node', () => {
  it('persists input content as a workspace artifact', async () => {
    const graph: WorkflowGraph = {
      version: 1,
      viewport: { x: 0, y: 0, zoom: 1 },
      nodes: [
        { id: 'T', type: 'trigger', title: 'Manual', position: { x: 0, y: 0 }, config: { kind: 'trigger', triggerType: 'manual' } },
        {
          id: 'P',
          type: 'transform',
          title: 'Produce',
          position: { x: 200, y: 0 },
          config: { kind: 'transform', expression: '({ page: "<h1>Saved</h1>" })' },
        },
        {
          id: 'A',
          type: 'artifact_save',
          title: 'Save',
          position: { x: 400, y: 0 },
          config: { kind: 'artifact_save', name: 'report.html', contentPath: 'page' },
        },
      ],
      edges: [
        { id: 'e1', source: 'T', target: 'P' },
        { id: 'e2', source: 'P', target: 'A' },
      ],
    };
    const wfId = seedWorkflow(graph);
    const runId = await startAndWait(wfId, graph, {});
    const row = loadRun(runId);
    expect(row.status).toBe('COMPLETED');

    const arts = ctx.db.select().from(schema.artifacts)
      .where(and(eq(schema.artifacts.runId, runId), eq(schema.artifacts.workspaceId, ctx.workspace.id)))
      .all();
    expect(arts).toHaveLength(1);
    expect(arts[0]!.type).toBe('html');
    expect(arts[0]!.content).toBe('<h1>Saved</h1>');
    expect((arts[0]!.metadata as { name?: string })?.name).toBe('report.html');

    const state = row.runState as { nodeStates: Record<string, { outputData?: { artifactId?: string } }> };
    expect(state.nodeStates.A?.outputData?.artifactId).toBe(arts[0]!.id);
  });
});
