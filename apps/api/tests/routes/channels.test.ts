/**
 * /v1/channels — route unit tests (Batch 4 / D35).
 *
 * Stubs the Telegram channel adapter to avoid network calls. Asserts the
 * outbound surface (CRUD + test + webhook-info) and the unauth ingress on
 * /v1/webhooks/channel/:id (mounted via buildWebhookRoutes).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHmac, randomUUID } from 'node:crypto';
import { schema } from '@agentis/db/sqlite';
import { eq } from 'drizzle-orm';
import { ConversationStore } from '../../src/services/conversation/conversationStore.js';
import { ChannelBridge, type PersistentChannelTransport } from '../../src/services/conversation/channelBridge.js';
import { buildChannelRoutes } from '../../src/routes/channels.js';
import { buildWebhookRoutes } from '../../src/routes/webhooks.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';
import type { ChannelAdapter, ParsedInboundMessage } from '../../src/adapters/channels/types.js';
import type { TriggerRuntime } from '../../src/engine/TriggerRuntime.js';
import { SlackChannelAdapter } from '../../src/adapters/channels/slack.js';

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

function fakePersistentTransport(): PersistentChannelTransport {
  return {
    handles: (conn) => conn.kind === 'whatsapp',
    requiresNoToken: (kind) => kind === 'whatsapp',
    status: () => ({ status: 'idle' }),
    send: async () => {
      throw new Error('should not send during QR-local create');
    },
  };
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
    adapters: { telegram: adapter, slack: new SlackChannelAdapter() },
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

  it('defaults Telegram to long polling when AGENTIS_PUBLIC_URL is not set', async () => {
    const previous = process.env.AGENTIS_PUBLIC_URL;
    delete process.env.AGENTIS_PUBLIC_URL;
    try {
      const agentId = seedAgent();
      const res = await app().request('/v1/channels', {
        method: 'POST',
        headers: ctx.authHeaders,
        body: JSON.stringify({
          kind: 'telegram',
          name: 'Tg poll',
          agentId,
          token: 'super-secret-bot-token',
          runInitialTest: false,
        }),
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as { connection: { transport: string | null } };
      expect(body.connection.transport).toBe('polling');
    } finally {
      if (previous) process.env.AGENTIS_PUBLIC_URL = previous;
      else delete process.env.AGENTIS_PUBLIC_URL;
    }
  });

  it('normalizes a labelled Telegram chat id (e.g. "ID: 7905735992") to the bare id', async () => {
    const agentId = seedAgent();
    const res = await app().request('/v1/channels', {
      method: 'POST',
      headers: ctx.authHeaders,
      body: JSON.stringify({
        kind: 'telegram',
        name: 'Tg labelled',
        agentId,
        token: 'super-secret-bot-token',
        defaultChatId: 'ID: 7905735992',
        runInitialTest: false,
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { connection: { defaultChatId: string | null } };
    // The label must be stripped, otherwise sendMessage fails with "chat not found".
    expect(body.connection.defaultChatId).toBe('7905735992');
  });

  it('does not auto-test WhatsApp QR-local connections before login', async () => {
    bridge.setPersistentTransport(fakePersistentTransport());
    const agentId = seedAgent();
    const res = await app().request('/v1/channels', {
      method: 'POST',
      headers: ctx.authHeaders,
      body: JSON.stringify({
        kind: 'whatsapp',
        mode: 'qr_local',
        name: 'WA local',
        agentId,
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      loginUrl?: string;
      health: { status: string; checks: Array<{ code: string }> };
    };
    expect(body.loginUrl).toMatch(/^\/v1\/channels\/.+\/login$/);
    expect(body.health.status).toBe('needs_action');
    expect(body.health.checks.every((check) => check.code === 'not_checked')).toBe(true);
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

  it('returns structured diagnostics when no chatId is available', async () => {
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
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; health: { status: string; checks: Array<{ code: string }> } };
    expect(body.ok).toBe(false);
    expect(body.health.status).toBe('needs_action');
    expect(body.health.checks.some((check) => check.code === 'missing_default_target')).toBe(true);
  });
});

describe('GET /v1/channels/:id/health', () => {
  it('returns current health without sending a message', async () => {
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
    const res = await app().request(`/v1/channels/${connection.id}/health`, {
      headers: ctx.authHeaders,
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { connection: { id: string }; health: { status: string; checks: unknown[] } };
    expect(body.connection.id).toBe(connection.id);
    expect(body.health.status).toBe('verifying');
    expect(adapter.sent).toEqual([]);
  });
});

describe('PATCH /v1/channels/:id/targets', () => {
  it('saves a default target and aliases without exposing secrets', async () => {
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
    const res = await app().request(`/v1/channels/${connection.id}/targets`, {
      method: 'PATCH',
      headers: ctx.authHeaders,
      body: JSON.stringify({ defaultChatId: '777', targetAliases: { work: '888' } }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { connection: { defaultChatId: string; targetAliases: Record<string, string> } };
    expect(body.connection.defaultChatId).toBe('777');
    expect(body.connection.targetAliases.work).toBe('888');
    expect(JSON.stringify(body)).not.toContain('tok');
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

  it('answers Slack URL verification challenge after signature validation', async () => {
    const agentId = seedAgent();
    const signingSecret = 'slack-signing-secret';
    const { connection } = bridge.create({
      workspaceId: ctx.workspace.id,
      ambientId: null,
      userId: ctx.user.id,
      agentId,
      kind: 'slack',
      name: 'slack',
      token: 'xoxb-token',
      signingSecret,
    });
    const rawBody = JSON.stringify({ type: 'url_verification', challenge: 'challenge-123' });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = `v0=${createHmac('sha256', signingSecret).update(`v0:${timestamp}:${rawBody}`).digest('hex')}`;
    const res = await app().request(`/v1/webhooks/channel/${connection.id}`, {
      method: 'POST',
      headers: {
        'x-slack-request-timestamp': timestamp,
        'x-slack-signature': signature,
      },
      body: rawBody,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ challenge: 'challenge-123' });
  });
});

describe('GET /v1/webhooks/channel/:connectionId', () => {
  it('answers WhatsApp Cloud webhook verification', async () => {
    const agentId = seedAgent();
    const { connection } = bridge.create({
      workspaceId: ctx.workspace.id,
      ambientId: null,
      userId: ctx.user.id,
      agentId,
      kind: 'whatsapp',
      name: 'wa cloud',
      mode: 'cloud',
      token: 'meta-access-token',
      phoneNumberId: '123456789',
      appSecret: 'meta-app-secret',
      verifyToken: 'verify-me',
    });
    const res = await app().request(`/v1/webhooks/channel/${connection.id}?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=abc123`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('abc123');
  });
});
