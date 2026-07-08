/**
 * ConversationStore — V1-SPEC §0.3 item 23.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { AgentisError, REALTIME_EVENTS } from '@agentis/core';
import { openSqlite, schema, type AgentisSqliteDb } from '@agentis/db/sqlite';
import { eq } from 'drizzle-orm';
import { ConversationStore } from '../src/services/conversation/conversationStore.js';
import { createInProcessEventBus, type EventBus } from '../src/event-bus.js';

let db: AgentisSqliteDb;
let bus: EventBus;
let store: ConversationStore;

beforeEach(() => {
  const opened = openSqlite({ path: ':memory:' });
  db = opened.db;
  opened.sqlite.pragma('foreign_keys = OFF');
  bus = createInProcessEventBus();
  store = new ConversationStore({ db, bus });
});

const baseGet = {
  workspaceId: 'ws1',
  ambientId: null,
  userId: 'u1',
  agentId: 'a1',
};

describe('ConversationStore', () => {
  it('getOrCreateByAgent returns the same conversation for repeated calls', () => {
    const a = store.getOrCreateByAgent(baseGet);
    const b = store.getOrCreateByAgent(baseGet);
    expect(a.id).toBe(b.id);
    expect(store.list('ws1')).toHaveLength(1);
  });

  it('separates desktop and channel-scoped conversations for the same agent', () => {
    const desktop = store.getOrCreateByAgent(baseGet);
    const channelA = store.getOrCreateByChannel({
      ...baseGet,
      channelConnectionId: 'conn-1',
      channelChatId: 'chat-1',
    });
    const channelAAgain = store.getOrCreateByChannel({
      ...baseGet,
      channelConnectionId: 'conn-1',
      channelChatId: 'chat-1',
    });
    const channelB = store.getOrCreateByChannel({
      ...baseGet,
      channelConnectionId: 'conn-1',
      channelChatId: 'chat-2',
    });
    const desktopAgain = store.getOrCreateByAgent(baseGet);

    expect(desktopAgain.id).toBe(desktop.id);
    expect(channelAAgain.id).toBe(channelA.id);
    expect(channelA.id).not.toBe(desktop.id);
    expect(channelB.id).not.toBe(channelA.id);
    expect(store.list('ws1')).toHaveLength(3);
  });

  it('appendOutbound writes a message and emits MESSAGE_SENT', () => {
    const conv = store.getOrCreateByAgent(baseGet);
    const events: string[] = [];
    bus.subscribe((m) => {
      if (m.room === `conversation:${conv.agentId}`) events.push(m.envelope.event);
    });
    const msg = store.appendOutbound({
      workspaceId: 'ws1',
      conversationId: conv.id,
      operatorId: 'u1',
      body: 'hello',
    });
    expect(msg.body).toBe('hello');
    expect(msg.authorType).toBe('operator');
    expect(events).toContain(REALTIME_EVENTS.CONVERSATION_MESSAGE_SENT);
  });

  it('appendMirrored is idempotent on sessionMessageId', () => {
    const conv = store.getOrCreateByAgent(baseGet);
    const a = store.appendMirrored({
      workspaceId: 'ws1',
      conversationId: conv.id,
      sessionMessageId: 'sm-1',
      body: 'from gateway',
      authorType: 'agent',
    });
    const b = store.appendMirrored({
      workspaceId: 'ws1',
      conversationId: conv.id,
      sessionMessageId: 'sm-1',
      body: 'from gateway',
      authorType: 'agent',
    });
    expect(a.id).toBe(b.id);
    expect(store.messages(conv.id)).toHaveLength(1);
  });

  it('rejects empty bodies', () => {
    const conv = store.getOrCreateByAgent(baseGet);
    expect(() =>
      store.appendOutbound({
        workspaceId: 'ws1',
        conversationId: conv.id,
        operatorId: 'u1',
        body: '',
      }),
    ).toThrow(AgentisError);
  });

  it('rejects messages crossing workspace boundaries', () => {
    const conv = store.getOrCreateByAgent(baseGet);
    expect(() =>
      store.appendOutbound({
        workspaceId: 'ws-other',
        conversationId: conv.id,
        operatorId: 'u1',
        body: 'sneaky',
      }),
    ).toThrow(AgentisError);
  });

  it('markRead resets unreadCount', () => {
    const conv = store.getOrCreateByAgent(baseGet);
    store.appendMirrored({
      workspaceId: 'ws1',
      conversationId: conv.id,
      sessionMessageId: 'sm-2',
      body: 'incoming',
      authorType: 'agent',
    });
    store.markRead('ws1', conv.id);
    const reloaded = store.list('ws1')[0]!;
    expect(reloaded.unreadCount).toBe(0);
  });

  it('uses id as a tiebreaker when paginating messages with the same timestamp', () => {
    const conv = store.getOrCreateByAgent(baseGet);
    const first = store.appendOutbound({
      workspaceId: 'ws1',
      conversationId: conv.id,
      operatorId: 'u1',
      body: 'first',
    });
    const second = store.appendMirrored({
      workspaceId: 'ws1',
      conversationId: conv.id,
      sessionMessageId: 'sm-same-ms',
      body: 'second',
      authorType: 'agent',
    });
    db.update(schema.conversationMessages)
      .set({ createdAt: '2026-01-01T00:00:00.000Z' })
      .where(eq(schema.conversationMessages.conversationId, conv.id))
      .run();

    const newest = store.messages(conv.id, 1).at(0)!;
    const older = store.messages(conv.id, 5, newest.createdAt, newest.id);

    expect([first.id, second.id]).toContain(newest.id);
    expect(older).toHaveLength(1);
    expect(older[0]!.id).not.toBe(newest.id);
  });
});
