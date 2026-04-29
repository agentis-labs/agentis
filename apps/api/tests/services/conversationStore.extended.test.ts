/**
 * ConversationStore — extended coverage for V1-SPEC §0.3 item 23.
 *
 * Complements `tests/conversationStore.test.ts`: list ordering by
 * lastMessageAt, mirroredSessionId enrichment on subsequent
 * getOrCreateByAgent calls, unreadCount accumulation, message reverse
 * chronology, deliveryStatus default propagation.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { openSqlite, type AgentisSqliteDb } from '@agentis/db/sqlite';
import { ConversationStore } from '../../src/services/conversationStore.js';
import { createInProcessEventBus, type EventBus } from '../../src/event-bus.js';

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

const wsA = 'ws-A';
const userA = 'u-A';

describe('ConversationStore — extended', () => {
  it('list orders conversations by lastMessageAt DESC', async () => {
    const c1 = store.getOrCreateByAgent({ workspaceId: wsA, ambientId: null, userId: userA, agentId: 'agent-1' });
    const c2 = store.getOrCreateByAgent({ workspaceId: wsA, ambientId: null, userId: userA, agentId: 'agent-2' });
    store.appendOutbound({ workspaceId: wsA, conversationId: c1.id, operatorId: userA, body: 'first' });
    // small wait so timestamps differ at ms granularity
    await new Promise((r) => setTimeout(r, 10));
    store.appendOutbound({ workspaceId: wsA, conversationId: c2.id, operatorId: userA, body: 'second' });
    const list = store.list(wsA);
    expect(list[0]!.id).toBe(c2.id);
    expect(list[1]!.id).toBe(c1.id);
  });

  it('isolates conversations by workspaceId', () => {
    store.getOrCreateByAgent({ workspaceId: 'ws-A', ambientId: null, userId: userA, agentId: 'agent-1' });
    store.getOrCreateByAgent({ workspaceId: 'ws-B', ambientId: null, userId: userA, agentId: 'agent-2' });
    expect(store.list('ws-A')).toHaveLength(1);
    expect(store.list('ws-B')).toHaveLength(1);
  });

  it('subsequent getOrCreateByAgent enriches mirroredSessionId when previously null', () => {
    const c1 = store.getOrCreateByAgent({ workspaceId: wsA, ambientId: null, userId: userA, agentId: 'agent-1' });
    expect(c1.mirroredSessionId).toBeFalsy();
    const c2 = store.getOrCreateByAgent({
      workspaceId: wsA,
      ambientId: null,
      userId: userA,
      agentId: 'agent-1',
      mirroredSessionId: 'oc-session-99',
    });
    expect(c2.id).toBe(c1.id);
    expect(c2.mirroredSessionId).toBe('oc-session-99');
  });

  it('mirrored messages increment unreadCount; outbound messages do not', () => {
    const c = store.getOrCreateByAgent({ workspaceId: wsA, ambientId: null, userId: userA, agentId: 'agent-1' });
    store.appendOutbound({ workspaceId: wsA, conversationId: c.id, operatorId: userA, body: 'me' });
    let row = store.list(wsA)[0]!;
    expect(row.unreadCount).toBe(0);
    store.appendMirrored({
      workspaceId: wsA,
      conversationId: c.id,
      sessionMessageId: 'sm-a',
      body: 'them',
      authorType: 'agent',
    });
    row = store.list(wsA)[0]!;
    expect(row.unreadCount).toBe(1);
    store.appendMirrored({
      workspaceId: wsA,
      conversationId: c.id,
      sessionMessageId: 'sm-b',
      body: 'them again',
      authorType: 'agent',
    });
    row = store.list(wsA)[0]!;
    expect(row.unreadCount).toBe(2);
  });

  it('messages() returns a chronological window in ascending order', () => {
    const c = store.getOrCreateByAgent({ workspaceId: wsA, ambientId: null, userId: userA, agentId: 'agent-1' });
    store.appendOutbound({ workspaceId: wsA, conversationId: c.id, operatorId: userA, body: 'first' });
    store.appendOutbound({ workspaceId: wsA, conversationId: c.id, operatorId: userA, body: 'second' });
    store.appendOutbound({ workspaceId: wsA, conversationId: c.id, operatorId: userA, body: 'third' });
    const msgs = store.messages(c.id);
    expect(msgs.map((m) => m.body)).toEqual(['first', 'second', 'third']);
  });

  it('appendOutbound respects an explicit deliveryStatus', () => {
    const c = store.getOrCreateByAgent({ workspaceId: wsA, ambientId: null, userId: userA, agentId: 'agent-1' });
    const msg = store.appendOutbound({
      workspaceId: wsA,
      conversationId: c.id,
      operatorId: userA,
      body: 'retry me',
      deliveryStatus: 'failed',
    });
    expect(msg.deliveryStatus).toBe('failed');
  });
});
