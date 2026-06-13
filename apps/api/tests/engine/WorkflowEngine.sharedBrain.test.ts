import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { type AgentAdapter, type AgentAdapterConfig, type AdapterHealthStatus, type NormalizedAgentEvent, type NormalizedTask, type WorkflowGraph } from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import { WorkflowEngine } from '../../src/engine/WorkflowEngine.js';
import { buildInitialRunState } from '../../src/engine/initialRunState.js';
import { AdapterManager } from '../../src/adapters/AdapterManager.js';
import { ActivityFeedService } from '../../src/services/activityFeed.js';
import { ApprovalInboxService } from '../../src/services/approvalInbox.js';
import { LedgerService } from '../../src/services/ledger.js';
import { ScratchpadService } from '../../src/services/scratchpad.js';
import { EpisodicMemoryStore } from '../../src/services/episodicMemoryStore.js';
import { HashingEmbeddingProvider } from '../../src/services/embeddingProvider.js';
import { MemoryStore } from '../../src/services/memoryStore.js';
import { SharedIntelligenceService } from '../../src/services/sharedIntelligence.js';
import { CognitivePromotionQueueWorker } from '../../src/services/cognitivePromotionQueueWorker.js';
import type { ExtensionRuntime } from '../../src/services/extensionRuntime.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

let ctx: TestContext;

beforeEach(async () => {
  ctx = await createTestContext();
});

afterEach(() => ctx.close());

class CapturingAdapter implements AgentAdapter {
  readonly adapterType = 'http' as const;
  #resolve!: (task: NormalizedTask) => void;
  readonly nextTask = new Promise<NormalizedTask>((resolve) => { this.#resolve = resolve; });

  async connect(_config: AgentAdapterConfig): Promise<void> {}
  async disconnect(): Promise<void> {}
  async healthCheck(): Promise<AdapterHealthStatus> {
    return { isHealthy: true, checkedAt: new Date().toISOString() };
  }
  async dispatchTask(task: NormalizedTask): Promise<void> {
    this.#resolve(task);
  }
  async cancelTask(_taskId: string): Promise<void> {}
  onEvent(_handler: (event: NormalizedAgentEvent) => void): void {}
}

describe('WorkflowEngine shared brain injection', () => {
  it('dispatches agent_task prompts with DB-backed shared brain atoms', async () => {
    const agentId = randomUUID();
    ctx.db.insert(schema.agents).values({
      id: agentId,
      workspaceId: ctx.workspace.id,
      ambientId: ctx.ambient.id,
      userId: ctx.user.id,
      name: 'Brain Agent',
      adapterType: 'http',
      capabilityTags: [],
      config: {},
      status: 'online',
    }).run();

    new MemoryStore(ctx.db, ctx.logger).write({
      workspaceId: ctx.workspace.id,
      scopeId: null,
      kind: 'preference',
      source: 'operator',
      title: 'Brevity preference',
      content: 'Keep workflow responses extremely short.',
      trust: 0.92,
      importance: 0.9,
      tags: ['test'],
    });

    const adapter = new CapturingAdapter();
    const adapters = new AdapterManager(ctx.logger);
    adapters.register(agentId, adapter);
    const sharedIntelligence = new SharedIntelligenceService(
      ctx.db,
      ctx.bus,
      new EpisodicMemoryStore(ctx.db, ctx.logger, new HashingEmbeddingProvider()),
      ctx.logger,
    );
    const brainQueue = new CognitivePromotionQueueWorker(ctx.db, sharedIntelligence, ctx.logger);
    const engine = new WorkflowEngine({
      db: ctx.db,
      bus: ctx.bus,
      logger: ctx.logger,
      ledger: new LedgerService(ctx.db, ctx.bus),
      scratchpad: new ScratchpadService(ctx.bus, ctx.logger),
      activity: new ActivityFeedService(ctx.db, ctx.bus),
      approvals: new ApprovalInboxService(ctx.db, ctx.bus),
      extensions: {} as ExtensionRuntime,
      adapters,
      sharedIntelligence,
      brainQueue,
    });

    const workflowId = randomUUID();
    const runId = randomUUID();
    const graph: WorkflowGraph = {
      version: 1,
      viewport: { x: 0, y: 0, zoom: 1 },
      nodes: [
        { id: 'T', type: 'trigger', title: 'Manual', position: { x: 0, y: 0 }, config: { kind: 'trigger', triggerType: 'manual' } },
        {
          id: 'A',
          type: 'agent_task',
          title: 'Answer',
          position: { x: 200, y: 0 },
          config: {
            kind: 'agent_task',
            agentId,
            prompt: 'Draft a workflow response about response length.',
            inputKeys: [],
            outputKeys: [],
            capabilityTags: [],
          },
        },
      ],
      edges: [{ id: 'e1', source: 'T', target: 'A' }],
    };
    const initialState = buildInitialRunState({ runId, workflowId, graph, inputs: {} });
    ctx.db.insert(schema.workflows).values({
      id: workflowId,
      workspaceId: ctx.workspace.id,
      ambientId: ctx.ambient.id,
      userId: ctx.user.id,
      title: 'brain-context',
      graph,
      settings: {},
    }).run();
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
      inputs: {},
      initialState,
      graph,
    });

    const task = await adapter.nextTask;
    expect(task.description).toContain('WORKSPACE BRAIN');
    expect(task.description).toContain('Keep workflow responses extremely short');

    await engine.notifyTaskCompleted({
      runId,
      nodeId: 'A',
      output: { result: 'Short answer prepared.' },
    });
    const queued = ctx.db.select().from(schema.cognitivePromotionQueue).all();
    expect(queued.filter((row) => row.itemType === 'atom_promotion')).toHaveLength(1);
  });
});
