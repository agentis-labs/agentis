/**
 * /v1/workspaces — list/get/create/update + ambients sub-resource.
 */

import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { and, eq } from 'drizzle-orm';
import { AgentisError, REALTIME_EVENTS, REALTIME_ROOMS, schemas } from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { AuthService } from '../services/auth.js';
import type { EventBus } from '../event-bus.js';
import { requireAuth, getUser } from '../middleware/auth.js';

export function buildWorkspaceRoutes(deps: { db: AgentisSqliteDb; auth: AuthService; bus: EventBus }) {
  const app = new Hono();
  app.use('*', requireAuth(deps));

  app.get('/', (c) => {
    const user = getUser(c);
    const rows = deps.db
      .select()
      .from(schema.workspaces)
      .where(eq(schema.workspaces.userId, user.id))
      .all();
    return c.json({ workspaces: rows });
  });

  app.post('/', async (c) => {
    const user = getUser(c);
    const body = schemas.createWorkspaceSchema.parse(await c.req.json());
    const id = randomUUID();
    deps.db
      .insert(schema.workspaces)
      .values({ id, userId: user.id, name: body.name, slug: body.slug })
      .run();
    return c.json({ workspace: { id, userId: user.id, name: body.name, slug: body.slug } }, 201);
  });

  app.get('/:id', (c) => {
    const user = getUser(c);
    const id = c.req.param('id');
    const ws = deps.db
      .select()
      .from(schema.workspaces)
      .where(and(eq(schema.workspaces.id, id), eq(schema.workspaces.userId, user.id)))
      .get();
    if (!ws) throw new AgentisError('RESOURCE_NOT_FOUND', 'Workspace not found');
    const ambients = deps.db
      .select()
      .from(schema.ambients)
      .where(eq(schema.ambients.workspaceId, ws.id))
      .all();
    return c.json({ workspace: ws, ambients });
  });

  app.post('/:id/ambients', async (c) => {
    const user = getUser(c);
    const id = c.req.param('id');
    const ws = deps.db
      .select()
      .from(schema.workspaces)
      .where(and(eq(schema.workspaces.id, id), eq(schema.workspaces.userId, user.id)))
      .get();
    if (!ws) throw new AgentisError('RESOURCE_NOT_FOUND', 'Workspace not found');
    const body = schemas.createAmbientSchema.parse({ ...(await c.req.json()), workspaceId: id });
    const ambientId = randomUUID();
    deps.db
      .insert(schema.ambients)
      .values({
        id: ambientId,
        workspaceId: ws.id,
        userId: user.id,
        name: body.name,
        kind: body.kind,
        settings: body.settings,
      })
      .run();
    return c.json({ ambient: { id: ambientId, ...body } }, 201);
  });

  // POST /v1/workspaces/:id/select — record the active workspace and emit
  // the realtime event so other tabs/sessions can react.
  app.post('/:id/select', (c) => {
    const user = getUser(c);
    const id = c.req.param('id');
    const ws = deps.db
      .select()
      .from(schema.workspaces)
      .where(and(eq(schema.workspaces.id, id), eq(schema.workspaces.userId, user.id)))
      .get();
    if (!ws) throw new AgentisError('RESOURCE_NOT_FOUND', 'Workspace not found');
    deps.bus.publish(
      REALTIME_ROOMS.user(user.id),
      REALTIME_EVENTS.WORKSPACE_SELECTED,
      { workspaceId: ws.id, name: ws.name, slug: ws.slug },
    );
    return c.json({ workspace: { id: ws.id, name: ws.name, slug: ws.slug, defaultAmbientId: ws.defaultAmbientId } });
  });

  // POST /v1/workspaces/:id/ambients/:ambientId/select — record the active
  // ambient inside the workspace and emit the realtime event. The dashboard
  // sends `x-agentis-ambient` on subsequent requests; the spec requires the
  // explicit endpoint for parity with the workspace selector.
  app.post('/:id/ambients/:ambientId/select', (c) => {
    const user = getUser(c);
    const id = c.req.param('id');
    const ambientId = c.req.param('ambientId');
    const ws = deps.db
      .select()
      .from(schema.workspaces)
      .where(and(eq(schema.workspaces.id, id), eq(schema.workspaces.userId, user.id)))
      .get();
    if (!ws) throw new AgentisError('RESOURCE_NOT_FOUND', 'Workspace not found');
    const amb = deps.db
      .select()
      .from(schema.ambients)
      .where(and(eq(schema.ambients.id, ambientId), eq(schema.ambients.workspaceId, ws.id)))
      .get();
    if (!amb) throw new AgentisError('RESOURCE_NOT_FOUND', 'Ambient not found in workspace');
    deps.db
      .update(schema.workspaces)
      .set({ defaultAmbientId: amb.id, updatedAt: new Date().toISOString() })
      .where(eq(schema.workspaces.id, ws.id))
      .run();
    deps.bus.publish(
      REALTIME_ROOMS.workspace(ws.id),
      REALTIME_EVENTS.AMBIENT_SELECTED,
      { workspaceId: ws.id, ambientId: amb.id, name: amb.name, kind: amb.kind },
    );
    return c.json({ ambient: { id: amb.id, name: amb.name, kind: amb.kind } });
  });

  return app;
}
