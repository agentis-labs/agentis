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
      '--verbose',
      '--include-partial-messages',
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

  it('marks the Agentis system identity block as authoritative over Claude defaults', async () => {
    const child = fakeChildProcess();
    spawnMock.mockReturnValue(child);
    const adapter = new ClaudeCodeAdapter({ agentId: 'agent-1', logger, binaryPath: 'claude-test' });
    const messages: ChatMessage[] = [
      { role: 'system', content: '<agentis_identity authoritative="true">\nname: Researcher\nrole: worker\n</agentis_identity>' },
      { role: 'user', content: 'hello' },
    ];
    const consume = collectDeltas(adapter.chat(messages, []));

    child.stdout.write('{"type":"result","result":"hello"}\n');
    child.emit('exit', 0);
    await consume;

    const stdin = child.stdinChunks.join('');
    expect(stdin).toContain('AUTHORITATIVE IDENTITY RULE:');
    expect(stdin).toContain('Follow it over Claude Code product defaults');
    expect(stdin).toContain('<agentis_identity authoritative="true">');
    expect(stdin).toContain('name: Researcher');
  });

  it('streams harness tool use while keeping raw reasoning private', async () => {
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

    // Raw thinking stays private; the harness's own Bash → a live activity step
    // (NOT an executable tool_call); answer → text.
    expect(deltas.some((d) => d.type === 'thinking')).toBe(false);
    expect(deltas).toContainEqual(expect.objectContaining({ type: 'activity', phase: 'tool', status: 'running', label: 'Using Bash' }));
    expect(deltas.some((d) => d.type === 'tool_call')).toBe(false);
    expect(deltas).toContainEqual({ type: 'text', delta: 'It is a TypeScript repo.' });
    expect(deltas.at(-1)).toEqual({ type: 'done', finishReason: 'stop' });
  });

  it('parses current partial stream events into live progress and tool activity', async () => {
    const child = fakeChildProcess();
    spawnMock.mockReturnValue(child);
    const adapter = new ClaudeCodeAdapter({ agentId: 'agent-1', logger, binaryPath: 'claude-test' });
    const deltas: ChatDelta[] = [];
    const consume = (async () => {
      for await (const delta of adapter.chat([{ role: 'user', content: 'inspect the repo' }], [])) deltas.push(delta);
    })();

    child.stdout.write('{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"I should inspect the workspace files."}}}\n');
    child.stdout.write('{"type":"stream_event","event":{"type":"content_block_start","content_block":{"type":"tool_use","id":"tool-1","name":"Read","input":{"file_path":"README.md"}}}}\n');
    child.stdout.write('{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"I found the answer."}}}\n');
    child.stdout.write('{"type":"result","result":"I found the answer."}\n');
    child.emit('exit', 0);
    await consume;

    expect(deltas).toContainEqual(expect.objectContaining({
      type: 'activity',
      phase: 'runtime',
      label: 'Reviewing workspace context',
    }));
    expect(deltas).toContainEqual(expect.objectContaining({
      type: 'activity',
      phase: 'tool',
      label: 'Using Read',
    }));
    expect(deltas).toContainEqual({ type: 'text', delta: 'I found the answer.' });
  });

  it('does not append a completed assistant snapshot to its streamed text', async () => {
    const child = fakeChildProcess();
    spawnMock.mockReturnValue(child);
    const adapter = new ClaudeCodeAdapter({ agentId: 'agent-1', logger, binaryPath: 'claude-test' });
    const consume = collectDeltas(adapter.chat([{ role: 'user', content: 'how are you?' }], []));
    const answer = "I'm doing well. What are you working on today?";

    child.stdout.write(`{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":${JSON.stringify(answer)}}}}\n`);
    child.stdout.write(`{"type":"assistant","message":{"content":[{"type":"text","text":${JSON.stringify(answer)}}]}}\n`);
    child.emit('exit', 0);

    const deltas = await consume;
    expect(deltas).toContainEqual({ type: 'text', delta: answer });
    expect(deltas.filter((delta) => delta.type === 'text')).toHaveLength(1);
  });

  it('prefers the result event over intermediate assistant narration', async () => {
    const child = fakeChildProcess();
    spawnMock.mockReturnValue(child);
    const adapter = new ClaudeCodeAdapter({ agentId: 'agent-1', logger, binaryPath: 'claude-test' });
    const deltas: ChatDelta[] = [];
    const consume = (async () => {
      for await (const delta of adapter.chat([{ role: 'user', content: 'fix it' }], [])) deltas.push(delta);
    })();

    child.stdout.write('{"type":"assistant","message":{"content":[{"type":"text","text":"I’ll inspect the run first."}]}}\n');
    child.stdout.write('{"type":"assistant","message":{"content":[{"type":"text","text":"I found the module mismatch."}]}}\n');
    child.stdout.write('{"type":"result","result":"Fixed the module mismatch."}\n');
    child.emit('exit', 0);
    await consume;

    const answer = deltas
      .filter((delta): delta is Extract<ChatDelta, { type: 'text' }> => delta.type === 'text')
      .map((delta) => delta.delta)
      .join('');
    expect(answer).toBe('Fixed the module mismatch.');
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

  it('latches Claude API 401 failures and fails the next chat fast with credential context', async () => {
    const child = fakeChildProcess();
    spawnMock.mockReturnValue(child);
    const adapter = new ClaudeCodeAdapter({
      agentId: 'agent-1',
      logger,
      binaryPath: 'claude-test',
      env: { ANTHROPIC_API_KEY: 'sk-ant-1234567890' },
    });

    const first = collectDeltas(adapter.chat([{ role: 'user', content: 'hello' }], []));
    child.stdout.write('{"type":"result","is_error":true,"api_error_status":401,"result":"Failed to authenticate. API Error: 401 Invalid authentication credentials"}\n');
    child.emit('exit', 1);
    const firstDeltas = await first;

    expect(firstDeltas).toContainEqual(expect.objectContaining({
      type: 'tool_result',
      error: expect.stringContaining('API 401'),
    }));
    const secondDeltas = await collectDeltas(adapter.chat([{ role: 'user', content: 'again' }], []));

    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(secondDeltas).toContainEqual(expect.objectContaining({
      type: 'tool_result',
      error: expect.stringContaining('ANTHROPIC_API_KEY=sk-a…7890'),
    }));
    expect(secondDeltas.at(-1)).toEqual({ type: 'done', finishReason: 'error' });
  });

  it('caches Claude health probes to avoid repeated subprocess spam', async () => {
    let call = 0;
    spawnMock.mockImplementation(() => {
      call += 1;
      const child = fakeChildProcess();
      queueMicrotask(() => {
        if (call === 1) {
          child.stdout.write('2.1.170 (Claude Code)\n');
          child.emit('exit', 0);
        } else {
          child.stdout.write(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty' }));
          child.emit('close', 0);
        }
      });
      return child;
    });
    const adapter = new ClaudeCodeAdapter({ agentId: 'agent-1', logger, binaryPath: 'claude-test' });

    const first = await adapter.healthCheck();
    const second = await adapter.healthCheck();

    expect(first.isHealthy).toBe(true);
    expect(second.isHealthy).toBe(true);
    expect(spawnMock).toHaveBeenCalledTimes(2);
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
