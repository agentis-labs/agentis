import { Hono } from 'hono';
import { z } from 'zod';
import { REALTIME_EVENTS, REALTIME_ROOMS } from '@agentis/core';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { AuthService } from '../services/auth.js';
import type { EventBus } from '../event-bus.js';
import type { InboxService } from '../services/inbox.js';
import { requireAuth } from '../middleware/auth.js';
import { requireWorkspace, getWorkspace } from '../middleware/workspace.js';

const dismissSchema = z.object({ itemKey: z.string().min(1) });

export function buildInboxRoutes(deps: { db: AgentisSqliteDb; auth: AuthService; inbox: InboxService; bus: EventBus }) {
  const app = new Hono();
  app.use('*', requireAuth(deps), requireWorkspace(deps));

  app.get('/', (c) => {
    const ws = getWorkspace(c);
    return c.json({ items: deps.inbox.getItems(ws.workspaceId, ws.user.id) });
  });

  app.get('/badges', (c) => {
    const ws = getWorkspace(c);
    return c.json(deps.inbox.badgeCounts(ws.workspaceId, ws.user.id));
  });

  app.post('/dismiss', async (c) => {
    const ws = getWorkspace(c);
    const body = dismissSchema.parse(await c.req.json());
    const dismissal = deps.inbox.dismiss(ws.workspaceId, ws.user.id, body.itemKey);
    deps.bus.publish(REALTIME_ROOMS.workspace(ws.workspaceId), REALTIME_EVENTS.INBOX_UPDATED, { itemKey: body.itemKey });
    return c.json({ dismissal });
  });

  return app;
}
