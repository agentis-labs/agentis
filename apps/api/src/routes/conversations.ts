/**
 * /v1/conversations — operator-agent threads.
 *
 *   GET  /                                 list of threads
 *   GET  /:agentId                         messages for a thread (creates thread on demand)
 *   POST /:agentId/send                    operator → agent
 *   POST /:agentId/continue/:sessionId     bind thread to a mirrored session id
 *   POST /:agentId/read                    clear unread badge
 */

import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { AgentisError, CONSTANTS } from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { AuthService } from '../services/auth.js';
import type { ConversationStore } from '../services/conversationStore.js';
import type { AdapterManager } from '../adapters/AdapterManager.js';
import { OpenClawAdapter } from '../adapters/OpenClawAdapter.js';
import type { Logger } from '../logger.js';
import { requireAuth } from '../middleware/auth.js';
import { requireWorkspace, getWorkspace } from '../middleware/workspace.js';

const sendSchema = z.object({ body: z.string().min(1).max(CONSTANTS.CONVERSATION_MESSAGE_MAX_LENGTH) });

export function buildConversationRoutes(deps: {
  db: AgentisSqliteDb;
  auth: AuthService;
  conversations: ConversationStore;
  adapters: AdapterManager;
  logger: Logger;
}) {
  const app = new Hono();
  app.use('*', requireAuth(deps), requireWorkspace(deps));

  app.get('/', (c) => {
    const ws = getWorkspace(c);
    const rows = deps.conversations.list(ws.workspaceId);
    const agentRows = deps.db
      .select()
      .from(schema.agents)
      .where(eq(schema.agents.workspaceId, ws.workspaceId))
      .all();
    const byId = new Map(agentRows.map((a) => [a.id, a]));
    const enriched = rows.map((r) => {
      const a = byId.get(r.agentId);
      const last = deps.conversations.messages(r.id, 1).at(-1);
      return {
        id: r.id,
        agentId: r.agentId,
        agentName: a?.name ?? r.agentId.slice(0, 8),
        agentColor: a?.colorHex ?? '#7a8390',
        unread: r.unreadCount,
        lastMessageAt: r.lastMessageAt,
        lastMessagePreview: last ? last.body.slice(0, 80) : null,
        mirroredSessionId: r.mirroredSessionId,
      };
    });
    return c.json({ conversations: enriched });
  });

  app.get('/:agentId', (c) => {
    const ws = getWorkspace(c);
    const agentId = c.req.param('agentId');
    const agent = deps.db.select().from(schema.agents).where(eq(schema.agents.id, agentId)).get();
    if (!agent || agent.workspaceId !== ws.workspaceId) throw new AgentisError('RESOURCE_NOT_FOUND', 'agent not found');
    const conversation = deps.conversations.getOrCreateByAgent({
      workspaceId: ws.workspaceId,
      ambientId: ws.ambientId,
      userId: ws.user.id,
      agentId,
    });
    return c.json({
      conversation,
      messages: deps.conversations
        .messages(conversation.id, CONSTANTS.CONVERSATION_HISTORY_PAGE_SIZE)
        .map((m) => ({ id: m.id, role: m.authorType, body: m.body, createdAt: m.createdAt })),
    });
  });

  app.post('/:agentId/send', async (c) => {
    const ws = getWorkspace(c);
    const agentId = c.req.param('agentId');
    const body = sendSchema.parse(await c.req.json());
    const agent = deps.db.select().from(schema.agents).where(eq(schema.agents.id, agentId)).get();
    if (!agent || agent.workspaceId !== ws.workspaceId) throw new AgentisError('RESOURCE_NOT_FOUND', 'agent not found');

    const conversation = deps.conversations.getOrCreateByAgent({
      workspaceId: ws.workspaceId,
      ambientId: ws.ambientId,
      userId: ws.user.id,
      agentId,
    });
    const message = deps.conversations.appendOutbound({
      workspaceId: ws.workspaceId,
      conversationId: conversation.id,
      operatorId: ws.user.id,
      body: body.body,
    });
    const reg = deps.adapters.get(agentId);
    if (reg && reg.adapter instanceof OpenClawAdapter) {
      try {
        await reg.adapter.sendSessionMessage({
          sessionId: conversation.mirroredSessionId ?? undefined,
          body: body.body,
        });
      } catch (err) {
        deps.logger.warn('conversations.send_failed', { agentId, err: (err as Error).message });
      }
    }
    return c.json({ message });
  });

  app.post('/:agentId/continue/:sessionId', (c) => {
    const ws = getWorkspace(c);
    const agentId = c.req.param('agentId');
    const sessionId = c.req.param('sessionId');
    const agent = deps.db.select().from(schema.agents).where(eq(schema.agents.id, agentId)).get();
    if (!agent || agent.workspaceId !== ws.workspaceId) throw new AgentisError('RESOURCE_NOT_FOUND', 'agent not found');
    const conversation = deps.conversations.getOrCreateByAgent({
      workspaceId: ws.workspaceId,
      ambientId: ws.ambientId,
      userId: ws.user.id,
      agentId,
      mirroredSessionId: sessionId,
    });
    return c.json({ conversation });
  });

  app.post('/:agentId/read', (c) => {
    const ws = getWorkspace(c);
    const agentId = c.req.param('agentId');
    const agent = deps.db.select().from(schema.agents).where(eq(schema.agents.id, agentId)).get();
    if (!agent || agent.workspaceId !== ws.workspaceId) throw new AgentisError('RESOURCE_NOT_FOUND', 'agent not found');
    const conversation = deps.conversations.getOrCreateByAgent({
      workspaceId: ws.workspaceId,
      ambientId: ws.ambientId,
      userId: ws.user.id,
      agentId,
    });
    deps.conversations.markRead(ws.workspaceId, conversation.id);
    return c.json({ ok: true });
  });

  return app;
}
