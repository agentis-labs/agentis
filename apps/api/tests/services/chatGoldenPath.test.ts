import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type {
  AdapterCapabilities,
  AgentAdapter,
  AdapterHealthStatus,
  ChatDelta,
  ChatMessage,
  NormalizedAgentEvent,
  NormalizedTask,
  ToolDefinition,
  WorkflowGraph,
} from '@agentis/core';
import { REALTIME_EVENTS } from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import { ChatSessionExecutor } from '../../src/services/chatSessionExecutor.js';
import { ChatToolExecutor } from '../../src/services/chatToolExecutor.js';
import { AgentisToolRegistry } from '../../src/services/agentisToolRegistry.js';
import { registerBuildTools } from '../../src/services/agentisToolHandlers/build.js';
import type { ToolHandlerDeps } from '../../src/services/agentisToolHandlers/deps.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

class ScriptedChatAdapter implements AgentAdapter {
  readonly adapterType = 'codex' as const;
  calls: ChatMessage[][] = [];

  constructor(
    private readonly impl: (messages: ChatMessage[], tools: ToolDefinition[], callIndex: number) => AsyncIterable<ChatDelta>,
  ) {}

  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}
  async healthCheck(): Promise<AdapterHealthStatus> {
    return { isHealthy: true, checkedAt: new Date().toISOString() };
  }
  capabilities(): AdapterCapabilities {
    return { interactiveChat: true, toolCalling: true, toolForwarding: 'marker_protocol' };
  }
  onEvent(_handler: (event: NormalizedAgentEvent) => void): void {}
  async dispatchTask(_task: NormalizedTask): Promise<void> {}
  async cancelTask(_taskId: string): Promise<void> {}
  chat(messages: ChatMessage[], tools: ToolDefinition[]): AsyncIterable<ChatDelta> {
    this.calls.push(messages);
    return this.impl(messages, tools, this.calls.length - 1);
  }
}

async function collect(iterable: AsyncIterable<ChatDelta>): Promise<ChatDelta[]> {
  const deltas: ChatDelta[] = [];
  for await (const delta of iterable) deltas.push(delta);
  return deltas;
}

let ctx: TestContext;

beforeEach(async () => {
  ctx = await createTestContext();
  const registry = new AgentisToolRegistry({ logger: ctx.logger });
  registerBuildTools(registry, deps());
  ChatToolExecutor.configure({ registry });
  ChatSessionExecutor.configure({ db: ctx.db, logger: ctx.logger, bus: ctx.bus });
});

afterEach(() => ctx.close());

function deps(): ToolHandlerDeps {
  return {
    db: ctx.db,
    logger: ctx.logger,
    bus: ctx.bus,
    engine: { cancelRun: async () => undefined } as ToolHandlerDeps['engine'],
    adapters: {} as ToolHandlerDeps['adapters'],
    ledger: { listForRun: async () => [] } as unknown as ToolHandlerDeps['ledger'],
    scratchpad: {} as ToolHandlerDeps['scratchpad'],
    approvals: { list: () => [] } as unknown as ToolHandlerDeps['approvals'],
    activity: {} as ToolHandlerDeps['activity'],
    replay: {} as ToolHandlerDeps['replay'],
  };
}

describe('chat golden path', () => {
  it('creates a Hello World workflow through the chat tool loop instead of advising manually', async () => {
    const captured = ctx.captureBus();
    const adapter = new ScriptedChatAdapter(async function* (_messages, tools, callIndex) {
      expect(tools.some((tool) => tool.name === 'agentis.build_workflow')).toBe(true);
      if (callIndex === 0) {
        yield { type: 'thinking', delta: 'I can build this directly.' };
        yield {
          type: 'tool_call',
          id: 'call_build_hello',
          name: 'agentis.build_workflow',
          args: {
            title: 'Hello World',
            description: 'Create a manual Hello World workflow that returns the fixed object { text: "Workflow is working" }.',
          },
        };
        yield { type: 'done', finishReason: 'tool_calls' };
        return;
      }
      expect(_messages.some((message) => message.role === 'tool' && String(message.content).includes('Workflow'))).toBe(true);
      yield { type: 'text', delta: 'Built it. Opening the workflow canvas now.' };
      yield { type: 'done', finishReason: 'stop' };
    });

    const deltas = await collect(ChatSessionExecutor.turn(adapter, [], 'Build a Hello World workflow.', {
      workspaceId: ctx.workspace.id,
      ambientId: ctx.ambient.id,
      agentId: 'agent_orchestrator',
      userId: ctx.user.id,
      conversationId: 'conv_golden',
    }));

    expect(deltas.some((delta) => delta.type === 'confirmation_required')).toBe(false);
    expect(deltas).toContainEqual(expect.objectContaining({
      type: 'tool_result',
      id: 'call_build_hello',
      name: 'agentis.build_workflow',
    }));
    expect(deltas).toContainEqual({ type: 'text', delta: 'Built it. Opening the workflow canvas now.' });
    expect(adapter.calls).toHaveLength(2);

    const workflows = ctx.db.select().from(schema.workflows).all();
    expect(workflows).toHaveLength(1);
    expect(workflows[0]!.title).toBe('Hello World');
    const graph = workflows[0]!.graph as WorkflowGraph;
    // build_workflow now emits trigger → transform (produces value) → return_output
    // with a renderAs viewer hint (Layer 6), instead of a transform+isOutput idiom.
    expect(graph.nodes).toEqual([
      expect.objectContaining({ id: 'trigger_manual', type: 'trigger' }),
      expect.objectContaining({
        id: 'produce_output',
        type: 'transform',
        config: expect.objectContaining({ expression: '{"text":"Workflow is working"}' }),
      }),
      expect.objectContaining({
        id: 'return_output',
        type: 'return_output',
        config: expect.objectContaining({ kind: 'return_output', renderAs: 'text' }),
      }),
    ]);
    expect(captured.events.some((event) => event.envelope.event === REALTIME_EVENTS.CANVAS_BUILD_COMPLETE)).toBe(true);
    captured.stop();
  });
});
