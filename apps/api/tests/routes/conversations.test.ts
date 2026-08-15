/**
 * /v1/conversations — route unit tests.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { schema } from '@agentis/db/sqlite';
import { buildConversationRoutes } from '../../src/routes/conversations.js';
import { AdapterManager } from '../../src/adapters/AdapterManager.js';
import { ConversationStore } from '../../src/services/conversation/conversationStore.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';
import { ConversationTurnLeaseRegistry } from '../../src/services/conversation/conversationTurnLease.js';
import { ConversationHandoffService } from '../../src/services/conversation/conversationHandoffService.js';

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

describe('POST /v1/conversations/:agentId/:messageId/rewrite', () => {
  it('retires preserved turns from the superseded branch before starting the edit', async () => {
    const agentId = seedAgent();
    const conversation = conversations.getOrCreateByAgent({
      workspaceId: ctx.workspace.id,
      ambientId: ctx.ambient.id,
      userId: ctx.user.id,
      agentId,
    });
    const message = conversations.appendOutbound({
      workspaceId: ctx.workspace.id,
      conversationId: conversation.id,
      operatorId: ctx.user.id,
      body: 'Original task',
    });
    const turnId = randomUUID();
    const now = new Date().toISOString();
    ctx.db.insert(schema.conversationTurns).values({
      id: turnId,
      workspaceId: ctx.workspace.id,
      conversationId: conversation.id,
      agentId,
      userId: ctx.user.id,
      messageId: message.id,
      planId: null,
      clientTurnId: randomUUID(),
      prompt: 'Original task',
      requestedMode: 'auto',
      effectiveMode: 'mission',
      permissionMode: 'auto',
      status: 'blocked',
      attachments: [],
      viewport: null,
      executionEnvelope: null,
      contextManifest: null,
      lastEventSeq: 0,
      leaseOwner: null,
      leaseExpiresAt: null,
      error: 'Completion verification is incomplete.',
      startedAt: now,
      completedAt: null,
      createdAt: now,
      updatedAt: now,
    }).run();

    const response = await app().request(
      `/v1/conversations/${agentId}/${message.id}/rewrite?conversationId=${conversation.id}`,
      {
        method: 'POST',
        headers: ctx.authHeaders,
        body: JSON.stringify({ text: 'Replacement task', clientTurnId: randomUUID() }),
      },
    );

    expect(response.status).toBe(200);
    const persisted = ctx.db.select().from(schema.conversationTurns).all().find((turn) => turn.id === turnId);
    expect(persisted?.status).toBe('cancelled');
    expect(conversations.messages(conversation.id, 20).find((item) => item.id === message.id)?.body).toBe('Replacement task');
  });
});

describe('PATCH /v1/conversations/:conversationId/handoff', () => {
  it('persists human ownership and releases it through the generic channel-safe API', async () => {
    const agentId = seedAgent();
    const conversation = conversations.getOrCreateByAgent({
      workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id, agentId,
    });
    const handoffs = new ConversationHandoffService({ db: ctx.db, bus: ctx.bus });
    const routed = ctx.buildApp([{ path: '/v1/conversations', app: buildConversationRoutes({
      db: ctx.db, auth: ctx.auth, conversations, adapters, logger: ctx.logger, bus: ctx.bus, handoffs,
    }) }]);
    const claim = await routed.request(`/v1/conversations/${conversation.id}/handoff`, {
      method: 'PATCH', headers: ctx.authHeaders, body: JSON.stringify({ state: 'human' }),
    });
    expect(claim.status).toBe(200);
    expect(await claim.json()).toMatchObject({
      conversationId: conversation.id, state: 'human', source: 'explicit', automationEpoch: 1,
    });
    const release = await routed.request(`/v1/conversations/${conversation.id}/handoff`, {
      method: 'PATCH', headers: ctx.authHeaders, body: JSON.stringify({ state: 'agent' }),
    });
    expect(await release.json()).toMatchObject({
      conversationId: conversation.id, state: 'agent', source: null, claimedAt: null, automationEpoch: 2,
    });
  });
});

describe('POST /v1/conversations/:agentId/stop', () => {
  it('discards queued messages and cancels only active runs spawned by that conversation', async () => {
    const agentId = seedAgent();
    const conversation = conversations.getOrCreateByAgent({
      workspaceId: ctx.workspace.id,
      ambientId: ctx.ambient.id,
      userId: ctx.user.id,
      agentId,
    });
    conversations.enqueueMessage({
      workspaceId: ctx.workspace.id,
      conversationId: conversation.id,
      text: 'queued follow-up',
    });
    const scopedRunId = randomUUID();
    const unrelatedRunId = randomUUID();
    ctx.db.insert(schema.workflowRuns).values([
      {
        id: scopedRunId,
        workspaceId: ctx.workspace.id,
        ambientId: ctx.ambient.id,
        userId: ctx.user.id,
        conversationId: conversation.id,
        status: 'RUNNING',
        runState: {},
      },
      {
        id: unrelatedRunId,
        workspaceId: ctx.workspace.id,
        ambientId: ctx.ambient.id,
        userId: ctx.user.id,
        status: 'RUNNING',
        runState: {},
      },
    ]).run();
    const cancelRun = vi.fn(async () => undefined);
    const turnLeases = new ConversationTurnLeaseRegistry();
    turnLeases.issue(ctx.workspace.id, conversation.id);
    const stopApp = ctx.buildApp([{
      path: '/v1/conversations',
      app: buildConversationRoutes({
        db: ctx.db,
        auth: ctx.auth,
        conversations,
        adapters,
        logger: ctx.logger,
        bus: ctx.bus,
        engine: { cancelRun },
        turnLeases,
      }),
    }]);

    const res = await stopApp.request(`/v1/conversations/${agentId}/stop?conversationId=${conversation.id}`, {
      method: 'POST',
      headers: ctx.authHeaders,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      ok: true,
      discardedMessages: 1,
      cancelledRunIds: [scopedRunId],
      leaseRevoked: true,
    });
    expect(cancelRun).toHaveBeenCalledTimes(1);
    expect(cancelRun).toHaveBeenCalledWith(scopedRunId);
    expect(conversations.listQueue(ctx.workspace.id, conversation.id)).toEqual([]);
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

