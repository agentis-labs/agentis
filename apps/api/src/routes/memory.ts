import { Hono } from 'hono';
import { z } from 'zod';
import type { AuthService } from '../services/auth.js';
import type { MemoryStore } from '../services/memoryStore.js';
import type { EpisodicMemoryStore } from '../services/episodicMemoryStore.js';
import type { BrainAskService } from '../services/brainAskService.js';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import { AgentisError } from '@agentis/core';
import { requireAuth } from '../middleware/auth.js';
import { getWorkspace, requireWorkspace } from '../middleware/workspace.js';

const writeMemorySchema = z.object({
  kind: z.enum(['fact', 'rule', 'preference', 'pattern', 'lesson']),
  title: z.string().trim().min(1).max(300),
  content: z.string().trim().min(1).max(20_000),
  trust: z.number().min(0).max(1).optional(),
  confidence: z.number().min(0).max(1).optional(),
  importance: z.number().min(0).max(10).optional(),
});

const askSchema = z.object({
  query: z.string().trim().min(1).max(2_000),
  scopeId: z.string().trim().min(1).optional(),
  limit: z.number().int().min(1).max(12).optional(),
});

export function buildMemoryRoutes(deps: {
  db: AgentisSqliteDb;
  auth: AuthService;
  memory: MemoryStore;
  episodes: EpisodicMemoryStore;
  brainAsk?: BrainAskService;
}) {
  const app = new Hono();
  app.use('*', requireAuth(deps), requireWorkspace(deps));

  // §C4 — interrogate the workspace brain: a cited, grounded answer or an honest
  // "I don't have that in memory". Never a sourceless guess.
  app.post('/ask', async (c) => {
    const ws = getWorkspace(c);
    if (!deps.brainAsk) throw new AgentisError('VALIDATION_FAILED', 'Brain ask is not available.');
    const body = askSchema.parse(await c.req.json());
    const result = await deps.brainAsk.ask({
      workspaceId: ws.workspaceId,
      query: body.query,
      scopeId: body.scopeId ?? null,
      limit: body.limit,
    });
    return c.json(result);
  });

  app.get('/', (c) => {
    const ws = getWorkspace(c);
    const memory = deps.memory.list({
      workspaceId: ws.workspaceId,
      scopeId: c.req.query('scopeId') ?? '',
      limit: numberQuery(c.req.query('limit'), 100, 200),
    });
    return c.json({ memory });
  });

  app.post('/', async (c) => {
    const ws = getWorkspace(c);
    const body = writeMemorySchema.parse(await c.req.json());
    const id = deps.memory.write({
      workspaceId: ws.workspaceId,
      scopeId: c.req.query('scopeId') ?? '',
      source: 'operator',
      kind: body.kind,
      title: body.title,
      content: body.content,
      trust: body.trust ?? body.confidence,
      importance: body.importance === undefined ? undefined : Math.min(body.importance / 10, 1),
    });
    return c.json({ memory: deps.memory.byId(ws.workspaceId, id) }, 201);
  });

  app.get('/episodes', (c) => {
    const ws = getWorkspace(c);
    // §B4 — typed workspace memory lives in the episode substrate but is listed
    // under "memory" (above), so exclude the plane-tagged rows from "episodes".
    const episodes = deps.episodes.list({
      workspaceId: ws.workspaceId,
      ...(c.req.query('scopeId') ? { scopeId: c.req.query('scopeId')! } : {}),
      limit: numberQuery(c.req.query('limit'), 80, 500),
    }).filter((ep) => !ep.tags.includes('plane:workspace_memory'));
    return c.json({ episodes });
  });

  app.delete('/:id', (c) => {
    const ws = getWorkspace(c);
    const removed = deps.memory.delete(ws.workspaceId, c.req.query('scopeId') ?? '', c.req.param('id'));
    if (!removed) throw new AgentisError('RESOURCE_NOT_FOUND', 'Memory entry not found');
    return c.json({ removed: true });
  });

  return app;
}

function numberQuery(raw: string | undefined, fallback: number, max: number): number {
  const parsed = raw ? Number(raw) : fallback;
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(Math.floor(parsed), max));
}
