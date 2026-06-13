import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import {
  REALTIME_EVENTS,
  type AdapterCapabilities,
  type AdapterType,
  type AgentAdapter,
  type ChatDelta,
  type ChatInvocationOptions,
  type ChatMessage,
  type NormalizedAgentEvent,
  type NormalizedTask,
  type ToolDefinition,
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
import { createCustomIntegrationManifest, normalizeIntegrationManifest } from '../../src/services/integrationRegistry.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

class EnvelopeAgentAdapter implements AgentAdapter {
  readonly adapterType: AdapterType = 'codex';
  readonly #handlers = new Set<(event: NormalizedAgentEvent) => void>();

  constructor(
    private readonly agentId: string,
    private readonly payload: Record<string, unknown>,
  ) {}

  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}
  async healthCheck() {
    return { isHealthy: true, checkedAt: new Date().toISOString() };
  }
  capabilities(): AdapterCapabilities {
    return { interactiveChat: true, toolCalling: false };
  }
  onEvent(handler: (event: NormalizedAgentEvent) => void): void {
    this.#handlers.add(handler);
  }
  async dispatchTask(task: NormalizedTask): Promise<void> {
    queueMicrotask(() => {
      for (const handler of this.#handlers) {
        handler({
          eventType: 'task.completed',
          agentId: this.agentId,
          taskId: task.taskId,
          runId: task.runId,
          workflowId: task.workflowId,
          output: {
            text: ['```json', JSON.stringify(this.payload), '```'].join('\n'),
          },
          timestamp: new Date().toISOString(),
        });
      }
    });
  }
  async *chat(
    _history: ChatMessage[],
    _tools: ToolDefinition[],
    _options?: ChatInvocationOptions,
  ): AsyncIterable<ChatDelta> {
    yield { type: 'done', finishReason: 'stop' };
  }
  async cancelTask(): Promise<void> {}
}

let ctx: TestContext;

beforeEach(async () => {
  ctx = await createTestContext();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  ctx.close();
});

