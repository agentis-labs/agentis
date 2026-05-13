/**
 * /v1/agents — V1-SPEC §3.3 spec-named entry point.
 *
 * Composes the GET-list endpoint with the full CRUD + terminal RPC surface
 * from `agentMutations.ts`. Spec §3.3 expects a single `agents.ts` route
 * file; the implementation was previously split for review-diff hygiene
 * during V1.0/V1.1 development.
 */

import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { z } from 'zod';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { AuthService } from '../services/auth.js';
import type { CredentialVault } from '../services/credentialVault.js';
import type { AdapterManager } from '../adapters/AdapterManager.js';
import type { Logger } from '../logger.js';
import type { ConversationStore } from '../services/conversationStore.js';
import { requireAuth } from '../middleware/auth.js';
import { requireWorkspace, getWorkspace } from '../middleware/workspace.js';
import { buildAgentMutationRoutes } from './agentMutations.js';

const writeAgentMemorySchema = z.object({
  kind: z.enum(['fact', 'rule', 'preference', 'pattern', 'lesson']).default('fact'),
  title: z.string().trim().min(1).max(160),
  content: z.string().trim().min(1).max(8000),
});

export interface AgentRoutesDeps {
  db: AgentisSqliteDb;
  auth: AuthService;
  vault: CredentialVault;
  adapters: AdapterManager;
  logger: Logger;
  conversations: ConversationStore;
}

export function buildAgentRoutes(deps: AgentRoutesDeps) {
  const app = new Hono();
  app.use('*', requireAuth(deps), requireWorkspace(deps));

  app.get('/', (c) => {
    const ws = getWorkspace(c);
    return c.json({
      agents: deps.db
        .select()
        .from(schema.agents)
        .where(eq(schema.agents.workspaceId, ws.workspaceId))
        .all(),
    });
  });

  app.get('/:id', (c) => {
    const ws = getWorkspace(c);
    const id = c.req.param('id');
    const agent = deps.db
      .select()
      .from(schema.agents)
      .where(eq(schema.agents.id, id))
      .get();
    if (!agent || agent.workspaceId !== ws.workspaceId) {
      return c.json({ error: { code: 'RESOURCE_NOT_FOUND', message: 'agent not found' } }, 404);
    }
    return c.json({ agent });
  });

  app.get('/:id/memory', (c) => {
    const ws = getWorkspace(c);
    const id = c.req.param('id');
    const agent = deps.db
      .select({ id: schema.agents.id, workspaceId: schema.agents.workspaceId })
      .from(schema.agents)
      .where(and(eq(schema.agents.id, id), eq(schema.agents.workspaceId, ws.workspaceId)))
      .get();
    if (!agent) {
      return c.json({ error: { code: 'RESOURCE_NOT_FOUND', message: 'agent not found' } }, 404);
    }
    const rows = deps.db
      .select()
      .from(schema.memoryEntries)
      .where(and(
        eq(schema.memoryEntries.workspaceId, ws.workspaceId),
        eq(schema.memoryEntries.agentId, id),
        isNull(schema.memoryEntries.archivedAt),
      ))
      .orderBy(desc(schema.memoryEntries.updatedAt))
      .limit(100)
      .all();
    return c.json({
      entries: rows.map((row) => ({
        id: row.id,
        source: row.sourceType === 'agent' ? 'agent' : 'platform',
        sourceType: row.sourceType,
        type: row.kind,
        kind: row.kind,
        title: row.title,
        content: row.content,
        trust: row.confidence,
        importance: row.importance,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      })),
    });
  });

  app.post('/:id/memory', async (c) => {
    const ws = getWorkspace(c);
    const id = c.req.param('id');
    const agent = deps.db
      .select({ id: schema.agents.id, workspaceId: schema.agents.workspaceId })
      .from(schema.agents)
      .where(and(eq(schema.agents.id, id), eq(schema.agents.workspaceId, ws.workspaceId)))
      .get();
    if (!agent) {
      return c.json({ error: { code: 'RESOURCE_NOT_FOUND', message: 'agent not found' } }, 404);
    }
    const body = writeAgentMemorySchema.parse(await c.req.json());
    const now = new Date().toISOString();
    const memory = {
      id: randomUUID(),
      workspaceId: ws.workspaceId,
      teamId: null,
      agentId: id,
      userId: ws.user.id,
      sourceType: 'operator',
      sourceId: null,
      kind: body.kind,
      title: body.title,
      content: body.content,
      importance: 7,
      confidence: 1,
      tags: [],
      metadata: { scope: 'agent' },
      archivedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    deps.db.insert(schema.memoryEntries).values(memory).run();
    return c.json({ memory, written: true }, 201);
  });

  // Mount the full mutation surface (POST /, PATCH /:id, DELETE /:id,
  // POST /:id/terminal/send, POST /:id/cancel-task/:taskId) at the root.
  app.route('/', buildAgentMutationRoutes(deps));

  return app;
}
