/**
 * /v1/channels — channel-bridge connections (Telegram/Discord/...).
 *
 *   GET    /                  list connections
 *   POST   /                  create connection (token encrypted via vault)
 *   DELETE /:id               remove connection
 *   POST   /:id/test          send a test message via the adapter
 *   GET    /:id/webhook-info  return inbound webhook URL + secret (one-time)
 *
 * Tokens are NEVER returned in responses. The webhook secret is returned ONLY
 * in the POST create response and via /webhook-info while the operator is
 * still authenticated.
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { AgentisError } from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import { eq } from 'drizzle-orm';
import type { AuthService } from '../services/auth.js';
import type { ChannelBridge } from '../services/channelBridge.js';
import { requireAuth } from '../middleware/auth.js';
import { requireWorkspace, getWorkspace } from '../middleware/workspace.js';

const createSchema = z.object({
  kind: z.enum(['telegram', 'discord']),
  name: z.string().min(1).max(120),
  agentId: z.string().min(1),
  token: z.string().min(8).max(4096),
  defaultChatId: z.string().min(1).max(120).optional(),
  ambientId: z.string().nullish(),
});

const testSchema = z.object({
  chatId: z.string().min(1).max(120).optional(),
  body: z.string().min(1).max(2048).optional(),
});

export function buildChannelRoutes(deps: {
  db: AgentisSqliteDb;
  auth: AuthService;
  bridge: ChannelBridge;
}) {
  const app = new Hono();
  app.use('*', requireAuth(deps), requireWorkspace(deps));

  app.get('/', (c) => {
    const ws = getWorkspace(c);
    return c.json({ connections: deps.bridge.list(ws.workspaceId) });
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
      token: body.token,
    };
    if (body.defaultChatId) input.defaultChatId = body.defaultChatId;
    const { connection, webhookSecret } = deps.bridge.create(input);
    return c.json(
      {
        connection,
        webhookSecret,
        webhookUrl: `/v1/webhooks/channel/${connection.id}`,
      },
      201,
    );
  });

  app.delete('/:id', (c) => {
    const ws = getWorkspace(c);
    deps.bridge.delete(ws.workspaceId, c.req.param('id'));
    return c.json({ ok: true });
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
    const row = deps.db
      .select()
      .from(schema.channelConnections)
      .where(eq(schema.channelConnections.id, id))
      .get();
    if (!row) throw new AgentisError('RESOURCE_NOT_FOUND', `channel connection ${id} not found`);
    return c.json({
      connection: conn,
      webhookSecret: row.webhookSecret,
      webhookUrl: `/v1/webhooks/channel/${id}`,
    });
  });

  return app;
}
