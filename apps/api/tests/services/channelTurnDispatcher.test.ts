/**
 * ChannelTurnDispatcher — inbound channel message → real orchestrator turn →
 * reply delivered back to the channel (OMNICHANNEL-ORCHESTRATOR-10X §3.3).
 *
 * Also covers the end-to-end wiring: ChannelBridge.handleInbound fires the
 * dispatcher, and the orchestrator's reply reaches adapter.send.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { schema } from '@agentis/db/sqlite';
import type { AgentAdapter, ChatDelta, ChatMessage } from '@agentis/core';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';
import { ConversationStore } from '../../src/services/conversationStore.js';
import { ChannelBridge } from '../../src/services/channelBridge.js';
import { ChannelTurnDispatcher, interpretConfirmation } from '../../src/services/channelTurnDispatcher.js';
import { AdapterManager } from '../../src/adapters/AdapterManager.js';
import type { ChannelAdapter, ParsedInboundMessage } from '../../src/adapters/channels/types.js';

/** A chat-capable adapter stub — only `.chat`/`.capabilities` are exercised. */
function chatStub(reply: string): AgentAdapter {
  return {
    capabilities: () => ({ interactiveChat: true }),
    async *chat(): AsyncIterable<ChatDelta> {
      yield { type: 'text', delta: reply };
      yield { type: 'done', finishReason: 'stop' };
    },
  } as unknown as AgentAdapter;
}

function seedAgent(ctx: TestContext) {
  const id = randomUUID();
  ctx.db.insert(schema.agents).values({
    id,
    workspaceId: ctx.workspace.id,
    ambientId: ctx.ambient.id,
    userId: ctx.user.id,
    name: 'Orchestrator',
    adapterType: 'http',
  }).run();
  return id;
}

