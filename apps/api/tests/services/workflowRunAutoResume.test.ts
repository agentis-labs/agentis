import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentisToolContext, WorkflowGraph, WorkflowRunState } from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import { AgentisToolRegistry } from '../../src/services/agentisToolRegistry.js';
import type { ToolHandlerDeps } from '../../src/services/agentisToolHandlers/deps.js';
import { registerRunTools } from '../../src/services/agentisToolHandlers/run.js';
import { PartialReplayService } from '../../src/services/partialReplay.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

let ctx: TestContext;
let registry: AgentisToolRegistry;
let starts: Array<{ initialState: WorkflowRunState; debugRun?: boolean }>;

const graph = (): WorkflowGraph => ({
  version: 1,
  viewport: { x: 0, y: 0, zoom: 1 },
  nodes: [
    { id: 'A', type: 'trigger', title: 'A', position: { x: 0, y: 0 }, config: { kind: 'trigger', triggerType: 'manual' } },
    { id: 'B', type: 'merge', title: 'B', position: { x: 100, y: 0 }, config: { kind: 'merge', requiredInputs: 'all' } },
    { id: 'C', type: 'merge', title: 'C', position: { x: 200, y: 0 }, config: { kind: 'merge', requiredInputs: 'all' } },
  ],
  edges: [
    { id: 'ab', source: 'A', target: 'B' },
    { id: 'bc', source: 'B', target: 'C' },
  ],
});

beforeEach(async () => {
  ctx = await createTestContext();
  starts = [];
  registry = new AgentisToolRegistry({ logger: ctx.logger });
  registerRunTools(registry, {
    db: ctx.db,
    logger: ctx.logger,
    bus: ctx.bus,
    engine: {
      startRun: async (args: { initialState: WorkflowRunState; workflowId: string; debugRun?: boolean }) => {
        starts.push({ initialState: args.initialState, debugRun: args.debugRun });
        return { runId: args.initialState.runId, workflowId: args.workflowId };
      },
    } as unknown as ToolHandlerDeps['engine'],
    adapters: {} as ToolHandlerDeps['adapters'],
    ledger: { listForRun: async () => [] } as unknown as ToolHandlerDeps['ledger'],
    scratchpad: {} as ToolHandlerDeps['scratchpad'],
    approvals: { list: () => [] } as unknown as ToolHandlerDeps['approvals'],
    activity: {} as ToolHandlerDeps['activity'],
    replay: new PartialReplayService(ctx.db),
  } as ToolHandlerDeps);
});

afterEach(() => ctx.close());

function toolCtx(): AgentisToolContext {
  return {
    workspaceId: ctx.workspace.id,
    ambientId: ctx.ambient.id,
    userId: ctx.user.id,
    conversationId: null,
    caller: 'chat',
  };
}

function seedFailedRun(): { workflowId: string; sourceRunId: string } {
  const workflowId = randomUUID();
  const sourceRunId = randomUUID();
  const workflowGraph = graph();
  ctx.db.insert(schema.workflows).values({
    id: workflowId,
    workspaceId: ctx.workspace.id,
    ambientId: ctx.ambient.id,
    userId: ctx.user.id,
    title: 'auto-resume',
    graph: workflowGraph,
    settings: {},
  }).run();
  const state: WorkflowRunState = {
    runId: sourceRunId,
    workflowId,
    status: 'FAILED',
    readyQueue: [],
    waitingInputs: {},
    nodeStates: {
      A: { nodeId: 'A', status: 'COMPLETED', outputData: { a: true } },
      B: { nodeId: 'B', status: 'COMPLETED', outputData: { b: true } },
      C: { nodeId: 'C', status: 'FAILED', error: 'frontier failed' },
    },
    activeExecutions: {},
    completedNodeIds: ['A', 'B'],
    failedNodeIds: ['C'],
    skippedNodeIds: [],
    graphRevision: 1,
    replanCount: 0,
    lastLedgerSequence: 0,
  };
  ctx.db.insert(schema.workflowRuns).values({
    id: sourceRunId,
    workspaceId: ctx.workspace.id,
    ambientId: ctx.ambient.id,
    workflowId,
    userId: ctx.user.id,
    status: 'FAILED',
    runState: state as unknown as object,
    graphSnapshot: workflowGraph as unknown as object,
  }).run();
  return { workflowId, sourceRunId };
}

