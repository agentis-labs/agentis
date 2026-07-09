/**
 * /v1/skills — the operator surface for Living Skills.
 *
 * A Skill is a `skill` atom in the Brain (skill-library plane): a name + a
 * discoverable description + a SKILL.md body (the procedure), with a live
 * confidence score. This route lets an operator browse, author, edit, and delete
 * them; the same atoms are what agents pull (`agentis.skill.load`) and what the
 * materializer projects to `.claude/skills/<slug>/SKILL.md` for CLI harnesses.
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { AgentisError } from '@agentis/core';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import { schema } from '@agentis/db/sqlite';
import { and, eq } from 'drizzle-orm';
import type { AuthService } from '../services/auth.js';
import type { SkillService } from '../services/skillService.js';
import { requireAuth } from '../middleware/auth.js';
import { requireWorkspace, getWorkspace } from '../middleware/workspace.js';

export interface SkillRoutesDeps {
  db: AgentisSqliteDb;
  auth: AuthService;
  skills: SkillService;
}

const createSchema = z.object({
  name: z.string().trim().min(1).max(160),
  description: z.string().trim().max(2000).default(''),
  body: z.string().max(60_000).default(''),
  /** Brain scope: an agentId/appId/workflowId, or null for workspace-global. */
  scopeId: z.string().trim().min(1).nullable().optional(),
  slug: z.string().trim().min(1).max(120).optional(),
});

const updateSchema = z.object({
  name: z.string().trim().min(1).max(160).optional(),
  description: z.string().trim().max(2000).optional(),
  body: z.string().max(60_000).optional(),
}).refine((v) => v.name !== undefined || v.description !== undefined || v.body !== undefined, {
  message: 'Provide at least one of name, description, or body',
});

/** List-shape omits the (potentially large) body; detail includes it. */
function toListItem(s: { id: string; slug: string; name: string; description: string; confidence: number; scopeId: string | null; updatedAt: string }) {
  return { id: s.id, slug: s.slug, name: s.name, description: s.description, confidence: s.confidence, scopeId: s.scopeId, updatedAt: s.updatedAt };
}

export function buildSkillRoutes(deps: SkillRoutesDeps) {
  const app = new Hono();
  app.use('*', requireAuth(deps), requireWorkspace(deps));

  app.get('/', (c) => {
    const { workspaceId } = getWorkspace(c);
    const scopeId = skillScope(deps.db, workspaceId, c.req.query('scopeId'));
    const includeWorkspace = c.req.query('includeWorkspace') !== 'false';
    const rows = scopeId === undefined
      ? deps.skills.listSkills(workspaceId)
      : deps.skills.listForScopes(workspaceId, includeWorkspace ? [scopeId, null] : [scopeId]);
    return c.json({ skills: rows.map(toListItem) });
  });

  app.get('/examples', (c) => {
    const { workspaceId } = getWorkspace(c);
    const scopeId = skillScope(deps.db, workspaceId, c.req.query('scopeId'));
    const includeWorkspace = c.req.query('includeWorkspace') !== 'false';
    const examples = deps.skills.listExamples(workspaceId)
      .filter((example) => scopeId === undefined
        || example.scopeId === scopeId
        || (includeWorkspace && example.scopeId === null));
    return c.json({ examples });
  });

  app.get('/:id', (c) => {
    const { workspaceId } = getWorkspace(c);
    const id = c.req.param('id');
    const skill = deps.skills.getSkill(workspaceId, id);
    if (!skill) throw new AgentisError('RESOURCE_NOT_FOUND', 'Skill not found');
    return c.json({
      skill,
      examples: deps.skills.listLinkedExamples(workspaceId, id, 20),
      lessons: deps.skills.listLinkedLessons(workspaceId, id, 20),
    });
  });

  app.post('/', async (c) => {
    const { workspaceId } = getWorkspace(c);
    const body = createSchema.parse(await c.req.json().catch(() => ({})));
    const scopeId = skillScope(deps.db, workspaceId, body.scopeId ?? undefined);
    const skill = deps.skills.upsertSkill({
      workspaceId,
      scopeId: scopeId ?? null,
      name: body.name,
      description: body.description,
      body: body.body,
      slug: body.slug,
      source: 'operator',
    });
    return c.json({ skill }, 201);
  });

  app.patch('/:id', async (c) => {
    const { workspaceId } = getWorkspace(c);
    const id = c.req.param('id');
    const patch = updateSchema.parse(await c.req.json().catch(() => ({})));
    const skill = deps.skills.updateSkill(workspaceId, id, patch);
    if (!skill) throw new AgentisError('RESOURCE_NOT_FOUND', 'Skill not found');
    return c.json({ skill });
  });

  app.delete('/:id', (c) => {
    const { workspaceId } = getWorkspace(c);
    const ok = deps.skills.deleteSkill(workspaceId, c.req.param('id'));
    if (!ok) throw new AgentisError('RESOURCE_NOT_FOUND', 'Skill not found');
    return c.json({ ok: true });
  });

  // Author a worked input→output example for a skill (operator-created, the same
  // shape agents promote via agentis.skill.promote_example). Edit/delete of an
  // existing example go through the generic /v1/brain/atoms/example/:id surface.
  app.post('/:id/examples', async (c) => {
    const { workspaceId } = getWorkspace(c);
    const body = exampleSchema.parse(await c.req.json().catch(() => ({})));
    const exampleId = deps.skills.promoteExample({
      workspaceId,
      skillId: c.req.param('id'),
      inputText: body.inputText,
      outputText: body.outputText,
      source: 'operator',
    });
    if (!exampleId) throw new AgentisError('RESOURCE_NOT_FOUND', 'Skill not found');
    return c.json({ id: exampleId }, 201);
  });

  return app;
}

const exampleSchema = z.object({
  inputText: z.string().trim().min(1).max(4000),
  outputText: z.string().trim().min(1).max(8000),
});

/** Validate that a requested scoped Skill library owner belongs to this workspace. */
function skillScope(db: AgentisSqliteDb, workspaceId: string, scopeId: string | undefined | null): string | undefined {
  if (!scopeId) return undefined;
  const app = db.select({ id: schema.apps.id })
    .from(schema.apps)
    .where(and(eq(schema.apps.id, scopeId), eq(schema.apps.workspaceId, workspaceId)))
    .get();
  if (app) return app.id;
  const agent = db.select({ id: schema.agents.id })
    .from(schema.agents)
    .where(and(eq(schema.agents.id, scopeId), eq(schema.agents.workspaceId, workspaceId)))
    .get();
  if (agent) return agent.id;
  const workflow = db.select({ id: schema.workflows.id })
    .from(schema.workflows)
    .where(and(eq(schema.workflows.id, scopeId), eq(schema.workflows.workspaceId, workspaceId)))
    .get();
  if (workflow) return workflow.id;
  throw new AgentisError('RESOURCE_NOT_FOUND', 'Skill scope not found');
}
