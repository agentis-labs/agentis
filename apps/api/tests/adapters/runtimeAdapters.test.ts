import { describe, expect, it } from 'vitest';
import { interpretClaudeChatEvent } from '../../src/adapters/ClaudeCodeAdapter.js';
import { cursorJsonEventToChatPart } from '../../src/adapters/CursorAdapter.js';
import { normalizeHttpChatJson } from '../../src/adapters/HttpAdapter.js';

describe('runtime adapter protocol parsing', () => {
  it('surfaces Claude Code structured stdout errors when stderr is empty', () => {
    const parts = interpretClaudeChatEvent({
      type: 'result',
      subtype: 'success',
      is_error: true,
      api_error_status: 401,
      result: 'Failed to authenticate. API Error: 401 Invalid authentication credentials',
    });

    expect(parts).toEqual([
      {
        kind: 'error',
        message: expect.stringContaining('API 401'),
      },
    ]);
    const [part] = parts;
    if (part?.kind !== 'error') throw new Error('expected error part');
    expect(part.message).toContain('Failed to authenticate');
  });

  it('treats Cursor CLI tool_call events as activity, not Agentis executable tool calls', () => {
    const part = cursorJsonEventToChatPart({
      type: 'tool_call',
      subtype: 'started',
      call_id: 'call-1',
      tool_call: {
        readToolCall: {
          args: { path: 'README.md' },
        },
      },
    });

    expect(part.kind).toBe('activity');
    if (part.kind !== 'activity') throw new Error('expected activity');
    expect(part.delta.id).toBe('cursor-call-1');
    expect(part.delta.label).toBe('Using read');
  });

  it('normalizes OpenAI-compatible HTTP chat deltas', () => {
    const deltas = Array.from(normalizeHttpChatJson({
      choices: [{
        delta: { content: 'hello' },
        finish_reason: null,
      }],
    }));

    expect(deltas).toEqual([
      { type: 'text', delta: 'hello' },
      { type: 'done', finishReason: 'stop' },
    ]);
  });

  it('turns HTTP structured errors into terminal error deltas', () => {
    const deltas = Array.from(normalizeHttpChatJson({
      error: { message: 'invalid model' },
    }));

    expect(deltas).toEqual([
      {
        type: 'tool_result',
        id: 'adapter',
        name: 'adapter.chat',
        result: null,
        error: 'invalid model',
      },
      { type: 'done', finishReason: 'error' },
    ]);
  });
});
