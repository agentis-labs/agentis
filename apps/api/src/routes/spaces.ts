/**
 * Spaces — organizational grouping (UIUX §23).
 *
 * GET    /v1/spaces        list spaces
 * POST   /v1/spaces        create
 * GET    /v1/spaces/:id    get one
 * PATCH  /v1/spaces/:id    rename / change color / link team
 * DELETE /v1/spaces/:id    delete
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { REALTIME_EVENTS, REALTIME_ROOMS } from '@agentis/core';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { AuthService } from '../services/auth.js';
import type { EventBus } from '../event-bus.js';
import { requireAuth } from '../middleware/auth.js';
import { getWorkspace, requireWorkspace } from '../middleware/workspace.js';
import { SpaceService } from '../services/spaces.js';

const createSchema = z.object({
  name: z.string().trim().min(1).max(120),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .nullable()
    .optional(),
  iconGlyph: z.string().trim().min(1).max(48).nullable().optional(),
  teamId: z.string().uuid().nullable().optional(),
});

const updateSchema = createSchema.partial();

export function buildSpaceRoutes(deps: {
  db: AgentisSqliteDb;
  auth: AuthService;
  bus?: EventBus;
}) {
  const app = new Hono();
  const spaces = new SpaceService(deps.db);
  app.use('*', requireAuth(deps), requireWorkspace(deps));

  app.get('/', (c) => {
    const ws = getWorkspace(c);
    return c.json({ spaces: spaces.list(ws.workspaceId) });
  });

  app.post('/', async (c) => {
    const ws = getWorkspace(c);
    const body = createSchema.parse(await c.req.json());
    const created = spaces.create(
      { workspaceId: ws.workspaceId, userId: ws.user.id },
      body,
    );
    deps.bus?.publish(REALTIME_ROOMS.workspace(ws.workspaceId), REALTIME_EVENTS.SPACE_CREATED, {
      spaceId: created.id,
      space: created,
    });
    return c.json({ space: created }, 201);
  });

  app.get('/:id', (c) => {
    const ws = getWorkspace(c);
    return c.json({ space: spaces.get(ws.workspaceId, c.req.param('id')) });
  });

  app.patch('/:id', async (c) => {
    const ws = getWorkspace(c);
    const body = updateSchema.parse(await c.req.json());
    const updated = spaces.update(
      { workspaceId: ws.workspaceId, userId: ws.user.id },
      c.req.param('id'),
      body,
    );
    deps.bus?.publish(REALTIME_ROOMS.workspace(ws.workspaceId), REALTIME_EVENTS.SPACE_UPDATED, {
      spaceId: updated.id,
      space: updated,
    });
    return c.json({ space: updated });
  });

  app.delete('/:id', (c) => {
    const ws = getWorkspace(c);
    const spaceId = c.req.param('id');
    spaces.delete({ workspaceId: ws.workspaceId, userId: ws.user.id }, spaceId);
    deps.bus?.publish(REALTIME_ROOMS.workspace(ws.workspaceId), REALTIME_EVENTS.SPACE_DELETED, { spaceId });
    return c.json({ ok: true });
  });

  return app;
}

export type { SpaceDto } from '../services/spaces.js';
