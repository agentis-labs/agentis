/**
 * /v1/listeners — EXTENSIONS-AND-LISTENER-10X §6.1.
 *
 * A listener is a persistent_listener trigger whose config is a ListenerConfig.
 * These routes are the operator's control + diagnostic surface: live health,
 * the recent event log, pause/resume, manual fire, and config updates.
 */

import { Hono, type Context } from 'hono';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { AgentisError, isListenerConfigV2, schemas } from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { AuthService } from '../services/auth.js';
import type { TriggerRuntime } from '../engine/TriggerRuntime.js';
import type { ActiveTrigger } from '../engine/ActiveWorkflowRegistry.js';
import { requireAuth } from '../middleware/auth.js';
import { requireWorkspace, getWorkspace } from '../middleware/workspace.js';

export function buildListenerRoutes(deps: { db: AgentisSqliteDb; auth: AuthService; runtime: TriggerRuntime }) {
  const app = new Hono();
  app.use('*', requireAuth(deps), requireWorkspace(deps));

  const fetchListener = (c: Context, id: string) => {
    const ws = getWorkspace(c);
    const row = deps.db
      .select()
      .from(schema.triggers)
      .where(and(eq(schema.triggers.id, id), eq(schema.triggers.workspaceId, ws.workspaceId)))
      .get();
    if (!row || row.triggerType !== 'persistent_listener') {
      throw new AgentisError('LISTENER_NOT_FOUND', `listener ${id} not found`);
    }
    return row;
  };

  const toActiveTrigger = (row: typeof schema.triggers.$inferSelect): ActiveTrigger => ({
    triggerId: row.id,
    workflowId: row.workflowId,
    workspaceId: row.workspaceId,
    ambientId: row.ambientId,
    userId: row.userId,
    triggerType: 'persistent_listener',
    config: (row.config ?? {}) as Record<string, unknown>,
  });

  app.get('/', (c) => {
    const ws = getWorkspace(c);
    const rows = deps.db
      .select()
      .from(schema.triggers)
      .where(and(eq(schema.triggers.workspaceId, ws.workspaceId), eq(schema.triggers.triggerType, 'persistent_listener')))
      .all();
    const listeners = rows.map(({ webhookSecret: _s, ...rest }) => ({
      ...rest,
      isV2: isListenerConfigV2(rest.config),
      health: deps.runtime.listeners?.health(rest.id) ?? null,
    }));
    return c.json({ listeners });
  });

  app.get('/:id', (c) => {
    const row = fetchListener(c, c.req.param('id'));
    const { webhookSecret: _s, ...rest } = row;
    return c.json({
      listener: { ...rest, isV2: isListenerConfigV2(rest.config) },
      health: deps.runtime.listeners?.health(row.id) ?? null,
    });
  });

  app.get('/:id/health', (c) => {
    const row = fetchListener(c, c.req.param('id'));
    const health = deps.runtime.listeners?.health(row.id);
    if (!health) throw new AgentisError('LISTENER_RUNTIME_UNAVAILABLE', 'listener is not active');
    return c.json({ health });
  });

  app.get('/:id/events', (c) => {
    const row = fetchListener(c, c.req.param('id'));
    const limit = Math.min(Number(c.req.query('limit') ?? 100) || 100, 100);
    return c.json({ events: deps.runtime.listeners?.events(row.id, limit) ?? [] });
  });

  app.delete('/:id/events', (c) => {
    const row = fetchListener(c, c.req.param('id'));
    deps.runtime.listeners?.clearEvents(row.id);
    return c.json({ ok: true });
  });

  app.post('/:id/pause', async (c) => {
    const row = fetchListener(c, c.req.param('id'));
    await deps.runtime.deactivate(row.id);
    deps.db.update(schema.triggers).set({ status: 'paused', updatedAt: new Date().toISOString() }).where(eq(schema.triggers.id, row.id)).run();
    return c.json({ ok: true, status: 'paused' });
  });

  app.post('/:id/resume', async (c) => {
    const row = fetchListener(c, c.req.param('id'));
    if (!isListenerConfigV2(row.config)) {
      throw new AgentisError('LISTENER_INVALID_CONFIG', 'listener config must declare a `source` before it can run');
    }
    await deps.runtime.activate(toActiveTrigger(row));
    deps.db.update(schema.triggers).set({ status: 'active', updatedAt: new Date().toISOString() }).where(eq(schema.triggers.id, row.id)).run();
    return c.json({ ok: true, status: 'active' });
  });

  app.post('/:id/fire-now', async (c) => {
    const row = fetchListener(c, c.req.param('id'));
    const runtime = deps.runtime.listeners;
    if (!runtime) throw new AgentisError('LISTENER_RUNTIME_UNAVAILABLE', 'listener runtime not wired');
    const body = await c.req.json().catch(() => ({}));
    const payload = body && typeof body === 'object' && 'payload' in body ? (body.payload as Record<string, unknown>) : undefined;
    const result = await runtime.fireNow(row.id, payload);
    return c.json({ ok: true, runId: result.runId });
  });

  app.patch('/:id', async (c) => {
    const row = fetchListener(c, c.req.param('id'));
    const body = z.object({ config: z.record(z.unknown()) }).parse(await c.req.json());
    const parsed = schemas.listenerConfigSchema.safeParse(body.config);
    if (!parsed.success) {
      throw new AgentisError('LISTENER_INVALID_CONFIG', 'Complete the listener configuration before saving it.', {
        details: { issues: parsed.error.issues },
      });
    }
    deps.db.update(schema.triggers).set({ config: parsed.data, updatedAt: new Date().toISOString() }).where(eq(schema.triggers.id, row.id)).run();
    // Reactivate with the new config if it was active.
    if (row.status === 'active') {
      await deps.runtime.activate(toActiveTrigger({ ...row, config: parsed.data }));
    }
    return c.json({ ok: true });
  });

  return app;
}
