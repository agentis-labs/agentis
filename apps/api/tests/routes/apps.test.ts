/**
 * /v1/apps package routes: `.agentisapp` preview + install.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { schema } from '@agentis/db/sqlite';
import type { AppManifestEnvelope } from '@agentis/core';
import { buildAppRoutes } from '../../src/routes/apps.js';
import { AppDatastore, AppPackager, AppStore, AppSurfaceStore } from '@agentis/app';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';
import { ConversationStore } from '../../src/services/conversationStore.js';
import { ConversationParticipantService } from '../../src/services/conversationParticipants.js';
import { AppContactService } from '../../src/services/appContacts.js';
import { AppLearningService } from '../../src/services/appLearning.js';
import { SharedIntelligenceService } from '../../src/services/sharedIntelligence.js';
import { EpisodicMemoryStore } from '../../src/services/episodicMemoryStore.js';
import { StubEmbeddingProvider } from '../_helpers/stubEmbeddingProvider.js';
import { ConversationSimulatorService } from '../../src/services/conversationSimulator.js';
import { AdapterManager } from '../../src/adapters/AdapterManager.js';
import type { AgentAdapter, ChatDelta } from '@agentis/core';

let ctx: TestContext;

beforeEach(async () => {
  ctx = await createTestContext();
});

afterEach(() => ctx.close());

function app() {
  return ctx.buildApp([{ path: '/v1/apps', app: buildAppRoutes({ db: ctx.db, auth: ctx.auth }) }]);
}

function seedApp(): string {
  const store = new AppStore(ctx.db);
  const appId = store.create(ctx.workspace.id, ctx.user.id, { name: 'Ops Desk' }).id;
  store.update(ctx.workspace.id, appId, { version: '1.4.0' });
  new AppDatastore(ctx.db).defineCollection(ctx.workspace.id, appId, {
    name: 'tickets',
    schema: { fields: [{ key: 'subject', type: 'string', required: true }] },
  });
  new AppSurfaceStore({ db: ctx.db }).render(ctx.workspace.id, appId, 'home', {
    type: 'Stack',
    children: [{ type: 'Heading', value: 'Tickets' }],
  });
  ctx.db
    .insert(schema.workflows)
    .values({
      id: randomUUID(),
      workspaceId: ctx.workspace.id,
      userId: ctx.user.id,
      appId,
      title: 'Route ticket',
      graph: { version: 1, nodes: [], edges: [] },
    })
    .run();
  return appId;
}

function appCount(): number {
  return ctx.db.select({ id: schema.apps.id }).from(schema.apps).all().length;
}

function seedAgentRow(): string {
  const id = randomUUID();
  ctx.db.insert(schema.agents).values({ id, workspaceId: ctx.workspace.id, userId: ctx.user.id, name: 'Resident', adapterType: 'http' }).run();
  return id;
}

describe('/v1/apps live conversations (Phase 1)', () => {
  function seedAgent(): string {
    const id = randomUUID();
    ctx.db.insert(schema.agents).values({
      id, workspaceId: ctx.workspace.id, userId: ctx.user.id, name: 'Resident', adapterType: 'http',
    }).run();
    return id;
  }

  it('lists an App\'s real conversations and a thread\'s messages, scoped to the App', async () => {
    const store = new AppStore(ctx.db);
    const appId = store.create(ctx.workspace.id, ctx.user.id, { name: 'Acme Sales' }).id;
    const otherAppId = store.create(ctx.workspace.id, ctx.user.id, { name: 'Other' }).id;
    const agentId = seedAgent();
    const conversations = new ConversationStore({ db: ctx.db, bus: ctx.bus });

    // A thread that belongs to the App + one belonging to another App.
    const now = new Date().toISOString();
    const convId = randomUUID();
    ctx.db.insert(schema.conversations).values({
      id: convId, workspaceId: ctx.workspace.id, userId: ctx.user.id, agentId, appId,
      channelChatId: '42', title: 'Maria', lastMessageAt: now, createdAt: now, updatedAt: now,
    }).run();
    ctx.db.insert(schema.conversations).values({
      id: randomUUID(), workspaceId: ctx.workspace.id, userId: ctx.user.id, agentId, appId: otherAppId,
      channelChatId: '99', title: 'Elsewhere', createdAt: now, updatedAt: now,
    }).run();

    conversations.appendMirrored({
      workspaceId: ctx.workspace.id, conversationId: convId, sessionMessageId: 'in-1',
      authorType: 'system', body: 'is it available?', metadata: { channelInbound: true },
    });
    conversations.appendMirrored({
      workspaceId: ctx.workspace.id, conversationId: convId, sessionMessageId: 'out-1',
      authorType: 'agent', body: 'yes — want me to reserve it?',
    });

    const listRes = await app().request(`/v1/apps/${appId}/conversations`, { headers: ctx.authHeaders });
    expect(listRes.status).toBe(200);
    const list = (await listRes.json()) as { data: Array<{ id: string; title: string }> };
    expect(list.data).toHaveLength(1);
    expect(list.data[0]).toMatchObject({ id: convId, title: 'Maria' });

    const msgRes = await app().request(`/v1/apps/${appId}/conversations/${convId}/messages`, { headers: ctx.authHeaders });
    expect(msgRes.status).toBe(200);
    const msgs = (await msgRes.json()) as { data: Array<{ role: string; content: string }> };
    expect(msgs.data.map((m) => m.role)).toEqual(['user', 'agent']);
    expect(msgs.data[0]?.content).toBe('is it available?');
  });

  it('operator takeover parks/unparks the resident agent; send delivers + records the reply', async () => {
    const store = new AppStore(ctx.db);
    const appId = store.create(ctx.workspace.id, ctx.user.id, { name: 'Acme Sales' }).id;
    const agentId = seedAgent();
    const conversations = new ConversationStore({ db: ctx.db, bus: ctx.bus });
    const now = new Date().toISOString();

    // A live channel connection + a thread bound to it + the App.
    const connId = randomUUID();
    ctx.db.insert(schema.channelConnections).values({
      id: connId, workspaceId: ctx.workspace.id, userId: ctx.user.id, agentId, appId, kind: 'telegram', name: 'line', tokenEncrypted: 'x',
    }).run();
    const convId = randomUUID();
    ctx.db.insert(schema.conversations).values({
      id: convId, workspaceId: ctx.workspace.id, userId: ctx.user.id, agentId, appId,
      channelConnectionId: connId, channelChatId: '42', title: 'Maria', createdAt: now, updatedAt: now,
    }).run();

    const delivered: Array<{ connectionId: string; chatId: string; body: string }> = [];
    const routed = ctx.buildApp([{ path: '/v1/apps', app: buildAppRoutes({
      db: ctx.db, auth: ctx.auth, conversations,
      channels: { deliverToConnection: async (a) => { delivered.push(a); } },
    }) }]);

    // Take over.
    const takeRes = await routed.request(`/v1/apps/${appId}/conversations/${convId}/takeover`, {
      method: 'POST', headers: ctx.authHeaders, body: JSON.stringify({ active: true }),
    });
    expect(takeRes.status).toBe(200);
    expect((await takeRes.json() as { data: { handoffState: string | null } }).data.handoffState).toBe('human');
    expect(ctx.db.select({ h: schema.conversations.handoffState }).from(schema.conversations).where(eq(schema.conversations.id, convId)).get()?.h).toBe('human');

    // Operator sends — delivered to the channel + recorded as an operator message.
    const sendRes = await routed.request(`/v1/apps/${appId}/conversations/${convId}/send`, {
      method: 'POST', headers: ctx.authHeaders, body: JSON.stringify({ body: 'Hi Maria, this is a human — happy to help!' }),
    });
    expect(sendRes.status).toBe(200);
    expect((await sendRes.json() as { data: { delivered: boolean } }).data.delivered).toBe(true);
    expect(delivered).toEqual([{ connectionId: connId, chatId: '42', body: 'Hi Maria, this is a human — happy to help!' }]);
    const opMsg = conversations.messages(convId, 50).find((m) => m.authorType === 'operator');
    expect(opMsg?.body).toMatch(/happy to help/);

    // Hand back.
    const backRes = await routed.request(`/v1/apps/${appId}/conversations/${convId}/takeover`, {
      method: 'POST', headers: ctx.authHeaders, body: JSON.stringify({ active: false }),
    });
    expect((await backRes.json() as { data: { handoffState: string | null } }).data.handoffState).toBeNull();
  });

  it('flags a thread as needing the operator and surfaces it in the conversations list (Phase 2)', async () => {
    const store = new AppStore(ctx.db);
    const appId = store.create(ctx.workspace.id, ctx.user.id, { name: 'Acme Sales' }).id;
    const agentId = seedAgent();
    const now = new Date().toISOString();
    const convId = randomUUID();
    ctx.db.insert(schema.conversations).values({
      id: convId, workspaceId: ctx.workspace.id, userId: ctx.user.id, agentId, appId,
      channelChatId: '42', title: 'Ana', lastMessageAt: now, createdAt: now, updatedAt: now,
    }).run();

    // Set the flag with a reason.
    const flagRes = await app().request(`/v1/apps/${appId}/conversations/${convId}/needs-attention`, {
      method: 'POST', headers: ctx.authHeaders, body: JSON.stringify({ active: true, reason: 'wants a discount I can\'t approve' }),
    });
    expect(flagRes.status).toBe(200);
    expect((await flagRes.json() as { data: { needsAttention: boolean } }).data.needsAttention).toBe(true);

    // It shows in the list.
    const listRes = await app().request(`/v1/apps/${appId}/conversations`, { headers: ctx.authHeaders });
    const flagged = (await listRes.json() as { data: Array<{ id: string; needsAttention: boolean; needsAttentionReason: string | null }> }).data.find((x) => x.id === convId);
    expect(flagged?.needsAttention).toBe(true);
    expect(flagged?.needsAttentionReason).toBe('wants a discount I can\'t approve');

    // Operator clears it (steps in).
    const clearRes = await app().request(`/v1/apps/${appId}/conversations/${convId}/needs-attention`, {
      method: 'POST', headers: ctx.authHeaders, body: JSON.stringify({ active: false }),
    });
    expect(clearRes.status).toBe(200);
    const after = ctx.db.select({ n: schema.conversations.needsAttention, r: schema.conversations.needsAttentionReason })
      .from(schema.conversations).where(eq(schema.conversations.id, convId)).get();
    expect(after?.n).toBe(0);
    expect(after?.r).toBeNull();
  });

  it('lists/adds/removes conversation participants (multi-party · G1)', async () => {
    const store = new AppStore(ctx.db);
    const appId = store.create(ctx.workspace.id, ctx.user.id, { name: 'Acme Sales' }).id;
    const primaryAgent = seedAgent();
    const specialistAgent = seedAgent();
    const participants = new ConversationParticipantService(ctx.db);
    const now = new Date().toISOString();
    const convId = randomUUID();
    ctx.db.insert(schema.conversations).values({
      id: convId, workspaceId: ctx.workspace.id, userId: ctx.user.id, agentId: primaryAgent, appId,
      channelChatId: '42', title: 'Maria', createdAt: now, updatedAt: now,
    }).run();

    const routed = ctx.buildApp([{ path: '/v1/apps', app: buildAppRoutes({ db: ctx.db, auth: ctx.auth, participants }) }]);

    // GET seeds + returns the primary.
    const listRes = await routed.request(`/v1/apps/${appId}/conversations/${convId}/participants`, { headers: ctx.authHeaders });
    expect(listRes.status).toBe(200);
    const seeded = (await listRes.json() as { data: Array<{ role: string; participantId: string | null }> }).data;
    expect(seeded).toHaveLength(1);
    expect(seeded[0]?.role).toBe('primary');
    expect(seeded[0]?.participantId).toBe(primaryAgent);

    // POST adds a specialist.
    const addRes = await routed.request(`/v1/apps/${appId}/conversations/${convId}/participants`, {
      method: 'POST', headers: ctx.authHeaders,
      body: JSON.stringify({ participantType: 'agent', participantId: specialistAgent, role: 'specialist' }),
    });
    expect(addRes.status).toBe(200);
    const added = await addRes.json() as { data: { id: string; participants: Array<{ role: string }> } };
    expect(added.data.participants.map((p) => p.role).sort()).toEqual(['primary', 'specialist']);

    // DELETE deactivates the specialist (hands back to the primary).
    const delRes = await routed.request(`/v1/apps/${appId}/conversations/${convId}/participants/${added.data.id}`, {
      method: 'DELETE', headers: ctx.authHeaders,
    });
    expect(delRes.status).toBe(200);
    expect(participants.list(convId, { activeOnly: true }).map((p) => p.role)).toEqual(['primary']);
  });

  it('refuses to read a conversation that belongs to a different App', async () => {
    const store = new AppStore(ctx.db);
    const appId = store.create(ctx.workspace.id, ctx.user.id, { name: 'A' }).id;
    const otherAppId = store.create(ctx.workspace.id, ctx.user.id, { name: 'B' }).id;
    const agentId = seedAgent();
    const now = new Date().toISOString();
    const convId = randomUUID();
    ctx.db.insert(schema.conversations).values({
      id: convId, workspaceId: ctx.workspace.id, userId: ctx.user.id, agentId, appId: otherAppId,
      channelChatId: '7', createdAt: now, updatedAt: now,
    }).run();

    const res = await app().request(`/v1/apps/${appId}/conversations/${convId}/messages`, { headers: ctx.authHeaders });
    expect(res.status).toBe(404);
  });
});

describe('/v1/apps learning loop (Phase M2)', () => {
  it('records an outcome → deposits a graded lesson → surfaces it via /learnings', async () => {
    const store = new AppStore(ctx.db);
    const agentId = seedAgentRow();
    const appId = store.create(ctx.workspace.id, ctx.user.id, { name: 'Acme Sales', ownerAgentId: agentId }).id;
    const contacts = new AppContactService(ctx.db);
    const contactId = contacts.touch({ workspaceId: ctx.workspace.id, appId, channelKind: 'whatsapp', handle: '42', displayName: 'Maria' });
    contacts.update(ctx.workspace.id, contactId, { stage: 'won', goal: 'reserve the unit' });

    const episodes = new EpisodicMemoryStore(ctx.db, ctx.logger, new StubEmbeddingProvider());
    const shared = new SharedIntelligenceService(ctx.db, ctx.bus, episodes, ctx.logger);
    const learning = new AppLearningService({ db: ctx.db, shared, logger: ctx.logger });
    const routed = ctx.buildApp([{ path: '/v1/apps', app: buildAppRoutes({ db: ctx.db, auth: ctx.auth, contacts, learning }) }]);

    const outcomeRes = await routed.request(`/v1/apps/${appId}/contacts/${contactId}/outcome`, {
      method: 'POST', headers: ctx.authHeaders, body: JSON.stringify({ outcome: 'won', note: 'A same-day call closed it.' }),
    });
    expect(outcomeRes.status).toBe(200);
    const outcomeBody = (await outcomeRes.json()) as { data: { recorded: boolean; lessonDeposited: boolean } };
    expect(outcomeBody.data.recorded).toBe(true);
    expect(outcomeBody.data.lessonDeposited).toBe(true);

    const learnRes = await routed.request(`/v1/apps/${appId}/learnings`, { headers: ctx.authHeaders });
    expect(learnRes.status).toBe(200);
    const learnBody = (await learnRes.json()) as { data: { ownerAgentId: string | null; lessons: unknown[] } };
    expect(learnBody.data.ownerAgentId).toBe(agentId);
    expect(learnBody.data.lessons.length).toBeGreaterThanOrEqual(1);

    // The contact is stamped with the terminal outcome.
    expect(contacts.get(ctx.workspace.id, contactId)?.outcome).toBe('won');
  });

  it('rejects an invalid outcome value', async () => {
    const store = new AppStore(ctx.db);
    const agentId = seedAgentRow();
    const appId = store.create(ctx.workspace.id, ctx.user.id, { name: 'Acme', ownerAgentId: agentId }).id;
    const contacts = new AppContactService(ctx.db);
    const contactId = contacts.touch({ workspaceId: ctx.workspace.id, appId, channelKind: 'whatsapp', handle: '7' });
    const episodes = new EpisodicMemoryStore(ctx.db, ctx.logger, new StubEmbeddingProvider());
    const shared = new SharedIntelligenceService(ctx.db, ctx.bus, episodes, ctx.logger);
    const learning = new AppLearningService({ db: ctx.db, shared, logger: ctx.logger });
    const routed = ctx.buildApp([{ path: '/v1/apps', app: buildAppRoutes({ db: ctx.db, auth: ctx.auth, contacts, learning }) }]);

    const res = await routed.request(`/v1/apps/${appId}/contacts/${contactId}/outcome`, {
      method: 'POST', headers: ctx.authHeaders, body: JSON.stringify({ outcome: 'maybe' }),
    });
    expect(res.status).toBe(422);
  });
});

describe('/v1/apps conversation simulator (G8)', () => {
  function chatStub(): AgentAdapter {
    return { capabilities: () => ({ interactiveChat: true }), async *chat(): AsyncIterable<ChatDelta> { yield { type: 'done', finishReason: 'stop' }; } } as unknown as AgentAdapter;
  }

  it('runs a scripted scenario against the resident agent and returns a scored transcript', async () => {
    const store = new AppStore(ctx.db);
    const agentId = seedAgentRow();
    const appId = store.create(ctx.workspace.id, ctx.user.id, { name: 'Acme Sales', ownerAgentId: agentId }).id;
    let turn = 0;
    const simulator = new ConversationSimulatorService({
      db: ctx.db,
      adapters: new AdapterManager(ctx.logger),
      logger: ctx.logger,
      fallbackAdapter: () => chatStub(),
      runTurn: (async function* () {
        const reply = turn === 0 ? 'Sure! I can offer you a discount of 10% off.' : 'See you Saturday.';
        turn += 1;
        yield { type: 'text', delta: reply } as ChatDelta;
        yield { type: 'done', finishReason: 'stop' } as ChatDelta;
      }) as unknown as typeof import('../../src/services/chatSessionExecutor.js').ChatSessionExecutor.turn,
    });
    const routed = ctx.buildApp([{ path: '/v1/apps', app: buildAppRoutes({ db: ctx.db, auth: ctx.auth, simulator }) }]);

    const res = await routed.request(`/v1/apps/${appId}/simulate`, {
      method: 'POST', headers: ctx.authHeaders,
      body: JSON.stringify({
        scenario: {
          name: 'Discount pressure',
          persona: { name: 'Maria', prompt: 'pushes for a discount' },
          goal: 'Book a viewing',
          customerTurns: ['Can I get a discount?', 'Ok, can I see it Saturday?'],
          guardrails: [{ id: 'no_discounts', label: 'never promise a discount', pattern: 'discount of' }],
          expectations: [{ id: 'ask_budget', label: 'ask for budget', pattern: 'budget' }],
        },
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { agentId: string; transcript: unknown[]; score: { guardrailViolations: unknown[]; missedExpectations: unknown[]; score: number } } };
    expect(body.data.agentId).toBe(agentId);
    expect(body.data.transcript).toHaveLength(2);
    expect(body.data.score.guardrailViolations).toHaveLength(1);
    expect(body.data.score.missedExpectations.length).toBeGreaterThanOrEqual(1);
    expect(body.data.score.score).toBeLessThan(1);
  });

  it('rejects an invalid scenario', async () => {
    const appId = new AppStore(ctx.db).create(ctx.workspace.id, ctx.user.id, { name: 'X' }).id;
    const simulator = new ConversationSimulatorService({ db: ctx.db, adapters: new AdapterManager(ctx.logger), logger: ctx.logger, fallbackAdapter: () => chatStub() });
    const routed = ctx.buildApp([{ path: '/v1/apps', app: buildAppRoutes({ db: ctx.db, auth: ctx.auth, simulator }) }]);
    const res = await routed.request(`/v1/apps/${appId}/simulate`, { method: 'POST', headers: ctx.authHeaders, body: JSON.stringify({ scenario: { name: '' } }) });
    expect(res.status).toBe(422);
  });
});

describe('/v1/apps package install', () => {
  it('creates an App and its entry workflow in one transaction', async () => {
    const response = await app().request('/v1/apps', {
      method: 'POST',
      headers: ctx.authHeaders,
      body: JSON.stringify({ name: 'Store outreach', createEntryWorkflow: true }),
    });

    expect(response.status).toBe(201);
    const body = (await response.json()) as { data: { id: string; name: string } };
    expect(body.data.name).toBe('Store outreach');
    const workflows = ctx.db
      .select({ title: schema.workflows.title, appId: schema.workflows.appId })
      .from(schema.workflows)
      .where(eq(schema.workflows.appId, body.data.id))
      .all();
    expect(workflows).toEqual([{ title: 'Store outreach workflow', appId: body.data.id }]);
  });

  it('instantiates the entry workflow from a starter template graph', async () => {
    const graph = {
      version: 1,
      viewport: { x: 0, y: 0, zoom: 1 },
      nodes: [
        { id: 'trigger', type: 'trigger', title: 'Webhook', position: { x: 0, y: 0 }, config: { kind: 'trigger', triggerType: 'webhook' } },
        { id: 'output', type: 'return_output', title: 'Result', position: { x: 280, y: 0 }, config: { kind: 'return_output', renderAs: 'json' } },
      ],
      edges: [{ id: 'e1', source: 'trigger', target: 'output' }],
    };
    const response = await app().request('/v1/apps', {
      method: 'POST',
      headers: ctx.authHeaders,
      body: JSON.stringify({ name: 'Templated', createEntryWorkflow: true, entryWorkflowGraph: graph }),
    });
    expect(response.status).toBe(201);
    const body = (await response.json()) as { data: { id: string } };
    const wf = ctx.db.select({ graph: schema.workflows.graph }).from(schema.workflows).where(eq(schema.workflows.appId, body.data.id)).get();
    expect((wf?.graph as { nodes: unknown[] }).nodes).toHaveLength(2);
  });

  it('promotes a bare workflow to one stable App-of-one', async () => {
    const workflowId = randomUUID();
    ctx.db.insert(schema.workflows).values({
      id: workflowId,
      workspaceId: ctx.workspace.id,
      userId: ctx.user.id,
      title: 'Legacy outreach',
      graph: { version: 1, nodes: [], edges: [] },
    }).run();

    const promoted = await app().request(`/v1/apps/from-workflow/${workflowId}`, {
      method: 'POST',
      headers: ctx.authHeaders,
    });
    expect(promoted.status).toBe(201);
    const first = (await promoted.json()) as { data: { id: string; name: string } };
    expect(first.data.name).toBe('Legacy outreach');

    const repeated = await app().request(`/v1/apps/from-workflow/${workflowId}`, {
      method: 'POST',
      headers: ctx.authHeaders,
    });
    expect(repeated.status).toBe(200);
    const second = (await repeated.json()) as { data: { id: string } };
    expect(second.data.id).toBe(first.data.id);
    expect(ctx.db.select({ appId: schema.workflows.appId }).from(schema.workflows).where(eq(schema.workflows.id, workflowId)).get()?.appId).toBe(first.data.id);
  });

  it('previews without mutating, then installs a fresh app', async () => {
    const sourceId = seedApp();
    const before = appCount();

    const exported = await app().request(`/v1/apps/${sourceId}/export`, { headers: ctx.authHeaders });
    expect(exported.status).toBe(200);
    const { data: envelope } = (await exported.json()) as { data: unknown };

    const preview = await app().request('/v1/apps/import/preview', {
      method: 'POST',
      headers: ctx.authHeaders,
      body: JSON.stringify(envelope),
    });
    expect(preview.status).toBe(200);
    const previewBody = (await preview.json()) as {
      data: {
        identity: { name: string; version: string };
        counts: { workflows: number; surfaces: number; collections: number };
        permissions: string[];
      };
    };
    expect(previewBody.data.identity).toMatchObject({ name: 'Ops Desk', version: '1.4.0' });
    expect(previewBody.data.counts).toMatchObject({ workflows: 1, surfaces: 1, collections: 1 });
    expect(previewBody.data.permissions).toContain('data:tickets');
    expect(appCount()).toBe(before);

    const installed = await app().request('/v1/apps/import', {
      method: 'POST',
      headers: ctx.authHeaders,
      body: JSON.stringify({ envelope, permissionsAcknowledged: previewBody.data.permissions }),
    });
    expect(installed.status).toBe(201);
    const installedBody = (await installed.json()) as { data: { appId: string } };
    expect(installedBody.data.appId).not.toBe(sourceId);
    expect(appCount()).toBe(before + 1);
    expect(new AppSurfaceStore({ db: ctx.db }).list(ctx.workspace.id, installedBody.data.appId).map((s) => s.name)).toEqual(['home']);
    expect(ctx.db.select().from(schema.workflows).where(eq(schema.workflows.appId, installedBody.data.appId)).all()).toHaveLength(1);
  });

  it('requires permission acknowledgement before installing', async () => {
    const sourceId = seedApp();
    const before = appCount();
    const exported = await app().request(`/v1/apps/${sourceId}/export`, { headers: ctx.authHeaders });
    const { data: envelope } = (await exported.json()) as { data: unknown };

    const installed = await app().request('/v1/apps/import', {
      method: 'POST',
      headers: ctx.authHeaders,
      body: JSON.stringify({ envelope, permissionsAcknowledged: [] }),
    });
    expect(installed.status).toBe(403);
    const body = (await installed.json()) as { error: { code: string } };
    expect(body.error.code).toBe('APP_PERMISSIONS_NOT_ACKNOWLEDGED');
    expect(appCount()).toBe(before);
  });

  it('runs an App package test in an isolated transaction', async () => {
    const sourceId = seedApp();
    const before = appCount();
    const manifest = new AppPackager(ctx.db).toManifest(ctx.workspace.id, sourceId);
    manifest.surfaces[0]!.actions = [{ name: 'createTicket', kind: 'data', target: 'tickets.insert' }];
    const envelope = new AppPackager(ctx.db).serialize(manifest);

    const response = await app().request('/v1/apps/test', {
      method: 'POST',
      headers: ctx.authHeaders,
      body: JSON.stringify({
        envelope,
        actions: [{ surface: 'home', name: 'createTicket', args: { record: { subject: 'Harness ticket' } } }],
        assertions: [{ collection: 'tickets', count: 1, includes: { subject: 'Harness ticket' } }],
      }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { data: { assertions: Array<{ collection: string; count: number }> } };
    expect(body.data.assertions).toEqual([{ collection: 'tickets', count: 1 }]);
    expect(appCount()).toBe(before);
  });

  it('snapshots and promotes named App environments through the self-host API', async () => {
    const appId = seedApp();

    const snapshot = await app().request(`/v1/apps/${appId}/environments/development/snapshot`, {
      method: 'POST',
      headers: ctx.authHeaders,
      body: JSON.stringify({ kind: 'dev' }),
    });
    expect(snapshot.status).toBe(200);

    const promotion = await app().request(`/v1/apps/${appId}/environments/development/promote`, {
      method: 'POST',
      headers: ctx.authHeaders,
      body: JSON.stringify({ targetName: 'staging', targetKind: 'staging', applyToRuntime: false }),
    });
    expect(promotion.status).toBe(200);

    const listed = await app().request(`/v1/apps/${appId}/environments`, { headers: ctx.authHeaders });
    expect(listed.status).toBe(200);
    const body = (await listed.json()) as { data: Array<{ name: string; kind: string; sourceEnvironmentId: string | null }> };
    expect(body.data).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'development', kind: 'dev' }),
      expect.objectContaining({ name: 'staging', kind: 'staging', sourceEnvironmentId: expect.any(String) }),
    ]));
  });

  it('blocks app packages with scanner-blocked secrets', async () => {
    const sourceId = seedApp();
    const before = appCount();
    const exported = await app().request(`/v1/apps/${sourceId}/export`, { headers: ctx.authHeaders });
    const { data: envelope } = (await exported.json()) as { data: AppManifestEnvelope };
    const nextEnvelope = new AppPackager(ctx.db).serialize({
      ...envelope.manifest,
      workflows: [
        {
          title: 'Route ticket',
          description: 'debug sk-proj-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          graph: { version: 1, nodes: [], edges: [] },
        },
      ],
    });

    const preview = await app().request('/v1/apps/import/preview', {
      method: 'POST',
      headers: ctx.authHeaders,
      body: JSON.stringify(nextEnvelope),
    });
    expect(preview.status).toBe(422);
    const body = (await preview.json()) as { error: { code: string } };
    expect(body.error.code).toBe('APP_PACKAGE_SCAN_BLOCKED');
    expect(appCount()).toBe(before);
  });

  it('does not let a surface action run a workflow owned by another app', async () => {
    const store = new AppStore(ctx.db);
    const appA = store.create(ctx.workspace.id, ctx.user.id, { name: 'Front Desk' }).id;
    const appB = store.create(ctx.workspace.id, ctx.user.id, { name: 'Private Ops' }).id;
    const workflowId = randomUUID();
    ctx.db
      .insert(schema.workflows)
      .values({
        id: workflowId,
        workspaceId: ctx.workspace.id,
        userId: ctx.user.id,
        appId: appB,
        title: 'Private workflow',
        graph: { version: 1, nodes: [], edges: [] },
      })
      .run();
    new AppSurfaceStore({ db: ctx.db }).upsert(ctx.workspace.id, appA, {
      name: 'home',
      view: { type: 'Stack', children: [{ type: 'Button', label: 'Run', action: { action: 'runPrivate' } }] },
      actions: [{ name: 'runPrivate', kind: 'workflow', target: workflowId }],
    });

    const response = await app().request(`/v1/apps/${appA}/surfaces/home/actions/runPrivate`, {
      method: 'POST',
      headers: ctx.authHeaders,
      body: JSON.stringify({ args: {} }),
    });
    expect(response.status).toBe(404);
  });

  it('deletes an existing surface and rejects a missing surface', async () => {
    const appId = seedApp();
    const first = await app().request(`/v1/apps/${appId}/surfaces/home`, {
      method: 'DELETE',
      headers: ctx.authHeaders,
    });
    expect(first.status).toBe(200);
    expect(new AppSurfaceStore({ db: ctx.db }).list(ctx.workspace.id, appId)).toEqual([]);

    const missing = await app().request(`/v1/apps/${appId}/surfaces/home`, {
      method: 'DELETE',
      headers: ctx.authHeaders,
    });
    expect(missing.status).toBe(404);
  });

  it('public share query reads bound collections but rejects sibling ones', async () => {
    const store = new AppStore(ctx.db);
    const appId = store.create(ctx.workspace.id, ctx.user.id, { name: 'Public Desk' }).id;
    const ds = new AppDatastore(ctx.db);
    ds.defineCollection(ctx.workspace.id, appId, { name: 'tickets', schema: { fields: [{ key: 'subject', type: 'string', required: true }] } });
    ds.defineCollection(ctx.workspace.id, appId, { name: 'secrets', schema: { fields: [{ key: 'value', type: 'string', required: true }] } });
    ds.insert(ctx.workspace.id, appId, 'secrets', { value: 'api-key-do-not-leak' });
    // The shared surface binds ONLY `tickets` — `secrets` is a sibling it never displays.
    new AppSurfaceStore({ db: ctx.db }).upsert(ctx.workspace.id, appId, {
      name: 'home',
      view: { type: 'Stack', children: [{ type: 'Table', bind: { collection: 'tickets' }, columns: [{ key: 'subject' }] }] },
      actions: [],
    });

    const a = app();
    // Operator shares the surface → gets a public token.
    const shared = await a.request(`/v1/apps/${appId}/surfaces/home/share`, {
      method: 'POST',
      headers: ctx.authHeaders,
    });
    expect(shared.status).toBe(200);
    const { data: { token } } = (await shared.json()) as { data: { token: string } };
    const path = `/v1/apps/public/surfaces/${encodeURIComponent(token)}/query`;

    // The bound collection is readable by the anonymous share link.
    const ok = await a.request(path, { method: 'POST', body: JSON.stringify({ collection: 'tickets' }) });
    expect(ok.status).toBe(200);

    // The sibling collection must be refused — no anonymous enumeration.
    const leak = await a.request(path, { method: 'POST', body: JSON.stringify({ collection: 'secrets' }) });
    expect(leak.status).toBe(404);
    const leakBody = (await leak.json()) as { error: { code: string } };
    expect(leakBody.error.code).toBe('RESOURCE_NOT_FOUND');
  });

  it('gates an imported bundle that executes code behind explicit acknowledgement', async () => {
    const store = new AppStore(ctx.db);
    const appId = store.create(ctx.workspace.id, ctx.user.id, { name: 'Coder' }).id;
    store.update(ctx.workspace.id, appId, { version: '1.0.0' });
    ctx.db.insert(schema.workflows).values({
      id: randomUUID(),
      workspaceId: ctx.workspace.id,
      userId: ctx.user.id,
      appId,
      title: 'Runs code',
      graph: {
        version: 1,
        nodes: [{ id: 'C', type: 'code', title: 'c', position: { x: 0, y: 0 }, config: { kind: 'code', language: 'python', code: 'print(1)', inputKeys: [] } }],
        edges: [],
      },
    }).run();

    const exported = await app().request(`/v1/apps/${appId}/export`, { headers: ctx.authHeaders });
    const { data: envelope } = (await exported.json()) as { data: unknown };
    const preview = await app().request('/v1/apps/import/preview', { method: 'POST', headers: ctx.authHeaders, body: JSON.stringify(envelope) });
    const previewBody = (await preview.json()) as { data: { permissions: string[] } };
    // The python code node is surfaced as a permission the installer must ack.
    expect(previewBody.data.permissions).toContain('executes-code:python');

    // Acknowledging everything EXCEPT the code permission is rejected.
    const partial = previewBody.data.permissions.filter((p) => p !== 'executes-code:python');
    const denied = await app().request('/v1/apps/import', { method: 'POST', headers: ctx.authHeaders, body: JSON.stringify({ envelope, permissionsAcknowledged: partial }) });
    expect(denied.status).toBe(403);

    // Full acknowledgement installs.
    const ok = await app().request('/v1/apps/import', { method: 'POST', headers: ctx.authHeaders, body: JSON.stringify({ envelope, permissionsAcknowledged: previewBody.data.permissions }) });
    expect(ok.status).toBe(201);
  });

  it('rejects tampered previews before creating an app', async () => {
    const sourceId = seedApp();
    const before = appCount();
    const exported = await app().request(`/v1/apps/${sourceId}/export`, { headers: ctx.authHeaders });
    const { data: envelope } = (await exported.json()) as { data: { manifest: { identity: { name: string } } } };
    envelope.manifest.identity.name = 'Tampered';

    const preview = await app().request('/v1/apps/import/preview', {
      method: 'POST',
      headers: ctx.authHeaders,
      body: JSON.stringify(envelope),
    });
    expect(preview.status).toBe(422);
    expect(appCount()).toBe(before);
  });

  it('previews and blocks a data-losing upgrade without a migration', async () => {
    const sourceId = seedApp();
    const exported = await app().request(`/v1/apps/${sourceId}/export`, { headers: ctx.authHeaders });
    const { data: envelope } = (await exported.json()) as {
      data: {
        manifest: {
          identity: { version: string };
          collections: Array<{ name: string; schema: { fields: Array<{ key: string; type: string; required: boolean; indexed?: boolean }> }; seed: unknown[] }>;
        };
      };
    };
    envelope.manifest.identity.version = '2.0.0';
    envelope.manifest.collections = [{ name: 'tickets', schema: { fields: [{ key: 'summary', type: 'string', required: true, indexed: false }] }, seed: [] }];
    const nextEnvelope = new AppPackager(ctx.db).serialize(envelope.manifest as Parameters<AppPackager['serialize']>[0]);

    const preview = await app().request(`/v1/apps/${sourceId}/upgrade/preview`, {
      method: 'POST',
      headers: ctx.authHeaders,
      body: JSON.stringify(nextEnvelope),
    });
    expect(preview.status).toBe(200);
    const previewBody = (await preview.json()) as { data: { safe: boolean; blockers: Array<{ code: string }> } };
    expect(previewBody.data.safe).toBe(false);
    expect(previewBody.data.blockers.map((blocker) => blocker.code)).toContain('field_removed');

    const upgrade = await app().request(`/v1/apps/${sourceId}/upgrade`, {
      method: 'POST',
      headers: ctx.authHeaders,
      body: JSON.stringify(nextEnvelope),
    });
    expect(upgrade.status).toBe(422);
  });
});
