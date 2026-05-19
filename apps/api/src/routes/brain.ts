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
import { z } from 'zod';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { AuthService } from '../services/auth.js';
import type { BrainComposer } from '../services/brainComposer.js';
import type { CollectiveBrainService } from '../services/collectiveBrain.js';
import type { KnowledgeAutoLinker } from '../services/knowledgeAutoLinker.js';
import type { BrainHealthService } from '../services/brainHealthService.js';
import type { DreamingService } from '../services/dreamingService.js';
import { AgentisError } from '@agentis/core';
import { requireAuth } from '../middleware/auth.js';
import { requireWorkspace, getWorkspace } from '../middleware/workspace.js';

export interface BrainRoutesDeps {
  db: AgentisSqliteDb;
  auth: AuthService;
  brain: BrainComposer;
  collectiveBrain: CollectiveBrainService;
  knowledgeAutoLinker: KnowledgeAutoLinker;
  health?: BrainHealthService;
  dreaming?: DreamingService;
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
    const includeWorkspace = c.req.query('includeWorkspace') === 'true';
    const kinds = parseKinds(c.req.query('kinds'));
    const minConfidence = numberQuery(c.req.query('minConfidence'));
    const limit = numberQuery(c.req.query('limit'));
    const graph = deps.collectiveBrain.getGraph(ws.workspaceId, {
      scope,
      appId,
      includeWorkspace,
      ...(kinds.length > 0 ? { kinds } : {}),
      ...(minConfidence !== null ? { minConfidence } : {}),
      ...(limit !== null ? { limit } : {}),
    });
    return c.json({ graph });
  });

  app.get('/health', (c) => {
    if (!deps.health) throw new AgentisError('RESOURCE_NOT_FOUND', 'Brain health service not available');
    const ws = getWorkspace(c);
    return c.json(deps.health.snapshot(ws.workspaceId));
  });

  app.get('/activity', (c) => {
    if (!deps.health) throw new AgentisError('RESOURCE_NOT_FOUND', 'Brain health service not available');
    const ws = getWorkspace(c);
    return c.json({ activity: deps.health.snapshot(ws.workspaceId).recentActivity });
  });

  app.post('/dream-pass', async (c) => {
    if (!deps.dreaming) throw new AgentisError('RESOURCE_NOT_FOUND', 'Dreaming service not available');
    const ws = getWorkspace(c);
    const body = dreamPassSchema.parse(await c.req.json().catch(() => ({})));
    const result = body.peerId
      ? await deps.dreaming.run({
          workspaceId: ws.workspaceId,
          peerId: body.peerId,
          peerType: body.peerType ?? 'user',
          phase: body.phase ?? 'both',
        })
      : await deps.dreaming.runDue(ws.workspaceId, { force: body.force ?? true, phase: body.phase ?? 'both' });
    return c.json(result);
  });

  app.get('/disputes', (c) => {
    const ws = getWorkspace(c);
    return c.json({ disputes: deps.collectiveBrain.listDisputes(ws.workspaceId) });
  });

  app.post('/disputes/:id/resolve', async (c) => {
    const ws = getWorkspace(c);
    const body = resolveDisputeSchema.parse(await c.req.json().catch(() => ({})));
    const result = await deps.collectiveBrain.resolveDispute({
      workspaceId: ws.workspaceId,
      disputeId: c.req.param('id'),
      action: body.action,
      contextA: body.contextA ?? null,
      contextB: body.contextB ?? null,
      snoozeDays: body.snoozeDays,
    });
    if (!result.resolved) throw new AgentisError('RESOURCE_NOT_FOUND', 'Dispute not found');
    return c.json(result);
  });

  app.get('/graph/node/:id', (c) => {
    const ws = getWorkspace(c);
    const id = c.req.param('id');
    const scope = c.req.query('scope') === 'app' ? 'app' : 'workspace';
    const appId = c.req.query('appId') ?? null;
    const includeWorkspace = c.req.query('includeWorkspace') === 'true';
    const detail = deps.collectiveBrain.getNode(ws.workspaceId, id, { scope, appId, includeWorkspace });
    if (!detail) return c.json({ error: 'Node not found' }, 404);
    return c.json(detail);
  });

  app.post('/links', async (c) => {
    const ws = getWorkspace(c);
    const body = createLinkSchema.parse(await c.req.json().catch(() => ({})));
    const link = deps.collectiveBrain.createLink({
      workspaceId: ws.workspaceId,
      sourceId: body.sourceId,
      sourceKind: body.sourceKind,
      targetId: body.targetId,
      targetKind: body.targetKind,
      relation: body.relation,
      confidence: body.confidence ?? 0.72,
    });
    if (!link) throw new AgentisError('VALIDATION_FAILED', 'Could not create link between those atoms');
    return c.json({ link }, 201);
  });

  app.delete('/atoms/:kind/:id', (c) => {
    const ws = getWorkspace(c);
    const kind = knowledgeAtomKindSchema.parse(c.req.param('kind'));
    const ok = deps.collectiveBrain.archiveAtom(ws.workspaceId, kind, c.req.param('id'));
    if (!ok) throw new AgentisError('RESOURCE_NOT_FOUND', 'Atom not found');
    return c.json({ archived: true });
  });

  app.patch('/atoms/:kind/:id', async (c) => {
    const ws = getWorkspace(c);
    const kind = knowledgeAtomKindSchema.parse(c.req.param('kind'));
    const body = updateAtomSchema.parse(await c.req.json().catch(() => ({})));
    const node = deps.collectiveBrain.updateAtomContent(ws.workspaceId, kind, c.req.param('id'), body);
    if (!node) throw new AgentisError('RESOURCE_NOT_FOUND', 'Atom not found or not editable');
    return c.json({ node });
  });

  app.post('/atoms/:kind/:id/suggest-links', (c) => {
    const ws = getWorkspace(c);
    const kind = knowledgeAtomKindSchema.parse(c.req.param('kind'));
    const id = c.req.param('id');
    const scope = c.req.query('scope') === 'app' ? 'app' : 'workspace';
    const appId = c.req.query('appId') ?? null;
    const detail = deps.collectiveBrain.getNode(ws.workspaceId, id, { scope, appId });
    if (!detail) throw new AgentisError('RESOURCE_NOT_FOUND', 'Atom not found');
    const candidates = deps.knowledgeAutoLinker.suggestLinks({
      workspaceId: ws.workspaceId,
      appId: scope === 'app' ? appId : null,
      sourceKind: kind,
      sourceId: id,
      sourceTitle: detail.node.label,
      sourceContent: detail.node.summary ?? detail.node.label,
    });
    return c.json({ candidates });
  });

  return app;
}

