/**
 * /v1/conversations — operator-agent threads.
 *
 *   GET  /                                 list of threads
 *   GET  /:agentId                         messages for a thread (creates thread on demand)
 *   POST /:agentId/send                    operator → agent
 *   POST /:agentId/continue/:sessionId     bind thread to a mirrored session id
 *   POST /:agentId/read                    clear unread badge
 */

import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { AgentisError, CONSTANTS, type ChatTurnContext } from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { AuthService } from '../services/auth.js';
import type { ConversationStore } from '../services/conversationStore.js';
import type { AdapterManager } from '../adapters/AdapterManager.js';
import { OpenClawAdapter } from '../adapters/OpenClawAdapter.js';
import { ChatSessionExecutor } from '../services/chatSessionExecutor.js';
import type { ViewportStore } from '../services/viewportStore.js';
import type { Logger } from '../logger.js';
import { requireAuth } from '../middleware/auth.js';
import { requireWorkspace, getWorkspace } from '../middleware/workspace.js';

const sendSchema = z.object({
  body: z.string().min(1).max(CONSTANTS.CONVERSATION_MESSAGE_MAX_LENGTH),
  useViewportContext: z.boolean().optional().default(true),
});
const editSchema = z.object({ text: z.string().min(1).max(CONSTANTS.CONVERSATION_MESSAGE_MAX_LENGTH) });

export function buildConversationRoutes(deps: {
  db: AgentisSqliteDb;
  auth: AuthService;
  conversations: ConversationStore;
  adapters: AdapterManager;
  logger: Logger;
  viewportStore?: ViewportStore;
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
    const limit = Math.min(Math.max(Number(c.req.query('limit') ?? CONSTANTS.CONVERSATION_HISTORY_PAGE_SIZE), 1), 200);
    const before = c.req.query('before') ?? null;
    return c.json({
      conversation,
      messages: deps.conversations
        .messages(conversation.id, limit, before)
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

    const acceptsSSE = c.req.header('accept')?.includes('text/event-stream');
    if (acceptsSSE) {
      return streamSSE(c, async (stream) => {
        let finalText = '';
        let wroteDoneDelta = false;
        if (reg?.adapter?.chat) {
          const history = deps.conversations
            .messages(conversation.id, 20)
            .slice(0, -1)
            .map((row) => ({
              role: row.authorType === 'operator' ? 'user' as const : 'assistant' as const,
              content: row.body,
            }));
          const turnContext: ChatTurnContext = {
            workspaceId: ws.workspaceId,
            ambientId: ws.ambientId,
            agentId,
            userId: ws.user.id,
            conversationId: conversation.id,
            maxTurns: 8,
            viewport: body.useViewportContext ? deps.viewportStore?.get(ws.user.id) ?? null : null,
          };
          for await (const delta of ChatSessionExecutor.turn(reg.adapter, history, body.body, turnContext)) {
            await stream.writeSSE({ event: 'delta', data: JSON.stringify(delta) });
            if (delta.type === 'text') finalText += delta.delta;
            if (delta.type === 'done') {
              wroteDoneDelta = true;
              break;
            }
          }
        } else {
          if (reg?.adapter instanceof OpenClawAdapter) {
            await relayOpenClaw(deps, reg.adapter, conversation.mirroredSessionId ?? undefined, body.body, agentId);
          } else {
            finalText = 'This agent is not connected to an interactive chat harness yet. Configure a V1 harness, then try again.';
            await stream.writeSSE({ event: 'delta', data: JSON.stringify({ type: 'text', delta: finalText }) });
          }
        }

        if (!wroteDoneDelta) {
          await stream.writeSSE({ event: 'delta', data: JSON.stringify({ type: 'done', finishReason: 'stop' }) });
        }

        if (finalText.trim()) {
          const persisted = deps.conversations.appendMirrored({
            workspaceId: ws.workspaceId,
            conversationId: conversation.id,
            sessionMessageId: `chat_${randomUUID()}`,
            authorType: 'agent',
            body: finalText,
          });
          await stream.writeSSE({
            event: 'message',
            data: JSON.stringify({
              id: persisted.id,
              role: 'agent',
              body: persisted.body,
              createdAt: persisted.createdAt,
              metadata: { source: 'chat_loop' },
              deliveryStatus: 'delivered',
            }),
          });
        }
        await stream.writeSSE({ event: 'done', data: JSON.stringify({ finishReason: 'stop' }) });
      });
    }

    if (reg && reg.adapter instanceof OpenClawAdapter) {
      await relayOpenClaw(deps, reg.adapter, conversation.mirroredSessionId ?? undefined, body.body, agentId);
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

  app.patch('/:agentId/:messageId', async (c) => {
    const ws = getWorkspace(c);
    const agentId = c.req.param('agentId');
    const messageId = c.req.param('messageId');
    const body = editSchema.parse(await c.req.json());
    const agent = deps.db.select().from(schema.agents).where(eq(schema.agents.id, agentId)).get();
    if (!agent || agent.workspaceId !== ws.workspaceId) throw new AgentisError('RESOURCE_NOT_FOUND', 'agent not found');
    const conversation = deps.conversations.getOrCreateByAgent({
      workspaceId: ws.workspaceId,
      ambientId: ws.ambientId,
      userId: ws.user.id,
      agentId,
    });
    const message = deps.conversations.updateMessage({
      workspaceId: ws.workspaceId,
      conversationId: conversation.id,
      messageId,
      body: body.text,
    });
    return c.json({ message });
  });

  app.delete('/:agentId/:messageId', (c) => {
    const ws = getWorkspace(c);
    const agentId = c.req.param('agentId');
    const messageId = c.req.param('messageId');
    const agent = deps.db.select().from(schema.agents).where(eq(schema.agents.id, agentId)).get();
    if (!agent || agent.workspaceId !== ws.workspaceId) throw new AgentisError('RESOURCE_NOT_FOUND', 'agent not found');
    const conversation = deps.conversations.getOrCreateByAgent({
      workspaceId: ws.workspaceId,
      ambientId: ws.ambientId,
      userId: ws.user.id,
      agentId,
    });
    deps.conversations.deleteMessage({
      workspaceId: ws.workspaceId,
      conversationId: conversation.id,
      messageId,
    });
    return c.json({ ok: true, id: messageId });
  });

  return app;
}

async function relayOpenClaw(
  deps: { logger: Logger },
  adapter: OpenClawAdapter,
  sessionId: string | undefined,
  body: string,
  agentId: string,
): Promise<void> {
  try {
    await adapter.sendSessionMessage({ sessionId, body });
  } catch (err) {
    deps.logger.warn('conversations.send_failed', { agentId, err: (err as Error).message });
  }
}
