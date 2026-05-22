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
let autoMutatingToolCalls = 0;

describe('ChatSessionExecutor', () => {
  beforeEach(() => {
    mutatingToolCalls = 0;
    autoMutatingToolCalls = 0;
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
    registry.register(
      {
        id: 'agentis.auto_write_test',
        family: 'build',
        description: 'Test auto-executed write action.',
        inputSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] },
        mutating: true,
        autoExecute: true,
      },
      async (args) => {
        autoMutatingToolCalls += 1;
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
    expect(confirmation!.impact).toEqual(expect.objectContaining({
      summary: 'Test write action.',
      riskLevel: 'medium',
      reversible: false,
    }));
    expect(initial.some((delta) => delta.type === 'tool_result')).toBe(false);
    expect(mutatingToolCalls).toBe(0);

    const resumed = await collect(ChatSessionExecutor.confirm(adapter, confirmation!.turnId, true, ctx));

    expect(mutatingToolCalls).toBe(1);
    expect(resumed.some((delta) => delta.type === 'tool_result' && delta.name === 'agentis.write_test')).toBe(true);
    expect(resumed).toContainEqual({ type: 'text', delta: 'write complete' });
    expect(adapter.calls).toHaveLength(2);
  });

  it('auto-executes mutating tools that explicitly opt in', async () => {
    const adapter = new FakeChatAdapter(async function* (_messages, _tools, callIndex) {
      if (callIndex === 0) {
        yield { type: 'tool_call', id: 'tool_auto', name: 'agentis.auto_write_test', args: { value: 'built' } };
        yield { type: 'done', finishReason: 'tool_calls' };
        return;
      }
      yield { type: 'text', delta: 'auto write complete' };
      yield { type: 'done', finishReason: 'stop' };
    });

    const deltas = await collect(ChatSessionExecutor.turn(adapter, [], 'build this', {
      workspaceId: 'ws_1',
      agentId: 'agent_1',
      userId: 'user_1',
      conversationId: 'conv_auto',
    }));

    expect(autoMutatingToolCalls).toBe(1);
    expect(deltas.some((delta) => delta.type === 'confirmation_required')).toBe(false);
    expect(deltas.some((delta) => delta.type === 'tool_result' && delta.name === 'agentis.auto_write_test')).toBe(true);
    expect(deltas).toContainEqual({ type: 'text', delta: 'auto write complete' });
  });

  it('answers marker-protocol (CLI) agents through the orchestrator runtime fast path', async () => {
    const cliAdapter: AgentAdapter = {
      adapterType: 'codex',
      async connect() {},
      async disconnect() {},
      async healthCheck() {
        return { isHealthy: true, checkedAt: new Date().toISOString() };
      },
      onEvent() {},
      async dispatchTask() {},
      async cancelTask() {},
      capabilities() {
        return { interactiveChat: true, toolCalling: true, toolForwarding: 'marker_protocol' as const };
      },
      async *chat() {
        yield { type: 'text', delta: 'FROM_SLOW_CLI' };
        yield { type: 'done', finishReason: 'stop' as const };
      },
    };
    const runtime = new FakeChatAdapter(async function* () {
      yield { type: 'text', delta: 'FROM_FAST_RUNTIME' };
      yield { type: 'done', finishReason: 'stop' };
    });
    ChatSessionExecutor.configure({ orchestratorRuntime: runtime });

    const deltas = await collect(ChatSessionExecutor.turn(cliAdapter, [], 'hi', {
      workspaceId: 'ws_1',
      agentId: 'agent_1',
      userId: 'user_1',
      conversationId: 'conv_fast',
    }));

    expect(deltas).toContainEqual({ type: 'text', delta: 'FROM_FAST_RUNTIME' });
    expect(deltas.some((delta) => delta.type === 'text' && delta.delta === 'FROM_SLOW_CLI')).toBe(false);
    expect(runtime.calls).toHaveLength(1);
  });

  it('does not divert native adapters when an orchestrator runtime is configured', async () => {
    const native = new FakeChatAdapter(async function* () {
      yield { type: 'text', delta: 'FROM_NATIVE' };
      yield { type: 'done', finishReason: 'stop' };
    });
    const runtime = new FakeChatAdapter(async function* () {
      yield { type: 'text', delta: 'FROM_RUNTIME' };
      yield { type: 'done', finishReason: 'stop' };
    });
    ChatSessionExecutor.configure({ orchestratorRuntime: runtime });

    const deltas = await collect(ChatSessionExecutor.turn(native, [], 'hi', {
      workspaceId: 'ws_1',
      agentId: 'agent_1',
      userId: 'user_1',
      conversationId: 'conv_native',
    }));

    expect(deltas).toContainEqual({ type: 'text', delta: 'FROM_NATIVE' });
    expect(runtime.calls).toHaveLength(0);
  });
});
