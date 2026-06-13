import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ChatDelta, ChatMessage } from '@agentis/core';
import { ClaudeCodeAdapter } from '../../src/adapters/ClaudeCodeAdapter.js';
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

describe('ClaudeCodeAdapter chat', () => {
  beforeEach(() => {
    spawnMock.mockReset();
  });

  it('reports marker-protocol tool capability', () => {
    const adapter = new ClaudeCodeAdapter({ agentId: 'agent-1', logger });

    expect(adapter.capabilities()).toEqual(expect.objectContaining({
      interactiveChat: true,
      toolCalling: true,
      toolForwarding: 'marker_protocol',
      affordances: expect.objectContaining({
        fileSystem: true,
        terminal: true,
        nativeMcp: true,
      }),
      memory: expect.objectContaining({
        ingestible: true,
        injectable: true,
      }),
    }));
  });

  it('turns AGENTIS_TOOL_CALL markers into chat tool calls', async () => {
    const child = fakeChildProcess();
    spawnMock.mockReturnValue(child);
    const adapter = new ClaudeCodeAdapter({ agentId: 'agent-1', logger, binaryPath: 'claude-test', maxTurns: 4 });
    const messages: ChatMessage[] = [{ role: 'user', content: 'build hello world' }];
    const deltas: ChatDelta[] = [];
    const consume = (async () => {
      for await (const delta of adapter.chat(messages, [{
        name: 'agentis.build_workflow',
        description: 'Build a workflow.',
        parameters: {
          type: 'object',
          properties: { description: { type: 'string' } },
          required: ['description'],
        },
      }])) {
        deltas.push(delta);
      }
    })();

    child.stdout.write('{"type":"assistant","message":{"content":[{"type":"text","text":"AGENTIS_TOOL_CALL {\\"name\\":\\"agentis.build_workflow\\",\\"arguments\\":{\\"description\\":\\"Hello World\\"}}"}]}}\n');
    child.emit('exit', 0);
    await consume;

    expect(spawnMock).toHaveBeenCalledWith('claude-test', [
      '--print',
      '--output-format=stream-json',
      '--max-turns=4',
      '--dangerously-skip-permissions',
    ], expect.any(Object));
    expect(deltas).toContainEqual(expect.objectContaining({
      type: 'tool_call',
      name: 'agentis.build_workflow',
      args: { description: 'Hello World' },
    }));
    expect(deltas.at(-1)).toEqual({ type: 'done', finishReason: 'tool_calls' });
  });

  it('streams thinking and the harness own tool use as live deltas, answer as text', async () => {
    const child = fakeChildProcess();
    spawnMock.mockReturnValue(child);
    const adapter = new ClaudeCodeAdapter({ agentId: 'agent-1', logger, binaryPath: 'claude-test' });
    const deltas: ChatDelta[] = [];
    const consume = (async () => {
      for await (const delta of adapter.chat([{ role: 'user', content: 'look around' }], [])) deltas.push(delta);
    })();

    // One assistant message carrying a thinking block, a native tool_use block,
    // and the answer text — the real stream-json content-block shape.
    child.stdout.write('{"type":"assistant","message":{"content":[{"type":"thinking","thinking":"Let me check the files."},{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"ls"}},{"type":"text","text":"It is a TypeScript repo."}]}}\n');
    child.emit('exit', 0);
    await consume;

    // Thinking → ThinkingBubble; the harness's own Bash → a live activity step
    // (NOT an executable tool_call); answer → text.
    expect(deltas).toContainEqual({ type: 'thinking', delta: 'Let me check the files.' });
    expect(deltas).toContainEqual(expect.objectContaining({ type: 'activity', phase: 'tool', status: 'running', label: 'Using Bash' }));
    expect(deltas.some((d) => d.type === 'tool_call')).toBe(false);
    expect(deltas).toContainEqual({ type: 'text', delta: 'It is a TypeScript repo.' });
    expect(deltas.at(-1)).toEqual({ type: 'done', finishReason: 'stop' });
  });

  it('does not yield chat spawn failures as assistant text', async () => {
    spawnMock.mockImplementation(() => {
      throw new Error('missing binary');
    });
    const adapter = new ClaudeCodeAdapter({ agentId: 'agent-1', logger });
    const deltas: ChatDelta[] = [];

    for await (const delta of adapter.chat([{ role: 'user', content: 'hello' }], [])) {
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
