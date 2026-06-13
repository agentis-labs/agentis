import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { and, eq } from 'drizzle-orm';
import { AgentisError, CONSTANTS, REALTIME_EVENTS, REALTIME_ROOMS } from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { AuthService } from '../services/auth.js';
import type { Logger } from '../logger.js';
import type { EventBus } from '../event-bus.js';
import { requireAuth } from '../middleware/auth.js';
import { requireWorkspace, getWorkspace } from '../middleware/workspace.js';
import { z } from 'zod';
import type { AdapterManager } from '../adapters/AdapterManager.js';

export interface SpaceRoutesDeps {
  db: AgentisSqliteDb;
  auth: AuthService;
  logger: Logger;
  adapters: AdapterManager;
  bus?: EventBus;
}

const createSpaceSchema = z.object({
  name: z.string().min(1).max(120),
  slug: z.string().min(1).max(120),
  description: z.string().max(240).nullish(),
  colorHex: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullish(),
  iconEmoji: z.string().max(8).nullish(),
  managerId: z.string().nullish(),
});

const updateSpaceSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  slug: z.string().min(1).max(120).optional(),
  description: z.string().max(240).nullish().optional(),
  colorHex: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullish().optional(),
  iconEmoji: z.string().max(8).nullish().optional(),
  managerId: z.string().nullish().optional(),
});

