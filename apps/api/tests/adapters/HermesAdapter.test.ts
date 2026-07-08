import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { NormalizedAgentEvent, NormalizedTask } from '@agentis/core';
import { HermesAdapter } from '../../src/adapters/HermesAdapter.js';
import { LocalLlmAdapter } from '../../src/adapters/LocalLlmAdapter.js';
import type { Logger } from '../../src/logger.js';

const logger: Logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: () => logger,
};

const task: NormalizedTask = {
  taskId: 'task-1',
  runId: 'run-1',
  workflowId: 'workflow-1',
  nodeId: 'node-1',
  title: 'Research',
  description: 'Summarize the result.',
  inputData: { topic: 'adapter' },
  scratchpadSnapshot: {},
  capabilityTags: ['research'],
  timeoutMs: 10_000,
};

describe('HermesAdapter', () => {
  beforeEach(() => {
    process.env.AGENTIS_EXTENSION_HTTP_ALLOW_PRIVATE = 'true';
  });

  afterEach(() => {
    delete process.env.AGENTIS_EXTENSION_HTTP_ALLOW_PRIVATE;
  });

  it('normalizes OpenAI-compatible SSE deltas into progress, tool, and completion events', async () => {
    const fetchImpl = vi.fn(async () => new Response([
      'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"lo","tool_calls":[{"function":{"name":"search","arguments":"{\\"q\\":\\"x\\"}"}}]}}]}\n\n',
      'data: [DONE]\n\n',
    ].join(''), { headers: { 'content-type': 'text/event-stream' } }));
    const adapter = new HermesAdapter({ agentId: 'agent-1', baseUrl: 'http://localhost:11434', model: 'hermes-3', apiKey: 'secret', logger, fetchImpl });
    const { events, completed } = captureUntil(adapter, 'task.completed');

    await adapter.dispatchTask(task);
    await completed;

    expect(fetchImpl).toHaveBeenCalledWith('http://localhost:11434/v1/chat/completions', expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({ authorization: 'Bearer secret' }),
    }));
    expect(events.map((event) => event.eventType)).toEqual(['task.started', 'task.progress', 'task.progress', 'agent.tool_call', 'task.completed']);
    expect(events).toContainEqual(expect.objectContaining({ eventType: 'task.completed', output: expect.objectContaining({ text: 'Hello' }) }));
    expect(events).toContainEqual(expect.objectContaining({ eventType: 'agent.tool_call', tool: 'search' }));
  });

  it('handles non-streaming JSON responses from OpenAI-compatible servers', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      model: 'hermes-3',
      choices: [{ message: { content: 'Final answer' } }],
      usage: { total_tokens: 12 },
    }), { headers: { 'content-type': 'application/json' } }));
    const adapter = new HermesAdapter({ agentId: 'agent-1', baseUrl: 'http://localhost:11434/v1', model: 'hermes-3', logger, fetchImpl });
    const { events, completed } = captureUntil(adapter, 'task.completed');

    await adapter.dispatchTask(task);
    await completed;

    expect(fetchImpl).toHaveBeenCalledWith('http://localhost:11434/v1/chat/completions', expect.anything());
    expect(events).toContainEqual(expect.objectContaining({ eventType: 'task.progress', message: 'Final answer' }));
    expect(events).toContainEqual(expect.objectContaining({ eventType: 'task.completed', output: expect.objectContaining({ text: 'Final answer' }) }));
  });

  it('emits task.failed when SSRF guard blocks a private endpoint', async () => {
    delete process.env.AGENTIS_EXTENSION_HTTP_ALLOW_PRIVATE;
    const fetchImpl = vi.fn(async () => new Response('should not run'));
    const adapter = new HermesAdapter({ agentId: 'agent-1', baseUrl: 'http://127.0.0.1:11434', model: 'hermes-3', logger, fetchImpl });
    const { events, completed } = captureUntil(adapter, 'task.failed');

    await adapter.dispatchTask(task);
    await completed;

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(events).toContainEqual(expect.objectContaining({ eventType: 'task.failed' }));
  });

  it('aborts a stalled chat() request via the idle watchdog instead of hanging forever', async () => {
    // A fetch that never resolves on its own — only the abort signal ends it.
    const fetchImpl = vi.fn((_url: string, init: { signal?: AbortSignal }) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    })) as unknown as typeof fetch;
    const adapter = new HermesAdapter({ agentId: 'agent-1', baseUrl: 'http://localhost:11434', model: 'hermes-3', logger, fetchImpl, chatTimeoutMs: 50 });

    const deltas: unknown[] = [];
    let threw = false;
    try {
      for await (const delta of adapter.chat([{ role: 'user', content: 'hi' }], [])) deltas.push(delta);
    } catch (err) {
      threw = true;
      expect((err as Error).message).toContain('did not respond within 50ms');
    }

    expect(threw).toBe(true);
    expect(deltas).toContainEqual({ type: 'done', finishReason: 'error' });
  });

  it('streams chat() deltas to completion when data flows (watchdog never trips)', async () => {
    const fetchImpl = vi.fn(async () => new Response(
      'data: {"choices":[{"delta":{"content":"Hi there"}}]}\n\ndata: [DONE]\n\n',
      { headers: { 'content-type': 'text/event-stream' } },
    )) as unknown as typeof fetch;
    const adapter = new HermesAdapter({ agentId: 'agent-1', baseUrl: 'http://localhost:11434', model: 'hermes-3', logger, fetchImpl, chatTimeoutMs: 5000 });

    const deltas: unknown[] = [];
    for await (const delta of adapter.chat([{ role: 'user', content: 'hi' }], [])) deltas.push(delta);

    expect(deltas).toContainEqual({ type: 'text', delta: 'Hi there' });
    expect(deltas.at(-1)).toEqual({ type: 'done', finishReason: 'stop' });
  });
});