const knowledgeAtomKindSchema = z.enum(['kb_chunk', 'knowledge_chunk', 'episode', 'memory', 'pattern']);
const linkRelationSchema = z.enum(['supports', 'contradicts', 'refines', 'derived_from', 'co_observed']);
const createLinkSchema = z.object({
  sourceId: z.string().min(1),
  sourceKind: knowledgeAtomKindSchema,
  targetId: z.string().min(1),
  targetKind: knowledgeAtomKindSchema,
  relation: linkRelationSchema.default('supports'),
  confidence: z.number().min(0).max(1).optional(),
});
const updateAtomSchema = z.object({
  title: z.string().min(1).max(500).optional(),
  content: z.string().max(20000).optional(),
}).refine((value) => value.title !== undefined || value.content !== undefined, {
  message: 'Provide at least one of title or content',
});
const resolveDisputeSchema = z.object({
  action: z.enum(['keep_a', 'keep_b', 'merge', 'context_split', 'snooze']),
  contextA: z.string().max(500).optional(),
  contextB: z.string().max(500).optional(),
  snoozeDays: z.number().int().min(1).max(365).optional(),
});
const dreamPassSchema = z.object({
  peerId: z.string().min(1).optional(),
  peerType: z.enum(['user', 'agent']).optional(),
  phase: z.enum(['deduction', 'induction', 'both']).optional(),
  force: z.boolean().optional(),
});

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
