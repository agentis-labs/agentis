/**
 * /v1/brain — the workspace Brain surface.
 *
 * The Brain is the workspace intelligence layer: the context files + MEMORY.md
 * log, the knowledge bases, per-workflow memory, and each agent's personal
 * memory. `GET /` returns the composed overview; the `/agents/:agentId/memory`
 * routes expose an individual agent's personal memory (its own Brain) for the
 * agent detail page.
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { AgentisError } from '@agentis/core';
import { eq, and } from 'drizzle-orm';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import { schema } from '@agentis/db/sqlite';
import type { AuthService } from '../services/auth.js';
import type { BrainService } from '../services/brain.js';
import type { AgentMemoryService } from '../services/agentMemory.js';
import { requireAuth } from '../middleware/auth.js';
import { getWorkspace, requireWorkspace } from '../middleware/workspace.js';

const appendSchema = z.object({
  section: z.string().trim().min(1).max(120).optional(),
  content: z.string().trim().min(1).max(8000),
  tags: z.array(z.string().trim().min(1).max(60)).max(20).optional(),
});

export function buildBrainRoutes(deps: {
  db: AgentisSqliteDb;
  auth: AuthService;
  brain: BrainService;
  agentMemory: AgentMemoryService;
}) {
  const app = new Hono();
  app.use('*', requireAuth(deps), requireWorkspace(deps));

  // Composed workspace Brain overview.
  app.get('/', async (c) => {
    const ws = getWorkspace(c);
    return c.json(await deps.brain.overview(ws.workspaceId));
  });

  // ── Agent-scoped memory (the agent's personal Brain) ──

  app.get('/agents/:agentId/memory', (c) => {
    const ws = getWorkspace(c);
    const agentId = assertAgent(deps.db, ws.workspaceId, c.req.param('agentId'));
    return c.json({ entries: deps.agentMemory.list(agentId, ws.workspaceId) });
  });

  app.post('/agents/:agentId/memory', async (c) => {
    const ws = getWorkspace(c);
    const agentId = assertAgent(deps.db, ws.workspaceId, c.req.param('agentId'));
    const body = appendSchema.parse(await c.req.json());
    const entry = deps.agentMemory.append({ agentId, workspaceId: ws.workspaceId, section: body.section, content: body.content, tags: body.tags });
    return c.json({ entry }, 201);
  });

  app.delete('/agents/:agentId/memory/:id', (c) => {
    const ws = getWorkspace(c);
    const agentId = assertAgent(deps.db, ws.workspaceId, c.req.param('agentId'));
    const removed = deps.agentMemory.remove(c.req.param('id'), agentId, ws.workspaceId);
    if (!removed) throw new AgentisError('RESOURCE_NOT_FOUND', 'Memory entry not found');
    return c.json({ removed: true });
  });

  app.delete('/agents/:agentId/memory', (c) => {
    const ws = getWorkspace(c);
    const agentId = assertAgent(deps.db, ws.workspaceId, c.req.param('agentId'));
    return c.json({ cleared: deps.agentMemory.clear(agentId, ws.workspaceId) });
  });

  return app;
}

/** Resolve + authorize an agent id against the active workspace. */
function assertAgent(db: AgentisSqliteDb, workspaceId: string, agentId: string): string {
  const agent = db
    .select({ id: schema.agents.id })
    .from(schema.agents)
    .where(and(eq(schema.agents.id, agentId), eq(schema.agents.workspaceId, workspaceId)))
    .get();
  if (!agent) throw new AgentisError('RESOURCE_NOT_FOUND', 'Agent not found');
  return agent.id;
}
