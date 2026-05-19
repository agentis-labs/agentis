/**
 * Spaces — business unit grouping (UIUX §23).
 *
 * GET    /v1/spaces                 list spaces
 * POST   /v1/spaces                 create
 * PATCH  /v1/spaces/:id             rename / change color / link team
 * DELETE /v1/spaces/:id             delete (apps fall back to General)
 * GET    /v1/spaces/:id/summary     aggregate per-window output metrics
 */

import { Hono } from 'hono';
import { and, eq, gte } from 'drizzle-orm';
import { z } from 'zod';
import { REALTIME_EVENTS, REALTIME_ROOMS } from '@agentis/core';
import { schema, type AgentisSqliteDb } from '@agentis/db/sqlite';
import type { AuthService } from '../services/auth.js';
import type { EventBus } from '../event-bus.js';
import { requireAuth } from '../middleware/auth.js';
import { getWorkspace, requireWorkspace } from '../middleware/workspace.js';
import { SpaceService } from '../services/spaces.js';
import { AppInstanceService } from '../services/appInstances.js';
import { aggregateOutputLabels } from '../services/outputLabels.js';

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

const windowSchema = z.enum(['24h', '7d', '30d']).default('7d');

function windowMs(window: string): number {
  switch (window) {
    case '24h':
      return 24 * 60 * 60 * 1000;
    case '7d':
      return 7 * 24 * 60 * 60 * 1000;
    case '30d':
      return 30 * 24 * 60 * 60 * 1000;
    default:
      return 7 * 24 * 60 * 60 * 1000;
  }
}

export function buildSpaceRoutes(deps: {
  db: AgentisSqliteDb;
  auth: AuthService;
  bus?: EventBus;
}) {
  const app = new Hono();
  const spaces = new SpaceService(deps.db);
  const apps = new AppInstanceService(deps.db);
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

  /**
   * Summary endpoint — orchestrator tool surface for §23.5.
   * Aggregates outputLabels across all apps in the space for the requested window.
   */
  app.get('/:id/summary', async (c) => {
    const ws = getWorkspace(c);
    const id = c.req.param('id');
    const space = spaces.get(ws.workspaceId, id);
    const window = windowSchema.parse(c.req.query('window') ?? '7d');
    const startedAfter = new Date(Date.now() - windowMs(window)).toISOString();

    const appList = apps.listBySpace(ws.workspaceId, id);
    const perApp: Array<{
      slug: string;
      name: string;
      outputs: Record<string, number>;
      runCount: number;
      successCount: number;
      failedCount: number;
      pendingApprovals: number;
      costMicros: number;
    }> = [];

    let combinedSuccess = 0;
    let combinedTotal = 0;
    let combinedCost = 0;

    const pendingApprovals = deps.db
      .select({ id: schema.approvalRequests.id })
      .from(schema.approvalRequests)
      .where(
        and(
          eq(schema.approvalRequests.workspaceId, ws.workspaceId),
          eq(schema.approvalRequests.status, 'pending'),
        ),
      )
      .all().length;

    for (const appInstance of appList) {
      const workflowIds: string[] = [];
      if (appInstance.entryWorkflowId) workflowIds.push(appInstance.entryWorkflowId);
      for (const wf of appInstance.contents.workflows) {
        const idGuess = (wf as { id?: string }).id;
        if (idGuess && !workflowIds.includes(idGuess)) workflowIds.push(idGuess);
      }
      const runs = workflowIds.length
        ? deps.db
            .select()
            .from(schema.workflowRuns)
            .where(
              and(
                eq(schema.workflowRuns.workspaceId, ws.workspaceId),
                gte(schema.workflowRuns.createdAt, startedAfter),
              ),
            )
            .all()
            .filter((r) => r.workflowId !== null && workflowIds.includes(r.workflowId))
        : [];

      const completed = runs.filter((r) => r.status === 'COMPLETED');
      const failed = runs.filter((r) => r.status === 'FAILED');
      const cost = 0;

      const labels = outputLabelsForApp(appInstance.contents.workflows);
      const outputs = aggregateOutputLabels(completed, labels);

      perApp.push({
        slug: appInstance.slug,
        name: appInstance.name,
        outputs,
        runCount: runs.length,
        successCount: completed.length,
        failedCount: failed.length,
        pendingApprovals: 0,
        costMicros: cost,
      });

      combinedSuccess += completed.length;
      combinedTotal += runs.length;
      combinedCost += cost;
    }

    return c.json({
      space,
      window,
      apps: perApp,
      combined: {
        successRate: combinedTotal > 0 ? combinedSuccess / combinedTotal : null,
        totalRuns: combinedTotal,
        totalCostMicros: combinedCost,
        pendingApprovals,
      },
    });
  });

  /** Move an app into / out of a space. */
  app.patch('/:id/apps/:slug', async (c) => {
    const ws = getWorkspace(c);
    const moved = apps.setSpace(
      { workspaceId: ws.workspaceId, userId: ws.user.id },
      c.req.param('slug'),
      c.req.param('id') === 'null' ? null : c.req.param('id'),
    );
    deps.bus?.publish(REALTIME_ROOMS.workspace(ws.workspaceId), REALTIME_EVENTS.APP_SPACE_CHANGED, {
      appSlug: moved.slug,
      spaceId: moved.spaceId ?? null,
    });
    return c.json({ app: moved });
  });

  return app;
}

export type { SpaceDto } from '../services/spaces.js';

function outputLabelsForApp(workflows: Array<{ settings?: unknown }>): string[] {
  const labels = new Set<string>();
  for (const workflow of workflows) {
    const settings =
      workflow.settings && typeof workflow.settings === 'object' && !Array.isArray(workflow.settings)
        ? workflow.settings as { outputLabels?: unknown }
        : null;
    if (!Array.isArray(settings?.outputLabels)) continue;
    for (const label of settings.outputLabels) {
      if (typeof label === 'string' && label.trim()) labels.add(label.trim());
    }
  }
  return [...labels];
}
