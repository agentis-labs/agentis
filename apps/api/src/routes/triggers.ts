/**
 * /v1/triggers — CRUD plus activate/deactivate.
 *
 * Cron and persistent_listener triggers register against the runtime when
 * activated. Webhook triggers expose `webhookSecret` once at creation
 * (and never again) along with the URL the operator should configure on
 * their upstream system.
 */

import { randomBytes, randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { AgentisError } from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { AuthService } from '../services/auth.js';
import type { TriggerRuntime } from '../engine/TriggerRuntime.js';
import { requireAuth } from '../middleware/auth.js';
import { requireWorkspace, getWorkspace } from '../middleware/workspace.js';

const triggerTypeSchema = z.enum(['manual', 'cron', 'webhook', 'persistent_listener']);

const createSchema = z.object({
  workflowId: z.string(),
  triggerType: triggerTypeSchema,
  config: z.record(z.unknown()).default({}),
  ambientId: z.string().nullish(),
});

const updateSchema = z.object({
  config: z.record(z.unknown()).optional(),
  status: z.enum(['active', 'paused']).optional(),
});

export function buildTriggerRoutes(deps: {
  db: AgentisSqliteDb;
  auth: AuthService;
  runtime: TriggerRuntime;
}) {
  const app = new Hono();
  app.use('*', requireAuth(deps), requireWorkspace(deps));

  app.get('/', (c) => {
    const ws = getWorkspace(c);
    const rows = deps.db
      .select()
      .from(schema.triggers)
      .where(eq(schema.triggers.workspaceId, ws.workspaceId))
      .all();
    // Strip webhookSecret from list responses.
    return c.json({ triggers: rows.map(({ webhookSecret: _s, ...rest }) => rest) });
  });

  app.post('/', async (c) => {
    const ws = getWorkspace(c);
    const body = createSchema.parse(await c.req.json());
    // Verify workflow ownership.
    const wf = deps.db.select().from(schema.workflows).where(eq(schema.workflows.id, body.workflowId)).get();
    if (!wf || wf.workspaceId !== ws.workspaceId) {
      throw new AgentisError('RESOURCE_NOT_FOUND', `workflow ${body.workflowId} not found`);
    }
    const id = randomUUID();
    const webhookSecret = body.triggerType === 'webhook' ? randomBytes(32).toString('base64url') : null;
    deps.db
      .insert(schema.triggers)
      .values({
        id,
        workspaceId: ws.workspaceId,
        ambientId: body.ambientId ?? null,
        workflowId: body.workflowId,
        userId: ws.user.id,
        triggerType: body.triggerType,
        config: body.config,
        status: 'paused',
        webhookSecret,
      })
      .run();
    return c.json(
      {
        id,
        triggerType: body.triggerType,
        // Surface secret only on creation.
        ...(webhookSecret ? { webhookSecret } : {}),
        webhookUrl: body.triggerType === 'webhook' ? `/v1/webhooks/trigger/${id}` : undefined,
      },
      201,
    );
  });

  app.patch('/:id', async (c) => {
    const ws = getWorkspace(c);
    const id = c.req.param('id');
    const body = updateSchema.parse(await c.req.json());
    const existing = deps.db
      .select()
      .from(schema.triggers)
      .where(and(eq(schema.triggers.id, id), eq(schema.triggers.workspaceId, ws.workspaceId)))
      .get();
    if (!existing) throw new AgentisError('RESOURCE_NOT_FOUND', 'trigger not found');
    if (body.config) {
      deps.db
        .update(schema.triggers)
        .set({ config: body.config, updatedAt: new Date().toISOString() })
        .where(eq(schema.triggers.id, id))
        .run();
    }
    if (body.status) {
      const fresh = deps.db.select().from(schema.triggers).where(eq(schema.triggers.id, id)).get()!;
      if (body.status === 'active') {
        await deps.runtime.activate({
          triggerId: fresh.id,
          workflowId: fresh.workflowId,
          workspaceId: fresh.workspaceId,
          ambientId: fresh.ambientId,
          userId: fresh.userId,
          triggerType: fresh.triggerType as 'manual' | 'cron' | 'webhook' | 'persistent_listener',
          config: (fresh.config ?? {}) as Record<string, unknown>,
        });
      } else {
        await deps.runtime.deactivate(fresh.id);
      }
    }
    return c.json({ ok: true });
  });

  app.delete('/:id', async (c) => {
    const ws = getWorkspace(c);
    const id = c.req.param('id');
    const existing = deps.db
      .select()
      .from(schema.triggers)
      .where(and(eq(schema.triggers.id, id), eq(schema.triggers.workspaceId, ws.workspaceId)))
      .get();
    if (!existing) throw new AgentisError('RESOURCE_NOT_FOUND', 'trigger not found');
    await deps.runtime.deactivate(id).catch(() => {});
    deps.db.delete(schema.triggers).where(eq(schema.triggers.id, id)).run();
    return c.json({ ok: true });
  });

  return app;
}
