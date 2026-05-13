/**
 * WorkflowEngine — Sprint A block primitives.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { eq } from 'drizzle-orm';
import { REALTIME_EVENTS, type WorkflowGraph, type WorkflowRunStatus } from '@agentis/core';
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
  engine = buildEngine();
});

afterEach(() => ctx.close());

function buildEngine() {
  const ledger = new LedgerService(ctx.db, ctx.bus);
  const scratchpad = new ScratchpadService(ctx.bus, ctx.logger);
  const activity = new ActivityFeedService(ctx.db, ctx.bus);
  const approvals = new ApprovalInboxService(ctx.db, ctx.bus);
  const adapters = new AdapterManager(ctx.logger);
  const skills = {} as unknown as SkillRuntime;
  return new WorkflowEngine({
    db: ctx.db,
    bus: ctx.bus,
    logger: ctx.logger,
    ledger,
    scratchpad,
    activity,
    approvals,
    skills,
    adapters,
  });
}

function seedRun(graph: WorkflowGraph, inputs: Record<string, unknown>) {
  const workflowId = randomUUID();
  const runId = randomUUID();
  ctx.db.insert(schema.workflows).values({
    id: workflowId,
    workspaceId: ctx.workspace.id,
    ambientId: ctx.ambient.id,
    userId: ctx.user.id,
    title: 'sprint-a',
    graph,
    settings: {},
  }).run();
  const initialState = buildInitialRunState({ runId, workflowId, graph, inputs });
  ctx.db.insert(schema.workflowRuns).values({
    id: runId,
    workspaceId: ctx.workspace.id,
    ambientId: ctx.ambient.id,
    workflowId,
    userId: ctx.user.id,
    status: 'CREATED',
    runState: initialState,
  }).run();
  return { workflowId, runId, initialState };
}

async function start(graph: WorkflowGraph, inputs: Record<string, unknown>) {
  const seeded = seedRun(graph, inputs);
  await engine.startRun({
    workspaceId: ctx.workspace.id,
    ambientId: ctx.ambient.id,
    workflowId: seeded.workflowId,
    userId: ctx.user.id,
    triggerId: null,
    inputs,
    initialState: seeded.initialState,
    graph,
  });
  return seeded;
}

async function waitForRunStatus(runId: string, target: WorkflowRunStatus): Promise<void> {
  const terminalEvent =
    target === 'COMPLETED'
      ? REALTIME_EVENTS.RUN_COMPLETED
      : target === 'FAILED'
        ? REALTIME_EVENTS.RUN_FAILED
        : null;
  if (terminalEvent) {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout waiting for ${target}`)), 2000);
      const off = ctx.bus.subscribe((message) => {
        if (message.room === `run:${runId}` && message.envelope.event === terminalEvent) {
          clearTimeout(timer);
          off();
          resolve();
        }
      });
    });
    return;
  }

  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    const row = ctx.db.select().from(schema.workflowRuns).where(eq(schema.workflowRuns.id, runId)).get();
    if (row?.status === target) return;
    await sleep(10);
  }
  throw new Error(`timeout waiting for ${target}`);
}

describe('WorkflowEngine Sprint A primitives', () => {
  it('executes variables, loop, parallel, wait, and response nodes', async () => {
    const graph: WorkflowGraph = {
      version: 1,
      viewport: { x: 0, y: 0, zoom: 1 },
      variables: [{ name: 'total', type: 'number', defaultValue: 0, required: false }],
      nodes: [
        {
          id: 'T',
          type: 'trigger',
          title: 'trigger',
          position: { x: 0, y: 0 },
          config: { kind: 'trigger', triggerType: 'manual' },
        },
        {
          id: 'V',
          type: 'variables',
          title: 'write variable',
          position: { x: 100, y: 0 },
          config: { kind: 'variables', operation: 'write', key: 'total', value: '<inputs.total>' },
        },
        {
          id: 'L',
          type: 'loop',
          title: 'loop',
          position: { x: 200, y: 0 },
          config: { kind: 'loop', loopType: 'forEach', items: '<inputs.items>' },
        },
        {
          id: 'P',
          type: 'parallel',
          title: 'parallel',
          position: { x: 300, y: 0 },
          config: { kind: 'parallel', parallelType: 'collection', items: '<L.results>' },
        },
        {
          id: 'W',
          type: 'wait',
          title: 'wait',
          position: { x: 400, y: 0 },
          config: { kind: 'wait', durationSeconds: 0 },
        },
        {
          id: 'R',
          type: 'response',
          title: 'response',
          position: { x: 500, y: 0 },
          config: {
            kind: 'response',
            statusCode: 201,
            content: { total: '<workflow.total>', branchCount: '<P.count>' },
          },
        },
      ],
      edges: [
        { id: 'T-V', source: 'T', target: 'V' },
        { id: 'T-L', source: 'T', target: 'L' },
        { id: 'V-L', source: 'V', target: 'L' },
        { id: 'L-P', source: 'L', target: 'P' },
        { id: 'P-W', source: 'P', target: 'W' },
        { id: 'W-R', source: 'W', target: 'R' },
      ],
    };

    const { runId } = await start(graph, { items: ['a', 'b', 'c'], total: 3 });
    await waitForRunStatus(runId, 'COMPLETED');

    const row = ctx.db.select().from(schema.workflowRuns).where(eq(schema.workflowRuns.id, runId)).get()!;
    const state = row.runState as {
      workflowVariables: Record<string, unknown>;
      response: { statusCode: number; body: Record<string, unknown> };
      loopScopes: Record<string, { results: unknown[] }>;
      parallelScopes: Record<string, { totalBranches: number }>;
    };
    expect(state.workflowVariables.total).toBe(3);
    expect(state.loopScopes.L?.results).toHaveLength(3);
    expect(state.parallelScopes.P?.totalBranches).toBe(3);
    expect(state.response.statusCode).toBe(201);
    expect(state.response.body).toEqual({ total: 3, branchCount: 3 });
  });

  it('executes guardrails and evaluator nodes with run observability', async () => {
    const graph: WorkflowGraph = {
      version: 1,
      viewport: { x: 0, y: 0, zoom: 1 },
      nodes: [
        {
          id: 'T',
          type: 'trigger',
          title: 'trigger',
          position: { x: 0, y: 0 },
          config: { kind: 'trigger', triggerType: 'manual' },
        },
        {
          id: 'G',
          type: 'guardrails',
          title: 'json guardrail',
          position: { x: 100, y: 0 },
          config: {
            kind: 'guardrails',
            mode: 'json',
            inputPath: 'answer',
            jsonSchema: { type: 'object', required: ['status'], properties: { status: { type: 'string' } } },
          },
        },
        {
          id: 'E',
          type: 'evaluator',
          title: 'evaluate',
          position: { x: 200, y: 0 },
          config: {
            kind: 'evaluator',
            criteria: 'status must be ok',
            inputPath: 'parsed',
            expected: { status: 'ok' },
            threshold: 1,
          },
        },
        {
          id: 'R',
          type: 'response',
          title: 'response',
          position: { x: 300, y: 0 },
          config: { kind: 'response', content: { passed: '<inputs.passed>', score: '<inputs.score>' } },
        },
      ],
      edges: [
        { id: 'T-G', source: 'T', target: 'G' },
        { id: 'G-E', source: 'G', target: 'E' },
        { id: 'E-R', source: 'E', target: 'R' },
      ],
    };

    const { runId } = await start(graph, { answer: { status: 'ok' } });
    await waitForRunStatus(runId, 'COMPLETED');

    const row = ctx.db.select().from(schema.workflowRuns).where(eq(schema.workflowRuns.id, runId)).get()!;
    const state = row.runState as { response: { body: Record<string, unknown> } };
    expect(state.response.body).toEqual({ passed: true, score: 1 });
    expect(row.blockData).toMatchObject({ G: { status: 'COMPLETED' }, E: { status: 'COMPLETED' } });
    expect(row.traceSpans).toEqual(expect.arrayContaining([expect.objectContaining({ nodeId: 'G' })]));
    expect(row.graphSnapshotHash).toMatch(/^[a-f0-9]{64}$/u);
  });

  it('pauses and resumes a human-in-the-loop node', async () => {
    const graph: WorkflowGraph = {
      version: 1,
      viewport: { x: 0, y: 0, zoom: 1 },
      nodes: [
        {
          id: 'T',
          type: 'trigger',
          title: 'trigger',
          position: { x: 0, y: 0 },
          config: { kind: 'trigger', triggerType: 'manual' },
        },
        {
          id: 'H',
          type: 'human_in_the_loop',
          title: 'human input',
          position: { x: 100, y: 0 },
          config: { kind: 'human_in_the_loop', displayData: '<inputs>', instructions: 'Approve?' },
        },
        {
          id: 'R',
          type: 'response',
          title: 'response',
          position: { x: 200, y: 0 },
          config: { kind: 'response', content: '<H.formData>' },
        },
      ],
      edges: [
        { id: 'T-H', source: 'T', target: 'H' },
        { id: 'H-R', source: 'H', target: 'R' },
      ],
    };

    const { runId } = await start(graph, { ticket: 'A-1' });
    await waitForRunStatus(runId, 'WAITING');

    const paused = ctx.db.select().from(schema.pausedRuns).where(eq(schema.pausedRuns.runId, runId)).get()!;
    expect(paused.nodeId).toBe('H');
    expect(paused.status).toBe('paused');

    await engine.resumeHumanInput({
      runId,
      contextId: paused.contextId,
      formData: { approved: true, note: 'ship it' },
    });
    await waitForRunStatus(runId, 'COMPLETED');

    const row = ctx.db.select().from(schema.workflowRuns).where(eq(schema.workflowRuns.id, runId)).get()!;
    const state = row.runState as { response: { body: unknown }; nodeStates: Record<string, { status: string }> };
    expect(state.nodeStates.H?.status).toBe('COMPLETED');
    expect(state.response.body).toEqual({ approved: true, note: 'ship it' });
    const updated = ctx.db.select().from(schema.pausedRuns).where(eq(schema.pausedRuns.id, paused.id)).get()!;
    expect(updated.status).toBe('resumed');
  });
});
