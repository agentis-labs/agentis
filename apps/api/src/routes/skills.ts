/**
 * /v1/skills — V1-SPEC §3.3 spec-named entry point.
 *
 * Lists workspace-scoped skills + accepts local manifest installs (no
 * registry round-trip). Registry-installed skills land here via
 * the install pipeline in routes/skillRegistry.ts.
 */

import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { CONSTANTS } from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { AuthService } from '../services/auth.js';
import { requireAuth } from '../middleware/auth.js';
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
