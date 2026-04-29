/**
 * ConversationStore — V1-SPEC §0.3 item 23.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { AgentisError, REALTIME_EVENTS } from '@agentis/core';
import { openSqlite, type AgentisSqliteDb } from '@agentis/db/sqlite';
import { ConversationStore } from '../src/services/conversationStore.js';
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
});
