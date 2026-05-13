import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { type AgentAdapter, type NormalizedAgentEvent, type NormalizedTask, type WorkflowGraph, type WorkflowRunStatus } from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import { WorkflowEngine } from '../../src/engine/WorkflowEngine.js';
import { buildInitialRunState } from '../../src/engine/initialRunState.js';
import { LedgerService } from '../../src/services/ledger.js';
import { ScratchpadService } from '../../src/services/scratchpad.js';
import { ActivityFeedService } from '../../src/services/activityFeed.js';
import { ApprovalInboxService } from '../../src/services/approvalInbox.js';
import { AdapterManager } from '../../src/adapters/AdapterManager.js';
import { KnowledgeBaseService } from '../../src/services/knowledgeBase.js';
import { CollectiveBrainService } from '../../src/services/collectiveBrain.js';
import { EpisodicMemoryStore } from '../../src/services/episodicMemoryStore.js';
import { HashingEmbeddingProvider } from '../../src/services/embeddingProvider.js';
import type { SkillRuntime } from '../../src/services/skillRuntime.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

let ctx: TestContext;
let engine: WorkflowEngine;
let adapters: AdapterManager;

beforeEach(async () => {
  ctx = await createTestContext();
  engine = buildEngine();
});

afterEach(() => {
  (engine as { shutdown?: () => void }).shutdown?.();
  ctx.close();
});

function buildEngine() {
  adapters = new AdapterManager(ctx.logger);
  return new WorkflowEngine({
    db: ctx.db,
    bus: ctx.bus,
    logger: ctx.logger,
    ledger: new LedgerService(ctx.db, ctx.bus),
    scratchpad: new ScratchpadService(ctx.bus, ctx.logger),
    activity: new ActivityFeedService(ctx.db, ctx.bus),
    approvals: new ApprovalInboxService(ctx.db, ctx.bus),
    skills: {} as unknown as SkillRuntime,
    adapters,
    knowledgeBases: new KnowledgeBaseService(ctx.db),
    collectiveBrain: new CollectiveBrainService(
      ctx.db,
      ctx.bus,
      new EpisodicMemoryStore(ctx.db, ctx.logger, new HashingEmbeddingProvider()),
      ctx.logger,
    ),
  });
}

async function start(graph: WorkflowGraph, inputs: Record<string, unknown>) {
  const workflowId = randomUUID();
  const runId = randomUUID();
  ctx.db.insert(schema.workflows).values({
    id: workflowId,
    workspaceId: ctx.workspace.id,
    ambientId: ctx.ambient.id,
    userId: ctx.user.id,
    title: 'engine-10x',
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
  await engine.startRun({
    workspaceId: ctx.workspace.id,
    ambientId: ctx.ambient.id,
    workflowId,
    userId: ctx.user.id,
    triggerId: null,
    inputs,
    initialState,
    graph,
  });
  return { workflowId, runId };
}

async function waitForRunStatus(runId: string, target: WorkflowRunStatus): Promise<void> {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    const row = ctx.db.select().from(schema.workflowRuns).where(eq(schema.workflowRuns.id, runId)).get();
    if (row?.status === target) return;
    await sleep(10);
  }
  throw new Error(`timeout waiting for ${target}`);
}

async function waitForEpisodeCount(target: number): Promise<void> {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    const rows = ctx.db.select().from(schema.memoryEpisodes)
      .where(eq(schema.memoryEpisodes.workspaceId, ctx.workspace.id))
      .all();
    if (rows.length >= target) return;
    await sleep(10);
  }
  throw new Error(`timeout waiting for ${target} collective brain episode(s)`);
}

function fakeCompletingAdapter(agentId: string): AgentAdapter {
  let handler: ((event: NormalizedAgentEvent) => void) | null = null;
  return {
    adapterType: 'claude_code',
    async connect() {},
    async disconnect() {},
    async healthCheck() {
      return { isHealthy: true, checkedAt: new Date().toISOString() };
    },
    async dispatchTask(task: NormalizedTask) {
      queueMicrotask(() => {
        handler?.({
          eventType: 'task.completed',
          agentId,
          taskId: task.nodeId,
          runId: task.runId,
          workflowId: task.workflowId,
          output: {
            summary: 'Observed that Stripe checkout returns rate limit responses after 100 requests per minute, so future calls should use exponential backoff.',
          },
          timestamp: new Date().toISOString(),
        });
      });
    },
    async cancelTask() {},
    onEvent(next) {
      handler = next;
    },
  };
}

