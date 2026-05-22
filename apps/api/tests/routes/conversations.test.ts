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
  it('archives the current thread and starts a fresh active one', async () => {
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
    const archived = history.conversations.find((conversation) => conversation.archivedAt);
    expect(archived?.lastMessagePreview).toBe('hello');

    const archivedRes = await app().request(`/v1/conversations/${agentId}?conversationId=${archived!.id}`, { headers: ctx.authHeaders });
    const archivedBody = (await archivedRes.json()) as { messages: Array<{ body: string }> };
    expect(archivedBody.messages.map((message) => message.body)).toContain('hello');
  });
});
