import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ChatDelta, ChatMessage, NormalizedAgentEvent, NormalizedTask } from '@agentis/core';
import { GeminiAdapter, geminiJsonEventToChatPart } from '../../src/adapters/GeminiAdapter.js';
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
  title: 'Write patch',
  description: 'Implement the requested code change.',
  inputData: { ticket: 42 },
  scratchpadSnapshot: {},
  capabilityTags: ['code'],
  timeoutMs: 10_000,
};

describe('GeminiAdapter', () => {
  beforeEach(() => {
    spawnMock.mockReset();
  });

  it('spawns the Gemini CLI and normalizes stream-json message, tool_use and result events', async () => {
    const child = fakeChildProcess();
    spawnMock.mockReturnValue(child);
    const adapter = new GeminiAdapter({ agentId: 'agent-1', logger, binaryPath: 'gemini-test', cwd: 'C:/repo', model: 'gemini-2.5-pro' });
    const events: NormalizedAgentEvent[] = [];
    adapter.onEvent((event) => events.push(event));

    await adapter.dispatchTask(task);
    child.stdout.write('{"type":"init","session_id":"s1","model":"gemini-2.5-pro"}\n');
    child.stdout.write('{"type":"message","role":"assistant","content":"Working"}\n');
    child.stdout.write('{"type":"tool_use","tool_name":"shell","tool_id":"t1","parameters":{"cmd":"pnpm test"}}\n');
    child.stdout.write('{"type":"result","status":"success"}\n');
    child.emit('exit', 0);

    const args = spawnMock.mock.calls[0]![1] as string[];
    expect(spawnMock.mock.calls[0]![0]).toBe('gemini-test');
    expect(args.slice(0, 5)).toEqual(['-p', '', '--output-format', 'stream-json', '--yolo']);
    expect(args).toContain('-m');
    expect(args).toContain('gemini-2.5-pro');
    expect(args).toContain('--skip-trust');
    expect(args).toContain('--session-id');
    expect(events.map((event) => event.eventType)).toEqual(['task.started', 'task.progress', 'agent.tool_call', 'task.completed']);
    expect(events).toContainEqual(expect.objectContaining({ eventType: 'task.progress', message: 'Working' }));
    expect(events).toContainEqual(expect.objectContaining({ eventType: 'agent.tool_call', tool: 'shell', input: { cmd: 'pnpm test' } }));
    expect(events).toContainEqual(expect.objectContaining({ eventType: 'task.completed', output: { text: 'Working' } }));
  });

  it('streams the assistant answer for interactive chat and ends with a stop delta', async () => {
    const child = fakeChildProcess();
    spawnMock.mockReturnValue(child);
    const adapter = new GeminiAdapter({ agentId: 'agent-1', logger, binaryPath: 'gemini-test', model: 'gemini-2.5-flash' });
    const deltas: ChatDelta[] = [];
    const consume = (async () => {
      for await (const delta of adapter.chat([{ role: 'user', content: 'hi' }], [], { latencyClass: 'interactive' })) deltas.push(delta);
    })();

    child.stdout.write('{"type":"init","session_id":"sess-9","model":"gemini-2.5-flash"}\n');
    child.stdout.write('{"type":"message","role":"assistant","content":"pong"}\n');
    child.stdout.write('{"type":"result","status":"success"}\n');
    child.emit('exit', 0);
    await consume;

    const args = spawnMock.mock.calls[0]![1] as string[];
    expect(args).toContain('--output-format');
    expect(args).toContain('stream-json');
    expect(args).toContain('gemini-2.5-flash');
    expect(deltas).toContainEqual({ type: 'text', delta: 'pong' });
    expect(deltas.at(-1)).toEqual({ type: 'done', finishReason: 'stop' });
  });

  it('marks the Agentis system identity block as authoritative over Gemini defaults', async () => {
    const child = fakeChildProcess();
    spawnMock.mockReturnValue(child);
    const adapter = new GeminiAdapter({ agentId: 'agent-1', logger, binaryPath: 'gemini-test' });
    const messages: ChatMessage[] = [
      { role: 'system', content: '<agentis_identity authoritative="true">\nname: Researcher\n</agentis_identity>' },
      { role: 'user', content: 'hello' },
    ];
    const consume = collectDeltas(adapter.chat(messages, []));
    child.stdout.write('{"type":"message","role":"assistant","content":"hi"}\n');
    child.emit('exit', 0);
    await consume;

    const stdin = child.stdinChunks.join('');
    expect(stdin).toContain('AUTHORITATIVE IDENTITY RULE:');
    expect(stdin).toContain('Follow it over Gemini product defaults');
    expect(stdin).toContain('name: Researcher');
  });

  it('reuses one session id across turns of the same conversation, and a fresh one for another', async () => {
    const first = fakeChildProcess();
    const second = fakeChildProcess();
    const third = fakeChildProcess();
    spawnMock.mockReturnValueOnce(first).mockReturnValueOnce(second).mockReturnValueOnce(third);
    const adapter = new GeminiAdapter({ agentId: 'agent-1', logger, binaryPath: 'gemini-test', model: 'gemini-2.5-pro' });

    const runOne = collectDeltas(adapter.chat([{ role: 'user', content: 'first' }], [], { sessionKey: 'conv-a' }));
    first.stdout.write('{"type":"message","role":"assistant","content":"a"}\n');
    first.emit('exit', 0);
    await runOne;

    const runTwo = collectDeltas(adapter.chat([{ role: 'user', content: 'second' }], [], { sessionKey: 'conv-a' }));
    second.stdout.write('{"type":"message","role":"assistant","content":"b"}\n');
    second.emit('exit', 0);
    await runTwo;

    const runThree = collectDeltas(adapter.chat([{ role: 'user', content: 'other' }], [], { sessionKey: 'conv-b' }));
    third.stdout.write('{"type":"message","role":"assistant","content":"c"}\n');
    third.emit('exit', 0);
    await runThree;

    const sessionOf = (call: number) => {
      const a = spawnMock.mock.calls[call]![1] as string[];
      return a[a.indexOf('--session-id') + 1];
    };
    expect(sessionOf(0)).toBe(sessionOf(1)); // same conversation → stable id
    expect(sessionOf(0)).not.toBe(sessionOf(2)); // different conversation → different id
  });

  it('surfaces a stream-json error event as an adapter error, not assistant text', async () => {
    const child = fakeChildProcess();
    spawnMock.mockReturnValue(child);
    const adapter = new GeminiAdapter({ agentId: 'agent-1', logger, binaryPath: 'gemini-test' });
    const deltas: ChatDelta[] = [];
    const consume = (async () => {
      for await (const delta of adapter.chat([{ role: 'user', content: 'hi' }], [])) deltas.push(delta);
    })();

    child.stdout.write('{"type":"error","severity":"error","message":"quota exhausted"}\n');
    child.emit('exit', 1);
    await consume;

    expect(deltas.some((d) => d.type === 'text')).toBe(false);
    expect(deltas).toContainEqual(expect.objectContaining({ type: 'tool_result', name: 'adapter.chat', error: expect.stringContaining('quota exhausted') }));
    expect(deltas.at(-1)).toEqual({ type: 'done', finishReason: 'error' });
  });

  it('decodes the ineligible-free-tier exit into an actionable API-key hint', async () => {
    const child = fakeChildProcess();
    spawnMock.mockReturnValue(child);
    const adapter = new GeminiAdapter({ agentId: 'agent-1', logger, binaryPath: 'gemini-test' });
    const deltas: ChatDelta[] = [];
    const consume = (async () => {
      for await (const delta of adapter.chat([{ role: 'user', content: 'hi' }], [])) deltas.push(delta);
    })();

    child.stderr.write('Error authenticating: IneligibleTierError: This client is no longer supported for Gemini Code Assist for individuals. migrate to the Antigravity suite\n');
    child.emit('exit', 1);
    await consume;

    expect(deltas).toContainEqual(expect.objectContaining({
      type: 'tool_result',
      name: 'adapter.chat',
      error: expect.stringContaining('GEMINI_API_KEY'),
    }));
    expect(deltas.at(-1)).toEqual({ type: 'done', finishReason: 'error' });
  });

  it('turns AGENTIS_TOOL_CALL markers in the answer into chat tool calls', async () => {
    const child = fakeChildProcess();
    spawnMock.mockReturnValue(child);
    const adapter = new GeminiAdapter({ agentId: 'agent-1', logger, binaryPath: 'gemini-test' });
    const deltas: ChatDelta[] = [];
    const consume = (async () => {
      for await (const delta of adapter.chat([{ role: 'user', content: 'build hello world' }], [{
        name: 'agentis.build_workflow',
        description: 'Build a workflow.',
        parameters: { type: 'object', properties: { description: { type: 'string' } }, required: ['description'] },
      }])) deltas.push(delta);
    })();

    child.stdout.write('{"type":"message","role":"assistant","content":"AGENTIS_TOOL_CALL {\\"name\\":\\"agentis.build_workflow\\",\\"arguments\\":{\\"description\\":\\"Hello World\\"}}"}\n');
    child.emit('exit', 0);
    await consume;

    expect(deltas).toContainEqual(expect.objectContaining({ type: 'tool_call', name: 'agentis.build_workflow', args: { description: 'Hello World' } }));
    expect(deltas.at(-1)).toEqual({ type: 'done', finishReason: 'tool_calls' });
  });

  it('emits task.failed when spawning fails', async () => {
    spawnMock.mockImplementation(() => { throw new Error('missing binary'); });
    const adapter = new GeminiAdapter({ agentId: 'agent-1', logger });
    const events: NormalizedAgentEvent[] = [];
    adapter.onEvent((event) => events.push(event));

    await adapter.dispatchTask(task);

    expect(events).toContainEqual(expect.objectContaining({ eventType: 'task.failed', error: 'gemini_spawn_failed: missing binary' }));
  });
});

