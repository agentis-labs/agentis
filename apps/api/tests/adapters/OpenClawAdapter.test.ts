import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ChatDelta } from '@agentis/core';
import { OpenClawAdapter } from '../../src/adapters/OpenClawAdapter.js';
import type { Logger } from '../../src/logger.js';

// A controllable in-memory WebSocket so we can drive the gateway's async events.
class FakeWebSocket {
  static readonly OPEN = 1;
  readonly readyState = 1;
  sent: string[] = [];
  #handlers = new Map<string, (arg: unknown) => void>();
  constructor(public url: string) {
    FakeWebSocket.instance = this;
  }
  static instance: FakeWebSocket | undefined;
  send(data: string) { this.sent.push(data); }
  close() {}
  on(event: string, cb: (arg: unknown) => void) {
    this.#handlers.set(event, cb);
    if (event === 'open') cb(undefined);
  }
  /** Simulate the gateway pushing a frame to the adapter. */
  emitMessage(frame: Record<string, unknown>) {
    this.#handlers.get('message')?.(JSON.stringify(frame));
  }
}

vi.mock('ws', () => ({ WebSocket: FakeWebSocket }));

const logger: Logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: () => logger,
};

describe('OpenClawAdapter chat', () => {
  beforeEach(() => {
    FakeWebSocket.instance = undefined;
  });

  it('advertises interactive chat (not task-only)', () => {
    const adapter = new OpenClawAdapter({ agentId: 'agent-1', gatewayUrl: 'wss://gw.test', logger });
    expect(adapter.capabilities().interactiveChat).toBe(true);
  });

  it('relays the operator message and streams the gateway reply as the answer', async () => {
    const adapter = new OpenClawAdapter({ agentId: 'agent-1', gatewayUrl: 'wss://gw.test', logger, defaultSessionId: 'sess-1' });
    await adapter.connect();
    const ws = FakeWebSocket.instance!;

    const deltas: ChatDelta[] = [];
    const consume = (async () => {
      for await (const delta of adapter.chat([{ role: 'user', content: 'what time is it?' }], [])) deltas.push(delta);
    })();

    // The relay must have sent a session.send carrying the operator's message.
    await new Promise((r) => setTimeout(r, 0));
    const sent = ws.sent.map((s) => JSON.parse(s));
    expect(sent).toContainEqual(expect.objectContaining({ kind: 'session.send', sessionId: 'sess-1', body: 'what time is it?' }));

    // The gateway streams thinking, then the agent's reply resolves the turn.
    ws.emitMessage({ kind: 'agent.thinking', text: 'checking the clock' });
    ws.emitMessage({ kind: 'session.message', authorType: 'agent', body: 'It is noon.' });
    await consume;

    expect(deltas).toContainEqual({ type: 'thinking', delta: 'checking the clock' });
    expect(deltas).toContainEqual({ type: 'text', delta: 'It is noon.' });
    expect(deltas.at(-1)).toEqual({ type: 'done', finishReason: 'stop' });
  });

  it('ignores the echo of the operator message and waits for the agent reply', async () => {
    const adapter = new OpenClawAdapter({ agentId: 'agent-1', gatewayUrl: 'wss://gw.test', logger });
    await adapter.connect();
    const ws = FakeWebSocket.instance!;

    const deltas: ChatDelta[] = [];
    const consume = (async () => {
      for await (const delta of adapter.chat([{ role: 'user', content: 'hi' }], [])) deltas.push(delta);
    })();
    await new Promise((r) => setTimeout(r, 0));

    // The operator's own message mirrored back must NOT end the turn.
    ws.emitMessage({ kind: 'session.message', authorType: 'operator', body: 'hi' });
    ws.emitMessage({ kind: 'session.message', authorType: 'agent', body: 'hello!' });
    await consume;

    const text = deltas.filter((d): d is Extract<ChatDelta, { type: 'text' }> => d.type === 'text').map((d) => d.delta).join('');
    expect(text).toBe('hello!');
    expect(deltas.at(-1)).toEqual({ type: 'done', finishReason: 'stop' });
  });
});
