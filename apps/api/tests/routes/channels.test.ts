/**
 * /v1/channels — route unit tests (Batch 4 / D35).
 *
 * Stubs the Telegram channel adapter to avoid network calls. Asserts the
 * outbound surface (CRUD + test + webhook-info) and the unauth ingress on
 * /v1/webhooks/channel/:id (mounted via buildWebhookRoutes).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { schema } from '@agentis/db/sqlite';
import { eq } from 'drizzle-orm';
import { ConversationStore } from '../../src/services/conversationStore.js';
import { ChannelBridge } from '../../src/services/channelBridge.js';
import { buildChannelRoutes } from '../../src/routes/channels.js';
import { buildWebhookRoutes } from '../../src/routes/webhooks.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';
import type { ChannelAdapter, ParsedInboundMessage } from '../../src/adapters/channels/types.js';
import type { TriggerRuntime } from '../../src/engine/TriggerRuntime.js';

class StubAdapter implements ChannelAdapter {
  readonly kind = 'telegram' as const;
  readonly sent: Array<{ chatId: string; body: string }> = [];
  acceptVerify = true;
  parseResult: ParsedInboundMessage | null = {
    externalId: 'telegram:101',
    chatId: '777',
    body: 'inbound text',
  };
  async send(args: { chatId: string; body: string }): Promise<void> {
    this.sent.push({ chatId: args.chatId, body: args.body });
  }
  verify(): boolean {
    return this.acceptVerify;
  }
  parseInbound(): ParsedInboundMessage | null {
    return this.parseResult;
  }
}

let ctx: TestContext;
let bridge: ChannelBridge;
let adapter: StubAdapter;

function seedAgent() {
  const id = randomUUID();
  ctx.db
    .insert(schema.agents)
    .values({
      id,
      workspaceId: ctx.workspace.id,
      ambientId: ctx.ambient.id,
      userId: ctx.user.id,
      name: 'Hermes',
      adapterType: 'http',
    })
    .run();
  return id;
}

function app() {
  return ctx.buildApp([
    { path: '/v1/channels', app: buildChannelRoutes({ db: ctx.db, auth: ctx.auth, bridge }) },
    {
      path: '/v1/webhooks',
      app: buildWebhookRoutes({
        runtime: {} as unknown as TriggerRuntime,
        bridge,
      }),
    },
  ]);
}

beforeEach(async () => {
  ctx = await createTestContext();
  adapter = new StubAdapter();
  const conversations = new ConversationStore({ db: ctx.db, bus: ctx.bus });
  bridge = new ChannelBridge({
    db: ctx.db,
    vault: ctx.vault,
    conversations,
    bus: ctx.bus,
    logger: ctx.logger,
    adapters: { telegram: adapter },
  });
});

afterEach(() => ctx.close());

describe('POST /v1/channels', () => {
  it('creates a connection, returns webhookSecret + URL once, never returns the token', async () => {
    const agentId = seedAgent();
    const res = await app().request('/v1/channels', {
      method: 'POST',
      headers: ctx.authHeaders,
      body: JSON.stringify({
        kind: 'telegram',
        name: 'Tg main',
        agentId,
        token: 'super-secret-bot-token',
        defaultChatId: '999',
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.webhookSecret).toMatch(/^[0-9a-f]{48}$/);
    expect(body.webhookUrl).toMatch(/^\/v1\/webhooks\/channel\//);
    expect(JSON.stringify(body)).not.toContain('super-secret-bot-token');
  });

  it('rejects without auth (401)', async () => {
    const res = await app().request('/v1/channels', {
      method: 'POST',
      body: JSON.stringify({ kind: 'telegram', name: 'x', agentId: 'x', token: 'x' }),
    });
    expect(res.status).toBe(401);
  });

  it('returns 422 on validation failure (missing fields)', async () => {
    const res = await app().request('/v1/channels', {
      method: 'POST',
      headers: ctx.authHeaders,
      body: JSON.stringify({ kind: 'telegram', name: 'x' }),
    });
    expect(res.status).toBe(422);
  });

  it('returns 4xx for unknown kind', async () => {
    const agentId = seedAgent();
    const res = await app().request('/v1/channels', {
      method: 'POST',
      headers: ctx.authHeaders,
      body: JSON.stringify({ kind: 'whatsapp', name: 'x', agentId, token: 'aaaaaaaa' }),
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });
});

describe('GET /v1/channels', () => {
  it('lists connections without exposing tokens', async () => {
    const agentId = seedAgent();
    bridge.create({
      workspaceId: ctx.workspace.id,
      ambientId: null,
      userId: ctx.user.id,
      agentId,
      kind: 'telegram',
      name: 'tg',
      token: 'tok',
    });
    const res = await app().request('/v1/channels', { headers: ctx.authHeaders });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { connections: Array<Record<string, unknown>> };
    expect(body.connections).toHaveLength(1);
    expect(JSON.stringify(body)).not.toContain('"tok"');
  });
});

describe('POST /v1/channels/:id/test', () => {
  it('sends a test message via the adapter', async () => {
    const agentId = seedAgent();
    const { connection } = bridge.create({
      workspaceId: ctx.workspace.id,
      ambientId: null,
      userId: ctx.user.id,
      agentId,
      kind: 'telegram',
      name: 'tg',
      token: 'tok',
      defaultChatId: '999',
    });
    const res = await app().request(`/v1/channels/${connection.id}/test`, {
      method: 'POST',
      headers: ctx.authHeaders,
      body: JSON.stringify({ body: 'ping' }),
    });
    expect(res.status).toBe(200);
    expect(adapter.sent).toEqual([{ chatId: '999', body: 'ping' }]);
  });

  it('returns 422 when no chatId is available', async () => {
    const agentId = seedAgent();
    const { connection } = bridge.create({
      workspaceId: ctx.workspace.id,
      ambientId: null,
      userId: ctx.user.id,
      agentId,
      kind: 'telegram',
      name: 'tg',
      token: 'tok',
    });
    const res = await app().request(`/v1/channels/${connection.id}/test`, {
      method: 'POST',
      headers: ctx.authHeaders,
      body: '{}',
    });
    expect(res.status).toBe(422);
  });
});

describe('DELETE /v1/channels/:id', () => {
  it('removes the connection', async () => {
    const agentId = seedAgent();
    const { connection } = bridge.create({
      workspaceId: ctx.workspace.id,
      ambientId: null,
      userId: ctx.user.id,
      agentId,
      kind: 'telegram',
      name: 'tg',
      token: 'tok',
    });
    const res = await app().request(`/v1/channels/${connection.id}`, {
      method: 'DELETE',
      headers: ctx.authHeaders,
    });
    expect(res.status).toBe(200);
    expect(bridge.list(ctx.workspace.id)).toHaveLength(0);
  });

  it('returns 404 for unknown id', async () => {
    const res = await app().request(`/v1/channels/${randomUUID()}`, {
      method: 'DELETE',
      headers: ctx.authHeaders,
    });
    expect(res.status).toBe(404);
  });
});

describe('GET /v1/channels/:id/webhook-info', () => {
  it('returns the inbound URL without re-disclosing the one-time secret', async () => {
    const agentId = seedAgent();
    const { connection } = bridge.create({
      workspaceId: ctx.workspace.id,
      ambientId: null,
      userId: ctx.user.id,
      agentId,
      kind: 'telegram',
      name: 'tg',
      token: 'tok',
    });
    const res = await app().request(`/v1/channels/${connection.id}/webhook-info`, {
      headers: ctx.authHeaders,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.webhookSecret).toBeUndefined();
    expect(body.webhookUrl).toContain(connection.id);
  });
});

describe('POST /v1/webhooks/channel/:connectionId — unauth ingress', () => {
  it('accepts a verified inbound update without auth and acks 202', async () => {
    const agentId = seedAgent();
    const { connection } = bridge.create({
      workspaceId: ctx.workspace.id,
      ambientId: null,
      userId: ctx.user.id,
      agentId,
      kind: 'telegram',
      name: 'tg',
      token: 'tok',
    });
    const res = await app().request(`/v1/webhooks/channel/${connection.id}`, {
      method: 'POST',
      body: '{}',
      // Note: NO Authorization or workspace headers — this is the unauth path.
    });
    expect(res.status).toBe(202);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.accepted).toBe(true);
  });

  it('returns 401 when adapter.verify rejects the signature', async () => {
    adapter.acceptVerify = false;
    const agentId = seedAgent();
    const { connection } = bridge.create({
      workspaceId: ctx.workspace.id,
      ambientId: null,
      userId: ctx.user.id,
      agentId,
      kind: 'telegram',
      name: 'tg',
      token: 'tok',
    });
    const res = await app().request(`/v1/webhooks/channel/${connection.id}`, {
      method: 'POST',
      body: '{}',
    });
    expect(res.status).toBe(401);
    // Connection persisted as 'error'.
    const row = ctx.db
      .select()
      .from(schema.channelConnections)
      .where(eq(schema.channelConnections.id, connection.id))
      .get()!;
    expect(row.status).toBe('error');
  });

  it('returns 200 + idempotent on duplicate externalId', async () => {
    const agentId = seedAgent();
    const { connection } = bridge.create({
      workspaceId: ctx.workspace.id,
      ambientId: null,
      userId: ctx.user.id,
      agentId,
      kind: 'telegram',
      name: 'tg',
      token: 'tok',
    });
    const first = await app().request(`/v1/webhooks/channel/${connection.id}`, {
      method: 'POST',
      body: '{}',
    });
    expect(first.status).toBe(202);
    const second = await app().request(`/v1/webhooks/channel/${connection.id}`, {
      method: 'POST',
      body: '{}',
    });
    expect(second.status).toBe(200);
    const body = (await second.json()) as Record<string, unknown>;
    expect(body.idempotent).toBe(true);
  });
});
