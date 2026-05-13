/**
 * /v1/brain — Global Brain (workspace-scoped intelligence surface).
 *
 * Spec: docs/memory/THE-BRAIN-UX-ARCHITECTURE.md §12, §16.
 *
 * Routes:
 *   GET  /v1/brain                      → workspace-level Brain
 *
 * App-scoped Brain lives at `/v1/apps/:slug/brain` (see routes/apps.ts) so
 * it shares middleware with the rest of the app surface.
 */

import { Hono } from 'hono';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { AuthService } from '../services/auth.js';
import type { BrainComposer } from '../services/brainComposer.js';
import type { CollectiveBrainService } from '../services/collectiveBrain.js';
import { requireAuth } from '../middleware/auth.js';
import { requireWorkspace, getWorkspace } from '../middleware/workspace.js';

export interface BrainRoutesDeps {
  db: AgentisSqliteDb;
  auth: AuthService;
  brain: BrainComposer;
  collectiveBrain: CollectiveBrainService;
}

export function buildBrainRoutes(deps: BrainRoutesDeps) {
  const app = new Hono();
  app.use('*', requireAuth(deps), requireWorkspace(deps));

  app.get('/', (c) => {
    const ws = getWorkspace(c);
    const response = deps.brain.composeForWorkspace(ws.workspaceId);
    return c.json(response);
  });

  app.get('/graph', (c) => {
    const ws = getWorkspace(c);
    const scope = c.req.query('scope') === 'app' ? 'app' : 'workspace';
    const appId = c.req.query('appId') ?? null;
    const kinds = parseKinds(c.req.query('kinds'));
    const minConfidence = numberQuery(c.req.query('minConfidence'));
    const limit = numberQuery(c.req.query('limit'));
    const graph = deps.collectiveBrain.getGraph(ws.workspaceId, {
      scope,
      appId,
      ...(kinds.length > 0 ? { kinds } : {}),
      ...(minConfidence !== null ? { minConfidence } : {}),
      ...(limit !== null ? { limit } : {}),
    });
    return c.json({ graph });
  });

  app.get('/graph/node/:id', (c) => {
    const ws = getWorkspace(c);
    const id = c.req.param('id');
    const scope = c.req.query('scope') === 'app' ? 'app' : 'workspace';
    const appId = c.req.query('appId') ?? null;
    const detail = deps.collectiveBrain.getNode(ws.workspaceId, id, { scope, appId });
    if (!detail) return c.json({ error: 'Node not found' }, 404);
    return c.json(detail);
  });

  return app;
}

function parseKinds(raw: string | undefined) {
  const allowed = new Set(['kb_chunk', 'knowledge_chunk', 'episode', 'memory', 'pattern']);
  return (raw ?? '')
    .split(',')
    .map((part) => part.trim())
    .filter((part) => allowed.has(part)) as Array<'kb_chunk' | 'knowledge_chunk' | 'episode' | 'memory' | 'pattern'>;
}

function numberQuery(raw: string | undefined): number | null {
  if (!raw) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}
