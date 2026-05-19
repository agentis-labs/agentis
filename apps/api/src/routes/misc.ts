/**
 * Misc resource routes — skills, activity, approvals, agents, gateways, dashboard.
 *
 * V1 surfaces are minimal CRUD; the engine + dashboard exercise them through
 * the realtime channel for the parts that matter at run time.
 */

import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { AgentisError, CONSTANTS } from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { AuthService } from '../services/auth.js';
import type { ActivityFeedService } from '../services/activityFeed.js';
import type { ApprovalInboxService } from '../services/approvalInbox.js';
import { requireAuth, getUser } from '../middleware/auth.js';
import { requireWorkspace, getWorkspace } from '../middleware/workspace.js';

const installLocalSkillSchema = z.object({
  manifest: z.object({
    name: z.string().min(1),
    slug: z.string().min(1),
    version: z.string().min(1),
    runtime: z.enum(['node_worker', 'docker_sandbox']),
    entrypoint: z.string(),
    capabilityTags: z.array(z.string()).default([]),
    inputSchema: z.record(z.unknown()).default({}),
    outputSchema: z.record(z.unknown()).default({}),
    timeoutMs: z.number().int().positive().max(CONSTANTS.SKILL_EXECUTION_MAX_TIMEOUT_MS).optional(),
  }),
});

export function buildSkillRoutes(deps: { db: AgentisSqliteDb; auth: AuthService }) {
  const app = new Hono();
  app.use('*', requireAuth(deps), requireWorkspace(deps));
  app.get('/', (c) => {
    const ws = getWorkspace(c);
    return c.json({
      skills: deps.db
        .select()
        .from(schema.skills)
        .where(eq(schema.skills.workspaceId, ws.workspaceId))
        .all(),
    });
  });

  // POST /v1/skills/install-local — register a single skill manifest from
  // disk (no registry round-trip). Builtin runtime is rejected; only Nexseed
  // ships builtins. The runtime is not pre-validated for sandbox availability
  // — that check happens lazily at first execution.
  app.post('/install-local', async (c) => {
    const ws = getWorkspace(c);
    const body = installLocalSkillSchema.parse(await c.req.json());
    const m = body.manifest;
    const id = randomUUID();
    deps.db
      .insert(schema.skills)
      .values({
        id,
        workspaceId: ws.workspaceId,
        ambientId: ws.ambientId,
        userId: ws.user.id,
        packageId: null,
        name: m.name,
        slug: m.slug,
        version: m.version,
        runtime: m.runtime,
        manifest: m,
      })
      .run();
    return c.json({ skill: { id, slug: m.slug, name: m.name, runtime: m.runtime } }, 201);
  });

  return app;
}

export function buildActivityRoutes(deps: {
  db: AgentisSqliteDb;
  auth: AuthService;
  activity: ActivityFeedService;
}) {
  const app = new Hono();
  app.use('*', requireAuth(deps), requireWorkspace(deps));
  app.get('/', (c) => {
    const ws = getWorkspace(c);
    const limit = Number(c.req.query('limit') ?? 100);
    return c.json({ events: deps.activity.list(ws.workspaceId, limit) });
  });
  return app;
}

export function buildApprovalRoutes(deps: {
  db: AgentisSqliteDb;
  auth: AuthService;
  approvals: ApprovalInboxService;
}) {
  const app = new Hono();
  app.use('*', requireAuth(deps), requireWorkspace(deps));
  app.get('/', (c) => {
    const ws = getWorkspace(c);
    const status = (c.req.query('status') ?? 'pending') as 'pending' | 'all';
    return c.json({ approvals: deps.approvals.list(ws.workspaceId, status) });
  });
  app.post('/:id/resolve', async (c) => {
    const ws = getWorkspace(c);
    const id = c.req.param('id');
    const body = (await c.req.json().catch(() => ({}))) as {
      decision?: 'approve' | 'reject';
      reason?: string;
    };
    if (body.decision !== 'approve' && body.decision !== 'reject') {
      throw new AgentisError('VALIDATION_FAILED', 'decision must be approve|reject');
    }
    const result = await deps.approvals.resolve({
      workspaceId: ws.workspaceId,
      approvalId: id,
      decision: body.decision,
      reason: body.reason,
    });
    return c.json({ approval: result });
  });
  return app;
}

export function buildDashboardRoutes(deps: { db: AgentisSqliteDb; auth: AuthService }) {
  const app = new Hono();
  app.use('*', requireAuth(deps), requireWorkspace(deps));
  app.get('/fleet-overview', (c) => {
    const ws = getWorkspace(c);
    const agents = deps.db
      .select()
      .from(schema.agents)
      .where(eq(schema.agents.workspaceId, ws.workspaceId))
      .all();
    const gateways = deps.db
      .select()
      .from(schema.openclawGateways)
      .where(eq(schema.openclawGateways.workspaceId, ws.workspaceId))
      .all();
    const runs = deps.db
      .select()
      .from(schema.workflowRuns)
      .where(eq(schema.workflowRuns.workspaceId, ws.workspaceId))
      .all();
    const workflows = deps.db
      .select()
      .from(schema.workflows)
      .where(eq(schema.workflows.workspaceId, ws.workspaceId))
      .all();
    const approvals = deps.db
      .select()
      .from(schema.approvalRequests)
      .where(
        and(
          eq(schema.approvalRequests.workspaceId, ws.workspaceId),
          eq(schema.approvalRequests.status, 'pending'),
        ),
      )
      .all();

    const activeRuns = runs.filter((r) => r.status === 'RUNNING');
    const recentRuns = runs
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
      .slice(0, 10);

    return c.json({
      agents: { total: agents.length, online: agents.filter((a) => a.status === 'online').length },
      gateways: {
        total: gateways.length,
        connected: gateways.filter((g) => g.status === 'connected').length,
      },
      workflows: { total: workflows.length },
      runs: { active: activeRuns.length, total: runs.length, recent: recentRuns },
      approvals: { pending: approvals.length },
      operator: getUser(c),
    });
  });
  return app;
}