describe('WorkflowEngine condition-edge dispatch', () => {
  it('holds polluted ready-queue nodes until upstream inputs actually exist', async () => {
    vi.stubEnv('AGENTIS_INTEGRATION_HTTP_ALLOW_PRIVATE', 'true');
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), init });
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        url: String(url),
        headers: new Headers({ 'content-type': 'application/json' }),
        async text() { return JSON.stringify({ id: 'msg_1' }); },
      } as unknown as Response;
    }));

    createCustomIntegrationManifest(
      ctx.db,
      { workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id },
      normalizeIntegrationManifest({
        service: 'custom_mailer',
        name: 'Custom Mailer',
        version: '1.0.0',
        category: 'Communication',
        description: 'A custom manifest-backed mailer.',
        auth: { type: 'none' },
        operationSpecs: [{
          name: 'send',
          method: 'POST',
          urlTemplate: 'https://custom.example.test/send',
          bodyTemplate: {
            to: '{{params.to}}',
            subject: '{{params.subject}}',
            text: '{{params.text}}',
          },
          paramSchema: { type: 'object', required: ['to', 'subject', 'text'] },
        }],
      }),
    );

    const agentId = randomUUID();
    ctx.db.insert(schema.agents).values({
      id: agentId,
      workspaceId: ctx.workspace.id,
      ambientId: ctx.ambient.id,
      userId: ctx.user.id,
      name: 'Digest Writer',
      adapterType: 'codex',
      capabilityTags: [],
      config: {},
      role: 'worker',
      status: 'online',
    }).run();

    const adapters = new AdapterManager(ctx.logger);
    const adapter = new EnvelopeAgentAdapter(agentId, {
      subject: 'Daily AI News Insights',
      text: 'Ready-to-send digest body.',
    });
    adapters.register(agentId, adapter);
    const engine = makeEngine(adapters);
    adapters.onEvent((event) => {
      if (event.eventType === 'task.completed') {
        void engine.notifyTaskCompleted({
          runId: event.runId,
          nodeId: event.taskId,
          output: event.output,
        });
      }
    });

    const graph: WorkflowGraph = {
      version: 1,
      viewport: { x: 0, y: 0, zoom: 1 },
      nodes: [
        {
          id: 'trigger',
          type: 'trigger',
          title: 'Manual',
          position: { x: 0, y: 0 },
          config: { kind: 'trigger', triggerType: 'manual' },
        },
        {
          id: 'draft',
          type: 'agent_task',
          title: 'Draft',
          position: { x: 200, y: 0 },
          config: {
            kind: 'agent_task',
            agentId,
            prompt: 'Return the digest payload.',
            inputKeys: [],
            outputKeys: ['subject', 'text'],
            capabilityTags: [],
          },
        },
        {
          id: 'send',
          type: 'integration',
          title: 'Send',
          position: { x: 400, y: 0 },
          config: {
            kind: 'integration',
            integrationId: 'custom_mailer',
            operationId: 'send',
            inputs: {
              to: 'op@example.com',
              subject: '{{nodes.draft.subject}}',
              text: '{{nodes.draft.text}}',
            },
          },
        },
      ],
      edges: [
        { id: 'trigger-to-draft', source: 'trigger', target: 'draft' },
        { id: 'draft-to-send', source: 'draft', target: 'send', type: 'condition' },
      ],
    };

    const { runId, workflowId, initialState } = persistWorkflow(graph);
    initialState.readyQueue.unshift({
      nodeId: 'send',
      priority: 0,
      insertedAt: new Date().toISOString(),
      inputData: {
        subject: 'stale subject',
        text: 'stale body',
      },
    });
    const terminal = waitForTerminal(runId);

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
    await terminal;

    const run = ctx.db
      .select()
      .from(schema.workflowRuns)
      .where(eq(schema.workflowRuns.id, runId))
      .get()!;
    const state = run.runState as {
      nodeStates: Record<string, { status: string; error?: string; inputData?: Record<string, unknown> }>;
    };

    expect(run.status).toBe('COMPLETED');
    expect(state.nodeStates.send?.status).toBe('COMPLETED');
    expect(state.nodeStates.send?.error).toBeUndefined();
    expect(calls).toHaveLength(1);
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      to: 'op@example.com',
      subject: 'Daily AI News Insights',
      text: 'Ready-to-send digest body.',
    });
  });

  it('treats bare condition edges as implicit pass/fail gates', async () => {
    vi.stubEnv('AGENTIS_INTEGRATION_HTTP_ALLOW_PRIVATE', 'true');
    const fetchSpy = vi.fn(async (url: string, init: RequestInit) => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      url: String(url),
      headers: new Headers({ 'content-type': 'application/json' }),
      async text() { return JSON.stringify({ id: 'msg_1' }); },
    } as unknown as Response));
    vi.stubGlobal('fetch', fetchSpy);

    createCustomIntegrationManifest(
      ctx.db,
      { workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id },
      normalizeIntegrationManifest({
        service: 'custom_mailer',
        name: 'Custom Mailer',
        version: '1.0.0',
        category: 'Communication',
        description: 'A custom manifest-backed mailer.',
        auth: { type: 'none' },
        operationSpecs: [{
          name: 'send',
          method: 'POST',
          urlTemplate: 'https://custom.example.test/send',
          bodyTemplate: {
            to: '{{params.to}}',
            subject: '{{params.subject}}',
            text: '{{params.text}}',
          },
          paramSchema: { type: 'object', required: ['to', 'subject', 'text'] },
        }],
      }),
    );

    const graph: WorkflowGraph = {
      version: 1,
      viewport: { x: 0, y: 0, zoom: 1 },
      nodes: [
        {
          id: 'trigger',
          type: 'trigger',
          title: 'Manual',
          position: { x: 0, y: 0 },
          config: { kind: 'trigger', triggerType: 'manual' },
        },
        {
          id: 'gate',
          type: 'transform',
          title: 'Gate',
          position: { x: 200, y: 0 },
          config: {
            kind: 'transform',
            expression: '({ passed: false, subject: "Do not send", text: "Blocked" })',
          },
        },
        {
          id: 'send',
          type: 'integration',
          title: 'Send',
          position: { x: 400, y: 0 },
          config: {
            kind: 'integration',
            integrationId: 'custom_mailer',
            operationId: 'send',
            inputs: {
              to: 'op@example.com',
              subject: '{{nodes.gate.subject}}',
              text: '{{nodes.gate.text}}',
            },
          },
        },
      ],
      edges: [
        { id: 'trigger-to-gate', source: 'trigger', target: 'gate' },
        { id: 'gate-to-send', source: 'gate', target: 'send', type: 'condition' },
      ],
    };

    const { runId, workflowId, initialState } = persistWorkflow(graph);
    const terminal = waitForTerminal(runId);

    const engine = makeEngine(new AdapterManager(ctx.logger));
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
    await terminal;

    const run = ctx.db
      .select()
      .from(schema.workflowRuns)
      .where(eq(schema.workflowRuns.id, runId))
      .get()!;
    const state = run.runState as {
      nodeStates: Record<string, { status: string }>;
      skippedNodeIds?: string[];
    };

    expect(run.status).toBe('COMPLETED');
    expect(state.nodeStates.gate?.status).toBe('COMPLETED');
    expect(state.nodeStates.send?.status).toBe('SKIPPED');
    expect(state.skippedNodeIds).toContain('send');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('does not publish WAITING while a node failure is being committed', async () => {
    const graph: WorkflowGraph = {
      version: 1,
      viewport: { x: 0, y: 0, zoom: 1 },
      nodes: [
        {
          id: 'trigger',
          type: 'trigger',
          title: 'Manual',
          position: { x: 0, y: 0 },
          config: { kind: 'trigger', triggerType: 'manual' },
        },
        {
          id: 'broken',
          type: 'transform',
          title: 'Broken transform',
          position: { x: 200, y: 0 },
          config: { kind: 'transform', expression: 'throw new Error("boom")' },
        },
        {
          id: 'downstream',
          type: 'transform',
          title: 'Downstream',
          position: { x: 400, y: 0 },
          config: { kind: 'transform', expression: 'input' },
        },
      ],
      edges: [
        { id: 'trigger-to-broken', source: 'trigger', target: 'broken' },
        { id: 'broken-to-downstream', source: 'broken', target: 'downstream' },
      ],
    };
    const { runId, workflowId, initialState } = persistWorkflow(graph);
    const statuses: string[] = [];
    const unsubscribe = ctx.bus.subscribe((message) => {
      if (message.room !== `run:${runId}`) return;
      const status = (message.envelope.payload as { status?: string }).status;
      if (status) statuses.push(status);
    });
    const terminal = waitForTerminal(runId);

    await makeEngine(new AdapterManager(ctx.logger)).startRun({
      workspaceId: ctx.workspace.id,
      ambientId: ctx.ambient.id,
      workflowId,
      userId: ctx.user.id,
      triggerId: null,
      inputs: {},
      initialState,
      graph,
    });
    await terminal;
    unsubscribe();

    const run = ctx.db
      .select()
      .from(schema.workflowRuns)
      .where(eq(schema.workflowRuns.id, runId))
      .get()!;
    const state = run.runState as {
      nodeStates: Record<string, { status: string }>;
    };
    expect(statuses).not.toContain('WAITING');
    expect(run.status).toBe('FAILED');
    expect(state.nodeStates.broken?.status).toBe('FAILED');
    expect(state.nodeStates.downstream?.status).toBe('SKIPPED');
  });
});

function makeEngine(adapters: AdapterManager): WorkflowEngine {
  return new WorkflowEngine({
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
}

function persistWorkflow(graph: WorkflowGraph): {
  workflowId: string;
  runId: string;
  initialState: ReturnType<typeof buildInitialRunState>;
} {
  const workflowId = randomUUID();
  const runId = randomUUID();
  const initialState = buildInitialRunState({ runId, workflowId, graph, inputs: {} });
  ctx.db.insert(schema.workflows).values({
    id: workflowId,
    workspaceId: ctx.workspace.id,
    ambientId: ctx.ambient.id,
    userId: ctx.user.id,
    title: 'Condition edges',
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
  return { workflowId, runId, initialState };
}

function waitForTerminal(runId: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), 15_000);
    const unsubscribe = ctx.bus.subscribe((message) => {
      if (
        message.room === `run:${runId}`
        && (
          message.envelope.event === REALTIME_EVENTS.RUN_COMPLETED
          || message.envelope.event === REALTIME_EVENTS.RUN_FAILED
        )
      ) {
        clearTimeout(timer);
        unsubscribe();
        resolve();
      }
    });
  });
}
