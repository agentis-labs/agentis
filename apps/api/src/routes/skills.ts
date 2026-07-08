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
    return c.json({ skills: deps.skills.listSkills(workspaceId).map(toListItem) });
  });

  app.get('/examples', (c) => {
    const { workspaceId } = getWorkspace(c);
    return c.json({ examples: deps.skills.listExamples(workspaceId) });
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
    const skill = deps.skills.upsertSkill({
      workspaceId,
      scopeId: body.scopeId ?? null,
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

  return app;
}