describe('ChannelTurnDispatcher', () => {
  let ctx: TestContext;
  beforeEach(async () => { ctx = await createTestContext(); });
  afterEach(() => ctx.close());

  it('runs a turn, persists the reply as an agent message, and delivers it', async () => {
    const conversations = new ConversationStore({ db: ctx.db, bus: ctx.bus });
    const agentId = seedAgent(ctx);
    const conv = conversations.getOrCreateByAgent({
      workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id, agentId,
    });

    const delivered: Array<{ connectionId: string; chatId: string; body: string }> = [];
    const dispatcher = new ChannelTurnDispatcher({
      db: ctx.db,
      adapters: new AdapterManager(ctx.logger),
      conversations,
      logger: ctx.logger,
      deliver: async (args) => { delivered.push(args); },
      fallbackAdapter: () => chatStub('Hello from the orchestrator.'),
    });

    const result = await dispatcher.dispatch({
      workspaceId: ctx.workspace.id,
      ambientId: ctx.ambient.id,
      userId: ctx.user.id,
      agentId,
      conversationId: conv.id,
      connectionId: 'conn-1',
      kind: 'telegram',
      chatId: '999',
      text: 'hi',
    });

    expect(result.replied).toBe(true);
    expect(delivered).toEqual([{ connectionId: 'conn-1', chatId: '999', body: 'Hello from the orchestrator.' }]);

    const messages = conversations.messages(conv.id, 50);
    const agentMsg = messages.find((m) => m.authorType === 'agent');
    expect(agentMsg?.body).toBe('Hello from the orchestrator.');
    expect((agentMsg?.metadata as { channelReply?: boolean })?.channelReply).toBe(true);
  });

  it('maps prior channel-inbound system messages to user role in history', async () => {
    const conversations = new ConversationStore({ db: ctx.db, bus: ctx.bus });
    const agentId = seedAgent(ctx);
    const conv = conversations.getOrCreateByAgent({
      workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id, agentId,
    });
    // Prior turn: a channel-inbound human message + an agent reply.
    conversations.appendMirrored({
      workspaceId: ctx.workspace.id, conversationId: conv.id, sessionMessageId: 'ext-1',
      authorType: 'system', body: 'earlier question', metadata: { channelInbound: true },
    });
    conversations.appendMirrored({
      workspaceId: ctx.workspace.id, conversationId: conv.id, sessionMessageId: 'reply-1',
      authorType: 'agent', body: 'earlier answer',
    });

    let captured: ChatMessage[] = [];
    const dispatcher = new ChannelTurnDispatcher({
      db: ctx.db,
      adapters: new AdapterManager(ctx.logger),
      conversations,
      logger: ctx.logger,
      deliver: async () => {},
      fallbackAdapter: () => chatStub('ok'),
      runTurn: async function* (_adapter, history) {
        captured = history;
        yield { type: 'text', delta: 'ok' };
        yield { type: 'done', finishReason: 'stop' };
      } as unknown as typeof import('../../src/services/chatSessionExecutor.js').ChatSessionExecutor.turn,
    });

    await dispatcher.dispatch({
      workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id,
      agentId, conversationId: conv.id, connectionId: 'c', kind: 'telegram', chatId: '1', text: 'follow up',
    });

    expect(captured).toEqual([
      { role: 'user', content: 'earlier question' },
      { role: 'assistant', content: 'earlier answer' },
    ]);
  });

  it('scopes turn history to the active thread (subject isolation)', async () => {
    const conversations = new ConversationStore({ db: ctx.db, bus: ctx.bus });
    const agentId = seedAgent(ctx);
    const conv = conversations.getOrCreateByAgent({
      workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id, agentId,
    });
    // Two prior human turns in two different threads of the same conversation.
    conversations.appendMirrored({
      workspaceId: ctx.workspace.id, conversationId: conv.id, sessionMessageId: 'tA-1',
      authorType: 'system', body: 'about the budget', metadata: { channelInbound: true, threadId: 'chan:A' },
    });
    conversations.appendMirrored({
      workspaceId: ctx.workspace.id, conversationId: conv.id, sessionMessageId: 'tB-1',
      authorType: 'system', body: 'about the deploy', metadata: { channelInbound: true, threadId: 'chan:B' },
    });

    let captured: ChatMessage[] = [];
    const dispatcher = new ChannelTurnDispatcher({
      db: ctx.db, adapters: new AdapterManager(ctx.logger), conversations, logger: ctx.logger,
      deliver: async () => {}, fallbackAdapter: () => chatStub('ok'),
      runTurn: async function* (_a, history) {
        captured = history;
        yield { type: 'text', delta: 'ok' } as ChatDelta;
        yield { type: 'done', finishReason: 'stop' } as ChatDelta;
      } as unknown as typeof import('../../src/services/chatSessionExecutor.js').ChatSessionExecutor.turn,
    });

    await dispatcher.dispatch({
      workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id,
      agentId, conversationId: conv.id, connectionId: 'c', kind: 'slack', chatId: 'chan:thread:A',
      threadId: 'chan:A', text: 'follow up on budget',
    });

    // Only the thread-A message survives; thread-B is excluded.
    expect(captured).toEqual([{ role: 'user', content: 'about the budget' }]);
  });

  it('delivers a not-connected notice when no chat adapter is available', async () => {
    const conversations = new ConversationStore({ db: ctx.db, bus: ctx.bus });
    const agentId = seedAgent(ctx);
    const conv = conversations.getOrCreateByAgent({
      workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id, agentId,
    });
    const delivered: string[] = [];
    const dispatcher = new ChannelTurnDispatcher({
      db: ctx.db,
      adapters: new AdapterManager(ctx.logger),
      conversations,
      logger: ctx.logger,
      deliver: async (a) => { delivered.push(a.body); },
      fallbackAdapter: () => undefined,
    });
    const result = await dispatcher.dispatch({
      workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id,
      agentId, conversationId: conv.id, connectionId: 'c', kind: 'telegram', chatId: '1', text: 'hi',
    });
    expect(result.replied).toBe(false);
    expect(result.reason).toBe('no_chat_adapter');
    expect(delivered[0]).toMatch(/not connected to an interactive runtime/);
  });

  it('channel-delivered confirmation: prompts yes/no, then resolves on the next reply', async () => {
    const conversations = new ConversationStore({ db: ctx.db, bus: ctx.bus });
    const agentId = seedAgent(ctx);
    const conv = conversations.getOrCreateByAgent({
      workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id, agentId,
    });
    const delivered: string[] = [];
    const confirmCalls: Array<{ turnId: string; confirmed: boolean }> = [];

    const dispatcher = new ChannelTurnDispatcher({
      db: ctx.db,
      adapters: new AdapterManager(ctx.logger),
      conversations,
      logger: ctx.logger,
      deliver: async (a) => { delivered.push(a.body); },
      fallbackAdapter: () => chatStub('unused'),
      // First turn asks for confirmation.
      runTurn: async function* () {
        yield { type: 'confirmation_required', turnId: 't-99', toolCall: { id: 'x', name: 'agentis.run.cancel', args: {} }, title: 'Cancel run?', body: 'This stops run r1.', confirmLabel: 'Cancel run', cancelLabel: 'Cancel', expiresAt: new Date(Date.now() + 60000).toISOString() } as unknown as ChatDelta;
        yield { type: 'done', finishReason: 'stop' } as ChatDelta;
      } as unknown as typeof import('../../src/services/chatSessionExecutor.js').ChatSessionExecutor.turn,
      runConfirm: async function* (_adapter, turnId, confirmed) {
        confirmCalls.push({ turnId, confirmed });
        yield { type: 'text', delta: confirmed ? 'Run cancelled.' : 'Left it running.' } as ChatDelta;
        yield { type: 'done', finishReason: 'stop' } as ChatDelta;
      } as unknown as typeof import('../../src/services/chatSessionExecutor.js').ChatSessionExecutor.confirm,
    });

    const base = {
      workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id,
      agentId, conversationId: conv.id, connectionId: 'c1', kind: 'telegram', chatId: '42',
    };
    // Turn 1: triggers a confirmation prompt.
    await dispatcher.dispatch({ ...base, text: 'stop the run' });
    expect(delivered[0]).toContain('Cancel run?');
    expect(delivered[0]).toContain('Reply "yes" to confirm');
    expect(confirmCalls).toHaveLength(0);

    // Turn 2: "yes" resolves the pending confirmation.
    await dispatcher.dispatch({ ...base, text: 'yes' });
    expect(confirmCalls).toEqual([{ turnId: 't-99', confirmed: true }]);
    expect(delivered[1]).toBe('Run cancelled.');
  });

  it('debounces rapid-fire messages into a single turn with combined text', async () => {
    const conversations = new ConversationStore({ db: ctx.db, bus: ctx.bus });
    const agentId = seedAgent(ctx);
    const conv = conversations.getOrCreateByAgent({
      workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id, agentId,
    });
    // Two inbound messages already persisted (as the bridge would) before dispatch.
    const m1 = conversations.appendMirrored({
      workspaceId: ctx.workspace.id, conversationId: conv.id, sessionMessageId: 'i1',
      authorType: 'system', body: 'first', metadata: { channelInbound: true },
    });
    const m2 = conversations.appendMirrored({
      workspaceId: ctx.workspace.id, conversationId: conv.id, sessionMessageId: 'i2',
      authorType: 'system', body: 'second', metadata: { channelInbound: true },
    });

    const turns: Array<{ text: string; history: ChatMessage[] }> = [];
    const dispatcher = new ChannelTurnDispatcher({
      db: ctx.db, adapters: new AdapterManager(ctx.logger), conversations, logger: ctx.logger,
      deliver: async () => {}, fallbackAdapter: () => chatStub('ok'), debounceMs: 40,
      runTurn: async function* (_a, history, userMessage) {
        turns.push({ text: userMessage as string, history });
        yield { type: 'text', delta: 'ok' } as ChatDelta;
        yield { type: 'done', finishReason: 'stop' } as ChatDelta;
      } as unknown as typeof import('../../src/services/chatSessionExecutor.js').ChatSessionExecutor.turn,
    });

    const base = {
      workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id,
      agentId, conversationId: conv.id, connectionId: 'c', kind: 'telegram', chatId: '1',
    };
    await dispatcher.dispatch({ ...base, text: 'first', inboundMessageId: m1.id });
    await dispatcher.dispatch({ ...base, text: 'second', inboundMessageId: m2.id });
    await new Promise((r) => setTimeout(r, 90));

    // Exactly one turn, combined text, and both inbound messages excluded from history.
    expect(turns).toHaveLength(1);
    expect(turns[0]!.text).toBe('first\nsecond');
    expect(turns[0]!.history).toEqual([]);
  });

  it('interpretConfirmation maps affirmatives/negatives, null otherwise', () => {
    for (const yes of ['yes', 'Y', 'approve', 'ok', 'do it', '👍', 'sim']) expect(interpretConfirmation(yes)).toBe(true);
    for (const no of ['no', 'cancel', 'stop', 'reject', '👎', 'não']) expect(interpretConfirmation(no)).toBe(false);
    for (const other of ['build me a workflow', 'maybe later', 'what runs are active?']) expect(interpretConfirmation(other)).toBeNull();
  });

  it('end-to-end: ChannelBridge.handleInbound fires the turn and the reply is sent', async () => {
    const conversations = new ConversationStore({ db: ctx.db, bus: ctx.bus });
    const sent: Array<{ chatId: string; body: string }> = [];
    const channelAdapter: ChannelAdapter = {
      kind: 'telegram',
      async send(args) { sent.push({ chatId: args.chatId, body: args.body }); },
      verify: () => true,
      parseInbound: (): ParsedInboundMessage => ({ externalId: 'u1', chatId: '777', body: 'ping', from: 'Bob' }),
    };
    const bridge = new ChannelBridge({
      db: ctx.db, vault: ctx.vault, conversations, bus: ctx.bus, logger: ctx.logger,
      adapters: { telegram: channelAdapter },
    });
    const agentId = seedAgent(ctx);
    const { connection } = bridge.create({
      workspaceId: ctx.workspace.id, ambientId: null, userId: ctx.user.id,
      agentId, kind: 'telegram', name: 'tg', token: 'tok',
    });

    const dispatcher = new ChannelTurnDispatcher({
      db: ctx.db,
      adapters: new AdapterManager(ctx.logger),
      conversations,
      logger: ctx.logger,
      deliver: (args) => bridge.deliverToConnection(args),
      fallbackAdapter: () => chatStub('pong'),
    });
    bridge.setTurnDispatcher(dispatcher);

    await bridge.handleInbound({ connectionId: connection.id, headers: {}, rawBody: '{}' });
    // Dispatcher runs fire-and-forget; drain microtasks.
    await new Promise((r) => setTimeout(r, 20));

    expect(sent).toEqual([{ chatId: '777', body: 'pong' }]);
    const conv = conversations.list(ctx.workspace.id)[0]!;
    const messages = conversations.messages(conv.id, 50);
    // inbound (system) + reply (agent)
    expect(messages.some((m) => m.authorType === 'system' && m.body.includes('ping'))).toBe(true);
    expect(messages.some((m) => m.authorType === 'agent' && m.body === 'pong')).toBe(true);
  });
});