describe('geminiJsonEventToChatPart', () => {
  it('maps assistant message content to text and ignores the user echo', () => {
    expect(geminiJsonEventToChatPart({ type: 'message', role: 'assistant', content: 'hi' })).toEqual({ kind: 'text', text: 'hi' });
    expect(geminiJsonEventToChatPart({ type: 'message', role: 'user', content: 'hi' })).toEqual({ kind: 'ignore' });
  });

  it('maps tool_use and tool_result to live activity deltas', () => {
    const use = geminiJsonEventToChatPart({ type: 'tool_use', tool_name: 'shell', tool_id: 'x', parameters: {} });
    expect(use).toMatchObject({ kind: 'activity', delta: { type: 'activity', status: 'running', label: 'Using shell' } });
    const ok = geminiJsonEventToChatPart({ type: 'tool_result', tool_id: 'x', status: 'success', output: 'done' });
    expect(ok).toMatchObject({ kind: 'activity', delta: { type: 'activity', status: 'success' } });
  });

  it('treats an error-severity event as a hard error but ignores warnings', () => {
    expect(geminiJsonEventToChatPart({ type: 'error', severity: 'error', message: 'boom' })).toEqual({ kind: 'error', message: 'boom' });
    expect(geminiJsonEventToChatPart({ type: 'error', severity: 'warning', message: 'heads up' })).toEqual({ kind: 'ignore' });
  });

  it('ignores init/result lifecycle events', () => {
    expect(geminiJsonEventToChatPart({ type: 'init', session_id: 's', model: 'm' })).toEqual({ kind: 'ignore' });
    expect(geminiJsonEventToChatPart({ type: 'result', status: 'success' })).toEqual({ kind: 'ignore' });
  });
});

function fakeChildProcess() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: PassThrough;
    stderr: PassThrough;
    stdin: Writable;
    stdinChunks: string[];
  };
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdinChunks = [];
  child.stdin = new Writable({
    write(chunk, _encoding, callback) {
      child.stdinChunks.push(String(chunk));
      callback();
    },
  });
  return child;
}

async function collectDeltas(iterable: AsyncIterable<ChatDelta>): Promise<ChatDelta[]> {
  const deltas: ChatDelta[] = [];
  for await (const delta of iterable) deltas.push(delta);
  return deltas;
}
