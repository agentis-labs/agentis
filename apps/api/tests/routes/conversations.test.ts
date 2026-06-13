/**
 * /v1/conversations — route unit tests.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { schema } from '@agentis/db/sqlite';
import { buildConversationRoutes } from '../../src/routes/conversations.js';
import { AdapterManager } from '../../src/adapters/AdapterManager.js';
import { ConversationStore } from '../../src/services/conversationStore.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

let ctx: TestContext;
let conversations: ConversationStore;
let adapters: AdapterManager;

beforeEach(async () => {
  ctx = await createTestContext();
  conversations = new ConversationStore({ db: ctx.db, bus: ctx.bus });
  adapters = new AdapterManager(ctx.logger);
});

function app() {
  return ctx.buildApp([
    {
      path: '/v1/conversations',
      app: buildConversationRoutes({
        db: ctx.db,
        auth: ctx.auth,
        conversations,
        adapters,
        logger: ctx.logger,
        bus: ctx.bus,
      }),
    },
  ]);
}

function seedAgent(overrides: Partial<typeof schema.agents.$inferInsert> = {}) {
  const id = randomUUID();
  ctx.db
    .insert(schema.agents)
    .values({
      id,
      workspaceId: ctx.workspace.id,
      ambientId: ctx.ambient.id,
      userId: ctx.user.id,
      name: 'Agent',
      adapterType: 'http',
      capabilityTags: [],
      config: {},
      status: 'offline',
      ...overrides,
    })
    .run();
  return id;
}

describe('GET /v1/conversations', () => {
  it('returns an empty list initially', async () => {
    const res = await app().request('/v1/conversations', { headers: ctx.authHeaders });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { conversations: unknown[] };
    expect(body.conversations).toEqual([]);
  });

  it('rejects without auth (401)', async () => {
    const res = await app().request('/v1/conversations');
    expect(res.status).toBe(401);
  });
});

describe('GET /v1/conversations/:agentId', () => {
  it('lazily creates a thread for a known agent', async () => {
    const agentId = seedAgent();
    const res = await app().request(`/v1/conversations/${agentId}`, { headers: ctx.authHeaders });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { conversation: { agentId: string }; messages: unknown[] };
    expect(body.conversation.agentId).toBe(agentId);
    expect(body.messages).toEqual([]);
  });

  it('returns 404 for unknown agent', async () => {
    const res = await app().request(`/v1/conversations/${randomUUID()}`, { headers: ctx.authHeaders });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('RESOURCE_NOT_FOUND');
  });
});

describe('GET /v1/conversations/orchestrator', () => {
  it('does not guess the orchestrator from an agent name', async () => {
    seedAgent({ name: 'My Orchestrator Strategy Agent', role: 'worker' });
    const res = await app().request('/v1/conversations/orchestrator', { headers: ctx.authHeaders });
    expect(res.status).toBe(404);
  });

  it('opens the workspace orchestrator by role', async () => {
    const agentId = seedAgent({ name: 'The Brain', role: 'orchestrator' });
    const res = await app().request('/v1/conversations/orchestrator', { headers: ctx.authHeaders });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { agent: { id: string; role: string } };
    expect(body.agent.id).toBe(agentId);
    expect(body.agent.role).toBe('orchestrator');
  });
});

describe('POST /v1/conversations/:agentId/send', () => {
  it('appends an outbound message', async () => {
    const agentId = seedAgent();
    const res = await app().request(`/v1/conversations/${agentId}/send`, {
      method: 'POST',
      headers: ctx.authHeaders,
      body: JSON.stringify({ body: 'hello' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { message: { body: string } };
    expect(body.message.body).toBe('hello');
  });

  it('returns 422 on empty body', async () => {
    const agentId = seedAgent();
    const res = await app().request(`/v1/conversations/${agentId}/send`, {
      method: 'POST',
      headers: ctx.authHeaders,
      body: JSON.stringify({ body: '' }),
    });
    expect(res.status).toBe(422);
  });
});

describe('POST /v1/conversations/:agentId/read', () => {
  it('clears unread (returns ok)', async () => {
    const agentId = seedAgent();
    const res = await app().request(`/v1/conversations/${agentId}/read`, {
      method: 'POST',
      headers: ctx.authHeaders,
    });
    expect(res.status).toBe(200);
  });
});

describe('POST /v1/conversations/:agentId/new', () => {
  it('keeps the old thread in active history and starts a fresh active one', async () => {
    const agentId = seedAgent();

    const sendRes = await app().request(`/v1/conversations/${agentId}/send`, {
      method: 'POST',
      headers: ctx.authHeaders,
      body: JSON.stringify({ body: 'hello' }),
    });
    expect(sendRes.status).toBe(200);

    const resetRes = await app().request(`/v1/conversations/${agentId}/new`, {
      method: 'POST',
      headers: ctx.authHeaders,
    });
    expect(resetRes.status).toBe(200);

    const threadRes = await app().request(`/v1/conversations/${agentId}`, { headers: ctx.authHeaders });
    expect(threadRes.status).toBe(200);
    const body = (await threadRes.json()) as { messages: Array<{ body: string }> };
    expect(body.messages).toEqual([]);

    const historyRes = await app().request('/v1/conversations', { headers: ctx.authHeaders });
    const history = (await historyRes.json()) as {
      conversations: Array<{ id: string; archivedAt: string | null; lastMessagePreview: string | null }>;
    };
    const prevConv = history.conversations.find((conversation) => conversation.lastMessagePreview === 'hello');
    expect(prevConv).toBeDefined();
    expect(prevConv?.archivedAt).toBeNull();

    const oldRes = await app().request(`/v1/conversations/${agentId}?conversationId=${prevConv!.id}`, { headers: ctx.authHeaders });
    const oldBody = (await oldRes.json()) as { messages: Array<{ body: string }> };
    expect(oldBody.messages.map((message) => message.body)).toContain('hello');
  });
});

describe('PATCH /v1/conversations/session/:conversationId', () => {
  it('updates title and archived status', async () => {
    const agentId = seedAgent();
    // Fetch once to create the active conversation
    const res = await app().request(`/v1/conversations/${agentId}`, { headers: ctx.authHeaders });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { conversation: { id: string } };
    const conversationId = body.conversation.id;

    // PATCH with archived: true
    const patchRes = await app().request(`/v1/conversations/session/${conversationId}`, {
      method: 'PATCH',
      headers: ctx.authHeaders,
      body: JSON.stringify({ archived: true, title: 'Archived Conversation' }),
    });
    expect(patchRes.status).toBe(200);
    const patchBody = (await patchRes.json()) as { conversation: { archivedAt: string | null; title: string | null } };
    expect(patchBody.conversation.archivedAt).not.toBeNull();
    expect(patchBody.conversation.title).toBe('Archived Conversation');

    // PATCH with archived: false
    const patchRes2 = await app().request(`/v1/conversations/session/${conversationId}`, {
      method: 'PATCH',
      headers: ctx.authHeaders,
      body: JSON.stringify({ archived: false }),
    });
    expect(patchRes2.status).toBe(200);
    const patchBody2 = (await patchRes2.json()) as { conversation: { archivedAt: string | null } };
    expect(patchBody2.conversation.archivedAt).toBeNull();
  });
});

