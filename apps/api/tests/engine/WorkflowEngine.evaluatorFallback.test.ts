import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
import { AuditTrailService } from '../../src/services/auditTrail.js';
import { ScratchpadService } from '../../src/services/scratchpad.js';
import { ActivityFeedService } from '../../src/services/activityFeed.js';
import { ApprovalInboxService } from '../../src/services/approvalInbox.js';
import { AdapterManager } from '../../src/adapters/AdapterManager.js';
import type { ExtensionRuntime } from '../../src/services/extensionRuntime.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

class EvaluatingAgentAdapter implements AgentAdapter {
  readonly adapterType: AdapterType = 'codex';
  readonly chatPrompts: ChatMessage[][] = [];
  readonly chatOptions: Array<ChatInvocationOptions | undefined> = [];
  readonly #handlers = new Set<(event: NormalizedAgentEvent) => void>();

  constructor(private readonly agentId: string) {}

  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}
  async healthCheck() {
    return { isHealthy: true, checkedAt: new Date().toISOString() };
  }
  capabilities(): AdapterCapabilities {
    return {
      interactiveChat: true,
      toolCalling: true,
      toolForwarding: 'marker_protocol',
    };
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
          output: { digest: 'A concise, sourced AI news digest.' },
          timestamp: new Date().toISOString(),
        });
      }
    });
  }
  async *chat(
    history: ChatMessage[],
    _tools: ToolDefinition[],
    options?: ChatInvocationOptions,
  ): AsyncIterable<ChatDelta> {
    this.chatPrompts.push(history);
    this.chatOptions.push(options);
    yield {
      type: 'text',
      delta: JSON.stringify({
        score: 9,
        passed: true,
        critique: 'The digest is concise and meets the requested criteria.',
      }),
    };
    yield { type: 'done', finishReason: 'stop' };
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

describe('WorkflowEngine evaluator agent fallback', () => {
  it('uses the evaluated agent model when no dedicated EvaluatorRuntime exists', async () => {
    const agentId = randomUUID();
    ctx.db.insert(schema.agents).values({
      id: agentId,
      workspaceId: ctx.workspace.id,
      ambientId: ctx.ambient.id,
      userId: ctx.user.id,
      name: 'Orchy',
      adapterType: 'codex',
      capabilityTags: [],
      config: { model: 'gpt-5.3-codex' },
      runtimeModel: 'gpt-5.3-codex',
      role: 'orchestrator',
      status: 'online',
    }).run();

    const adapter = new EvaluatingAgentAdapter(agentId);
    const adapters = new AdapterManager(ctx.logger);
    adapters.register(agentId, adapter);
    const engine = new WorkflowEngine({
      db: ctx.db,
      bus: ctx.bus,
      logger: ctx.logger,
      ledger: new LedgerService(ctx.db, ctx.bus),
      scratchpad: new ScratchpadService(ctx.bus, ctx.logger),
      activity: new ActivityFeedService(ctx.db, ctx.bus),
      approvals: new ApprovalInboxService(ctx.db, ctx.bus),
      audit: new AuditTrailService(ctx.db, ctx.logger),
      extensions: {} as unknown as ExtensionRuntime,
      adapters,
    });
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
          id: 'write-digest',
          type: 'agent_task',
          title: 'Write digest',
          position: { x: 200, y: 0 },
          config: {
            kind: 'agent_task',
            agentId,
            prompt: 'Write the digest.',
            inputKeys: [],
            outputKeys: [],
            capabilityTags: [],
            modelOverride: 'gpt-5.3-codex',
          },
        },
        {
          id: 'evaluate-digest',
          type: 'evaluator',
          title: 'Evaluate digest',
          position: { x: 400, y: 0 },
          config: {
            kind: 'evaluator',
            targetPath: '{{nodes.write-digest}}',
            criteria: 'The digest must be concise and useful.',
            passThreshold: 8,
          },
        },
      ],
      edges: [
        { id: 'trigger-to-agent', source: 'trigger', target: 'write-digest' },
        { id: 'agent-to-evaluator', source: 'write-digest', target: 'evaluate-digest' },
      ],
    };
    const workflowId = randomUUID();
    const runId = randomUUID();
    const initialState = buildInitialRunState({
      runId,
      workflowId,
      graph,
      inputs: {},
    });
    ctx.db.insert(schema.workflows).values({
      id: workflowId,
      workspaceId: ctx.workspace.id,
      ambientId: ctx.ambient.id,
      userId: ctx.user.id,
      title: 'Evaluator fallback',
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

    const terminal = new Promise<void>((resolve, reject) => {
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
      nodeStates: Record<string, { outputData?: Record<string, unknown>; error?: string }>;
    };
    expect(run.status).toBe('COMPLETED');
    expect(state.nodeStates['evaluate-digest']?.error).toBeFalsy();
    expect(state.nodeStates['evaluate-digest']?.outputData).toMatchObject({
      score: 9,
      passed: true,
    });
    expect(adapter.chatPrompts).toHaveLength(1);
    expect(adapter.chatOptions[0]?.preferredModel).toBe('gpt-5.3-codex');
    expect(adapter.chatPrompts[0]?.map((message) => message.content).join('\n'))
      .toContain('A concise, sourced AI news digest.');

    // Attribution gap closed: the evaluator ran on the agent's model, so its
    // `node.completed` audit entry must METER the spend AND stamp the agent id —
    // no evaluator/router spend reads as anonymous "engine" anymore.
    const evalAudit = ctx.db
      .select()
      .from(schema.auditEntries)
      .where(eq(schema.auditEntries.runId, runId))
      .all()
      .find((entry) => entry.nodeId === 'evaluate-digest' && entry.action === 'node.completed');
    expect(evalAudit).toBeTruthy();
    expect(evalAudit?.agentId).toBe(agentId);
    expect((evalAudit?.tokensIn ?? 0) + (evalAudit?.tokensOut ?? 0)).toBeGreaterThan(0);
  });
});