describe('agentis.workflow.run debug restart policy', () => {
  it('auto-resumes the latest same-graph failed frontier without rerunning the trigger', async () => {
    const { workflowId, sourceRunId } = seedFailedRun();
    const result = await registry.execute({
      id: 'auto-resume',
      toolId: 'agentis.workflow.run',
      arguments: { workflowId, debugRun: true },
    }, toolCtx());

    expect(result.ok).toBe(true);
    const output = result.output as {
      runId: string;
      restartMode: string;
      resumedFromRunId?: string;
      reusedNodeIds?: string[];
    };
    expect(output.restartMode).toBe('failed_frontier');
    expect(output.resumedFromRunId).toBe(sourceRunId);
    expect(output.reusedNodeIds?.sort()).toEqual(['A', 'B']);
    expect(starts[0]?.debugRun).toBe(true);
    expect(starts[0]?.initialState.readyQueue.map((item) => item.nodeId)).toEqual(['C']);

    const row = ctx.db.select().from(schema.workflowRuns).all().find((candidate) => candidate.id === output.runId);
    expect(row?.parentRunId).toBe(sourceRunId);
    expect(row?.isReplay).toBe(true);
  });

  it('honors an explicit fresh debug restart', async () => {
    const { workflowId } = seedFailedRun();
    const result = await registry.execute({
      id: 'fresh-debug',
      toolId: 'agentis.workflow.run',
      arguments: { workflowId, debugRun: true, restartMode: 'fresh' },
    }, toolCtx());

    expect(result.ok).toBe(true);
    const output = result.output as { runId: string; restartMode: string; resumedFromRunId?: string };
    expect(output.restartMode).toBe('fresh');
    expect(output.resumedFromRunId).toBeUndefined();
    expect(starts[0]?.initialState.readyQueue.map((item) => item.nodeId)).toEqual(['A']);
    const row = ctx.db.select().from(schema.workflowRuns).all().find((candidate) => candidate.id === output.runId);
    expect(row?.parentRunId).toBeNull();
    expect(row?.isReplay).toBe(false);
  });

  it('starts fresh in auto mode when replacement inputs are supplied', async () => {
    const { workflowId } = seedFailedRun();
    const result = await registry.execute({
      id: 'new-input-debug',
      toolId: 'agentis.workflow.run',
      arguments: { workflowId, debugRun: true, inputs: { leadId: 'new-lead' } },
    }, toolCtx());

    expect(result.ok).toBe(true);
    const output = result.output as { restartMode: string; resumedFromRunId?: string };
    expect(output.restartMode).toBe('fresh');
    expect(output.resumedFromRunId).toBeUndefined();
    expect(starts[0]?.initialState.readyQueue[0]?.inputData).toEqual({ leadId: 'new-lead' });
  });

  it('returns the existing same-graph debug run instead of starting a duplicate', async () => {
    const { workflowId } = seedFailedRun();
    const activeRunId = randomUUID();
    const workflowGraph = graph();
    ctx.db.insert(schema.workflowRuns).values({
      id: activeRunId,
      workspaceId: ctx.workspace.id,
      ambientId: ctx.ambient.id,
      workflowId,
      userId: ctx.user.id,
      status: 'RUNNING',
      runState: {
        runId: activeRunId, workflowId, status: 'RUNNING', readyQueue: [], waitingInputs: {}, nodeStates: {},
        activeExecutions: {}, completedNodeIds: [], failedNodeIds: [], skippedNodeIds: [], graphRevision: 1, replanCount: 0, lastLedgerSequence: 0,
      },
      graphSnapshot: workflowGraph,
    }).run();

    const result = await registry.execute({
      id: 'dedupe-debug',
      toolId: 'agentis.workflow.run',
      arguments: { workflowId, debugRun: true },
    }, toolCtx());

    expect(result.ok).toBe(true);
    expect(result.output).toMatchObject({ runId: activeRunId, status: 'already_running', restartMode: 'in_progress' });
    expect(starts).toHaveLength(0);
  });
});
