import { beforeEach, describe, expect, it } from 'vitest';
import type { AgentAdapter, AdapterHealthStatus, ChatDelta, ChatMessage, NormalizedAgentEvent, NormalizedTask, ToolDefinition } from '@agentis/core';
import { ChatSessionExecutor } from '../../src/services/chatSessionExecutor.js';
import { ChatToolExecutor } from '../../src/services/chatToolExecutor.js';
import { AgentisToolRegistry } from '../../src/services/agentisToolRegistry.js';
import { createLogger } from '../../src/logger.js';

class FakeChatAdapter implements AgentAdapter {
  readonly adapterType = 'http' as const;
  calls: ChatMessage[][] = [];
  constructor(private readonly impl: (messages: ChatMessage[], tools: ToolDefinition[], callIndex: number) => AsyncIterable<ChatDelta>) {}
  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}
  async healthCheck(): Promise<AdapterHealthStatus> {
    return { isHealthy: true, checkedAt: new Date().toISOString() };
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

let mutatingToolCalls = 0;

describe('ChatSessionExecutor', () => {
  beforeEach(() => {
    mutatingToolCalls = 0;
    const registry = new AgentisToolRegistry({ logger: createLogger({ level: 'error' }) });
    registry.register(
      {
        id: 'agentis.plan',
        family: 'inspect',
        description: 'Test planner.',
        inputSchema: { type: 'object', properties: { goal: { type: 'string' } }, required: ['goal'] },
        mutating: false,
      },
      async (args) => ({ goal: args.goal, steps: [`Plan ${String(args.goal)}`] }),
    );
    registry.register(
      {
        id: 'agentis.write_test',
        family: 'run',
        description: 'Test write action.',
        inputSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] },
        mutating: true,
      },
      async (args) => {
        mutatingToolCalls += 1;
        return { wrote: args.value };
      },
    );
    ChatToolExecutor.configure({ registry });
    ChatSessionExecutor.configure({});
  });

  it('streams a normal assistant response and terminates', async () => {
    const adapter = new FakeChatAdapter(async function* () {
      yield { type: 'text', delta: 'hello' };
      yield { type: 'done', finishReason: 'stop' };
    });

    const deltas = await collect(ChatSessionExecutor.turn(adapter, [], 'hi', {
      workspaceId: 'ws_1',
      agentId: 'agent_1',
      userId: 'user_1',
      conversationId: 'conv_1',
    }));

    expect(deltas).toContainEqual({ type: 'text', delta: 'hello' });
    expect(deltas.at(-1)).toEqual({ type: 'done', finishReason: 'stop' });
    expect(adapter.calls[0]![0]!.role).toBe('system');
    expect(adapter.calls[0]!.at(-1)).toMatchObject({ role: 'user', content: 'hi' });
  });

  it('executes tool calls and feeds summarized tool results into the next model turn', async () => {
    const adapter = new FakeChatAdapter(async function* (_messages, _tools, callIndex) {
      if (callIndex === 0) {
        yield { type: 'tool_call', id: 'tool_1', name: 'agentis.plan', args: { goal: 'ship chat loop' } };
        yield { type: 'done', finishReason: 'tool_calls' };
        return;
      }
      yield { type: 'text', delta: 'planned' };
      yield { type: 'done', finishReason: 'stop' };
    });

    const deltas = await collect(ChatSessionExecutor.turn(adapter, [], 'plan this', {
      workspaceId: 'ws_1',
      agentId: 'agent_1',
      userId: 'user_1',
      conversationId: 'conv_1',
    }));

    expect(deltas.some((delta) => delta.type === 'tool_result' && delta.name === 'agentis.plan')).toBe(true);
    expect(deltas).toContainEqual({ type: 'text', delta: 'planned' });
    expect(adapter.calls).toHaveLength(2);
    expect(adapter.calls[1]!.some((message) => message.role === 'tool' && String(message.content).includes('ship chat loop'))).toBe(true);
  });

  it('stops runaway tool loops at maxTurns', async () => {
    const adapter = new FakeChatAdapter(async function* () {
      yield { type: 'tool_call', id: 'tool_1', name: 'agentis.plan', args: { goal: 'loop' } };
      yield { type: 'done', finishReason: 'tool_calls' };
    });

    const deltas = await collect(ChatSessionExecutor.turn(adapter, [], 'loop', {
      workspaceId: 'ws_1',
      agentId: 'agent_1',
      userId: 'user_1',
      conversationId: 'conv_1',
      maxTurns: 1,
    }));

    expect(deltas.at(-1)).toEqual({ type: 'done', finishReason: 'max_turns' });
  });

  it('pauses mutating tools for confirmation and resumes after approval', async () => {
    const adapter = new FakeChatAdapter(async function* (_messages, _tools, callIndex) {
      if (callIndex === 0) {
        yield { type: 'tool_call', id: 'tool_write', name: 'agentis.write_test', args: { value: 'confirmed' } };
        yield { type: 'done', finishReason: 'tool_calls' };
        return;
      }
      yield { type: 'text', delta: 'write complete' };
      yield { type: 'done', finishReason: 'stop' };
    });

    const ctx = {
      workspaceId: 'ws_1',
      agentId: 'agent_1',
      userId: 'user_1',
      conversationId: 'conv_confirm',
    };
    const initial = await collect(ChatSessionExecutor.turn(adapter, [], 'write this', ctx));
    const confirmation = initial.find(
      (delta): delta is Extract<ChatDelta, { type: 'confirmation_required' }> => delta.type === 'confirmation_required',
    );

    expect(confirmation).toBeTruthy();
    expect(initial.some((delta) => delta.type === 'tool_result')).toBe(false);
    expect(mutatingToolCalls).toBe(0);

    const resumed = await collect(ChatSessionExecutor.confirm(adapter, confirmation!.turnId, true, ctx));

    expect(mutatingToolCalls).toBe(1);
    expect(resumed.some((delta) => delta.type === 'tool_result' && delta.name === 'agentis.write_test')).toBe(true);
    expect(resumed).toContainEqual({ type: 'text', delta: 'write complete' });
    expect(adapter.calls).toHaveLength(2);
  });
});
