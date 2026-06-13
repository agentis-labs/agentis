/**
 * /v1/channels — channel-bridge connections (Telegram/Discord/...).
 *
 *   GET    /                  list connections
 *   POST   /                  create connection (token encrypted via vault)
 *   DELETE /:id               remove connection
 *   POST   /:id/test          send a test message via the adapter
 *   GET    /:id/webhook-info  return inbound webhook URL
 *
 * Tokens are NEVER returned in responses. The webhook secret is returned ONLY
 * in the POST create response.
 */

import { Hono } from 'hono';
import { z } from 'zod';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import { AgentisError } from '@agentis/core';
import type { AuthService } from '../services/auth.js';
import type { ChannelBridge } from '../services/channelBridge.js';
import type { ChannelConnectionSupervisor } from '../services/channelConnectionSupervisor.js';
import type { ChannelIdentityService } from '../services/channelIdentityService.js';
import { requireAuth } from '../middleware/auth.js';
import { requireWorkspace, getWorkspace } from '../middleware/workspace.js';

const createSchema = z
  .object({
    // WhatsApp is QR-authenticated (no token); the others are token/webhook-based.
    kind: z.enum(['telegram', 'discord', 'slack', 'whatsapp']),
    name: z.string().min(1).max(120),
    agentId: z.string().min(1),
    token: z.string().min(8).max(4096).optional(),
    defaultChatId: z.string().min(1).max(120).optional(),
    // Persistent transports: Telegram 'polling' (long-poll), Discord 'gateway'
    // (live message events) — both avoid a public webhook.
    transport: z.enum(['polling', 'webhook', 'gateway']).optional(),
    ambientId: z.string().nullish(),
  })
  .refine((v) => v.kind === 'whatsapp' || Boolean(v.token), {
    message: 'token is required for this channel kind',
    path: ['token'],
  });

const linkSchema = z.object({
  channelKind: z.enum(['telegram', 'discord', 'slack', 'whatsapp']),
  handle: z.string().min(1).max(256),
  /** Null unlinks the handle from any workspace user. */
  userId: z.string().min(1).nullish(),
});

const testSchema = z.object({
  chatId: z.string().min(1).max(120).optional(),
  body: z.string().min(1).max(2048).optional(),
});

export function buildChannelRoutes(deps: {
  db: AgentisSqliteDb;
  auth: AuthService;
  bridge: ChannelBridge;
  /** Persistent-transport supervisor (WhatsApp). Optional — absent in some tests. */
  supervisor?: ChannelConnectionSupervisor;
  /** Cross-surface peer identity. Optional — absent in some tests. */
  identity?: ChannelIdentityService;
}) {
  const app = new Hono();
  app.use('*', requireAuth(deps), requireWorkspace(deps));

  app.get('/', (c) => {
    const ws = getWorkspace(c);
    return c.json({ connections: deps.bridge.list(ws.workspaceId) });
  });

  // ── Cross-surface peer identity (§5.2) ───────────────────
  app.get('/identities', (c) => {
    const ws = getWorkspace(c);
    if (!deps.identity) return c.json({ identities: [] });
    return c.json({ identities: deps.identity.list(ws.workspaceId) });
  });

  app.post('/identities/link', async (c) => {
    const ws = getWorkspace(c);
    if (!deps.identity) throw new AgentisError('RESOURCE_NOT_FOUND', 'identity service not available');
    const body = linkSchema.parse(await c.req.json());
    const linked = deps.identity.link({
      workspaceId: ws.workspaceId,
      channelKind: body.channelKind,
      handle: body.handle,
      userId: body.userId ?? null,
    });
    if (!linked) throw new AgentisError('RESOURCE_NOT_FOUND', 'peer identity not found');
    return c.json({ identity: linked });
  });

  app.post('/', async (c) => {
    const ws = getWorkspace(c);
    const body = createSchema.parse(await c.req.json());
    const input: Parameters<ChannelBridge['create']>[0] = {
      workspaceId: ws.workspaceId,
      ambientId: body.ambientId ?? null,
      userId: ws.user.id,
      agentId: body.agentId,
      kind: body.kind,
      name: body.name,
    };
    if (body.token) input.token = body.token;
    if (body.defaultChatId) input.defaultChatId = body.defaultChatId;
    if (body.transport) input.transport = body.transport;
    const { connection, webhookSecret } = deps.bridge.create(input);
    return c.json(
      {
        connection,
        webhookSecret,
        // WhatsApp links via QR (POST /:id/login); the others ingest via webhook.
        ...(connection.kind === 'whatsapp'
          ? { loginUrl: `/v1/channels/${connection.id}/login` }
          : { webhookUrl: `/v1/webhooks/channel/${connection.id}` }),
      },
      201,
    );
  });

  app.delete('/:id', (c) => {
    const ws = getWorkspace(c);
    deps.bridge.delete(ws.workspaceId, c.req.param('id'));
    return c.json({ ok: true });
  });

  // ── WhatsApp QR login (persistent transport) ─────────────
  // POST starts/refreshes the login and returns the current QR; GET polls state.
  app.post('/:id/login', async (c) => {
    const ws = getWorkspace(c);
    const conn = deps.bridge.get(ws.workspaceId, c.req.param('id')); // 404s if missing
    if (conn.kind !== 'whatsapp') {
      throw new AgentisError('VALIDATION_FAILED', `channel kind '${conn.kind}' does not use QR login`);
    }
    if (!deps.supervisor) {
      throw new AgentisError('CHANNEL_KIND_UNAVAILABLE', 'WhatsApp transport is not available on this server');
    }
    const state = await deps.supervisor.startLogin(conn.id);
    return c.json({ connectionId: conn.id, ...state });
  });

  app.get('/:id/login', (c) => {
    const ws = getWorkspace(c);
    const conn = deps.bridge.get(ws.workspaceId, c.req.param('id')); // 404s if missing
    if (conn.kind !== 'whatsapp') {
      throw new AgentisError('VALIDATION_FAILED', `channel kind '${conn.kind}' does not use QR login`);
    }
    if (!deps.supervisor) {
      throw new AgentisError('CHANNEL_KIND_UNAVAILABLE', 'WhatsApp transport is not available on this server');
    }
    return c.json({ connectionId: conn.id, ...deps.supervisor.loginState(conn.id) });
  });

  app.post('/:id/test', async (c) => {
    const ws = getWorkspace(c);
    let parsed: { chatId?: string; body?: string } = {};
    try {
      parsed = testSchema.parse(await c.req.json());
    } catch {
      // empty body is allowed; falls through to defaults
    }
    const args: Parameters<ChannelBridge['test']>[0] = {
      workspaceId: ws.workspaceId,
      id: c.req.param('id'),
    };
    if (parsed.chatId) args.chatId = parsed.chatId;
    if (parsed.body) args.body = parsed.body;
    await deps.bridge.test(args);
    return c.json({ ok: true });
  });

  app.get('/:id/webhook-info', (c) => {
    const ws = getWorkspace(c);
    const id = c.req.param('id');
    const conn = deps.bridge.get(ws.workspaceId, id); // 404s if missing
    return c.json({
      connection: conn,
      webhookUrl: `/v1/webhooks/channel/${id}`,
    });
  });

  return app;
}
