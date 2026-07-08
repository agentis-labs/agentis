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
import { ChatSessionExecutor } from '../../src/services/chat/chatSessionExecutor.js';
import { ChatToolExecutor } from '../../src/services/chat/chatToolExecutor.js';
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
    adapters: { get: () => undefined, list: () => [] } as unknown as ToolHandlerDeps['adapters'],
    ledger: { listForRun: async () => [] } as unknown as ToolHandlerDeps['ledger'],
    scratchpad: {} as ToolHandlerDeps['scratchpad'],
    approvals: { list: () => [] } as unknown as ToolHandlerDeps['approvals'],
    activity: {} as ToolHandlerDeps['activity'],
    replay: {} as ToolHandlerDeps['replay'],
  };
}

describe('chat golden path', () => {
  it('builds a workflow through an agent-authored tool call', async () => {
    const captured = ctx.captureBus();
    // The selected agent owns the graph design, invokes the build tool, and then
    // reports the persisted result to the operator.
    const adapter = new ScriptedChatAdapter(async function* (_messages, _tools, callIndex) {
      if (callIndex === 0) {
        yield {
          type: 'tool_call',
          id: 'build-hello-world',
          name: 'agentis.build_workflow',
          args: {
            title: 'Hello World',
            description: 'Build a Hello World workflow.',
            graphDraft: {
              version: 1,
              viewport: { x: 0, y: 0, zoom: 1 },
              nodes: [
                { id: 'trigger', type: 'trigger', title: 'Manual Trigger', position: { x: 0, y: 0 }, config: { kind: 'trigger', triggerType: 'manual' } },
                { id: 'produce_output', type: 'transform', title: 'Produce Output', position: { x: 280, y: 0 }, config: { kind: 'transform', expression: '{"text":"Workflow is working"}' } },
                { id: 'return_output', type: 'return_output', title: 'Return Output', position: { x: 560, y: 0 }, config: { kind: 'return_output', renderAs: 'text' } },
              ],
              edges: [
                { id: 'trigger-produce', source: 'trigger', target: 'produce_output' },
                { id: 'produce-output', source: 'produce_output', target: 'return_output' },
              ],
            },
          },
        };
        yield { type: 'done', finishReason: 'tool_calls' };
        return;
      }
      yield { type: 'text', delta: 'Built the Hello World workflow.' };
      yield { type: 'done', finishReason: 'stop' };
    });

    const deltas = await collect(ChatSessionExecutor.turn(adapter, [], 'Build a Hello World workflow.', {
      workspaceId: ctx.workspace.id,
      ambientId: ctx.ambient.id,
      agentId: 'agent_orchestrator',
      userId: ctx.user.id,
      conversationId: 'conv_golden',
    }));

    expect(adapter.calls).toHaveLength(2);
    expect(deltas.some((delta) => delta.type === 'confirmation_required')).toBe(false);

    // The build ran as a real tool and produced a workflow id (not advice).
    const toolResult = deltas.find(
      (d): d is Extract<ChatDelta, { type: 'tool_result' }> =>
        d.type === 'tool_result' && d.name === 'agentis.build_workflow',
    );
    expect(toolResult).toBeDefined();
    expect(toolResult!.error).toBeUndefined();

    // Never a blank turn — it tells the operator what happened, then stops cleanly.
    expect(deltas.some((d) => d.type === 'text' && /built/i.test(d.delta))).toBe(true);
    expect(deltas.at(-1)).toEqual({ type: 'done', finishReason: 'stop' });

    // Exactly one workflow persisted with the agent-authored Hello World graph.
    const workflows = ctx.db.select().from(schema.workflows).all();
    expect(workflows).toHaveLength(1);
    expect(workflows[0]!.title).toContain('Hello World');
    const graph = workflows[0]!.graph as WorkflowGraph;
    expect(graph.nodes.map((n) => n.id)).toEqual(['trigger', 'produce_output', 'return_output']);
    expect(graph.nodes[1]).toEqual(expect.objectContaining({
      type: 'transform',
      config: expect.objectContaining({ expression: '{"text":"Workflow is working"}' }),
    }));
    expect(graph.nodes[2]).toEqual(expect.objectContaining({
      type: 'return_output',
      config: expect.objectContaining({ kind: 'return_output', renderAs: 'text' }),
    }));

    // The canvas receives a build-complete signal for the live UI.
    expect(captured.events.some((event) => event.envelope.event === REALTIME_EVENTS.CANVAS_BUILD_COMPLETE)).toBe(true);
    captured.stop();
  });
});
