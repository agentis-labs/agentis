import { Hono } from 'hono';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { AuthService } from '../services/auth.js';
import type { BuildSessionService } from '../services/buildSessionService.js';
import { requireAuth } from '../middleware/auth.js';
import { getWorkspace, requireWorkspace } from '../middleware/workspace.js';

/** Read-only evidence surface. Session transitions are owned by verified platform operations. */
export function buildBuildSessionRoutes(deps: {
  db: AgentisSqliteDb;
  auth: AuthService;
  sessions: BuildSessionService;
}) {
  const app = new Hono();
  app.use('*', requireAuth(deps), requireWorkspace(deps));

  app.get('/', (c) => {
    const ws = getWorkspace(c);
    const limit = Number(c.req.query('limit') ?? 50);
    return c.json({ sessions: deps.sessions.list(ws.workspaceId, limit) });
  });

  app.get('/latest', (c) => {
    const ws = getWorkspace(c);
    const appId = c.req.query('appId')?.trim();
    const conversationId = c.req.query('conversationId')?.trim();
    if ((!appId && !conversationId) || (appId && conversationId)) {
      return c.json({ error: { code: 'VALIDATION_FAILED', message: 'Provide exactly one of appId or conversationId.' } }, 422);
    }
    const session = appId
      ? deps.sessions.latestForApp(ws.workspaceId, appId)
      : deps.sessions.latestForConversation(ws.workspaceId, conversationId!);
    return c.json({
      session,
      blueprint: session ? deps.sessions.getBlueprint(ws.workspaceId, session.blueprintId) : null,
    });
  });

  app.get('/:id', (c) => {
    const ws = getWorkspace(c);
    try {
      const session = deps.sessions.get(ws.workspaceId, c.req.param('id'));
      return c.json({ session, blueprint: deps.sessions.getBlueprint(ws.workspaceId, session.blueprintId) });
    } catch {
      return c.json({ error: { code: 'RESOURCE_NOT_FOUND', message: 'Build session not found.' } }, 404);
    }
  });

  return app;
}
