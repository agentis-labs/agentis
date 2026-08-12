import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { schema } from '@agentis/db/sqlite';
import { ConversationStore } from '../../src/services/conversation/conversationStore.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

describe('silent channel history reconciliation', () => {
  let ctx: TestContext;
  beforeEach(async () => { ctx = await createTestContext(); });
  afterEach(() => ctx.close());

  it('stores reverse and duplicate provider chunks once, chronologically, without unread or realtime ingress', () => {
    const agentId = randomUUID();
    ctx.db.insert(schema.agents).values({
      id: agentId, workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id,
      userId: ctx.user.id, name: 'Agent', adapterType: 'http',
    }).run();
    const store = new ConversationStore({ db: ctx.db, bus: ctx.bus });
    const conversation = store.getOrCreateByAgent({
      workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id, agentId,
    });
    const capture = ctx.captureBus();
    const rows = [
      { id: 'm3', body: 'customer reply', side: 'customer' as const, at: '2026-08-10T20:02:00.000Z' },
      { id: 'm2', body: 'business promise', side: 'business' as const, at: '2026-08-10T20:01:00.000Z' },
      { id: 'm1', body: 'customer opener', side: 'customer' as const, at: '2026-08-10T20:00:00.000Z' },
      { id: 'm2', body: 'business promise', side: 'business' as const, at: '2026-08-10T20:01:00.000Z' },
    ];
    for (const row of rows) store.appendReconciledChannelMessage({
      workspaceId: ctx.workspace.id,
      conversationId: conversation.id,
      sessionMessageId: row.id,
      body: row.body,
      participantSide: row.side,
      occurredAt: row.at,
      metadata: { channel: 'whatsapp' },
    });
    expect(store.messages(conversation.id, 20).map((row) => [row.sessionMessageId, row.body, row.participantSide])).toEqual([
      ['m1', 'customer opener', 'customer'],
      ['m2', 'business promise', 'business'],
      ['m3', 'customer reply', 'customer'],
    ]);
    expect(store.getById(ctx.workspace.id, conversation.id).unreadCount).toBe(0);
    expect(capture.events).toHaveLength(0);
    capture.stop();
  });
});