describe('WorkflowEngine Engine 10x primitives', () => {
  it('executes knowledge nodes and returns retrieved chunks', async () => {
    const knowledge = new KnowledgeBaseService(ctx.db);
    const kb = knowledge.createKnowledgeBase({ workspaceId: ctx.workspace.id, name: 'Runbooks' });
    knowledge.addDocument({
      workspaceId: ctx.workspace.id,
      knowledgeBaseId: kb.id,
      name: 'billing.md',
      mimeType: 'text/markdown',
      content: 'Payment retry failures must be escalated to billing operations before another workflow run.',
    });
    const graph: WorkflowGraph = {
      version: 1,
      viewport: { x: 0, y: 0, zoom: 1 },
      nodes: [
        { id: 'T', type: 'trigger', title: 'trigger', position: { x: 0, y: 0 }, config: { kind: 'trigger', triggerType: 'manual' } },
        { id: 'K', type: 'knowledge', title: 'knowledge', position: { x: 100, y: 0 }, config: { kind: 'knowledge', knowledgeBaseId: kb.id, queryMode: 'static', query: 'payment retry', topK: 3 } },
      ],
      edges: [{ id: 'T-K', source: 'T', target: 'K' }],
    };

    const { runId } = await start(graph, {});
    await waitForRunStatus(runId, 'COMPLETED');
    const row = ctx.db.select().from(schema.workflowRuns).where(eq(schema.workflowRuns.id, runId)).get()!;
    const state = row.runState as { nodeStates: Record<string, { outputData?: { resultCount?: number; results?: Array<{ content: string }> } }> };
    expect(state.nodeStates.K?.outputData?.resultCount).toBe(1);
    expect(state.nodeStates.K?.outputData?.results?.[0]?.content).toContain('Payment retry failures');
  });

  it('promotes completed agent task output into the collective brain', async () => {
    const agentId = randomUUID();
    ctx.db.insert(schema.agents).values({
      id: agentId,
      workspaceId: ctx.workspace.id,
      ambientId: ctx.ambient.id,
      userId: ctx.user.id,
      name: 'Builder',
      adapterType: 'claude_code',
      capabilityTags: ['build'],
      config: {},
    }).run();
    adapters.register(agentId, fakeCompletingAdapter(agentId));
    adapters.onEvent((event) => {
      if (event.eventType !== 'task.completed') return;
      void engine.notifyTaskCompleted({
        runId: event.runId,
        nodeId: event.taskId,
        output: event.output,
      });
    });

    const graph: WorkflowGraph = {
      version: 1,
      viewport: { x: 0, y: 0, zoom: 1 },
      nodes: [
        { id: 'T', type: 'trigger', title: 'trigger', position: { x: 0, y: 0 }, config: { kind: 'trigger', triggerType: 'manual' } },
        { id: 'A', type: 'agent_task', title: 'agent', position: { x: 100, y: 0 }, config: { kind: 'agent_task', agentId, capabilityTags: ['build'], prompt: 'learn', inputKeys: [], outputKeys: [] } },
      ],
      edges: [{ id: 'T-A', source: 'T', target: 'A' }],
    };

    const { runId } = await start(graph, {});
    await waitForRunStatus(runId, 'COMPLETED');
    await waitForEpisodeCount(1);
    const episode = ctx.db.select().from(schema.memoryEpisodes)
      .where(eq(schema.memoryEpisodes.workspaceId, ctx.workspace.id))
      .get();
    expect(episode?.summary).toContain('Stripe checkout returns rate limit responses');
    expect(episode?.agentId).toBe(agentId);
  });

  it('executes context_compress key_filter and records compression stats', async () => {
    const graph: WorkflowGraph = {
      version: 1,
      viewport: { x: 0, y: 0, zoom: 1 },
      nodes: [
        { id: 'T', type: 'trigger', title: 'trigger', position: { x: 0, y: 0 }, config: { kind: 'trigger', triggerType: 'manual' } },
        { id: 'C', type: 'context_compress', title: 'compress', position: { x: 100, y: 0 }, config: { kind: 'context_compress', strategy: 'key_filter', keepKeys: ['keep'] } },
        { id: 'R', type: 'response', title: 'response', position: { x: 200, y: 0 }, config: { kind: 'response', content: '<C>' } },
      ],
      edges: [
        { id: 'T-C', source: 'T', target: 'C' },
        { id: 'C-R', source: 'C', target: 'R' },
      ],
    };
    const { runId } = await start(graph, { keep: 'yes', drop: 'no' });
    await waitForRunStatus(runId, 'COMPLETED');
    const row = ctx.db.select().from(schema.workflowRuns).where(eq(schema.workflowRuns.id, runId)).get()!;
    const state = row.runState as { response: { body: Record<string, unknown> }; observability: { blockData: Record<string, { compression?: { inputChars: number; outputChars: number } }> } };
    expect(state.response.body).toEqual({ keep: 'yes' });
    expect(state.observability.blockData.C?.compression?.inputChars).toBeGreaterThan(state.observability.blockData.C?.compression?.outputChars ?? 0);
  });

  it('fails downstream nodes when an edge data contract is violated', async () => {
    const graph: WorkflowGraph = {
      version: 1,
      viewport: { x: 0, y: 0, zoom: 1 },
      nodes: [
        { id: 'T', type: 'trigger', title: 'trigger', position: { x: 0, y: 0 }, config: { kind: 'trigger', triggerType: 'manual' } },
        { id: 'C', type: 'context_compress', title: 'compress', position: { x: 100, y: 0 }, config: { kind: 'context_compress', strategy: 'key_filter', keepKeys: ['keep'] } },
        { id: 'R', type: 'response', title: 'response', position: { x: 200, y: 0 }, config: { kind: 'response', content: '<C>' } },
      ],
      edges: [
        { id: 'T-C', source: 'T', target: 'C' },
        { id: 'C-R', source: 'C', target: 'R', dataContract: { requiredKeys: ['missing'] } },
      ],
    };
    const { runId } = await start(graph, { keep: 'yes' });
    await waitForRunStatus(runId, 'FAILED');
    const row = ctx.db.select().from(schema.workflowRuns).where(eq(schema.workflowRuns.id, runId)).get()!;
    const state = row.runState as { nodeStates: Record<string, { status: string; error?: string }> };
    expect(state.nodeStates.R?.status).toBe('FAILED');
    expect(state.nodeStates.R?.error).toMatch(/data contract/i);
  });

  it('applies graph patches to the run snapshot without rewriting the saved workflow by default', async () => {
    const graph: WorkflowGraph = {
      version: 1,
      viewport: { x: 0, y: 0, zoom: 1 },
      nodes: [
        { id: 'T', type: 'trigger', title: 'trigger', position: { x: 0, y: 0 }, config: { kind: 'trigger', triggerType: 'manual' } },
      ],
      edges: [],
    };
    const workflowId = randomUUID();
    const runId = randomUUID();
    ctx.db.insert(schema.workflows).values({
      id: workflowId,
      workspaceId: ctx.workspace.id,
      ambientId: ctx.ambient.id,
      userId: ctx.user.id,
      title: 'surgical-edit',
      graph,
      settings: {},
    }).run();
    const initialState = buildInitialRunState({ runId, workflowId, graph, inputs: {} });
    ctx.db.insert(schema.workflowRuns).values({
      id: runId,
      workspaceId: ctx.workspace.id,
      ambientId: ctx.ambient.id,
      workflowId,
      userId: ctx.user.id,
      status: 'CREATED',
      runState: initialState,
    }).run();

    await engine.applyGraphPatch({
      runId,
      patch: {
        patchId: 'patch-1',
        reason: 'user_edit',
        baseGraphRevision: initialState.graphRevision,
        addNodes: [
          { id: 'R', type: 'response', title: 'response', position: { x: 100, y: 0 }, config: { kind: 'response', content: 'ok' } },
        ],
        updateNodes: [],
        removeNodeIds: [],
        addEdges: [{ id: 'T-R', source: 'T', target: 'R' }],
        removeEdgeIds: [],
      },
    });

    const workflow = ctx.db.select().from(schema.workflows).where(eq(schema.workflows.id, workflowId)).get()!;
    const run = ctx.db.select().from(schema.workflowRuns).where(eq(schema.workflowRuns.id, runId)).get()!;
    const savedGraph = workflow.graph as WorkflowGraph;
    const runState = run.runState as { graphRevision: number; observability: { graphSnapshot: WorkflowGraph } };
    expect(savedGraph.nodes.map((node) => node.id)).toEqual(['T']);
    expect(runState.graphRevision).toBe(initialState.graphRevision + 1);
    expect(runState.observability.graphSnapshot.nodes.map((node) => node.id)).toEqual(['T', 'R']);
  });
});