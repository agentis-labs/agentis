/**
 * /v1/harness — agent transition & import (AGENT-TRANSITION §8).
 *
 *   GET  /agents           → enumerate external agents on this machine (roster)
 *   POST /agents/preview    → identity + scope-routed memory candidates for one
 *   POST /import            → batch: commission (or reuse) + scoped memory ingest
 *
 * Mounted alongside `buildHarnessRoutes` at the same base path; the paths do not
 * collide with /detect, /install, /test, /models.
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { AgentisError } from '@agentis/core';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { AuthService } from '../services/auth.js';
import { requireAuth } from '../middleware/auth.js';
import { requireWorkspace, getWorkspace } from '../middleware/workspace.js';
import {
  discoverImportableAgents,
  previewAgentImport,
  importAgents,
  checkImportUpdates,
  type HarnessImportDeps,
} from '../services/harness/harnessAgentImport.js';

export interface HarnessImportRoutesDeps extends HarnessImportDeps {
  db: AgentisSqliteDb;
  auth: AuthService;
}

const previewSchema = z.object({
  externalId: z.string().min(1),
  cwd: z.string().nullish(),
  minQuality: z.number().min(0).max(1).optional(),
});

const importSchema = z.object({
  cwd: z.string().nullish(),
  agents: z.array(z.object({
    externalId: z.string().min(1),
    overrides: z.object({
      name: z.string().min(1).max(120).optional(),
      role: z.string().max(120).nullish(),
      reportsTo: z.string().nullish(),
    }).optional(),
    acceptedHashes: z.array(z.string()).optional(),
    acceptedSkillPaths: z.array(z.string()).optional(),
    minQuality: z.number().min(0).max(1).optional(),
  })).min(1).max(50),
});

export function buildHarnessImportRoutes(deps: HarnessImportRoutesDeps) {
  const app = new Hono();
  app.use('*', requireAuth(deps), requireWorkspace(deps));

  app.get('/agents', async (c) => {
    const ws = getWorkspace(c);
    const cwd = c.req.query('cwd') || null;
    const agents = await discoverImportableAgents(deps, ws.workspaceId, { cwd });
    return c.json({ agents });
  });

  // P4 continuous transition: how much new memory have imported agents
  // accumulated? Read-only; the operator pulls via POST /import (idempotent).
  app.get('/import/updates', async (c) => {
    const ws = getWorkspace(c);
    const cwd = c.req.query('cwd') || null;
    const updates = await checkImportUpdates(deps, ws.workspaceId, { cwd });
    return c.json({ updates });
  });

  app.post('/agents/preview', async (c) => {
    const ws = getWorkspace(c);
    const body = previewSchema.parse(await c.req.json());
    try {
      const preview = await previewAgentImport(deps, ws.workspaceId, body.externalId, {
        cwd: body.cwd ?? null,
        minQuality: body.minQuality,
      });
      return c.json(preview);
    } catch (err) {
      throw new AgentisError('RESOURCE_NOT_FOUND', err instanceof Error ? err.message : 'agent not found');
    }
  });

  app.post('/import', async (c) => {
    const ws = getWorkspace(c);
    const body = importSchema.parse(await c.req.json());
    const result = await importAgents(deps, {
      workspaceId: ws.workspaceId,
      userId: ws.user.id,
      cwd: body.cwd ?? null,
      specs: body.agents.map((a) => ({
        externalId: a.externalId,
        overrides: a.overrides ? { name: a.overrides.name, role: a.overrides.role ?? undefined, reportsTo: a.overrides.reportsTo ?? undefined } : undefined,
        acceptedHashes: a.acceptedHashes,
        acceptedSkillPaths: a.acceptedSkillPaths,
        minQuality: a.minQuality,
      })),
    });
    return c.json(result);
  });

  return app;
}
