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

export interface DomainRoutesDeps {
  db: AgentisSqliteDb;
  auth: AuthService;
  logger: Logger;
  adapters: AdapterManager;
  bus?: EventBus;
}

const createDomainSchema = z.object({
  name: z.string().min(1).max(120),
  slug: z.string().min(1).max(120),
  description: z.string().max(240).nullish(),
  colorHex: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullish(),
  iconEmoji: z.string().max(8).nullish(),
  managerId: z.string().nullish(),
  /** When set, this domain is a Subdomain nested under the referenced parent Domain. */
  parentDomainId: z.string().nullish(),
});

const updateDomainSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  slug: z.string().min(1).max(120).optional(),
  description: z.string().max(240).nullish().optional(),
  colorHex: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullish().optional(),
  iconEmoji: z.string().max(8).nullish().optional(),
  managerId: z.string().nullish().optional(),
  parentDomainId: z.string().nullish().optional(),
});

export function buildDomainRoutes(deps: DomainRoutesDeps) {
  const app = new Hono<{ Variables: { user: { id: string } } }>();
  app.use('*', requireAuth(deps), requireWorkspace(deps));

  app.get('/', async (c) => {
    const ws = getWorkspace(c);
    const domains = deps.db
      .select()
      .from(schema.domains)
      .where(eq(schema.domains.workspaceId, ws.workspaceId))
      .all();
    return c.json({ data: domains });
  });

  app.post('/', async (c) => {
    const ws = getWorkspace(c);
    const bodyRaw = await c.req.json();
    const result = createDomainSchema.safeParse(bodyRaw);
    if (!result.success) {
      throw new AgentisError('VALIDATION_FAILED', 'Invalid domain input');
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

    // Subdomains nest under a top-level Domain. Resolve the parent's manager so
    // the owning specialist reports to it (keeps the canvas hierarchy coherent).
    let parent: { id: string; managerId: string | null } | undefined;
    if (data.parentDomainId) {
      parent = deps.db
        .select({ id: schema.domains.id, managerId: schema.domains.managerId })
        .from(schema.domains)
        .where(and(eq(schema.domains.id, data.parentDomainId), eq(schema.domains.workspaceId, ws.workspaceId)))
        .get();
      if (!parent) throw new AgentisError('RESOURCE_NOT_FOUND', 'Parent domain not found');
    }

    const id = randomUUID();
    const now = new Date().toISOString();

    deps.db
      .insert(schema.domains)
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
        parentDomainId: data.parentDomainId ?? null,
        createdAt: now,
        updatedAt: now,
      })
      .run();

    if (data.managerId) {
      // A subdomain's manager is its responsible specialist — also point it at
      // the parent domain's manager via reports_to.
      const set: Partial<typeof schema.agents.$inferInsert> = { spaceId: id, spaceTag: tagForDomain(data.name), updatedAt: now };
      if (parent?.managerId) set.reportsTo = parent.managerId;
      deps.db
        .update(schema.agents)
        .set(set)
        .where(and(eq(schema.agents.id, data.managerId), eq(schema.agents.workspaceId, ws.workspaceId)))
        .run();
    }

    deps.bus?.publish(REALTIME_ROOMS.workspace(ws.workspaceId), REALTIME_EVENTS.SPACE_CREATED, {
      workspaceId: ws.workspaceId,
      spaceId: id,
    });

    const domain = deps.db
      .select()
      .from(schema.domains)
      .where(and(eq(schema.domains.id, id), eq(schema.domains.workspaceId, ws.workspaceId)))
      .get();
    return c.json({ data: domain });
  });

  app.get('/:id', async (c) => {
    const ws = getWorkspace(c);
    const id = c.req.param('id');
    const domain = deps.db
      .select()
      .from(schema.domains)
      .where(and(eq(schema.domains.id, id), eq(schema.domains.workspaceId, ws.workspaceId)))
      .get();
    if (!domain) throw new AgentisError('RESOURCE_NOT_FOUND', 'Domain not found');
    return c.json({ data: domain });
  });

  app.get('/:id/agents', async (c) => {
    const ws = getWorkspace(c);
    const id = c.req.param('id');
    const domain = deps.db
      .select({ id: schema.domains.id })
      .from(schema.domains)
      .where(and(eq(schema.domains.id, id), eq(schema.domains.workspaceId, ws.workspaceId)))
      .get();
    if (!domain) throw new AgentisError('RESOURCE_NOT_FOUND', 'Domain not found');
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
    const result = updateDomainSchema.safeParse(bodyRaw);
    if (!result.success) {
      throw new AgentisError('VALIDATION_FAILED', 'Invalid domain input');
    }
    const data = result.data;

    const domain = deps.db
      .select()
      .from(schema.domains)
      .where(and(eq(schema.domains.id, id), eq(schema.domains.workspaceId, ws.workspaceId)))
      .get();
    if (!domain) throw new AgentisError('RESOURCE_NOT_FOUND', 'Domain not found');

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

    const nextParentDomainId = data.parentDomainId === undefined ? domain.parentDomainId : data.parentDomainId ?? null;
    let parent: { id: string; managerId: string | null } | undefined;
    if (data.parentDomainId) {
      parent = deps.db
        .select({ id: schema.domains.id, managerId: schema.domains.managerId })
        .from(schema.domains)
        .where(and(eq(schema.domains.id, data.parentDomainId), eq(schema.domains.workspaceId, ws.workspaceId)))
        .get();
      if (!parent) throw new AgentisError('RESOURCE_NOT_FOUND', 'Parent domain not found');
    } else if (nextParentDomainId) {
      parent = deps.db
        .select({ id: schema.domains.id, managerId: schema.domains.managerId })
        .from(schema.domains)
        .where(and(eq(schema.domains.id, nextParentDomainId), eq(schema.domains.workspaceId, ws.workspaceId)))
        .get();
    }

    const updates: Partial<typeof schema.domains.$inferInsert> = { updatedAt: new Date().toISOString() };
    if (data.name !== undefined) updates.name = data.name;
    if (data.slug !== undefined) updates.slug = data.slug;
    if (data.description !== undefined) updates.description = data.description ?? null;
    if (data.colorHex !== undefined) updates.colorHex = data.colorHex ?? null;
    if (data.iconEmoji !== undefined) updates.iconEmoji = data.iconEmoji ?? null;
    if (data.managerId !== undefined) updates.managerId = data.managerId ?? null;
    if (data.parentDomainId !== undefined) updates.parentDomainId = data.parentDomainId ?? null;

    deps.db
      .update(schema.domains)
      .set(updates)
      .where(and(eq(schema.domains.id, id), eq(schema.domains.workspaceId, ws.workspaceId)))
      .run();

    const nextName = data.name ?? domain.name;
    const nextManagerId = data.managerId === undefined ? domain.managerId : data.managerId ?? null;
    if (domain.managerId && domain.managerId !== nextManagerId) {
      deps.db
        .update(schema.agents)
        .set({ spaceId: null, spaceTag: null, updatedAt: new Date().toISOString() })
        .where(and(eq(schema.agents.id, domain.managerId), eq(schema.agents.workspaceId, ws.workspaceId), eq(schema.agents.spaceId, id)))
        .run();
    }
    if (nextManagerId) {
      // For a subdomain, also report its owning specialist to the parent's manager.
      const set: Partial<typeof schema.agents.$inferInsert> = { spaceId: id, spaceTag: tagForDomain(nextName), updatedAt: new Date().toISOString() };
      if (parent?.managerId) set.reportsTo = parent.managerId;
      deps.db
        .update(schema.agents)
        .set(set)
        .where(and(eq(schema.agents.id, nextManagerId), eq(schema.agents.workspaceId, ws.workspaceId)))
        .run();
    }
    if (data.name !== undefined) {
      deps.db
        .update(schema.agents)
        .set({ spaceTag: tagForDomain(nextName), updatedAt: new Date().toISOString() })
        .where(and(eq(schema.agents.workspaceId, ws.workspaceId), eq(schema.agents.spaceId, id)))
        .run();
    }

    deps.bus?.publish(REALTIME_ROOMS.workspace(ws.workspaceId), REALTIME_EVENTS.SPACE_UPDATED, {
      workspaceId: ws.workspaceId,
      spaceId: id,
    });

    const updated = deps.db
      .select()
      .from(schema.domains)
      .where(and(eq(schema.domains.id, id), eq(schema.domains.workspaceId, ws.workspaceId)))
      .get();
    return c.json({ data: updated });
  });

  app.delete('/:id', async (c) => {
    const ws = getWorkspace(c);
    const id = c.req.param('id');
    const domain = deps.db
      .select()
      .from(schema.domains)
      .where(and(eq(schema.domains.id, id), eq(schema.domains.workspaceId, ws.workspaceId)))
      .get();
    if (!domain) throw new AgentisError('RESOURCE_NOT_FOUND', 'Domain not found');

    // Deleting a Domain also removes its nested Subdomains. Detach agent/workflow
    // links for the domain and every subdomain, then delete them all.
    const subdomainIds = deps.db
      .select({ id: schema.domains.id })
      .from(schema.domains)
      .where(and(eq(schema.domains.workspaceId, ws.workspaceId), eq(schema.domains.parentDomainId, id)))
      .all()
      .map((row) => row.id);
    const affectedDomainIds = [id, ...subdomainIds];
    const now = new Date().toISOString();
    for (const domainId of affectedDomainIds) {
      deps.db
        .update(schema.agents)
        .set({ spaceId: null, spaceTag: null, updatedAt: now })
        .where(and(eq(schema.agents.workspaceId, ws.workspaceId), eq(schema.agents.spaceId, domainId)))
        .run();
      deps.db
        .update(schema.workflows)
        .set({ spaceId: null, updatedAt: now })
        .where(and(eq(schema.workflows.workspaceId, ws.workspaceId), eq(schema.workflows.spaceId, domainId)))
        .run();
    }
    if (subdomainIds.length > 0) {
      deps.db
        .delete(schema.domains)
        .where(and(eq(schema.domains.workspaceId, ws.workspaceId), eq(schema.domains.parentDomainId, id)))
        .run();
    }
    deps.db
      .delete(schema.domains)
      .where(and(eq(schema.domains.id, id), eq(schema.domains.workspaceId, ws.workspaceId)))
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

    const domain = deps.db
      .select()
      .from(schema.domains)
      .where(and(eq(schema.domains.id, id), eq(schema.domains.workspaceId, ws.workspaceId)))
      .get();
    if (!domain) throw new AgentisError('RESOURCE_NOT_FOUND', 'Domain not found');
    if (!domain.managerId) throw new AgentisError('VALIDATION_FAILED', 'Domain has no manager to dispatch to');

    const taskId = randomUUID();
    await deps.adapters.dispatchTask({
      taskId,
      runId: '', // Dispatched directly, not part of a workflow run
      workflowId: '',
      nodeId: '',
      title: `Domain Task: ${domain.name}`,
      description: prompt,
      inputData: body.inputData ?? {},
      scratchpadSnapshot: {},
      capabilityTags: [],
      timeoutMs: CONSTANTS.AGENT_TASK_RESPONSE_TIMEOUT_MS,
    }, domain.managerId);

    return c.json({ data: { taskId } });
  });

  return app;
}

function tagForDomain(name: string): string {
  return name.trim().slice(0, 80);
}
