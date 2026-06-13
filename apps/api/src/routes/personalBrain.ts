import { Hono } from 'hono';
import { z } from 'zod';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { AuthService } from '../services/auth.js';
import type { PersonalBrainService } from '../services/personalBrain.js';
import { AgentisError } from '@agentis/core';
import { getUser, requireAuth } from '../middleware/auth.js';

const noteSchema = z.object({
  title: z.string().trim().max(160).nullable().optional(),
  content: z.string().trim().min(1).max(30_000),
  noteType: z.string().trim().min(1).max(40).optional(),
  tags: z.array(z.string().trim().min(1).max(60)).max(20).optional(),
  pinned: z.boolean().optional(),
});
const patchNoteSchema = noteSchema.partial();
const searchSchema = z.object({ query: z.string().trim().min(1).max(4000), limit: z.number().int().positive().max(30).optional() });
const grantSchema = z.object({ accessLevel: z.enum(['read', 'write']).default('read') });

export function buildPersonalBrainRoutes(deps: { db: AgentisSqliteDb; auth: AuthService; brain: PersonalBrainService }) {
  const app = new Hono();
  app.use('*', requireAuth(deps));

  app.get('/notes', (c) => c.json({ notes: deps.brain.list(getUser(c).id) }));
  app.get('/graph', (c) => c.json({ graph: deps.brain.graph(getUser(c).id) }));
  app.get('/graph/node/:id', (c) => {
    const detail = deps.brain.detail(getUser(c).id, c.req.param('id'));
    if (!detail) throw new AgentisError('RESOURCE_NOT_FOUND', 'Personal Brain node not found');
    return c.json(detail);
  });
  app.post('/notes', async (c) => {
    const note = await deps.brain.create(getUser(c).id, noteSchema.parse(await c.req.json()));
    return c.json({ note }, 201);
  });
  app.patch('/notes/:id', async (c) => {
    const note = await deps.brain.update(getUser(c).id, c.req.param('id'), patchNoteSchema.parse(await c.req.json()));
    return c.json({ note });
  });
  app.delete('/notes/:id', (c) => {
    if (!deps.brain.remove(getUser(c).id, c.req.param('id'))) throw new AgentisError('RESOURCE_NOT_FOUND', 'Personal note not found');
    return c.json({ removed: true });
  });
  app.post('/search', async (c) => {
    const body = searchSchema.parse(await c.req.json());
    return c.json({ notes: await deps.brain.search(getUser(c).id, body.query, body.limit) });
  });
  app.get('/grants', (c) => c.json({ grants: deps.brain.grants(getUser(c).id) }));
  app.put('/grants/:agentId', async (c) => {
    const body = grantSchema.parse(await c.req.json().catch(() => ({})));
    return c.json({ grant: deps.brain.grant(getUser(c).id, c.req.param('agentId'), body.accessLevel) });
  });
  app.delete('/grants/:agentId', (c) => c.json({ revoked: deps.brain.revoke(getUser(c).id, c.req.param('agentId')) }));

  return app;
}