describe('LocalLlmAdapter', () => {
  afterEach(() => {
    delete process.env.AGENTIS_EXTENSION_HTTP_ALLOW_PRIVATE;
  });

  it('allows localhost OpenAI-compatible endpoints without the private-network env flag', async () => {
    delete process.env.AGENTIS_EXTENSION_HTTP_ALLOW_PRIVATE;
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      model: 'llama3.1',
      choices: [{ message: { content: 'Local answer' } }],
    }), { headers: { 'content-type': 'application/json' } }));
    const adapter = new LocalLlmAdapter({ agentId: 'agent-1', baseUrl: 'http://127.0.0.1:11434', model: 'llama3.1', logger, fetchImpl });
    const { events, completed } = captureUntil(adapter, 'task.completed');

    await adapter.dispatchTask(task);
    await completed;

    expect(fetchImpl).toHaveBeenCalledWith('http://127.0.0.1:11434/v1/chat/completions', expect.objectContaining({
      headers: expect.objectContaining({ 'user-agent': 'Agentis/1.0 (LocalLlmAdapter)' }),
    }));
    expect(events).toContainEqual(expect.objectContaining({ eventType: 'task.completed', output: expect.objectContaining({ text: 'Local answer' }) }));
  });

  it('rejects public endpoints so local mode cannot bypass hosted SSRF protections', async () => {
    const fetchImpl = vi.fn(async () => new Response('should not run'));
    const adapter = new LocalLlmAdapter({ agentId: 'agent-1', baseUrl: 'https://8.8.8.8:11434', model: 'llama3.1', logger, fetchImpl });
    const { events, completed } = captureUntil(adapter, 'task.failed');

    await adapter.dispatchTask(task);
    await completed;

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(events).toContainEqual(expect.objectContaining({ eventType: 'task.failed' }));
  });
});

function captureUntil(adapter: HermesAdapter, eventType: NormalizedAgentEvent['eventType']) {
  const events: NormalizedAgentEvent[] = [];
  let resolveCompleted: () => void;
  const completed = new Promise<void>((resolve) => {
    resolveCompleted = resolve;
  });
  adapter.onEvent((event) => {
    events.push(event);
    if (event.eventType === eventType) resolveCompleted();
  });
  return { events, completed };
}