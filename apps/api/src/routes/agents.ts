/**
 * /v1/agents — V1-SPEC §3.3 spec-named entry point.
 *
 * Composes the GET-list endpoint with the full CRUD + terminal RPC surface
 * from `agentMutations.ts`. Spec §3.3 expects a single `agents.ts` route
 * file; the implementation was previously split for review-diff hygiene
 * during V1.0/V1.1 development.
 */

import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
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

  // Mount the full mutation surface (POST /, PATCH /:id, DELETE /:id,
  // POST /:id/terminal/send, POST /:id/cancel-task/:taskId) at the root.
  app.route('/', buildAgentMutationRoutes(deps));

  return app;
}
