/**
 * /v1/abilities — Agent Abilities (BRAIN-ABILITIES-REPLAN.md Part IV) + the
 * operator profile layer (§BL8).
 *
 * Routes:
 *   GET    /v1/abilities?agentId=&workflowId=   → list (+ team abilities)
 *   GET    /v1/abilities/:id                     → ability + version history
 *   POST   /v1/abilities                         → create (operator_write)
 *   PATCH  /v1/abilities/:id                     → patch (new version)
 *   POST   /v1/abilities/:id/pin                 → pin / unpin
 *   POST   /v1/abilities/:id/rollback            → roll back to this version
 *   DELETE /v1/abilities/:id                     → archive
 *   GET    /v1/abilities/profile                 → operator profile
 *   PUT    /v1/abilities/profile                 → upsert operator profile
 */

import { Hono } from 'hono';
import { z } from 'zod';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { AuthService } from '../services/auth.js';
import type { AgentAbilityService } from '../services/agentAbilityService.js';
import type { UserProfileService } from '../services/userProfileService.js';
import { requireAuth, getUser } from '../middleware/auth.js';
import { requireWorkspace, getWorkspace } from '../middleware/workspace.js';

export interface AbilityRoutesDeps {
  db: AgentisSqliteDb;
  auth: AuthService;
  abilities: AgentAbilityService;
  userProfiles: UserProfileService;
}

const createSchema = z.object({
  agentId: z.string().optional(),
  workflowId: z.string().optional(),
  teamRole: z.string().optional(),
  title: z.string().min(1).max(200),
  content: z.string().min(1).max(20_000),
  tags: z.array(z.string()).optional(),
  confidence: z.number().min(0).max(1).optional(),
});

const patchSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  content: z.string().min(1).max(20_000).optional(),
  tags: z.array(z.string()).optional(),
  confidence: z.number().min(0).max(1).optional(),
  changeNote: z.string().max(300).optional(),
});

export function buildAbilityRoutes(deps: AbilityRoutesDeps) {
  const app = new Hono();
  app.use('*', requireAuth(deps), requireWorkspace(deps));

  // ── operator profile (§BL8) — declared before /:id so it is not shadowed ──
  app.get('/profile', (c) => {
    const ws = getWorkspace(c);
    const user = getUser(c);
    const profile = deps.userProfiles.get(ws.workspaceId, user.id);
    return c.json({ profile: profile ?? { workspaceId: ws.workspaceId, userId: user.id, content: '', updatedAt: null } });
  });

  app.put('/profile', async (c) => {
    const ws = getWorkspace(c);
    const user = getUser(c);
    const body = await c.req.json().catch(() => ({}));
    const content = z.object({ content: z.string().max(8_000) }).parse(body).content;
    const profile = deps.userProfiles.set(ws.workspaceId, user.id, content);
    return c.json({ profile });
  });

  // ── abilities ────────────────────────────────────────────────
  app.get('/', (c) => {
    const ws = getWorkspace(c);
    const agentId = c.req.query('agentId');
    const workflowId = c.req.query('workflowId');
    const includeSuperseded = c.req.query('includeSuperseded') === 'true';
    const abilities = deps.abilities.list(ws.workspaceId, {
      agentId: agentId ?? null,
      workflowId: workflowId ?? null,
      teamRole: c.req.query('teamRole') ?? null,
      includeSuperseded,
    });
    return c.json({ abilities });
  });

  app.get('/:id', (c) => {
    const ws = getWorkspace(c);
    const ability = deps.abilities.get(ws.workspaceId, c.req.param('id'));
    if (!ability) return c.json({ error: 'Ability not found' }, 404);
    const history = deps.abilities.history(ws.workspaceId, ability.id);
    return c.json({ ability, history });
  });

  app.post('/', async (c) => {
    const ws = getWorkspace(c);
    const body = createSchema.parse(await c.req.json().catch(() => ({})));
    if (!body.agentId && !body.workflowId) {
      return c.json({ error: 'agentId or workflowId is required' }, 400);
    }
    const ability = await deps.abilities.create({
      workspaceId: ws.workspaceId,
      agentId: body.agentId ?? null,
      workflowId: body.workflowId ?? null,
      teamRole: body.teamRole ?? null,
      title: body.title,
      content: body.content,
      tags: body.tags ?? [],
      confidence: body.confidence,
      source: 'operator_write',
      managed: false,
    });
    return c.json({ ability }, 201);
  });

  app.patch('/:id', async (c) => {
    const ws = getWorkspace(c);
    const body = patchSchema.parse(await c.req.json().catch(() => ({})));
    const ability = await deps.abilities.patch(ws.workspaceId, c.req.param('id'), body);
    if (!ability) return c.json({ error: 'Ability not found' }, 404);
    return c.json({ ability });
  });

  app.post('/:id/pin', async (c) => {
    const ws = getWorkspace(c);
    const body = await c.req.json().catch(() => ({}));
    const pinned = z.object({ pinned: z.boolean() }).parse(body).pinned;
    const ok = deps.abilities.setPinned(ws.workspaceId, c.req.param('id'), pinned);
    if (!ok) return c.json({ error: 'Ability not found' }, 404);
    return c.json({ ok: true, pinned });
  });

  app.post('/:id/rollback', async (c) => {
    const ws = getWorkspace(c);
    const ability = await deps.abilities.rollback(ws.workspaceId, c.req.param('id'));
    if (!ability) return c.json({ error: 'Ability version not found' }, 404);
    return c.json({ ability });
  });

  app.delete('/:id', (c) => {
    const ws = getWorkspace(c);
    const ok = deps.abilities.archive(ws.workspaceId, c.req.param('id'));
    if (!ok) return c.json({ error: 'Ability not found' }, 404);
    return c.json({ ok: true });
  });

  return app;
}
