import { beforeEach, describe, expect, it } from 'vitest';
import type { AgentAdapter, AdapterHealthStatus, ChatDelta, ChatInvocationOptions, ChatMessage, NormalizedAgentEvent, NormalizedTask, ToolDefinition } from '@agentis/core';
import { REALTIME_EVENTS } from '@agentis/core';
import { ChatSessionExecutor } from '../../src/services/chatSessionExecutor.js';
import { ChatToolExecutor } from '../../src/services/chatToolExecutor.js';
import { AgentisToolRegistry } from '../../src/services/agentisToolRegistry.js';
import { createInProcessEventBus } from '../../src/event-bus.js';
import { createLogger } from '../../src/logger.js';

class FakeChatAdapter implements AgentAdapter {
  readonly adapterType = 'http' as const;
  calls: ChatMessage[][] = [];
  chatOptions: Array<ChatInvocationOptions | undefined> = [];
  constructor(private readonly impl: (messages: ChatMessage[], tools: ToolDefinition[], callIndex: number) => AsyncIterable<ChatDelta>) {}
  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}
  async healthCheck(): Promise<AdapterHealthStatus> {
    return { isHealthy: true, checkedAt: new Date().toISOString() };
  }
  onEvent(_handler: (event: NormalizedAgentEvent) => void): void {}
  async dispatchTask(_task: NormalizedTask): Promise<void> {}
  async cancelTask(_taskId: string): Promise<void> {}
  chat(messages: ChatMessage[], tools: ToolDefinition[], options?: ChatInvocationOptions): AsyncIterable<ChatDelta> {
    this.calls.push(messages);
    this.chatOptions.push(options);
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
let directBuildToolCalls = 0;
let directBuildToolRunIds: string[] = [];
let directBuildToolArgs: Array<Record<string, unknown>> = [];

describe('ChatSessionExecutor', () => {
  beforeEach(() => {
    mutatingToolCalls = 0;
    autoMutatingToolCalls = 0;
    directBuildToolCalls = 0;
    directBuildToolRunIds = [];
    directBuildToolArgs = [];
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
    registry.register(
      {
        id: 'agentis.build_workflow',
        family: 'build',
        description: 'Build a workflow from a description.',
        inputSchema: {
          type: 'object',
          properties: { description: { type: 'string' }, title: { type: 'string' }, workflowId: { type: 'string' } },
          required: ['description'],
        },
        mutating: true,
        autoExecute: true,
      },
      async (args, toolCtx) => {
        directBuildToolCalls += 1;
        directBuildToolRunIds.push(String(toolCtx.runId ?? ''));
        directBuildToolArgs.push(args);
        return {
          workflowId: 'wf_direct',
          runId: toolCtx.runId,
          title: typeof args.title === 'string' ? args.title : 'Email Robson',
          description: args.description,
          nodeCount: 5,
          edgeCount: 4,
          approvalRequired: true,
          warnings: [],
          estimatedDurationMs: 1900,
          deliveryPreview: [
            {
              service: 'agentmail',
              to: 'robsonpradodev@gmail.com',
              summary: 'Agentmail -> robsonpradodev@gmail.com',
            },
          ],
        };
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

    const deltas = await collect(ChatSessionExecutor.turn(adapter, [], 'answer normally', {
      workspaceId: 'ws_1',
      agentId: 'agent_1',
      userId: 'user_1',
      conversationId: 'conv_1',
    }));

    expect(deltas).toContainEqual({ type: 'text', delta: 'hello' });
    expect(deltas.at(-1)).toEqual({ type: 'done', finishReason: 'stop' });
    expect(adapter.calls[0]![0]!.role).toBe('system');
    expect(adapter.calls[0]!.at(-1)).toMatchObject({ role: 'user', content: 'answer normally' });
    expect(adapter.chatOptions[0]).toMatchObject({
      latencyClass: 'interactive',
      timeoutMs: 15_000,
    });
  });

  it('answers greetings through the real harness (no canned shortcut)', async () => {
    const adapter = new FakeChatAdapter(async function* () {
      yield { type: 'text', delta: 'Hey! What can I help you with?' };
      yield { type: 'done', finishReason: 'stop' };
    });

    const deltas = await collect(ChatSessionExecutor.turn(adapter, [], 'hi', {
      workspaceId: 'ws_1',
      agentId: 'agent_1',
      userId: 'user_1',
      conversationId: 'conv_1',
      clientTurnId: 'turn_1',
    }));

    // The greeting now flows to the model like any other turn — the response is
    // whatever the harness produced, never a hardcoded string.
    expect(deltas).toContainEqual({ type: 'text', delta: 'Hey! What can I help you with?' });
    expect(deltas.at(-1)).toEqual({ type: 'done', finishReason: 'stop' });
    expect(adapter.calls.length).toBe(1);
    expect(adapter.calls[0]!.at(-1)).toMatchObject({ role: 'user', content: 'hi' });
  });

  it('never ends a turn silently — emits a terminal message when the model returns no text', async () => {
    // Model produces neither text nor a tool call and just signals done.
    const adapter = new FakeChatAdapter(async function* () {
      yield { type: 'done', finishReason: 'stop' };
    });

    const deltas = await collect(ChatSessionExecutor.turn(adapter, [], 'do the thing', {
      workspaceId: 'ws_1',
      agentId: 'agent_1',
      userId: 'user_1',
      conversationId: 'conv_1',
    }));

    const text = deltas.filter((d): d is Extract<ChatDelta, { type: 'text' }> => d.type === 'text').map((d) => d.delta).join('');
    expect(text.length).toBeGreaterThan(0);
    expect(deltas.at(-1)).toEqual({ type: 'done', finishReason: 'stop' });
  });

  it('does not inject a fallback message when the model already produced text', async () => {
    const adapter = new FakeChatAdapter(async function* () {
      yield { type: 'text', delta: 'real answer' };
      yield { type: 'done', finishReason: 'stop' };
    });

    const deltas = await collect(ChatSessionExecutor.turn(adapter, [], 'do the thing', {
      workspaceId: 'ws_1',
      agentId: 'agent_1',
      userId: 'user_1',
      conversationId: 'conv_1',
    }));

    const text = deltas.filter((d): d is Extract<ChatDelta, { type: 'text' }> => d.type === 'text').map((d) => d.delta).join('');
    expect(text).toBe('real answer');
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

  it('directly builds obvious workflow requests without invoking the chat adapter', async () => {
    const adapter = new FakeChatAdapter(async function* () {
      throw new Error('chat adapter should not be invoked for direct workflow builds');
    });

    const deltas = await collect(ChatSessionExecutor.turn(adapter, [], 'build a workflow that sends Hi Robson to my email robsonpradodev@gmail.com', {
      workspaceId: 'ws_1',
      agentId: 'agent_1',
      userId: 'user_1',
      conversationId: 'conv_direct_build',
      clientTurnId: 'turn_build_1',
    }));

    expect(adapter.calls).toHaveLength(0);
    expect(directBuildToolCalls).toBe(1);
    expect(directBuildToolRunIds).toEqual(['build_turn_build_1']);
    expect(deltas).toContainEqual(expect.objectContaining({
      type: 'activity',
      phase: 'workflow',
      runId: 'build_turn_build_1',
      label: 'Building workflow',
    }));
    expect(deltas).toContainEqual(expect.objectContaining({
      type: 'tool_call',
      name: 'agentis.build_workflow',
    }));
    expect(deltas).toContainEqual(expect.objectContaining({
      type: 'tool_result',
      name: 'agentis.build_workflow',
      result: expect.objectContaining({
        workflowId: 'wf_direct',
        runId: 'build_turn_build_1',
      }),
    }));
    const text = deltas
      .filter((delta): delta is Extract<ChatDelta, { type: 'text' }> => delta.type === 'text')
      .map((delta) => delta.delta)
      .join('');
    expect(text).toContain('5 nodes');
    expect(text).toContain('robsonpradodev@gmail.com');
    expect(text).toContain('Approval required before delivery');
    expect(text).not.toMatch(/Est\.|\/run|Completed in|seconds?/i);
    expect(deltas.at(-1)).toEqual({ type: 'done', finishReason: 'stop' });
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

  it('gives a CLI harness a realistic per-round timeout when it answers directly (no runtime)', async () => {
    // With no orchestrator runtime configured the harness answers the turn itself.
    // A re-spawning CLI cannot meet the 15s streaming budget, so the loop must hand
    // it the larger harness budget — otherwise every real task dies with
    // "request timed out after 15 seconds".
    const seenOptions: Array<ChatInvocationOptions | undefined> = [];
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
      async *chat(_messages, _tools, options) {
        seenOptions.push(options);
        yield { type: 'text', delta: 'built it' };
        yield { type: 'done', finishReason: 'stop' as const };
      },
    };

    await collect(ChatSessionExecutor.turn(cliAdapter, [], 'create a workflow with a new extension', {
      workspaceId: 'ws_1',
      agentId: 'agent_1',
      userId: 'user_1',
      conversationId: 'conv_harness',
    }));

    expect(seenOptions[0]?.latencyClass).toBe('interactive');
    expect(seenOptions[0]?.timeoutMs).toBe(240_000);
    expect(seenOptions[0]?.timeoutMs).not.toBe(15_000);
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

  it('injects agent memory, personal brain, workspace context, and agent instructions into the system prompt when wired', async () => {
    const native = new FakeChatAdapter(async function* () {
      yield { type: 'text', delta: 'ok' };
      yield { type: 'done', finishReason: 'stop' };
    });

    const fakeAgentMemory = {
      contextSection: (agentId: string, workspaceId: string) => `FAKE_AGENT_MEMORY_FOR_${agentId}_IN_${workspaceId}`,
    } as any;

    const fakePersonalBrain = {
      contextForAgent: async (userId: string, agentId: string, query: string) => `FAKE_PERSONAL_BRAIN_FOR_${agentId}`,
    } as any;

    const fakeWorkspaceIntelligence = {
      buildContextBlock: async (workspaceId: string, opts: any) => `FAKE_WORKSPACE_CONTEXT_IN_${workspaceId}_QUERY_${opts.knowledgeQuery}`,
    } as any;

    // Chainable query stub: where(...).orderBy(...).limit(...).all()/.get().
    const queryChain: any = {
      get: () => ({ id: 'agent_1', name: 'Test Agent', instructions: 'FAKE_AGENT_INSTRUCTIONS_HERE' }),
      all: () => [],
      orderBy: () => queryChain,
      limit: () => queryChain,
    };
    const fakeDb = {
      select: () => ({ from: () => ({ where: () => queryChain }) }),
    } as any;

    ChatSessionExecutor.configure({
      db: fakeDb,
      agentMemory: fakeAgentMemory,
      personalBrain: fakePersonalBrain,
      workspaceIntelligence: fakeWorkspaceIntelligence,
    });

    await collect(ChatSessionExecutor.turn(native, [], 'summarize the latest workflow run', {
      workspaceId: 'ws_1',
      agentId: 'agent_1',
      userId: 'user_1',
      conversationId: 'conv_1',
    }));

    expect(native.calls).toHaveLength(1);
    const systemPrompt = native.calls[0]![0]!.content;
    expect(systemPrompt).toContain('FAKE_AGENT_INSTRUCTIONS_HERE');
    expect(systemPrompt).toContain('FAKE_AGENT_MEMORY_FOR_agent_1_IN_ws_1');
    expect(systemPrompt).toContain('FAKE_PERSONAL_BRAIN_FOR_agent_1');
    // A substantive message carries a query signal, so knowledge retrieval runs
    // and the message is forwarded as the knowledge query.
    expect(systemPrompt).toContain('FAKE_WORKSPACE_CONTEXT_IN_ws_1_QUERY_summarize the latest workflow run');
  });

  it('clamps injected memory/brain context to a fixed budget so prompt size stays constant', async () => {
    const native = new FakeChatAdapter(async function* () {
      yield { type: 'text', delta: 'ok' };
      yield { type: 'done', finishReason: 'stop' };
    });
    // A retriever that returns a huge block (simulating years of accumulated memory).
    const huge = 'X'.repeat(50_000);
    const queryChain: any = {
      get: () => ({ id: 'agent_1', name: 'Test Agent', instructions: 'INSTR' }),
      all: () => [], orderBy: () => queryChain, limit: () => queryChain,
    };
    ChatSessionExecutor.configure({
      db: { select: () => ({ from: () => ({ where: () => queryChain }) }) } as any,
      agentMemory: { contextSection: () => huge } as any,
      personalBrain: { contextForAgent: async () => huge } as any,
      workspaceIntelligence: { buildContextBlock: async () => huge } as any,
    });

    await collect(ChatSessionExecutor.turn(native, [], 'hi', {
      workspaceId: 'ws_1', agentId: 'agent_1', userId: 'user_1', conversationId: 'conv_2',
    }));

    const systemPrompt = native.calls[0]![0]!.content as string;
    // The 3 × 50KB blocks must be clamped to their budgets (~8KB total), not 150KB.
    expect(systemPrompt.length).toBeLessThan(20_000);
    expect(systemPrompt).toContain('truncated to keep context size constant');
  });

  it('gives mcp_native harnesses native tool ownership while preserving the bounded fallback loop', async () => {
    let chatCalls = 0;
    const invocationOptions: Array<ChatInvocationOptions | undefined> = [];
    const harness: AgentAdapter = {
      adapterType: 'codex' as AgentAdapter['adapterType'],
      capabilities: () => ({ interactiveChat: true, toolCalling: true, toolForwarding: 'mcp_native' }),
      async connect() {},
      async disconnect() {},
      async healthCheck() { return { isHealthy: true, checkedAt: new Date().toISOString() }; },
      onEvent() {},
      async dispatchTask() {},
      async cancelTask() {},
      chat(_messages, _tools, options) {
        chatCalls += 1;
        invocationOptions.push(options);
        const call = chatCalls;
        return (async function* () {
          if (call === 1) {
            yield { type: 'tool_call', id: 't1', name: 'agentis.plan', args: { goal: 'x' } } as ChatDelta;
            yield { type: 'done', finishReason: 'tool_calls' } as ChatDelta;
            return;
          }
          yield { type: 'text', delta: 'Done.' } as ChatDelta;
          yield { type: 'done', finishReason: 'stop' } as ChatDelta;
        })();
      },
    };

    const deltas = await collect(ChatSessionExecutor.turn(harness, [], 'build me a thing', {
      workspaceId: 'ws_1', agentId: 'agent_1', userId: 'user_1', conversationId: 'conv_mcp',
    }));

    expect(chatCalls).toBe(2);
    expect(invocationOptions[0]).toMatchObject({
      toolMode: 'adapter_native',
      sessionKey: 'conv_mcp',
    });
    expect(deltas.some((d) => d.type === 'tool_call')).toBe(true);
    expect(deltas).toContainEqual({ type: 'text', delta: 'Done.' });
    expect(deltas.at(-1)).toEqual({ type: 'done', finishReason: 'stop' });
  });

  it('skips MCP and remote context enrichment for lightweight conversation', async () => {
    let receivedTools: ToolDefinition[] = [];
    let enrichmentCalls = 0;
    const invocationOptions: Array<ChatInvocationOptions | undefined> = [];
    const harness: AgentAdapter = {
      adapterType: 'codex',
      capabilities: () => ({ interactiveChat: true, toolCalling: true, toolForwarding: 'mcp_native' }),
      async connect() {},
      async disconnect() {},
      async healthCheck() { return { isHealthy: true, checkedAt: new Date().toISOString() }; },
      onEvent() {},
      async dispatchTask() {},
      async cancelTask() {},
      chat(_messages, tools, options) {
        receivedTools = tools;
        invocationOptions.push(options);
        return (async function* () {
          yield { type: 'text', delta: 'Hello.' } as ChatDelta;
          yield { type: 'done', finishReason: 'stop' } as ChatDelta;
        })();
      },
    };
    ChatSessionExecutor.configure({
      brainDiscourse: { buildTurn: async () => { enrichmentCalls += 1; return null; } } as any,
      personalBrain: { contextForAgent: async () => { enrichmentCalls += 1; return null; } } as any,
      workspaceIntelligence: { buildContextBlock: async () => { enrichmentCalls += 1; return null; } } as any,
    });

    const deltas = await collect(ChatSessionExecutor.turn(harness, [], 'Hi', {
      workspaceId: 'ws_1', agentId: 'agent_1', userId: 'user_1', conversationId: 'conv_hi',
    }));

    expect(receivedTools).toEqual([]);
    expect(invocationOptions[0]).toMatchObject({
      toolMode: 'caller_loop',
      sessionKey: 'conv_hi',
    });
    expect(enrichmentCalls).toBe(0);
    expect(deltas).toContainEqual({ type: 'text', delta: 'Hello.' });
  });

  it('routes active-canvas workflow mutations directly to the durable compiler', async () => {
    const adapter = new FakeChatAdapter(async function* () {
      throw new Error('chat adapter should not be invoked for active workflow mutations');
    });

    const deltas = await collect(ChatSessionExecutor.turn(
      adapter,
      [],
      'update this workflow to send html emails',
      {
        workspaceId: 'ws_1',
        agentId: 'agent_1',
        userId: 'user_1',
        conversationId: 'conv_direct_update',
        clientTurnId: 'turn_update_1',
      },
      {
        viewport: {
          surface: 'workflow_detail',
          resourceKind: 'workflow',
          resourceId: 'wf_active',
          title: 'Workflow canvas',
        },
      },
    ));

    expect(adapter.calls).toHaveLength(0);
    expect(directBuildToolCalls).toBe(1);
    expect(directBuildToolArgs[0]).toMatchObject({
      workflowId: 'wf_active',
      description: 'update this workflow to send html emails',
    });
    expect(deltas).toContainEqual(expect.objectContaining({
      type: 'activity',
      phase: 'workflow',
      label: 'Updating workflow',
    }));
    expect(deltas.some((delta) => delta.type === 'text' && delta.delta.startsWith('Updated '))).toBe(true);
    expect(deltas.at(-1)).toEqual({ type: 'done', finishReason: 'stop' });
  });

  it('does not mutate a workflow when no target resource is available', async () => {
    const adapter = new FakeChatAdapter(async function* () {
      yield { type: 'text', delta: 'Which workflow should I update?' };
      yield { type: 'done', finishReason: 'stop' };
    });

    const deltas = await collect(ChatSessionExecutor.turn(adapter, [], 'update this workflow to send html emails', {
      workspaceId: 'ws_1',
      agentId: 'agent_1',
      userId: 'user_1',
      conversationId: 'conv_missing_target',
    }));

    expect(directBuildToolCalls).toBe(0);
    expect(adapter.calls).toHaveLength(1);
    expect(deltas).toContainEqual({ type: 'text', delta: 'Which workflow should I update?' });
  });

  it('keeps workflow architecture discussion in ordinary chat', async () => {
    const adapter = new FakeChatAdapter(async function* () {
      yield { type: 'text', delta: 'Architecture explanation' };
      yield { type: 'done', finishReason: 'stop' };
    });

    await collect(ChatSessionExecutor.turn(
      adapter,
      [],
      'explain how to improve this workflow architecture',
      {
        workspaceId: 'ws_1',
        agentId: 'agent_1',
        userId: 'user_1',
        conversationId: 'conv_meta',
      },
      {
        viewport: {
          surface: 'workflow_detail',
          resourceKind: 'workflow',
          resourceId: 'wf_active',
          title: 'Workflow canvas',
        },
      },
    ));

    expect(directBuildToolCalls).toBe(0);
    expect(adapter.calls).toHaveLength(1);
  });

  it('uses the full tool loop when a workflow request also requires creating a capability', async () => {
    const adapter = new FakeChatAdapter(async function* () {
      yield { type: 'text', delta: 'I will create the listener extension before building the workflow.' };
      yield { type: 'done', finishReason: 'stop' };
    });

    await collect(ChatSessionExecutor.turn(
      adapter,
      [],
      'Create a new extension that watches social posts, then build a workflow that emails matching posts.',
      {
        workspaceId: 'ws_1',
        agentId: 'agent_1',
        userId: 'user_1',
        conversationId: 'conv_capability_build',
      },
    ));

    expect(directBuildToolCalls).toBe(0);
    expect(adapter.calls).toHaveLength(1);
  });

  it('streams live build narration (phases + nodes) into the chat turn', async () => {
    // A build tool that publishes the real backend narration on the bus, keyed by
    // the build runId — exactly as createWorkflowFromDescription does.
    const bus = createInProcessEventBus();
    const registry = new AgentisToolRegistry({ logger: createLogger({ level: 'error' }) });
    registry.register(
      {
        id: 'agentis.build_workflow', family: 'build', description: 'b',
        inputSchema: { type: 'object', properties: { description: { type: 'string' } }, required: ['description'] },
        mutating: true, autoExecute: true,
      },
      async (args, toolCtx) => {
        const runId = String(toolCtx.runId ?? '');
        bus.publish('workspace:ws_1', REALTIME_EVENTS.WORKFLOW_BUILD_PHASE, { workflowId: 'wf1', runId, phase: 'drafting' });
        bus.publish('workspace:ws_1', REALTIME_EVENTS.CANVAS_NODE_PLACED, { workflowId: 'wf1', runId, node: { id: 'n1' }, nodeLabel: 'Fetch AI news' });
        bus.publish('workspace:ws_1', REALTIME_EVENTS.CANVAS_BUILD_COMPLETE, { workflowId: 'wf1', runId, nodeCount: 5, edgeCount: 4 });
        return { workflowId: 'wf1', runId, title: 'AI News', description: String(args.description), nodeCount: 5, edgeCount: 4, warnings: [] };
      },
    );
    ChatToolExecutor.configure({ registry });
    ChatSessionExecutor.configure({ bus });

    const adapter = new FakeChatAdapter(async function* () { yield { type: 'done', finishReason: 'stop' }; });
    const deltas = await collect(ChatSessionExecutor.turn(adapter, [], 'create a workflow that emails me the AI news', {
      workspaceId: 'ws_1', agentId: 'agent_1', userId: 'user_1', conversationId: 'conv_narr', clientTurnId: 'turn_narr',
    }));

    const labels = deltas
      .filter((d): d is Extract<ChatDelta, { type: 'activity' }> => d.type === 'activity')
      .map((d) => d.label);
    expect(labels).toContain('Drafting the workflow graph');
    expect(labels.some((l) => l.startsWith('Placed Fetch AI news'))).toBe(true);
    expect(labels).toContain('Workflow ready');
  });

  it('recovers a reasoning-only turn instead of returning the empty fallback', async () => {
    // Round 0: the model reasons but emits no answer text (reasoning model burning
    // its budget thinking). Round 1 (the recovery retry): a real answer.
    const adapter = new FakeChatAdapter(async function* (_m, _t, callIndex) {
      if (callIndex === 0) {
        yield { type: 'thinking', delta: 'let me think about this…' };
        yield { type: 'done', finishReason: 'stop' };
      } else {
        yield { type: 'text', delta: 'here is the answer' };
        yield { type: 'done', finishReason: 'stop' };
      }
    });

    const deltas = await collect(ChatSessionExecutor.turn(adapter, [], 'fix the trigger then', {
      workspaceId: 'ws_1', agentId: 'agent_1', userId: 'user_1', conversationId: 'conv_recover',
    }));

    const text = deltas.filter((d): d is Extract<ChatDelta, { type: 'text' }> => d.type === 'text').map((d) => d.delta).join('');
    expect(text).toContain('here is the answer');
    expect(text).not.toContain('didn’t produce a reply');
    expect(adapter.calls.length).toBe(2);
    // The retry appends an explicit "write your final answer" nudge.
    expect(String(adapter.calls[1]!.at(-1)!.content)).toContain('final answer');
  });

  it('recovers a truncated (finish_reason length) turn with a retry', async () => {
    const adapter = new FakeChatAdapter(async function* (_m, _t, callIndex) {
      if (callIndex === 0) {
        yield { type: 'done', finishReason: 'length' };
      } else {
        yield { type: 'text', delta: 'recovered answer' };
        yield { type: 'done', finishReason: 'stop' };
      }
    });

    const deltas = await collect(ChatSessionExecutor.turn(adapter, [], 'summarize the long thing', {
      workspaceId: 'ws_1', agentId: 'agent_1', userId: 'user_1', conversationId: 'conv_len',
    }));

    const text = deltas.filter((d): d is Extract<ChatDelta, { type: 'text' }> => d.type === 'text').map((d) => d.delta).join('');
    expect(text).toContain('recovered answer');
    expect(adapter.calls.length).toBe(2);
  });

  it('gives an honest message when a reasoning-only turn stays empty after the retry', async () => {
    // Both passes reason without answering — after one retry, give up honestly
    // (and do NOT loop forever).
    const adapter = new FakeChatAdapter(async function* () {
      yield { type: 'thinking', delta: 'thinking…' };
      yield { type: 'done', finishReason: 'stop' };
    });

    const deltas = await collect(ChatSessionExecutor.turn(adapter, [], 'do the thing', {
      workspaceId: 'ws_1', agentId: 'agent_1', userId: 'user_1', conversationId: 'conv_giveup',
    }));

    const text = deltas.filter((d): d is Extract<ChatDelta, { type: 'text' }> => d.type === 'text').map((d) => d.delta).join('');
    expect(text).toContain('didn’t manage to put my answer into words');
    expect(adapter.calls.length).toBe(2);
  });
});
