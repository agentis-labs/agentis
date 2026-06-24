/**
 * RuntimeSessionStore — FK-crash regression (the self-heal process killer).
 *
 * The CLI adapters persist a runtime session on each `session_id` event and pass
 * their `sessionKey` as the `conversationId`. During chat the sessionKey IS a
 * real conversation id, but for self-heal / structured completions it is a
 * SYNTHETIC key ('default'). Writing that into the `conversation_id` FK column
 * raised SQLITE_CONSTRAINT_FOREIGNKEY inside an adapter stdout handler — an
 * uncaught throw that killed the whole API process mid-run and tore down every
 * live SSE stream. These tests prove the upsert is now crash-proof and only
 * persists the FK when it points at a real conversation.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { schema } from '@agentis/db/sqlite';
import { RuntimeSessionStore } from '../../src/services/runtimeSessionStore.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

let ctx: TestContext;
let store: RuntimeSessionStore;
let agentId: string;

beforeEach(async () => {
  ctx = await createTestContext(); // foreign_keys = ON, as in production
  store = new RuntimeSessionStore(ctx.db);
  agentId = randomUUID();
  ctx.db.insert(schema.agents).values({
    id: agentId, workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id,
    name: 'Claude Code', adapterType: 'claude_code', capabilityTags: [], config: {}, status: 'online', role: 'researcher',
  }).run();
});

afterEach(() => ctx.close());

function seedConversation(): string {
  const id = randomUUID();
  ctx.db.insert(schema.conversations).values({
    id, workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id, agentId,
  }).run();
  return id;
}

describe('RuntimeSessionStore.upsert', () => {
  it('does not throw and stores null when conversationId is a synthetic key (the crash)', () => {
    expect(() =>
      store.upsert({
        workspaceId: ctx.workspace.id,
        agentId,
        conversationId: 'default', // not a real conversation — would have raised an FK error
        sessionKey: 'default',
        runtimeSessionId: 'claude-runtime-session-1',
      }),
    ).not.toThrow();

    const row = store.get(ctx.workspace.id, agentId, 'default');
    expect(row).not.toBeNull();
    expect(row?.conversationId).toBeNull();
    expect(row?.runtimeSessionId).toBe('claude-runtime-session-1');
  });

  it('preserves a conversationId that points at a real conversation', () => {
    const conversationId = seedConversation();
    store.upsert({
      workspaceId: ctx.workspace.id,
      agentId,
      conversationId,
      sessionKey: conversationId,
      runtimeSessionId: 'claude-runtime-session-2',
    });
    const row = store.get(ctx.workspace.id, agentId, conversationId);
    expect(row?.conversationId).toBe(conversationId);
  });

  it('upserts idempotently on the same session key without throwing', () => {
    store.upsert({ workspaceId: ctx.workspace.id, agentId, sessionKey: 'default', conversationId: 'default', runtimeSessionId: 'gen-1' });
    expect(() =>
      store.upsert({ workspaceId: ctx.workspace.id, agentId, sessionKey: 'default', conversationId: 'default', runtimeSessionId: 'gen-2', processGeneration: 2 }),
    ).not.toThrow();
    const row = store.get(ctx.workspace.id, agentId, 'default');
    expect(row?.runtimeSessionId).toBe('gen-2');
    expect(row?.processGeneration).toBe(2);
  });
});
