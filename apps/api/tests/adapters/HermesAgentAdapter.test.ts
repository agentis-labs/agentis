import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ChatDelta, NormalizedAgentEvent, NormalizedTask } from '@agentis/core';
import { HermesAgentAdapter } from '../../src/adapters/HermesAgentAdapter.js';
import type { Logger } from '../../src/logger.js';

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));

vi.mock('node:child_process', () => ({ spawn: spawnMock }));

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
  title: 'Summarize',
  description: 'Summarize the input.',
  inputData: {},
  scratchpadSnapshot: {},
  capabilityTags: [],
  timeoutMs: 10_000,
};

describe('HermesAgentAdapter', () => {
  beforeEach(() => {
    vi.useRealTimers();
    spawnMock.mockReset();
  });

  it('defaults to the stable CLI compatibility transport', () => {
    const adapter = new HermesAgentAdapter({ agentId: 'agent-1', logger, binaryPath: 'hermes-test' });
    const caps = adapter.capabilities();
    expect(caps.interactiveChat).toBe(true);
    expect(caps.toolCalling).toBe(true);
    expect(caps.toolForwarding).toBe('marker_protocol');
    expect(caps.limitations).toContainEqual(expect.stringContaining('ACP builds can stall'));
  });

  it('advertises MCP-native chat when ACP is explicitly enabled', () => {
    const adapter = new HermesAgentAdapter({
      agentId: 'agent-1',
      logger,
      binaryPath: 'hermes-test',
      chatTransport: 'acp',
    });
    expect(adapter.capabilities().toolForwarding).toBe('mcp_native');
  });

  it('chats over ACP: streams thinking + answer and ends with done(stop)', async () => {
    const child = fakeAcpChild();
    spawnMock.mockReturnValue(child);
    const adapter = new HermesAgentAdapter({ agentId: 'agent-1', logger, binaryPath: 'hermes-test', chatTransport: 'acp' });
    const deltas: ChatDelta[] = [];

    child.on('__prompt', () => {
      child.update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'considering' } });
      child.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hello operator' } });
      child.finishPrompt('end_turn');
    });

    for await (const delta of adapter.chat([{ role: 'user', content: 'hi' }], [])) deltas.push(delta);

    // Spawned in ACP mode, not the old one-shot chat path.
    expect(spawnMock.mock.calls[0]![1]).toEqual(['acp']);
    expect(deltas).toContainEqual({ type: 'thinking', delta: 'considering' });
    expect(deltas).toContainEqual({ type: 'text', delta: 'Hello operator' });
    expect(deltas.at(-1)).toEqual({ type: 'done', finishReason: 'stop' });
  });

  it('mounts the Agentis MCP server in session/new so tools are real', async () => {
    const child = fakeAcpChild();
    spawnMock.mockReturnValue(child);
    const adapter = new HermesAgentAdapter({
      agentId: 'agent-1',
      logger,
      binaryPath: 'hermes-test',
      chatTransport: 'acp',
      mcpServers: [{ name: 'agentis', url: 'http://127.0.0.1:8787/v1/mcp/rpc', headers: { authorization: 'Bearer k', 'x-agentis-workspace': 'ws1' } }],
    });
    const deltas: ChatDelta[] = [];

    child.on('__prompt', () => child.finishPrompt('end_turn'));
    for await (const delta of adapter.chat([{ role: 'user', content: 'hi' }], [])) deltas.push(delta);

    const newParams = child.sessionNewParams as { mcpServers?: unknown[] };
    expect(newParams.mcpServers).toEqual([
      {
        type: 'http',
        name: 'agentis',
        url: 'http://127.0.0.1:8787/v1/mcp/rpc',
        headers: [
          { name: 'authorization', value: 'Bearer k' },
          { name: 'x-agentis-workspace', value: 'ws1' },
        ],
      },
    ]);
  });

  it('surfaces the harness own tool calls as live activity, never executable tool_calls', async () => {
    const child = fakeAcpChild();
    spawnMock.mockReturnValue(child);
    const adapter = new HermesAgentAdapter({ agentId: 'agent-1', logger, binaryPath: 'hermes-test', chatTransport: 'acp' });
    const deltas: ChatDelta[] = [];

    child.on('__prompt', () => {
      child.update({ sessionUpdate: 'tool_call', toolCallId: 'tc1', title: 'List workflows', kind: 'mcp__agentis__workflow_list', status: 'pending' });
      child.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Done.' } });
      child.finishPrompt('end_turn');
    });
    for await (const delta of adapter.chat([{ role: 'user', content: 'list workflows' }], [])) deltas.push(delta);

    expect(deltas).toContainEqual(expect.objectContaining({ type: 'activity', phase: 'tool', label: 'Using List workflows' }));
    // The agent ran the tool itself over MCP — Agentis must NOT re-execute it.
    expect(deltas.some((d) => d.type === 'tool_call')).toBe(false);
    expect(deltas.at(-1)).toEqual({ type: 'done', finishReason: 'stop' });
  });

  it('switches the ACP session to the configured model, resolving provider-prefixed ids', async () => {
    const child = fakeAcpChild({
      models: {
        availableModels: [
          { modelId: 'nous:stepfun/step-3.7-flash:free', name: 'stepfun/step-3.7-flash:free' },
          { modelId: 'nous:anthropic/claude-opus-4.5', name: 'anthropic/claude-opus-4.5' },
        ],
        currentModelId: 'nous:stepfun/step-3.7-flash:free',
      },
    });
    spawnMock.mockReturnValue(child);
    // Agentis stores the bare model name; the agent namespaces it by provider.
    const adapter = new HermesAgentAdapter({ agentId: 'agent-1', logger, binaryPath: 'hermes-test', model: 'anthropic/claude-opus-4.5', chatTransport: 'acp' });

    child.on('__prompt', () => child.finishPrompt('end_turn'));
    for await (const _ of adapter.chat([{ role: 'user', content: 'hi' }], [])) { /* drain */ }

    expect(child.setModelParams).toEqual({ sessionId: 'sess-1', modelId: 'nous:anthropic/claude-opus-4.5' });
  });

  it('prefers the per-call model override (UI runtime picker) over the static config', async () => {
    const child = fakeAcpChild({
      models: { availableModels: [{ modelId: 'nous:zai-org/glm-4.7', name: 'zai-org/glm-4.7' }], currentModelId: 'x' },
    });
    spawnMock.mockReturnValue(child);
    const adapter = new HermesAgentAdapter({ agentId: 'agent-1', logger, binaryPath: 'hermes-test', model: 'anthropic/claude-opus-4.5', chatTransport: 'acp' });

    child.on('__prompt', () => child.finishPrompt('end_turn'));
    for await (const _ of adapter.chat([{ role: 'user', content: 'hi' }], [], { preferredModel: 'zai-org/glm-4.7' })) { /* drain */ }

    expect(child.setModelParams).toEqual({ sessionId: 'sess-1', modelId: 'nous:zai-org/glm-4.7' });
  });

  it('maps a token-exhausted stop to a guardrail pause (max_turns), not an error', async () => {
    const child = fakeAcpChild();
    spawnMock.mockReturnValue(child);
    const adapter = new HermesAgentAdapter({ agentId: 'agent-1', logger, binaryPath: 'hermes-test', chatTransport: 'acp' });
    const deltas: ChatDelta[] = [];

    child.on('__prompt', () => {
      child.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'partial' } });
      child.finishPrompt('max_tokens');
    });
    for await (const delta of adapter.chat([{ role: 'user', content: 'hi' }], [])) deltas.push(delta);

    expect(deltas.some((d) => d.type === 'tool_result' && d.error)).toBe(false);
    expect(deltas.at(-1)).toEqual({ type: 'done', finishReason: 'max_turns' });
  });

  it('keeps one warm ACP process and isolates native sessions by conversation', async () => {
    const child = fakeAcpChild();
    spawnMock.mockReturnValue(child);
    const adapter = new HermesAgentAdapter({ agentId: 'agent-1', logger, binaryPath: 'hermes-test', chatTransport: 'acp' });
    child.on('__prompt', () => child.finishPrompt('end_turn'));

    for await (const _ of adapter.chat(
      [{ role: 'user', content: 'first' }],
      [],
      { sessionKey: 'conversation-a' },
    )) { /* drain */ }
    for await (const _ of adapter.chat(
      [{ role: 'user', content: 'second' }],
      [],
      { sessionKey: 'conversation-a' },
    )) { /* drain */ }
    for await (const _ of adapter.chat(
      [{ role: 'user', content: 'other conversation' }],
      [],
      { sessionKey: 'conversation-b' },
    )) { /* drain */ }

    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(child.sessionNewCalls).toBe(2);
    expect(child.promptSessionIds).toEqual(['sess-1', 'sess-1', 'sess-2']);
  });

  it('allows long provider silence after an ACP lifecycle event without reporting a stream stall', async () => {
    vi.useFakeTimers();
    const child = fakeAcpChild();
    spawnMock.mockReturnValue(child);
    const adapter = new HermesAgentAdapter({ agentId: 'agent-1', logger, binaryPath: 'hermes-test', chatTransport: 'acp' });
    let prompted = false;
    child.on('__prompt', () => {
      prompted = true;
    });

    const run = collectDeltas(adapter.chat(
      [{ role: 'user', content: 'take the time you need' }],
      [],
      { sessionKey: 'slow-conversation', timeoutMs: 90_000 },
    ));
    await vi.advanceTimersByTimeAsync(0);
    expect(prompted).toBe(true);

    child.update({ sessionUpdate: 'available_commands_update', availableCommands: [] });
    await vi.advanceTimersByTimeAsync(300_000);
    child.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Still here.' } });
    child.finishPrompt('end_turn');
    await vi.advanceTimersByTimeAsync(0);

    const deltas = await run;
    expect(deltas).toContainEqual({ type: 'text', delta: 'Still here.' });
    expect(deltas.some((delta) => delta.type === 'tool_result' && Boolean(delta.error))).toBe(false);
    expect(deltas.at(-1)).toEqual({ type: 'done', finishReason: 'stop' });
  });

  it('does not yield chat spawn failures as assistant text', async () => {
    spawnMock.mockImplementation(() => {
      throw new Error('missing binary');
    });
    const adapter = new HermesAgentAdapter({ agentId: 'agent-1', logger });
    const deltas: ChatDelta[] = [];
    for await (const delta of adapter.chat([{ role: 'user', content: 'hi' }], [])) deltas.push(delta);

    expect(deltas).toContainEqual(expect.objectContaining({
      type: 'tool_result',
      error: expect.stringContaining('missing binary'),
    }));
    expect(deltas.at(-1)).toEqual({ type: 'done', finishReason: 'error' });
    expect(deltas.some((d) => d.type === 'text')).toBe(false);
  });

  it('answers chat through the documented Hermes CLI contract by default', async () => {
    const child = fakeChildProcess();
    spawnMock.mockImplementation(() => {
      queueMicrotask(() => {
        child.stdout.write('CLI_OK\n');
        child.emit('exit', 0);
      });
      return child;
    });
    const adapter = new HermesAgentAdapter({ agentId: 'agent-1', logger, binaryPath: 'hermes-test' });

    const deltas = await collectDeltas(adapter.chat(
      [{ role: 'user', content: 'Reply with exactly CLI_OK' }],
      [],
      { preferredModel: 'hermes-auto' },
    ));

    const args = spawnMock.mock.calls[0]![1] as string[];
    expect(args[0]).toBe('chat');
    expect(args).toContain('-Q');
    expect(args).not.toContain('-m');
    expect(deltas).toContainEqual({ type: 'text', delta: 'CLI_OK' });
    expect(deltas.at(-1)).toEqual({ type: 'done', finishReason: 'stop' });
  });

  it('dispatches workflow tasks through the real `hermes chat -q "@file:…" -Q` contract', async () => {
    const child = fakeChildProcess();
    spawnMock.mockReturnValue(child);
    const adapter = new HermesAgentAdapter({ agentId: 'agent-1', logger, binaryPath: 'hermes-test', model: 'hermes-pro' });
    const events: NormalizedAgentEvent[] = [];
    adapter.onEvent((event) => events.push(event));

    await adapter.dispatchTask(task);
    child.stdout.write('Summary: all good.\n');
    child.emit('exit', 0);
    await new Promise((r) => setTimeout(r, 0));

    const args = spawnMock.mock.calls[0]![1] as string[];
    expect(args[0]).toBe('chat');
    const qIndex = args.indexOf('-q');
    expect(args[qIndex + 1]).toMatch(/^@file:.+/);
    expect(args).toContain('-Q');
    expect(args.some((a) => a.startsWith('--max-turns='))).toBe(false);
    expect(events).toContainEqual(expect.objectContaining({ eventType: 'task.completed', output: { text: 'Summary: all good.' } }));
  });
});

