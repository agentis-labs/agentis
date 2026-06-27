import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ChatDelta, ChatMessage, NormalizedAgentEvent, NormalizedTask } from '@agentis/core';
import { AntigravityAdapter, antigravityJsonEventToChatPart } from '../../src/adapters/AntigravityAdapter.js';
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

describe('AntigravityAdapter', () => {
  beforeEach(() => {
    spawnMock.mockReset();
  });

  it('spawns the agy CLI and normalizes stream-json message, tool_use and result events', async () => {
    const child = fakeChildProcess();
    spawnMock.mockReturnValue(child);
    const adapter = new AntigravityAdapter({ agentId: 'agent-1', logger, binaryPath: 'agy-test', cwd: 'C:/repo', model: 'Gemini 3.5 Flash (High)' });
    const events: NormalizedAgentEvent[] = [];
    adapter.onEvent((event) => events.push(event));

    await adapter.dispatchTask(task);
    child.stdout.write('{"type":"init","session_id":"s1","model":"Gemini 3.5 Flash (High)"}\n');
    child.stdout.write('{"type":"message","role":"assistant","content":"Working"}\n');
    child.stdout.write('{"type":"tool_use","tool_name":"shell","tool_id":"t1","parameters":{"cmd":"pnpm test"}}\n');
    child.stdout.write('{"type":"result","status":"success"}\n');
    child.emit('exit', 0);

    const args = spawnMock.mock.calls[0]![1] as string[];
    expect(spawnMock.mock.calls[0]![0]).toBe('agy-test');
    expect(args.slice(0, 5)).toEqual(['-p', '', '--output-format', 'stream-json', '--yolo']);
    expect(args).toContain('-m');
    expect(args).toContain('Gemini 3.5 Flash (High)');
    expect(args).toContain('--session-id');
    expect(events.map((event) => event.eventType)).toEqual(['task.started', 'task.progress', 'agent.tool_call', 'task.completed']);
    expect(events).toContainEqual(expect.objectContaining({ eventType: 'task.completed', output: { text: 'Working' } }));
  });

  it('tolerates plain-text agy output (no JSON) by surfacing it as progress and the answer', async () => {
    const child = fakeChildProcess();
    spawnMock.mockReturnValue(child);
    const adapter = new AntigravityAdapter({ agentId: 'agent-1', logger, binaryPath: 'agy-test' });
    const events: NormalizedAgentEvent[] = [];
    adapter.onEvent((event) => events.push(event));

    await adapter.dispatchTask(task);
    child.stdout.write('Here is the plain text answer from agy.\n');
    child.emit('exit', 0);

    expect(events).toContainEqual(expect.objectContaining({ eventType: 'task.progress', message: 'Here is the plain text answer from agy.' }));
    expect(events).toContainEqual(expect.objectContaining({ eventType: 'task.completed', output: { text: 'Here is the plain text answer from agy.' } }));
  });

  it('streams the assistant answer for interactive chat and ends with a stop delta', async () => {
    const child = fakeChildProcess();
    spawnMock.mockReturnValue(child);
    const adapter = new AntigravityAdapter({ agentId: 'agent-1', logger, binaryPath: 'agy-test' });
    const deltas: ChatDelta[] = [];
    const consume = (async () => {
      for await (const delta of adapter.chat([{ role: 'user', content: 'hi' }], [], { latencyClass: 'interactive' })) deltas.push(delta);
    })();

    child.stdout.write('{"type":"init","session_id":"sess-9"}\n');
    child.stdout.write('{"type":"message","role":"assistant","content":"pong"}\n');
    child.stdout.write('{"type":"result","status":"success"}\n');
    child.emit('exit', 0);
    await consume;

    expect(deltas).toContainEqual({ type: 'text', delta: 'pong' });
    expect(deltas.at(-1)).toEqual({ type: 'done', finishReason: 'stop' });
  });

  it('decodes a not-signed-in exit into an actionable `agy` sign-in hint', async () => {
    const child = fakeChildProcess();
    spawnMock.mockReturnValue(child);
    const adapter = new AntigravityAdapter({ agentId: 'agent-1', logger, binaryPath: 'agy-test' });
    const deltas: ChatDelta[] = [];
    const consume = (async () => {
      for await (const delta of adapter.chat([{ role: 'user', content: 'hi' }], [])) deltas.push(delta);
    })();

    child.stderr.write('Error: not signed in. Please authenticate.\n');
    child.emit('exit', 1);
    await consume;

    expect(deltas).toContainEqual(expect.objectContaining({
      type: 'tool_result',
      name: 'adapter.chat',
      error: expect.stringContaining('agy'),
    }));
    expect(deltas.at(-1)).toEqual({ type: 'done', finishReason: 'error' });
  });

  it('turns AGENTIS_TOOL_CALL markers in the answer into chat tool calls', async () => {
    const child = fakeChildProcess();
    spawnMock.mockReturnValue(child);
    const adapter = new AntigravityAdapter({ agentId: 'agent-1', logger, binaryPath: 'agy-test' });
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
    const adapter = new AntigravityAdapter({ agentId: 'agent-1', logger });
    const events: NormalizedAgentEvent[] = [];
    adapter.onEvent((event) => events.push(event));

    await adapter.dispatchTask(task);

    expect(events).toContainEqual(expect.objectContaining({ eventType: 'task.failed', error: 'antigravity_spawn_failed: missing binary' }));
  });
});

describe('antigravityJsonEventToChatPart', () => {
  it('maps assistant message content to text and ignores the user echo', () => {
    expect(antigravityJsonEventToChatPart({ type: 'message', role: 'assistant', content: 'hi' })).toEqual({ kind: 'text', text: 'hi' });
    expect(antigravityJsonEventToChatPart({ type: 'message', role: 'user', content: 'hi' })).toEqual({ kind: 'ignore' });
  });

  it('maps tool_use and tool_result to live activity deltas', () => {
    const use = antigravityJsonEventToChatPart({ type: 'tool_use', tool_name: 'shell', tool_id: 'x', parameters: {} });
    expect(use).toMatchObject({ kind: 'activity', delta: { type: 'activity', status: 'running', label: 'Using shell' } });
    const ok = antigravityJsonEventToChatPart({ type: 'tool_result', tool_id: 'x', status: 'success', output: 'done' });
    expect(ok).toMatchObject({ kind: 'activity', delta: { type: 'activity', status: 'success' } });
  });

  it('treats an error-severity event as a hard error but ignores warnings and lifecycle', () => {
    expect(antigravityJsonEventToChatPart({ type: 'error', severity: 'error', message: 'boom' })).toEqual({ kind: 'error', message: 'boom' });
    expect(antigravityJsonEventToChatPart({ type: 'error', severity: 'warning', message: 'heads up' })).toEqual({ kind: 'ignore' });
    expect(antigravityJsonEventToChatPart({ type: 'init', session_id: 's' })).toEqual({ kind: 'ignore' });
    expect(antigravityJsonEventToChatPart({ type: 'result', status: 'success' })).toEqual({ kind: 'ignore' });
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
