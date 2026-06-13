import { describe, expect, it } from 'vitest';
import type {
  AgentAdapter,
  ChatDelta,
  ChatInvocationOptions,
  ChatMessage,
  ToolDefinition,
} from '@agentis/core';
import { AdapterStructuredCompleter, completeStructuredViaAdapter } from '../../src/services/structuredCompleter.js';

function adapterWithChat(
  chat: (
    messages: ChatMessage[],
    tools: ToolDefinition[],
    options?: ChatInvocationOptions,
  ) => AsyncIterable<ChatDelta>,
  capabilities?: AgentAdapter['capabilities'],
): AgentAdapter {
  return {
    adapterType: 'codex',
    async connect() {},
    async disconnect() {},
    async healthCheck() {
      return { isHealthy: true, checkedAt: new Date().toISOString() };
    },
    async dispatchTask() {},
    async cancelTask() {},
    onEvent() {},
    chat,
    ...(capabilities ? { capabilities } : {}),
  };
}

describe('completeStructuredViaAdapter', () => {
  it('uses the bounded caller-owned structured profile', async () => {
    let invocation: ChatInvocationOptions | undefined;
    const adapter = adapterWithChat((_messages, _tools, options) => {
      invocation = options;
      return (async function* () {
        yield { type: 'text', delta: '{"status":"ok"}' } as ChatDelta;
        yield { type: 'done', finishReason: 'stop' } as ChatDelta;
      })();
    });

    const result = await completeStructuredViaAdapter<{ status: string }>(adapter, {
      system: 'Return JSON.',
      user: 'Build a graph.',
      maxTokens: 2_500,
      timeoutMs: 12_345,
    });

    expect(result).toEqual({ value: { status: 'ok' }, error: null });
    expect(invocation).toMatchObject({
      latencyClass: 'structured',
      toolMode: 'caller_loop',
      timeoutMs: 12_345,
      maxTokens: 2_500,
    });
  });

  it('defaults structured completions to 30 seconds', async () => {
    let invocation: ChatInvocationOptions | undefined;
    const adapter = adapterWithChat((_messages, _tools, options) => {
      invocation = options;
      return (async function* () {
        yield { type: 'text', delta: '{"status":"ok"}' } as ChatDelta;
        yield { type: 'done', finishReason: 'stop' } as ChatDelta;
      })();
    });

    await completeStructuredViaAdapter(adapter, {
      system: 'Return JSON.',
      user: 'Build a graph.',
    });

    expect(invocation?.timeoutMs).toBe(30_000);
  });

  it('retries a transient runtime failure in a fresh structured attempt', async () => {
    let calls = 0;
    const adapter = adapterWithChat(() => {
      calls += 1;
      return (async function* () {
        if (calls === 1) {
          yield {
            type: 'tool_result',
            id: 'adapter',
            name: 'adapter.chat',
            result: null,
            error: 'Transport channel closed',
          } as ChatDelta;
          yield { type: 'done', finishReason: 'error' } as ChatDelta;
          return;
        }
        yield { type: 'text', delta: '{"status":"recovered"}' } as ChatDelta;
        yield { type: 'done', finishReason: 'stop' } as ChatDelta;
      })();
    });

    const result = await completeStructuredViaAdapter(adapter, {
      system: 'Return JSON.',
      user: 'Build a graph.',
      maxAttempts: 2,
    });

    expect(calls).toBe(2);
    expect(result).toEqual({ value: { status: 'recovered' }, error: null });
  });

  it('returns the runtime error after the bounded transient retry is exhausted', async () => {
    let calls = 0;
    const adapter = adapterWithChat(() => {
      calls += 1;
      return (async function* () {
        yield {
          type: 'tool_result',
          id: 'adapter',
          name: 'adapter.chat',
          result: null,
          error: 'Codex request timed out',
        } as ChatDelta;
        yield { type: 'done', finishReason: 'error' } as ChatDelta;
      })();
    });

    const result = await completeStructuredViaAdapter(adapter, {
      system: 'Return JSON.',
      user: 'Build a graph.',
      maxAttempts: 2,
    });

    expect(calls).toBe(2);
    expect(result).toEqual({ value: null, error: 'Codex request timed out' });
  });

  it('does not retry a non-transient adapter exception', async () => {
    let calls = 0;
    const adapter = adapterWithChat(() => {
      calls += 1;
      throw new Error('invalid runtime configuration');
    });

    const result = await completeStructuredViaAdapter(adapter, {
      system: 'Return JSON.',
      user: 'Build a graph.',
      maxAttempts: 3,
    });

    expect(calls).toBe(1);
    expect(result).toEqual({ value: null, error: 'invalid runtime configuration' });
  });
});

describe('AdapterStructuredCompleter default timeout', () => {
  function captureTimeout(capabilities?: AgentAdapter['capabilities']): {
    completer: AdapterStructuredCompleter;
    seen: () => number | undefined;
  } {
    let invocation: ChatInvocationOptions | undefined;
    const adapter = adapterWithChat((_messages, _tools, options) => {
      invocation = options;
      return (async function* () {
        yield { type: 'text', delta: '{"status":"ok"}' } as ChatDelta;
        yield { type: 'done', finishReason: 'stop' } as ChatDelta;
      })();
    }, capabilities);
    return { completer: new AdapterStructuredCompleter(adapter), seen: () => invocation?.timeoutMs };
  }

  it('gives a CLI harness 60s for synthesis (cold re-spawn needs the headroom)', async () => {
    const { completer, seen } = captureTimeout(() => ({
      interactiveChat: true,
      toolCalling: true,
      toolForwarding: 'marker_protocol' as const,
    }));
    await completer.completeStructured({ system: 'Return JSON.', user: 'Build a graph.' });
    expect(seen()).toBe(60_000);
  });

  it('keeps the tight 30s default for a streaming (non-harness) adapter', async () => {
    const { completer, seen } = captureTimeout(() => ({
      interactiveChat: true,
      toolCalling: true,
      toolForwarding: 'native' as const,
    }));
    await completer.completeStructured({ system: 'Return JSON.', user: 'Build a graph.' });
    expect(seen()).toBe(30_000);
  });

  it('honors an explicit per-call timeout over the adapter default', async () => {
    const { completer, seen } = captureTimeout(() => ({
      interactiveChat: true,
      toolCalling: true,
      toolForwarding: 'marker_protocol' as const,
    }));
    await completer.completeStructured({ system: 'Return JSON.', user: 'Build a graph.', timeoutMs: 5_000 });
    expect(seen()).toBe(5_000);
  });
});