/** A fake `hermes acp` child: auto-answers the ACP handshake over JSON-RPC. */
function fakeAcpChild(opts?: { models?: unknown }) {
  const child = new EventEmitter() as EventEmitter & {
    stdout: PassThrough;
    stderr: PassThrough;
    stdin: Writable;
    update: (u: Record<string, unknown>) => void;
    finishPrompt: (stopReason?: string) => void;
    sessionNewParams?: unknown;
    sessionNewCalls: number;
    promptSessionIds: string[];
    setModelParams?: unknown;
  };
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.sessionNewCalls = 0;
  child.promptSessionIds = [];
  let promptId: number | undefined;
  const write = (obj: unknown) => child.stdout.write(JSON.stringify(obj) + '\n');
  const reply = (id: number, result: unknown) => write({ jsonrpc: '2.0', id, result });

  child.stdin = new Writable({
    write(chunk, _enc, cb) {
      for (const line of String(chunk).split('\n')) {
        if (!line.trim()) continue;
        const msg = JSON.parse(line);
        if (msg.method === 'initialize') reply(msg.id, { protocolVersion: 1, agentCapabilities: {} });
        else if (msg.method === 'session/new') {
          child.sessionNewCalls += 1;
          child.sessionNewParams = msg.params;
          reply(msg.id, {
            sessionId: `sess-${child.sessionNewCalls}`,
            ...(opts?.models ? { models: opts.models } : {}),
          });
        } else if (msg.method === 'session/set_model') {
          child.setModelParams = msg.params;
          reply(msg.id, {});
        } else if (msg.method === 'session/prompt') {
          promptId = msg.id;
          child.promptSessionIds.push(msg.params.sessionId);
          queueMicrotask(() => child.emit('__prompt', msg.params));
        }
      }
      cb();
    },
  });

  child.update = (update) => write({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'sess-1', update } });
  child.finishPrompt = (stopReason = 'end_turn') => {
    if (promptId !== undefined) reply(promptId, { stopReason });
  };
  return child;
}

async function collectDeltas(iterable: AsyncIterable<ChatDelta>): Promise<ChatDelta[]> {
  const deltas: ChatDelta[] = [];
  for await (const delta of iterable) deltas.push(delta);
  return deltas;
}

function fakeChildProcess() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: PassThrough;
    stderr: PassThrough;
    stdin: Writable;
  };
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
  return child;
}
