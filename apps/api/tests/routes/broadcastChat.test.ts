import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { ChatDelta } from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import { buildRoomRoutes } from '../../src/routes/rooms.js';
import { BroadcastDispatcher } from '../../src/services/broadcastDispatcher.js';
import { ConversationStore } from '../../src/services/conversation/conversationStore.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

function seedAgent(ctx: TestContext, name: string): string {
  const id = randomUUID();
  ctx.db.insert(schema.agents).values({
    id, workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id,
    name, adapterType: 'http',
  }).run();
  return id;
}

/** Fake adapter manager whose every agent is "chattable" (the gate only checks `.chat`). */
function fakeAdapters(): any {
  return {
    get: (agentId: string) => ({
      agentId,
      adapterType: 'http',
      adapter: { chat: () => { /* real turn is overridden via runTurn */ } },
    }),
  };
}

async function listMessages(app: any, headers: Record<string, string>) {
  const res = await app.request('/v1/rooms/__broadcast__/messages', { headers });
  const body = (await res.json()) as { messages: Array<{ authorType: string; authorId: string | null; content: { text?: string } }> };
  return body.messages;
}

describe('Global Chat (broadcast room)', () => {
  it('resolves __broadcast__ to a real room and persists an operator message', async () => {
    const ctx = await createTestContext();
    const app = ctx.buildApp([
      { path: '/v1/rooms', app: buildRoomRoutes({ db: ctx.db, auth: ctx.auth, bus: ctx.bus }) },
    ]);
    try {
      const sent = await app.request('/v1/rooms/__broadcast__/messages', {
        method: 'POST',
        headers: ctx.authHeaders,
        body: JSON.stringify({ contentType: 'text', content: { text: 'hello world' } }),
      });
      expect(sent.status).toBe(201); // no more "Room not found"

      const messages = await listMessages(app, ctx.authHeaders);
      expect(messages).toHaveLength(1);
      expect(messages[0]?.content.text).toBe('hello world');

      // A single backing workspace room was provisioned.
      const rooms = ctx.db.select().from(schema.rooms).all();
      expect(rooms.filter((r) => r.kind === 'workspace')).toHaveLength(1);
    } finally {
      ctx.close();
    }
  });

  it('matches @handles to agents by normalized name', async () => {
    const ctx = await createTestContext();
    try {
      const hermesId = seedAgent(ctx, 'Hermes');
      const orchyId = seedAgent(ctx, 'Orchy');
      const dispatcher = new BroadcastDispatcher({
        db: ctx.db, adapters: fakeAdapters(), conversations: new ConversationStore({ db: ctx.db, bus: ctx.bus }),
        bus: ctx.bus, logger: ctx.logger,
      });
      const ids = dispatcher.resolveMentionedAgentIds(ctx.workspace.id, '@hermes say hi to @Orchy');
      expect(ids.sort()).toEqual([hermesId, orchyId].sort());
      expect(dispatcher.resolveMentionedAgentIds(ctx.workspace.id, 'nobody mentioned')).toEqual([]);
    } finally {
      ctx.close();
    }
  });

  it('dispatches a mentioned agent and posts its reply back into Global Chat', async () => {
    const ctx = await createTestContext();
    seedAgent(ctx, 'Hermes');
    const runTurn = (async function* (): AsyncIterable<ChatDelta> {
      yield { type: 'text', delta: '👋 Hey, joining in!' };
      yield { type: 'done', finishReason: 'stop' };
    }) as unknown as typeof import('../../src/services/chat/chatSessionExecutor.js').ChatSessionExecutor.turn;

    const dispatcher = new BroadcastDispatcher({
      db: ctx.db, adapters: fakeAdapters(), conversations: new ConversationStore({ db: ctx.db, bus: ctx.bus }),
      bus: ctx.bus, logger: ctx.logger, runTurn,
    });
    const app = ctx.buildApp([
      { path: '/v1/rooms', app: buildRoomRoutes({ db: ctx.db, auth: ctx.auth, bus: ctx.bus, broadcast: dispatcher }) },
    ]);
    try {
      const sent = await app.request('/v1/rooms/__broadcast__/messages', {
        method: 'POST',
        headers: ctx.authHeaders,
        body: JSON.stringify({ contentType: 'text', content: { text: '@hermes say hi' } }),
      });
      expect(sent.status).toBe(201);

      // Dispatch is fire-and-forget — poll briefly for the agent's reply.
      let agentReply: { authorType: string; content: { text?: string } } | undefined;
      for (let i = 0; i < 40 && !agentReply; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 25));
        const messages = await listMessages(app, ctx.authHeaders);
        agentReply = messages.find((m) => m.authorType === 'agent');
      }
      expect(agentReply?.content.text).toBe('👋 Hey, joining in!');
    } finally {
      ctx.close();
    }
  });

  it('posts an honest system notice (never silence) when the agent turn errors with no text', async () => {
    const ctx = await createTestContext();
    seedAgent(ctx, 'Hermes');
    const runTurn = (async function* (): AsyncIterable<ChatDelta> {
      yield { type: 'tool_result', id: 'adapter', name: 'adapter.chat', result: null, error: 'hermes runtime is unavailable' };
      yield { type: 'done', finishReason: 'error' };
    }) as unknown as typeof import('../../src/services/chat/chatSessionExecutor.js').ChatSessionExecutor.turn;

    const dispatcher = new BroadcastDispatcher({
      db: ctx.db, adapters: fakeAdapters(), conversations: new ConversationStore({ db: ctx.db, bus: ctx.bus }),
      bus: ctx.bus, logger: ctx.logger, runTurn,
    });
    const app = ctx.buildApp([
      { path: '/v1/rooms', app: buildRoomRoutes({ db: ctx.db, auth: ctx.auth, bus: ctx.bus, broadcast: dispatcher }) },
    ]);
    try {
      await app.request('/v1/rooms/__broadcast__/messages', {
        method: 'POST', headers: ctx.authHeaders,
        body: JSON.stringify({ contentType: 'text', content: { text: '@hermes say hi' } }),
      });
      let notice: { authorType: string; content: { text?: string } } | undefined;
      for (let i = 0; i < 40 && !notice; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 25));
        notice = (await listMessages(app, ctx.authHeaders)).find((m) => m.authorType === 'system');
      }
      expect(notice?.content.text).toContain("couldn't reply");
      expect(notice?.content.text).toContain('hermes runtime is unavailable');
    } finally {
      ctx.close();
    }
  });

  it('posts a "not connected" notice when a mentioned agent has no interactive runtime', async () => {
    const ctx = await createTestContext();
    seedAgent(ctx, 'Hermes');
    const adaptersNoChat: any = { get: (agentId: string) => ({ agentId, adapterType: 'http', adapter: {} }) };
    const dispatcher = new BroadcastDispatcher({
      db: ctx.db, adapters: adaptersNoChat, conversations: new ConversationStore({ db: ctx.db, bus: ctx.bus }),
      bus: ctx.bus, logger: ctx.logger,
    });
    const app = ctx.buildApp([
      { path: '/v1/rooms', app: buildRoomRoutes({ db: ctx.db, auth: ctx.auth, bus: ctx.bus, broadcast: dispatcher }) },
    ]);
    try {
      await app.request('/v1/rooms/__broadcast__/messages', {
        method: 'POST', headers: ctx.authHeaders,
        body: JSON.stringify({ contentType: 'text', content: { text: '@hermes say hi' } }),
      });
      let notice: { authorType: string; content: { text?: string } } | undefined;
      for (let i = 0; i < 40 && !notice; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 25));
        notice = (await listMessages(app, ctx.authHeaders)).find((m) => m.authorType === 'system');
      }
      expect(notice?.content.text).toContain("isn't connected to an interactive runtime");
    } finally {
      ctx.close();
    }
  });
});
