/**
 * /v1/brain — the workspace Brain (intelligence surface).
 *
 * Composes the knowledge graph, memory, evaluators/baselines, health, disputes,
 * and per-agent memory into one workspace-scoped surface.
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import { schema } from '@agentis/db/sqlite';
import type { AuthService } from '../services/auth.js';
import type { BrainComposer } from '../services/brain/brainComposer.js';
import type { SharedIntelligenceService } from '../services/sharedIntelligence.js';
import type { KnowledgeAutoLinker } from '../services/knowledge/knowledgeAutoLinker.js';
import type { BrainHealthService } from '../services/brain/brainHealthService.js';
import type { ReflectionService } from '../services/reflectionService.js';
import type { AgentMemoryService } from '../services/agent/agentMemory.js';
import type { PeerProfileService } from '../services/peerProfileService.js';
import type { SessionMomentService } from '../services/sessionMomentService.js';
import { AgentisError } from '@agentis/core';
import { requireAuth } from '../middleware/auth.js';
import { requireWorkspace, getWorkspace } from '../middleware/workspace.js';

export interface BrainRoutesDeps {
  db: AgentisSqliteDb;
  auth: AuthService;
  brain: BrainComposer;
  SharedIntelligence: SharedIntelligenceService;
  knowledgeAutoLinker: KnowledgeAutoLinker;
  health?: BrainHealthService;
  Reflection?: ReflectionService;
  /** Agent-scoped personal memory (§G11) — the per-agent Brain. */
  agentMemory?: AgentMemoryService;
  peerProfiles?: PeerProfileService;
  sessionMoments?: SessionMomentService;
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
    const scope = c.req.query('scope') === 'scoped' ? 'scoped' : 'workspace';
    const scopeId = c.req.query('scopeId') ?? null;
    const includeWorkspace = c.req.query('includeWorkspace') === 'true';
    const kinds = parseKinds(c.req.query('kinds'));
    const minConfidence = numberQuery(c.req.query('minConfidence'));
    const limit = numberQuery(c.req.query('limit'));
    const graph = deps.SharedIntelligence.getGraph(ws.workspaceId, {
      scope,
      scopeId,
      includeWorkspace,
      ...(kinds.length > 0 ? { kinds } : {}),
      ...(minConfidence !== null ? { minConfidence } : {}),
      ...(limit !== null ? { limit } : {}),
    });
    return c.json({ graph });
  });

  // §scope-visibility — whether a scope's (App/Agent/Workflow) atoms surface in
  // the Workspace Brain. Default: visible. Stored as workspace.brainSettings
  // .hiddenScopeIds (the exception list).
  const readHiddenScopes = (workspaceId: string): string[] => {
    const row = deps.db.select({ brainSettings: schema.workspaces.brainSettings })
      .from(schema.workspaces).where(eq(schema.workspaces.id, workspaceId)).get();
    const raw = row?.brainSettings;
    const settings = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
    const hidden = settings.hiddenScopeIds;
    return Array.isArray(hidden) ? hidden.filter((x): x is string => typeof x === 'string') : [];
  };

  app.get('/scopes/:scopeId/visibility', (c) => {
    const ws = getWorkspace(c);
    return c.json({ surfacedInWorkspace: !readHiddenScopes(ws.workspaceId).includes(c.req.param('scopeId')) });
  });

  app.put('/scopes/:scopeId/visibility', async (c) => {
    const ws = getWorkspace(c);
    const scopeId = c.req.param('scopeId');
    const body = await c.req.json().catch(() => ({})) as { surfacedInWorkspace?: boolean };
    const surfaced = body.surfacedInWorkspace !== false;
    const current = readHiddenScopes(ws.workspaceId);
    const next = surfaced ? current.filter((id) => id !== scopeId) : [...new Set([...current, scopeId])];
    const row = deps.db.select({ brainSettings: schema.workspaces.brainSettings })
      .from(schema.workspaces).where(eq(schema.workspaces.id, ws.workspaceId)).get();
    const settings = row?.brainSettings && typeof row.brainSettings === 'object' ? row.brainSettings as Record<string, unknown> : {};
    deps.db.update(schema.workspaces).set({ brainSettings: { ...settings, hiddenScopeIds: next } })
      .where(eq(schema.workspaces.id, ws.workspaceId)).run();
    return c.json({ surfacedInWorkspace: surfaced });
  });

  app.get('/health', (c) => {
    if (!deps.health) throw new AgentisError('RESOURCE_NOT_FOUND', 'Brain health service not available');
    const ws = getWorkspace(c);
    return c.json(deps.health.snapshot(ws.workspaceId, c.req.query('scopeId') ?? null));
  });

  app.get('/activity', (c) => {
    if (!deps.health) throw new AgentisError('RESOURCE_NOT_FOUND', 'Brain health service not available');
    const ws = getWorkspace(c);
    return c.json({ activity: deps.health.snapshot(ws.workspaceId, c.req.query('scopeId') ?? null).recentActivity });
  });

  app.post('/dream-pass', async (c) => {
    if (!deps.Reflection) throw new AgentisError('RESOURCE_NOT_FOUND', 'Reflection service not available');
    const ws = getWorkspace(c);
    const body = dreamPassSchema.parse(await c.req.json().catch(() => ({})));
    const result = body.peerId
      ? await deps.Reflection.run({
          workspaceId: ws.workspaceId,
          peerId: body.peerId,
          peerType: body.peerType ?? 'user',
          phase: body.phase ?? 'both',
        })
      : await deps.Reflection.runDue(ws.workspaceId, { force: body.force ?? true, phase: body.phase ?? 'both' });
    return c.json(result);
  });

  // §P4 — one-shot cleanup of pre-formation pollution. POST with {"dryRun":true}
  // first to preview how many junk atoms would be archived.
  app.post('/rebuild-memory', async (c) => {
    const ws = getWorkspace(c);
    const body = rebuildMemorySchema.parse(await c.req.json().catch(() => ({})));
    const result = deps.SharedIntelligence.quarantineRunPromotionJunk(ws.workspaceId, {
      dryRun: body.dryRun ?? false,
      ...(body.limit !== undefined ? { limit: body.limit } : {}),
    });
    return c.json(result);
  });

  app.get('/disputes', (c) => {
    const ws = getWorkspace(c);
    return c.json({ disputes: deps.SharedIntelligence.listDisputes(ws.workspaceId) });
  });

  app.post('/disputes/:id/resolve', async (c) => {
    const ws = getWorkspace(c);
    const body = resolveDisputeSchema.parse(await c.req.json().catch(() => ({})));
    const result = await deps.SharedIntelligence.resolveDispute({
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
    const scope = c.req.query('scope') === 'scoped' ? 'scoped' : 'workspace';
    const scopeId = c.req.query('scopeId') ?? null;
    const includeWorkspace = c.req.query('includeWorkspace') === 'true';
    const detail = deps.SharedIntelligence.getNode(ws.workspaceId, id, { scope, scopeId, includeWorkspace });
    if (!detail) return c.json({ error: 'Node not found' }, 404);
    return c.json(detail);
  });

  app.post('/links', async (c) => {
    const ws = getWorkspace(c);
    const body = createLinkSchema.parse(await c.req.json().catch(() => ({})));
    const link = deps.SharedIntelligence.createLink({
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
    const ok = deps.SharedIntelligence.archiveAtom(ws.workspaceId, kind, c.req.param('id'));
    if (!ok) throw new AgentisError('RESOURCE_NOT_FOUND', 'Atom not found');
    return c.json({ archived: true });
  });

  app.patch('/atoms/:kind/:id', async (c) => {
    const ws = getWorkspace(c);
    const kind = knowledgeAtomKindSchema.parse(c.req.param('kind'));
    const body = updateAtomSchema.parse(await c.req.json().catch(() => ({})));
    const node = deps.SharedIntelligence.updateAtomContent(ws.workspaceId, kind, c.req.param('id'), body);
    if (!node) throw new AgentisError('RESOURCE_NOT_FOUND', 'Atom not found or not editable');
    return c.json({ node });
  });

  app.post('/atoms/:kind/:id/suggest-links', (c) => {
    const ws = getWorkspace(c);
    const kind = knowledgeAtomKindSchema.parse(c.req.param('kind'));
    const id = c.req.param('id');
    const scope = c.req.query('scope') === 'scoped' ? 'scoped' : 'workspace';
    const scopeId = c.req.query('scopeId') ?? null;
    const detail = deps.SharedIntelligence.getNode(ws.workspaceId, id, { scope, scopeId });
    if (!detail) throw new AgentisError('RESOURCE_NOT_FOUND', 'Atom not found');
    const candidates = deps.knowledgeAutoLinker.suggestLinks({
      workspaceId: ws.workspaceId,
      scopeId: scope === 'scoped' ? scopeId : null,
      sourceKind: kind,
      sourceId: id,
      sourceTitle: detail.node.label,
      sourceContent: detail.node.summary ?? detail.node.label,
    });
    return c.json({ candidates });
  });

  app.get('/peers/:peerType/:peerId', (c) => {
    if (!deps.peerProfiles) throw new AgentisError('RESOURCE_NOT_FOUND', 'Peer profile service not available');
    const ws = getWorkspace(c);
    const peerType = peerTypeSchema.parse(c.req.param('peerType'));
    const peerId = c.req.param('peerId');
    const observerScope = c.req.query('observerScope') || 'global';
    return c.json({
      peerType,
      peerId,
      observerScope,
      summary: deps.peerProfiles.getSummary(ws.workspaceId, peerType, peerId, observerScope),
      stats: deps.peerProfiles.getPeerCardStats(ws.workspaceId, peerType, peerId, observerScope),
      facts: deps.peerProfiles.getPeerCard(ws.workspaceId, peerType, peerId, observerScope),
      conclusions: deps.peerProfiles.getConclusions(ws.workspaceId, peerId, {
        observerScope,
        limit: numberQuery(c.req.query('limit')) ?? 25,
      }),
    });
  });

  app.get('/session-moments', (c) => {
    if (!deps.sessionMoments) throw new AgentisError('RESOURCE_NOT_FOUND', 'Session moment service not available');
    const ws = getWorkspace(c);
    const sessionId = c.req.query('sessionId');
    if (!sessionId) throw new AgentisError('VALIDATION_FAILED', 'sessionId query parameter is required');
    return c.json({
      sessionId,
      moments: deps.sessionMoments.list({
        workspaceId: ws.workspaceId,
        sessionId,
        limit: numberQuery(c.req.query('limit')) ?? 20,
      }),
    });
  });

  // -- Agent-scoped memory (the agent's personal Brain, §G11) --
  app.get('/agents/:agentId/memory', (c) => {
    if (!deps.agentMemory) throw new AgentisError('RESOURCE_NOT_FOUND', 'Agent memory service not available');
    const ws = getWorkspace(c);
    const agentId = assertBrainAgent(deps.db, ws.workspaceId, c.req.param('agentId'));
    return c.json({ entries: deps.agentMemory.list(agentId, ws.workspaceId) });
  });

  app.get('/agents/:agentId/graph', (c) => {
    if (!deps.agentMemory) throw new AgentisError('RESOURCE_NOT_FOUND', 'Agent memory service not available');
    const ws = getWorkspace(c);
    const agentId = assertBrainAgent(deps.db, ws.workspaceId, c.req.param('agentId'));
    const agent = deps.db.select({ name: schema.agents.name }).from(schema.agents).where(eq(schema.agents.id, agentId)).get();
    return c.json({ graph: deps.agentMemory.graph(agentId, ws.workspaceId, agent?.name ?? 'Agent brain') });
  });

  app.get('/agents/:agentId/graph/node/:id', (c) => {
    if (!deps.agentMemory) throw new AgentisError('RESOURCE_NOT_FOUND', 'Agent memory service not available');
    const ws = getWorkspace(c);
    const agentId = assertBrainAgent(deps.db, ws.workspaceId, c.req.param('agentId'));
    const agent = deps.db.select({ name: schema.agents.name }).from(schema.agents).where(eq(schema.agents.id, agentId)).get();
    const detail = deps.agentMemory.detail(agentId, ws.workspaceId, c.req.param('id'), agent?.name ?? 'Agent brain');
    if (!detail) throw new AgentisError('RESOURCE_NOT_FOUND', 'Agent Brain node not found');
    return c.json(detail);
  });

  app.post('/agents/:agentId/memory', async (c) => {
    if (!deps.agentMemory) throw new AgentisError('RESOURCE_NOT_FOUND', 'Agent memory service not available');
    const ws = getWorkspace(c);
    const agentId = assertBrainAgent(deps.db, ws.workspaceId, c.req.param('agentId'));
    const body = appendAgentMemorySchema.parse(await c.req.json());
    const entry = deps.agentMemory.append({ agentId, workspaceId: ws.workspaceId, section: body.section, content: body.content, tags: body.tags });
    return c.json({ entry }, 201);
  });

  app.delete('/agents/:agentId/memory/:id', (c) => {
    if (!deps.agentMemory) throw new AgentisError('RESOURCE_NOT_FOUND', 'Agent memory service not available');
    const ws = getWorkspace(c);
    const agentId = assertBrainAgent(deps.db, ws.workspaceId, c.req.param('agentId'));
    if (!deps.agentMemory.remove(c.req.param('id'), agentId, ws.workspaceId)) throw new AgentisError('RESOURCE_NOT_FOUND', 'Memory entry not found');
    return c.json({ removed: true });
  });

  app.delete('/agents/:agentId/memory', (c) => {
    if (!deps.agentMemory) throw new AgentisError('RESOURCE_NOT_FOUND', 'Agent memory service not available');
    const ws = getWorkspace(c);
    const agentId = assertBrainAgent(deps.db, ws.workspaceId, c.req.param('agentId'));
    return c.json({ cleared: deps.agentMemory.clear(agentId, ws.workspaceId) });
  });

  return app;
}

const appendAgentMemorySchema = z.object({
  section: z.string().trim().min(1).max(120).optional(),
  content: z.string().trim().min(1).max(8000),
  tags: z.array(z.string().trim().min(1).max(60)).max(20).optional(),
});

function assertBrainAgent(db: AgentisSqliteDb, workspaceId: string, agentId: string): string {
  const agent = db
    .select({ id: schema.agents.id })
    .from(schema.agents)
    .where(and(eq(schema.agents.id, agentId), eq(schema.agents.workspaceId, workspaceId)))
    .get();
  if (!agent) throw new AgentisError('RESOURCE_NOT_FOUND', 'Agent not found');
  return agent.id;
}

const knowledgeAtomKindSchema = z.enum(['kb_chunk', 'knowledge_chunk', 'episode', 'memory', 'pattern', 'skill', 'example']);
const peerTypeSchema = z.enum(['user', 'agent']);
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
const rebuildMemorySchema = z.object({
  dryRun: z.boolean().optional(),
  limit: z.number().int().min(1).max(20000).optional(),
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
