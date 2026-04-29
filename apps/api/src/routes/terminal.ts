/**
 * /v1/agents/:id/terminal — V1-SPEC §3.3 spec-named entry point.
 *
 * Terminal pane uses two endpoints:
 *  - POST /v1/agents/:id/terminal/send  — operator → agent message
 *    (mounted via routes/agentMutations.ts so it shares the agent
 *    lifecycle middleware).
 *  - GET  /v1/agents/:id/terminal       — recent message history
 *    surfaced through this builder.
 *
 * Realtime updates flow through the websocket `conversation:agentId` room.
 */

import { Hono } from 'hono';
import { and, eq } from 'drizzle-orm';
import { AgentisError } from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { AuthService } from '../services/auth.js';
import type { ConversationStore } from '../services/conversationStore.js';
import { requireAuth } from '../middleware/auth.js';
import { requireWorkspace, getWorkspace } from '../middleware/workspace.js';

export function buildTerminalRoutes(deps: {
  db: AgentisSqliteDb;
  auth: AuthService;
  conversations: ConversationStore;
}) {
  const app = new Hono();
  app.use('*', requireAuth(deps), requireWorkspace(deps));

  app.get('/:agentId/terminal', (c) => {
    const ws = getWorkspace(c);
    const agentId = c.req.param('agentId');
    const agent = deps.db
      .select()
      .from(schema.agents)
      .where(
        and(
          eq(schema.agents.id, agentId),
          eq(schema.agents.workspaceId, ws.workspaceId),
        ),
      )
      .get();
    if (!agent) throw new AgentisError('RESOURCE_NOT_FOUND', 'agent not found');
    const conv = deps.db
      .select()
      .from(schema.conversations)
      .where(
        and(
          eq(schema.conversations.workspaceId, ws.workspaceId),
          eq(schema.conversations.agentId, agentId),
        ),
      )
      .get();
    if (!conv) return c.json({ messages: [] });
    const limit = Math.min(Math.max(Number(c.req.query('limit') ?? 50), 1), 200);
    return c.json({ messages: deps.conversations.messages(conv.id, limit) });
  });

  return app;
}