export function buildSpaceRoutes(deps: SpaceRoutesDeps) {
  const app = new Hono<{ Variables: { user: { id: string } } }>();
  app.use('*', requireAuth(deps), requireWorkspace(deps));

  app.get('/', async (c) => {
    const ws = getWorkspace(c);
    const spaces = deps.db
      .select()
      .from(schema.spaces)
      .where(eq(schema.spaces.workspaceId, ws.workspaceId))
      .all();
    return c.json({ data: spaces });
  });

  app.post('/', async (c) => {
    const ws = getWorkspace(c);
    const bodyRaw = await c.req.json();
    const result = createSpaceSchema.safeParse(bodyRaw);
    if (!result.success) {
      throw new AgentisError('VALIDATION_FAILED', 'Invalid space input');
    }
    const data = result.data;
    const user = c.get('user');

    if (data.managerId) {
      const manager = deps.db
        .select({ id: schema.agents.id })
        .from(schema.agents)
        .where(and(eq(schema.agents.id, data.managerId), eq(schema.agents.workspaceId, ws.workspaceId)))
        .get();
      if (!manager) {
        throw new AgentisError('RESOURCE_NOT_FOUND', 'Manager agent not found');
      }
    }

    const id = randomUUID();
    const now = new Date().toISOString();

    deps.db
      .insert(schema.spaces)
      .values({
        id,
        workspaceId: ws.workspaceId,
        userId: user.id,
        name: data.name,
        slug: data.slug,
        description: data.description ?? null,
        colorHex: data.colorHex ?? null,
        iconEmoji: data.iconEmoji ?? null,
        managerId: data.managerId ?? null,
        createdAt: now,
        updatedAt: now,
      })
      .run();

    if (data.managerId) {
      deps.db
        .update(schema.agents)
        .set({ spaceId: id, spaceTag: tagForSpace(data.name), updatedAt: now })
        .where(and(eq(schema.agents.id, data.managerId), eq(schema.agents.workspaceId, ws.workspaceId)))
        .run();
    }

    deps.bus?.publish(REALTIME_ROOMS.workspace(ws.workspaceId), REALTIME_EVENTS.SPACE_CREATED, {
      workspaceId: ws.workspaceId,
      spaceId: id,
    });

    const space = deps.db
      .select()
      .from(schema.spaces)
      .where(and(eq(schema.spaces.id, id), eq(schema.spaces.workspaceId, ws.workspaceId)))
      .get();
    return c.json({ data: space });
  });

  app.get('/:id', async (c) => {
    const ws = getWorkspace(c);
    const id = c.req.param('id');
    const space = deps.db
      .select()
      .from(schema.spaces)
      .where(and(eq(schema.spaces.id, id), eq(schema.spaces.workspaceId, ws.workspaceId)))
      .get();
    if (!space) throw new AgentisError('RESOURCE_NOT_FOUND', 'Space not found');
    return c.json({ data: space });
  });

  app.get('/:id/agents', async (c) => {
    const ws = getWorkspace(c);
    const id = c.req.param('id');
    const space = deps.db
      .select({ id: schema.spaces.id })
      .from(schema.spaces)
      .where(and(eq(schema.spaces.id, id), eq(schema.spaces.workspaceId, ws.workspaceId)))
      .get();
    if (!space) throw new AgentisError('RESOURCE_NOT_FOUND', 'Space not found');
    const agents = deps.db
      .select()
      .from(schema.agents)
      .where(and(eq(schema.agents.workspaceId, ws.workspaceId), eq(schema.agents.spaceId, id)))
      .all();
    return c.json({ data: agents });
  });

  app.patch('/:id', async (c) => {
    const ws = getWorkspace(c);
    const id = c.req.param('id');
    const bodyRaw = await c.req.json();
    const result = updateSpaceSchema.safeParse(bodyRaw);
    if (!result.success) {
      throw new AgentisError('VALIDATION_FAILED', 'Invalid space input');
    }
    const data = result.data;

    const space = deps.db
      .select()
      .from(schema.spaces)
      .where(and(eq(schema.spaces.id, id), eq(schema.spaces.workspaceId, ws.workspaceId)))
      .get();
    if (!space) throw new AgentisError('RESOURCE_NOT_FOUND', 'Space not found');

    if (data.managerId) {
      const manager = deps.db
        .select({ id: schema.agents.id })
        .from(schema.agents)
        .where(and(eq(schema.agents.id, data.managerId), eq(schema.agents.workspaceId, ws.workspaceId)))
        .get();
      if (!manager) {
        throw new AgentisError('RESOURCE_NOT_FOUND', 'Manager agent not found');
      }
    }

    const updates: Partial<typeof schema.spaces.$inferInsert> = { updatedAt: new Date().toISOString() };
    if (data.name !== undefined) updates.name = data.name;
    if (data.slug !== undefined) updates.slug = data.slug;
    if (data.description !== undefined) updates.description = data.description ?? null;
    if (data.colorHex !== undefined) updates.colorHex = data.colorHex ?? null;
    if (data.iconEmoji !== undefined) updates.iconEmoji = data.iconEmoji ?? null;
    if (data.managerId !== undefined) updates.managerId = data.managerId ?? null;

    deps.db
      .update(schema.spaces)
      .set(updates)
      .where(and(eq(schema.spaces.id, id), eq(schema.spaces.workspaceId, ws.workspaceId)))
      .run();

    const nextName = data.name ?? space.name;
    const nextManagerId = data.managerId === undefined ? space.managerId : data.managerId ?? null;
    if (space.managerId && space.managerId !== nextManagerId) {
      deps.db
        .update(schema.agents)
        .set({ spaceId: null, spaceTag: null, updatedAt: new Date().toISOString() })
        .where(and(eq(schema.agents.id, space.managerId), eq(schema.agents.workspaceId, ws.workspaceId), eq(schema.agents.spaceId, id)))
        .run();
    }
    if (nextManagerId) {
      deps.db
        .update(schema.agents)
        .set({ spaceId: id, spaceTag: tagForSpace(nextName), updatedAt: new Date().toISOString() })
        .where(and(eq(schema.agents.id, nextManagerId), eq(schema.agents.workspaceId, ws.workspaceId)))
        .run();
    }
    if (data.name !== undefined) {
      deps.db
        .update(schema.agents)
        .set({ spaceTag: tagForSpace(nextName), updatedAt: new Date().toISOString() })
        .where(and(eq(schema.agents.workspaceId, ws.workspaceId), eq(schema.agents.spaceId, id)))
        .run();
    }

    deps.bus?.publish(REALTIME_ROOMS.workspace(ws.workspaceId), REALTIME_EVENTS.SPACE_UPDATED, {
      workspaceId: ws.workspaceId,
      spaceId: id,
    });

    const updated = deps.db
      .select()
      .from(schema.spaces)
      .where(and(eq(schema.spaces.id, id), eq(schema.spaces.workspaceId, ws.workspaceId)))
      .get();
    return c.json({ data: updated });
  });

  app.delete('/:id', async (c) => {
    const ws = getWorkspace(c);
    const id = c.req.param('id');
    const space = deps.db
      .select()
      .from(schema.spaces)
      .where(and(eq(schema.spaces.id, id), eq(schema.spaces.workspaceId, ws.workspaceId)))
      .get();
    if (!space) throw new AgentisError('RESOURCE_NOT_FOUND', 'Space not found');

    deps.db
      .update(schema.agents)
      .set({ spaceId: null, spaceTag: null, updatedAt: new Date().toISOString() })
      .where(and(eq(schema.agents.workspaceId, ws.workspaceId), eq(schema.agents.spaceId, id)))
      .run();
    deps.db
      .update(schema.workflows)
      .set({ spaceId: null, updatedAt: new Date().toISOString() })
      .where(and(eq(schema.workflows.workspaceId, ws.workspaceId), eq(schema.workflows.spaceId, id)))
      .run();
    deps.db
      .delete(schema.spaces)
      .where(and(eq(schema.spaces.id, id), eq(schema.spaces.workspaceId, ws.workspaceId)))
      .run();

    deps.bus?.publish(REALTIME_ROOMS.workspace(ws.workspaceId), REALTIME_EVENTS.SPACE_DELETED, {
      workspaceId: ws.workspaceId,
      spaceId: id,
    });

    return c.json({ success: true });
  });

  app.post('/:id/dispatch', async (c) => {
    const ws = getWorkspace(c);
    const id = c.req.param('id');
    const body = await c.req.json();

    const prompt = body.prompt;
    if (typeof prompt !== 'string' || !prompt.trim()) {
      throw new AgentisError('VALIDATION_FAILED', 'prompt is required');
    }

    const space = deps.db
      .select()
      .from(schema.spaces)
      .where(and(eq(schema.spaces.id, id), eq(schema.spaces.workspaceId, ws.workspaceId)))
      .get();
    if (!space) throw new AgentisError('RESOURCE_NOT_FOUND', 'Space not found');
    if (!space.managerId) throw new AgentisError('VALIDATION_FAILED', 'Space has no manager to dispatch to');

    const taskId = randomUUID();
    await deps.adapters.dispatchTask({
      taskId,
      runId: '', // Dispatched directly, not part of a workflow run
      workflowId: '',
      nodeId: '',
      title: `Space Task: ${space.name}`,
      description: prompt,
      inputData: body.inputData ?? {},
      scratchpadSnapshot: {},
      capabilityTags: [],
      timeoutMs: CONSTANTS.AGENT_TASK_RESPONSE_TIMEOUT_MS,
    }, space.managerId);

    return c.json({ data: { taskId } });
  });

  return app;
}

function tagForSpace(name: string): string {
  return name.trim().slice(0, 80);
}
