import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import {
  REALTIME_EVENTS,
  type AdapterCapabilities,
  type AgentAdapter,
  type AdapterType,
  type NormalizedAgentEvent,
  type NormalizedTask,
  type WorkflowGraph,
} from '@agentis/core';
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

class CapturingAdapter implements AgentAdapter {
  readonly adapterType: AdapterType = 'http';
  readonly tasks: NormalizedTask[] = [];
  readonly #handlers = new Set<(event: NormalizedAgentEvent) => void>();

  constructor(
    private readonly agentId: string,
    private readonly affordances: NonNullable<AdapterCapabilities['affordances']>,
  ) {}

  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}
  async healthCheck() {
    return { isHealthy: true, checkedAt: new Date().toISOString() };
  }
  capabilities(): AdapterCapabilities {
    return {
      interactiveChat: false,
      toolCalling: false,
      toolForwarding: 'none',
      affordances: this.affordances,
    };
  }
  onEvent(handler: (event: NormalizedAgentEvent) => void): void {
    this.#handlers.add(handler);
  }
  async dispatchTask(task: NormalizedTask): Promise<void> {
    this.tasks.push(task);
    queueMicrotask(() => {
      for (const handler of this.#handlers) {
        handler({
          eventType: 'task.completed',
          agentId: this.agentId,
          taskId: task.nodeId,
          runId: task.runId,
          workflowId: task.workflowId,
          output: { routedTo: this.agentId },
          timestamp: new Date().toISOString(),
        });
      }
    });
  }
  async cancelTask(): Promise<void> {}
}

let ctx: TestContext;

beforeEach(async () => {
  ctx = await createTestContext();
});

afterEach(() => {
  ctx.close();
});

function seedAgent(name: string, capabilityTags: string[]): string {
  const id = randomUUID();
  ctx.db.insert(schema.agents).values({
    id,
    workspaceId: ctx.workspace.id,
    ambientId: ctx.ambient.id,
    userId: ctx.user.id,
    name,
    adapterType: 'http',
    capabilityTags,
    config: {},
    status: 'online',
  }).run();
  return id;
}

function buildEngine(adapters: AdapterManager): WorkflowEngine {
  const engine = new WorkflowEngine({
    db: ctx.db,
    bus: ctx.bus,
    logger: ctx.logger,
    ledger: new LedgerService(ctx.db, ctx.bus),
    scratchpad: new ScratchpadService(ctx.bus, ctx.logger),
    activity: new ActivityFeedService(ctx.db, ctx.bus),
    approvals: new ApprovalInboxService(ctx.db, ctx.bus),
    extensions: {} as unknown as ExtensionRuntime,
    adapters,
  });
  adapters.onEvent((event) => {
    if (event.eventType === 'task.completed') {
      void engine.notifyTaskCompleted({ runId: event.runId, nodeId: event.taskId, output: event.output });
    } else if (event.eventType === 'task.failed') {
      void engine.notifyTaskFailed({ runId: event.runId, nodeId: event.taskId, error: event.error });
    }
  });
  return engine;
}

function graph(config: Record<string, unknown>): WorkflowGraph {
  return {
    version: 1,
    viewport: { x: 0, y: 0, zoom: 1 },
    nodes: [
      { id: 'T', type: 'trigger', title: 'Manual', position: { x: 0, y: 0 }, config: { kind: 'trigger', triggerType: 'manual' } },
      {
        id: 'A',
        type: 'agent_task',
        title: 'Route me',
        position: { x: 200, y: 0 },
        config: {
          kind: 'agent_task',
          prompt: 'Use the best runtime.',
          inputKeys: [],
          outputKeys: [],
          capabilityTags: [],
          ...config,
        },
      },
    ],
    edges: [{ id: 'e1', source: 'T', target: 'A' }],
  } as WorkflowGraph;
}

function runGraph(engine: WorkflowEngine, graph: WorkflowGraph): Promise<'COMPLETED' | 'FAILED'> {
  const workflowId = randomUUID();
  const runId = randomUUID();
  ctx.db.insert(schema.workflows).values({
    id: workflowId,
    workspaceId: ctx.workspace.id,
    ambientId: ctx.ambient.id,
    userId: ctx.user.id,
    title: 'capability-routing',
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
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), 15_000);
    const off = ctx.bus.subscribe((message) => {
      if (message.room !== `run:${runId}`) return;
      if (message.envelope.event === REALTIME_EVENTS.RUN_COMPLETED) {
        clearTimeout(timer);
        off();
        resolve('COMPLETED');
      }
      if (message.envelope.event === REALTIME_EVENTS.RUN_FAILED) {
        clearTimeout(timer);
        off();
        resolve('FAILED');
      }
    });
    void engine.startRun({
      workspaceId: ctx.workspace.id,
      ambientId: ctx.ambient.id,
      workflowId,
      userId: ctx.user.id,
      triggerId: null,
      inputs: {},
      initialState,
      graph,
    });
  });
}

describe('WorkflowEngine capability-aware routing', () => {
  it('falls back from an auto-materialized specialist pin to a connected runtime', async () => {
    const specialistId = randomUUID();
    ctx.db.insert(schema.agents).values({
      id: specialistId,
      workspaceId: ctx.workspace.id,
      ambientId: ctx.ambient.id,
      userId: ctx.user.id,
      name: 'Research Specialist',
      role: 'researcher',
      adapterType: 'http',
      capabilityTags: [],
      config: { specialist: true },
      status: 'offline',
    }).run();

    const orchestratorId = seedAgent('Workspace Orchestrator', []);
    ctx.db.update(schema.agents)
      .set({ role: 'orchestrator' })
      .where(eq(schema.agents.id, orchestratorId))
      .run();

    const orchestratorAdapter = new CapturingAdapter(orchestratorId, { terminal: true });
    const adapters = new AdapterManager(ctx.logger);
    adapters.register(orchestratorId, orchestratorAdapter);

    const status = await runGraph(buildEngine(adapters), graph({
      agentId: specialistId,
      agentRole: 'researcher',
    }));

    expect(status).toBe('COMPLETED');
    expect(orchestratorAdapter.tasks).toHaveLength(1);
  });

  it('filters tag-matched agent_task candidates by required adapter affordance', async () => {
    const codeAgentId = seedAgent('Code runtime', ['research']);
    const browserAgentId = seedAgent('Browser runtime', ['research']);
    const codeAdapter = new CapturingAdapter(codeAgentId, { terminal: true });
    const browserAdapter = new CapturingAdapter(browserAgentId, { browser: true, terminal: true });
    const adapters = new AdapterManager(ctx.logger);
    adapters.register(codeAgentId, codeAdapter);
    adapters.register(browserAgentId, browserAdapter);

    const status = await runGraph(buildEngine(adapters), graph({
      capabilityTags: ['research'],
      requires: { browser: true },
    }));

    expect(status).toBe('COMPLETED');
    expect(codeAdapter.tasks).toHaveLength(0);
    expect(browserAdapter.tasks).toHaveLength(1);
  });

  it('fails early when a pinned agent lacks a required affordance', async () => {
    const agentId = seedAgent('Terminal runtime', ['research']);
    const adapter = new CapturingAdapter(agentId, { terminal: true });
    const adapters = new AdapterManager(ctx.logger);
    adapters.register(agentId, adapter);

    const status = await runGraph(buildEngine(adapters), graph({
      agentId,
      requires: { browser: true },
    }));

    expect(status).toBe('FAILED');
    expect(adapter.tasks).toHaveLength(0);
  });
});
