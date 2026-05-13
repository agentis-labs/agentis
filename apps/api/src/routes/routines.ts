import { Hono } from 'hono';
import { z } from 'zod';
import { AgentisError } from '@agentis/core';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { AuthService } from '../services/auth.js';
import type { RoutineService } from '../services/routines.js';
import { requireAuth } from '../middleware/auth.js';
import { requireWorkspace, getWorkspace } from '../middleware/workspace.js';

const routineSchema = z.object({
  workflowId: z.string().uuid(),
  title: z.string().trim().min(1).max(255),
  description: z.string().max(4000).nullable().optional(),
  status: z.enum(['active', 'paused', 'archived']).optional(),
  variables: z.record(z.string(), z.unknown()).optional(),
});
const updateRoutineSchema = routineSchema.omit({ workflowId: true }).partial().extend({ concurrencyPolicy: z.string().optional(), catchUpPolicy: z.string().optional() });
const fireSchema = z.object({ variables: z.record(z.string(), z.unknown()).optional() });

export function buildRoutineRoutes(deps: { db: AgentisSqliteDb; auth: AuthService; routines: RoutineService }) {
  const app = new Hono();
  app.use('*', requireAuth(deps), requireWorkspace(deps));

  app.get('/', (c) => c.json({ routines: deps.routines.list(getWorkspace(c).workspaceId) }));

  app.post('/', async (c) => {
    const ws = getWorkspace(c);
    const body = routineSchema.parse(await c.req.json());
    const routine = deps.routines.create({ workspaceId: ws.workspaceId, userId: ws.user.id, ...body });
    return c.json({ routine }, 201);
  });

  app.get('/:id', (c) => {
    const ws = getWorkspace(c);
    const routine = deps.routines.get(ws.workspaceId, c.req.param('id'));
    if (!routine) throw new AgentisError('RESOURCE_NOT_FOUND', 'Routine not found');
    return c.json({ routine });
  });

  app.patch('/:id', async (c) => {
    const ws = getWorkspace(c);
    const routine = deps.routines.update(ws.workspaceId, c.req.param('id'), updateRoutineSchema.parse(await c.req.json()));
    if (!routine) throw new AgentisError('RESOURCE_NOT_FOUND', 'Routine not found');
    return c.json({ routine });
  });

  app.post('/:id/fire', async (c) => {
    const ws = getWorkspace(c);
    const body = fireSchema.parse(await c.req.json().catch(() => ({})));
    const run = await deps.routines.fire({ workspaceId: ws.workspaceId, userId: ws.user.id, routineId: c.req.param('id'), overrideVariables: body.variables });
    if (!run) throw new AgentisError('RESOURCE_NOT_FOUND', 'Routine not found');
    return c.json(run, 202);
  });

  return app;
}
