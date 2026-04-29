/**
 * /v1/packages — agent package CRUD + install-from-local-manifest.
 *
 * V1-SPEC §11. Registry-installed packages persist to
 * `installed_registry_artifacts` via /v1/skills/registry/install; this route
 * handles **local** packages (e.g. a developer authoring a package on disk
 * and installing it without going through the registry) and lists/get/delete
 * of installed packages regardless of source.
 *
 * Installing a package fans out into:
 *   - one `agent_packages` row,
 *   - one `skills` row per declared skill,
 *   - one `agents` row per declared agent (in `offline` state until the
 *     operator binds credentials),
 *   - one `workflows` row per declared template (graph copied verbatim).
 *
 * Skills declared inside a local package are forced to `node_worker` runtime
 * unless the manifest explicitly declares `builtin` (rejected for local
 * packages — only Nexseed-shipped builtins are trusted).
 */

import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { AgentisError, CONSTANTS } from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { AuthService } from '../services/auth.js';
import { requireAuth } from '../middleware/auth.js';
import { requireWorkspace, getWorkspace } from '../middleware/workspace.js';

const skillDefSchema = z.object({
  name: z.string().min(1),
  slug: z.string().min(1),
  version: z.string().min(1),
  runtime: z.enum(['builtin', 'node_worker', 'docker_sandbox']),
  entrypoint: z.string(),
  capabilityTags: z.array(z.string()).default([]),
  inputSchema: z.record(z.unknown()).default({}),
  outputSchema: z.record(z.unknown()).default({}),
  timeoutMs: z.number().int().positive().max(CONSTANTS.SKILL_EXECUTION_MAX_TIMEOUT_MS).optional(),
});

const agentDefSchema = z.object({
  name: z.string().min(1),
  adapterType: z.enum(['openclaw', 'claude_code', 'http']),
  capabilityTags: z.array(z.string()).default([]),
  defaultConfig: z.record(z.unknown()).default({}),
});

const templateDefSchema = z.object({
  name: z.string().min(1),
  slug: z.string().min(1),
  summary: z.string().default(''),
  graph: z.object({
    version: z.literal(1),
    nodes: z.array(z.unknown()),
    edges: z.array(z.unknown()),
    viewport: z.object({ x: z.number(), y: z.number(), zoom: z.number() }).optional(),
  }),
  variables: z.array(z.unknown()).default([]),
});

const manifestSchema = z.object({
  manifestVersion: z.literal(1),
  name: z.string().min(1),
  version: z.string().min(1),
  summary: z.string().default(''),
  agents: z.array(agentDefSchema).default([]),
  skills: z.array(skillDefSchema).default([]),
  workflowTemplates: z.array(templateDefSchema).default([]),
  credentials: z.array(z.unknown()).default([]),
});

const installLocalSchema = z.object({
  manifest: manifestSchema,
  permissionsAcknowledged: z.literal(true, {
    errorMap: () => ({ message: 'permissionsAcknowledged must be true' }),
  }),
});

export function buildPackageRoutes(deps: { db: AgentisSqliteDb; auth: AuthService }) {
  const app = new Hono();
  app.use('*', requireAuth(deps), requireWorkspace(deps));

  app.get('/', (c) => {
    const ws = getWorkspace(c);
    const rows = deps.db
      .select()
      .from(schema.agentPackages)
      .where(eq(schema.agentPackages.workspaceId, ws.workspaceId))
      .all();
    return c.json({ packages: rows });
  });

  app.get('/:id', (c) => {
    const ws = getWorkspace(c);
    const id = c.req.param('id');
    const pkg = deps.db
      .select()
      .from(schema.agentPackages)
      .where(and(eq(schema.agentPackages.id, id), eq(schema.agentPackages.workspaceId, ws.workspaceId)))
      .get();
    if (!pkg) throw new AgentisError('RESOURCE_NOT_FOUND', 'package not found');
    const skills = deps.db.select().from(schema.skills).where(eq(schema.skills.packageId, id)).all();
    const agents = deps.db.select().from(schema.agents).where(eq(schema.agents.packageId, id)).all();
    return c.json({ package: pkg, skills, agents });
  });

  app.post('/install-local', async (c) => {
    const ws = getWorkspace(c);
    const body = installLocalSchema.parse(await c.req.json());
    const m = body.manifest;

    // V1 trust rule (§9.2): local install cannot ship `builtin`.
    for (const s of m.skills) {
      if (s.runtime === 'builtin') {
        throw new AgentisError(
          'VALIDATION_FAILED',
          `skill ${s.slug}: builtin runtime is reserved for Nexseed-shipped skills`,
        );
      }
    }

    const packageId = randomUUID();
    deps.db
      .insert(schema.agentPackages)
      .values({
        id: packageId,
        workspaceId: ws.workspaceId,
        ambientId: ws.ambientId,
        userId: ws.user.id,
        registryEntryId: null,
        name: m.name,
        version: m.version,
        manifest: m,
      })
      .run();

    const createdSkills: { id: string; slug: string }[] = [];
    for (const s of m.skills) {
      const id = randomUUID();
      deps.db
        .insert(schema.skills)
        .values({
          id,
          workspaceId: ws.workspaceId,
          ambientId: ws.ambientId,
          userId: ws.user.id,
          packageId,
          name: s.name,
          slug: s.slug,
          version: s.version,
          runtime: s.runtime,
          manifest: s,
        })
        .run();
      createdSkills.push({ id, slug: s.slug });
    }

    const createdAgents: { id: string; name: string }[] = [];
    for (const a of m.agents) {
      const id = randomUUID();
      const colorHex = CONSTANTS.AGENT_COLOR_PALETTE[Math.floor(Math.random() * CONSTANTS.AGENT_COLOR_PALETTE.length)];
      deps.db
        .insert(schema.agents)
        .values({
          id,
          workspaceId: ws.workspaceId,
          ambientId: ws.ambientId,
          userId: ws.user.id,
          gatewayId: null,
          packageId,
          name: a.name,
          adapterType: a.adapterType,
          capabilityTags: a.capabilityTags,
          config: a.defaultConfig,
          status: 'offline',
          colorHex,
        })
        .run();
      createdAgents.push({ id, name: a.name });
    }

    const createdWorkflows: { id: string; title: string }[] = [];
    for (const tpl of m.workflowTemplates) {
      const id = randomUUID();
      deps.db
        .insert(schema.workflows)
        .values({
          id,
          workspaceId: ws.workspaceId,
          ambientId: ws.ambientId,
          userId: ws.user.id,
          registryEntryId: null,
          registryVersion: null,
          title: tpl.name,
          summary: tpl.summary,
          graph: tpl.graph,
          settings: {},
          isFromRegistry: false,
        })
        .run();
      createdWorkflows.push({ id, title: tpl.name });
    }

    return c.json(
      {
        packageId,
        name: m.name,
        version: m.version,
        skills: createdSkills,
        agents: createdAgents,
        workflows: createdWorkflows,
      },
      201,
    );
  });

  app.delete('/:id', (c) => {
    const ws = getWorkspace(c);
    const id = c.req.param('id');
    // Cascade: NULL out skills.packageId and agents.packageId — keep them so
    // the operator can decide what to do with their bound credentials.
    const result = deps.db
      .delete(schema.agentPackages)
      .where(and(eq(schema.agentPackages.id, id), eq(schema.agentPackages.workspaceId, ws.workspaceId)))
      .run();
    if (result.changes === 0) throw new AgentisError('RESOURCE_NOT_FOUND', 'package not found');
    return c.json({ ok: true });
  });

  return app;
}
