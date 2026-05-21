import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ChatDelta, ChatMessage, NormalizedAgentEvent, NormalizedTask } from '@agentis/core';
import { CodexAdapter } from '../../src/adapters/CodexAdapter.js';
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

describe('CodexAdapter', () => {
  beforeEach(() => {
    spawnMock.mockReset();
  });

  it('spawns the Codex CLI and normalizes JSONL progress, tool, and completion events', async () => {
    const child = fakeChildProcess();
    spawnMock.mockReturnValue(child);
    const adapter = new CodexAdapter({ agentId: 'agent-1', logger, binaryPath: 'codex-test', cwd: 'C:/repo', model: 'codex', maxTurns: 3 });
    const events: NormalizedAgentEvent[] = [];
    adapter.onEvent((event) => events.push(event));

    await adapter.dispatchTask(task);
    child.stdout.write('{"type":"assistant","text":"Working"}\n');
    child.stdout.write('{"type":"tool_call","name":"shell","input":{"cmd":"pnpm test"}}\n');
    child.stdout.write('{"type":"result","result":{"text":"done"}}\n');
    child.emit('exit', 0);

    expect(spawnMock).toHaveBeenCalledWith('codex-test', ['exec', '--json', '--model=codex', '--dangerously-bypass-approvals-and-sandbox'], expect.objectContaining({ cwd: 'C:/repo' }));
    expect(events.map((event) => event.eventType)).toEqual(['task.started', 'task.progress', 'agent.tool_call', 'task.completed']);
    expect(events).toContainEqual(expect.objectContaining({ eventType: 'task.progress', message: 'Working' }));
    expect(events).toContainEqual(expect.objectContaining({ eventType: 'agent.tool_call', tool: 'shell', input: { cmd: 'pnpm test' } }));
    expect(events).toContainEqual(expect.objectContaining({ eventType: 'task.completed', output: { text: 'done' } }));
  });

  it('emits task.failed when spawning fails', async () => {
    spawnMock.mockImplementation(() => {
      throw new Error('missing binary');
    });
    const adapter = new CodexAdapter({ agentId: 'agent-1', logger });
    const events: NormalizedAgentEvent[] = [];
    adapter.onEvent((event) => events.push(event));

    await adapter.dispatchTask(task);

    expect(events).toContainEqual(expect.objectContaining({ eventType: 'task.failed', error: 'codex_spawn_failed: missing binary' }));
  });

  it('does not yield chat spawn failures as assistant text', async () => {
    spawnMock.mockImplementation(() => {
      throw new Error('missing binary');
    });
    const adapter = new CodexAdapter({ agentId: 'agent-1', logger });
    const deltas: ChatDelta[] = [];
    const messages: ChatMessage[] = [{ role: 'user', content: 'hello' }];

    for await (const delta of adapter.chat(messages, [])) {
      deltas.push(delta);
    }

    expect(deltas.some((delta) => delta.type === 'text')).toBe(false);
    expect(deltas).toContainEqual(expect.objectContaining({
      type: 'tool_result',
      name: 'adapter.chat',
      error: expect.stringContaining('missing binary'),
    }));
    expect(deltas.at(-1)).toEqual({ type: 'done', finishReason: 'error' });
  });

  it('uses the Codex exec JSONL contract for chat without legacy CLI flags', async () => {
    const child = fakeChildProcess();
    spawnMock.mockReturnValue(child);
    const adapter = new CodexAdapter({
      agentId: 'agent-1',
      logger,
      binaryPath: 'codex-test',
      model: 'gpt-5.3-codex',
      maxTurns: 12,
      fastMode: true,
    });
    const messages: ChatMessage[] = [{ role: 'user', content: 'hello' }];
    const deltas: ChatDelta[] = [];
    const consume = (async () => {
      for await (const delta of adapter.chat(messages, [])) {
        deltas.push(delta);
      }
    })();

    child.stdout.write('{"type":"assistant","text":"Hi"}\n');
    child.emit('exit', 0);
    await consume;

    expect(spawnMock).toHaveBeenCalledWith('codex-test', [
      'exec',
      '--json',
      '--model=gpt-5.3-codex',
      '-c',
      'model_reasoning_effort="minimal"',
      '--dangerously-bypass-approvals-and-sandbox',
    ], expect.any(Object));
    const args = spawnMock.mock.calls[0]![1] as string[];
    expect(args[0]).toBe('exec');
    expect(args[1]).toBe('--json');
    expect(args.some((arg) => arg.startsWith('--max-turns'))).toBe(false);
    expect(args).not.toContain('--fast');
    expect(deltas).toContainEqual({ type: 'text', delta: 'Hi' });
    expect(deltas.at(-1)).toEqual({ type: 'done', finishReason: 'stop' });
  });
});

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
