/**
 * /v1/memory — Memory Architecture HTTP surface.
 *
 * Spec: docs/memory/MEMORY-ARCHITECTURE.md.
 *
 * Endpoints (all authenticated + workspace-scoped):
 *
 *   ── Layer 1: Working memory ───────────────────────────
 *   GET    /v1/memory/working/:runId                       → snapshot of all entries
 *   GET    /v1/memory/working/:runId/summary               → composed summary (auto-compact)
 *   POST   /v1/memory/working/:runId/compact               → force compaction
 *   GET    /v1/memory/working/:runId/:namespace/:kind/:key → read one entry
 *   PUT    /v1/memory/working/:runId/:namespace/:kind/:key → write one entry
 *   DELETE /v1/memory/working/:runId/:namespace/:kind/:key → delete one entry
 *
 *   ── Layer 3: Episodes ─────────────────────────────────
 *   GET    /v1/memory/episodes                             → list (filters: appId, type, archived)
 *   POST   /v1/memory/episodes                             → write (operator)
 *   GET    /v1/memory/episodes/:id                         → one episode
 *   PATCH  /v1/memory/episodes/:id                         → update
 *   DELETE /v1/memory/episodes/:id                         → archive
 *   POST   /v1/memory/episodes/:id/reinforce               → reinforce
 *   POST   /v1/memory/episodes/search                      → semantic/lexical search
 *
 *   ── Promotion ─────────────────────────────────────────
 *   POST   /v1/memory/promotions/promote                   → promote one or more candidates
 *   GET    /v1/memory/promotions                           → audit trail listing
 *
 *   ── Layer 5: Composed retrieval ───────────────────────
 *   POST   /v1/memory/retrieval/context                    → buildContext()
 *
 *   ── Layer 4: Rolling baselines ────────────────────────
 *   GET    /v1/memory/baselines/:workflowId                → latest per window
 *   GET    /v1/memory/baselines/:workflowId/history        → history for one window
 *   POST   /v1/memory/baselines/:workflowId/capture        → capture a new snapshot
 *   POST   /v1/memory/baselines/:workflowId/anomalies      → detect anomalies for observed metrics
 */

import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { z } from 'zod';
import { eq, and, isNull, isNotNull, like, sql } from 'drizzle-orm';
import { AgentisError, REALTIME_EVENTS, REALTIME_ROOMS } from '@agentis/core';
import type {
  BaselineWindow,
  PromotionCandidate,
  RetrievalBudgetClass,
  RetrievalMode,
  RuntimeEpisodeOutcome,
  RuntimeEpisodeType,
  WorkingMemoryKind,
  WorkingMemoryNamespace,
} from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import type { AuthService } from '../services/auth.js';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { EventBus } from '../event-bus.js';
import type { MemoryRuntime } from '../services/memoryRuntime.js';
import type { MemoryPromotion } from '../services/memoryPromotion.js';
import type { EpisodicMemoryStore } from '../services/episodicMemoryStore.js';
import type { RollingBaselineStore } from '../services/rollingBaselineStore.js';
import { requireAuth } from '../middleware/auth.js';
import { requireWorkspace, getWorkspace } from '../middleware/workspace.js';

export interface MemoryRoutesDeps {
  db: AgentisSqliteDb;
  auth: AuthService;
  bus: EventBus;
  memory?: MemoryRuntime;
  promotion?: MemoryPromotion;
  episodes?: EpisodicMemoryStore;
  rollingBaselines?: RollingBaselineStore;
}

// ────────────────────────────────────────────────────────────
// Flat entries CRUD Zod schemas
// ────────────────────────────────────────────────────────────

const createEntrySchema = z.object({
  title: z.string().min(1),
  content: z.string().min(1),
  kind: z.string().optional(),
  importance: z.number().int().min(1).max(10).optional(),
  confidence: z.number().min(0).max(1).optional(),
  tags: z.array(z.string()).optional(),
  metadata: z.record(z.unknown()).optional(),
  teamId: z.string().nullable().optional(),
  agentId: z.string().nullable().optional(),
  userId: z.string().nullable().optional(),
  sourceType: z.string().optional(),
  sourceId: z.string().nullable().optional(),
});

const patchEntrySchema = z.object({
  title: z.string().min(1).optional(),
  content: z.string().min(1).optional(),
  kind: z.string().optional(),
  importance: z.number().int().min(1).max(10).optional(),
  confidence: z.number().min(0).max(1).optional(),
  tags: z.array(z.string()).optional(),
  metadata: z.record(z.unknown()).optional(),
});

// ────────────────────────────────────────────────────────────
// Zod schemas
// ────────────────────────────────────────────────────────────

const NAMESPACE = ['run','agent','subflow','turn','eval','artifact','system'] as const;
const KIND = [
  'working_plan','working_summary','pending_questions','tool_result_cache',
  'artifact_draft','evaluation_state','turn_history','blocker','note',
] as const;
const EPISODE_TYPE = [
  'decision','failure','recovery','success_pattern','approval',
  'evaluator_outcome','incident','artifact_outcome','distilled_lesson',
] as const;
const PROMOTION_CANDIDATE_SOURCE = [
  'evaluator_failure_summary','approval_rationale','replay_root_cause',
  'tool_failure_pattern','winning_output_pattern','final_artifact_validation',
  'operator_distillation','agent_proposal',
] as const;
const OUTCOME = ['good','bad','mixed'] as const;
const RETRIEVAL_MODE = ['strict','normal','exploratory'] as const;
const RETRIEVAL_BUDGET = ['cheap','balanced','power'] as const;
const BASELINE_WINDOW = ['rolling_7d','rolling_30d','rolling_90d'] as const;

const writeWorkingSchema = z.object({
  payload: z.unknown(),
});

const writeEpisodeSchema = z.object({
  appId: z.string().nullable().optional(),
  workflowId: z.string().nullable().optional(),
  runId: z.string().nullable().optional(),
  agentId: z.string().nullable().optional(),
  type: z.enum(EPISODE_TYPE),
  title: z.string().min(1),
  summary: z.string().min(1),
  details: z.string().nullable().optional(),
  confidence: z.number().min(0).max(1).optional(),
  importance: z.number().min(0).max(1).optional(),
  trust: z.number().min(0).max(1).optional(),
  tags: z.array(z.string()).optional(),
  entities: z.array(z.string()).optional(),
  outcomeStatus: z.enum(OUTCOME).nullable().optional(),
  metadata: z.record(z.unknown()).optional(),
});

const updateEpisodeSchema = z.object({
  title: z.string().optional(),
  summary: z.string().optional(),
  details: z.string().nullable().optional(),
  tags: z.array(z.string()).optional(),
  entities: z.array(z.string()).optional(),
  importance: z.number().min(0).max(1).optional(),
  trust: z.number().min(0).max(1).optional(),
  confidence: z.number().min(0).max(1).optional(),
  outcomeStatus: z.enum(OUTCOME).nullable().optional(),
  metadata: z.record(z.unknown()).optional(),
});

const searchEpisodesSchema = z.object({
  appId: z.string().optional(),
  workflowId: z.string().optional(),
  query: z.string().optional(),
  types: z.array(z.enum(EPISODE_TYPE)).optional(),
  tags: z.array(z.string()).optional(),
  entities: z.array(z.string()).optional(),
  outcomeStatus: z.enum(OUTCOME).optional(),
  includeArchived: z.boolean().optional(),
  includeSuperseded: z.boolean().optional(),
  limit: z.number().int().positive().max(50).optional(),
});

const promotionCandidateSchema = z.object({
  source: z.enum(PROMOTION_CANDIDATE_SOURCE),
  title: z.string().min(1),
  summary: z.string().min(1),
  details: z.string().optional(),
  type: z.enum(EPISODE_TYPE),
  outcomeStatus: z.enum(OUTCOME).optional(),
  signals: z.object({
    humanApproved: z.boolean().optional(),
    evaluatorValidated: z.boolean().optional(),
    repeatedCount: z.number().int().nonnegative().optional(),
    importanceHint: z.number().min(0).max(1).optional(),
    confidenceHint: z.number().min(0).max(1).optional(),
  }).default({}),
  tags: z.array(z.string()).optional(),
  entities: z.array(z.string()).optional(),
  metadata: z.record(z.unknown()).optional(),
});

const promoteSchema = z.object({
  appId: z.string().nullable().optional(),
  workflowId: z.string().nullable().optional(),
  runId: z.string().nullable().optional(),
  agentId: z.string().nullable().optional(),
  candidates: z.array(promotionCandidateSchema).min(1),
});

const buildContextSchema = z.object({
  appId: z.string().optional(),
  workflowId: z.string().optional(),
  runId: z.string().optional(),
  agentId: z.string().optional(),
  taskDescription: z.string().min(1),
  budgetClass: z.enum(RETRIEVAL_BUDGET).optional(),
  tokenBudget: z.number().int().positive().optional(),
  mode: z.enum(RETRIEVAL_MODE).optional(),
  caps: z.object({
    knowledge: z.number().int().nonnegative().optional(),
    episodes: z.number().int().nonnegative().optional(),
    evaluatorExamples: z.number().int().nonnegative().optional(),
    baselineHints: z.number().int().nonnegative().optional(),
  }).optional(),
  includeWorkingSummary: z.boolean().optional(),
});

const captureBaselineSchema = z.object({
  appId: z.string().nullable().optional(),
  window: z.enum(BASELINE_WINDOW),
  successRate: z.number().min(0).max(1),
  p50LatencyMs: z.number().nonnegative(),
  p95LatencyMs: z.number().nonnegative(),
  avgCostMicros: z.number().nonnegative(),
  avgReplayCount: z.number().nonnegative(),
  avgApprovalCount: z.number().nonnegative(),
  evaluatorPassRate: z.number().min(0).max(1),
  sampleSize: z.number().int().nonnegative(),
  windowStart: z.string(),
  windowEnd: z.string(),
});

const anomalyCheckSchema = z.object({
  appId: z.string().nullable().optional(),
  successRate: z.number().min(0).max(1).optional(),
  latencyMs: z.number().nonnegative(),
  costMicros: z.number().nonnegative(),
  replayCount: z.number().int().nonnegative(),
  approvalCount: z.number().int().nonnegative(),
  evaluatorPassRate: z.number().min(0).max(1).optional(),
});

// ────────────────────────────────────────────────────────────
// Routes builder
// ────────────────────────────────────────────────────────────

export function buildMemoryRoutes(deps: MemoryRoutesDeps) {
  const app = new Hono();
  app.use('*', requireAuth(deps), requireWorkspace(deps));

  // ────────────────────────────────────────────────────────
  // Flat memory entries CRUD
  // ────────────────────────────────────────────────────────

  app.post('/', async (c) => {
    const ws = getWorkspace(c);
    const body = createEntrySchema.parse(await c.req.json());

    // Validate teamId if provided
    if (body.teamId) {
      const team = deps.db
        .select({ id: schema.teams.id })
        .from(schema.teams)
        .where(and(eq(schema.teams.id, body.teamId), eq(schema.teams.workspaceId, ws.workspaceId)))
        .get();
      if (!team) throw new AgentisError('RESOURCE_NOT_FOUND', `team '${body.teamId}' not found`);
    }

    const now = new Date().toISOString();
    const entry = {
      id: randomUUID(),
      workspaceId: ws.workspaceId,
      teamId: body.teamId ?? null,
      agentId: body.agentId ?? null,
      userId: body.userId ?? ws.user.id,
      sourceType: body.sourceType ?? 'operator',
      sourceId: body.sourceId ?? null,
      kind: body.kind ?? 'note',
      title: body.title,
      content: body.content,
      importance: body.importance ?? 5,
      confidence: body.confidence ?? 1,
      tags: body.tags ?? [],
      metadata: body.metadata ?? {},
      archivedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    deps.db.insert(schema.memoryEntries).values(entry).run();
    deps.bus.publish(
      REALTIME_ROOMS.workspace(ws.workspaceId),
      REALTIME_EVENTS.MEMORY_WRITTEN,
      { memory: entry },
    );
    return c.json({ memory: entry }, 201);
  });

  app.get('/', (c) => {
    const ws = getWorkspace(c);
    const q = c.req.query('q');
    const kind = c.req.query('kind');
    const teamId = c.req.query('teamId');
    const agentId = c.req.query('agentId');
    const includeArchived = c.req.query('includeArchived') === '1';
    const limit = Math.min(Number(c.req.query('limit') ?? '100'), 500);

    const conditions = [eq(schema.memoryEntries.workspaceId, ws.workspaceId)];
    if (!includeArchived) conditions.push(isNull(schema.memoryEntries.archivedAt));
    if (kind) conditions.push(eq(schema.memoryEntries.kind, kind));
    if (teamId) conditions.push(eq(schema.memoryEntries.teamId, teamId));
    if (agentId) conditions.push(eq(schema.memoryEntries.agentId, agentId));
    if (q) {
      const pattern = `%${q}%`;
      conditions.push(
        sql`(${schema.memoryEntries.title} LIKE ${pattern} OR ${schema.memoryEntries.content} LIKE ${pattern})`,
      );
    }

    const rows = deps.db
      .select()
      .from(schema.memoryEntries)
      .where(and(...conditions))
      .orderBy(sql`${schema.memoryEntries.updatedAt} DESC`)
      .limit(limit)
      .all();
    return c.json({ memory: rows, count: rows.length });
  });

  app.get('/:id', (c) => {
    const ws = getWorkspace(c);
    const id = c.req.param('id');
    const entry = deps.db
      .select()
      .from(schema.memoryEntries)
      .where(and(eq(schema.memoryEntries.id, id), eq(schema.memoryEntries.workspaceId, ws.workspaceId)))
      .get();
    if (!entry) throw new AgentisError('RESOURCE_NOT_FOUND', `memory entry '${id}' not found`);
    return c.json({ memory: entry });
  });

  app.patch('/:id', async (c) => {
    const ws = getWorkspace(c);
    const id = c.req.param('id');
    const body = patchEntrySchema.parse(await c.req.json());

    const existing = deps.db
      .select()
      .from(schema.memoryEntries)
      .where(and(eq(schema.memoryEntries.id, id), eq(schema.memoryEntries.workspaceId, ws.workspaceId)))
      .get();
    if (!existing) throw new AgentisError('RESOURCE_NOT_FOUND', `memory entry '${id}' not found`);

    const patch: Record<string, unknown> = { updatedAt: new Date().toISOString() };
    if (body.title !== undefined) patch.title = body.title;
    if (body.content !== undefined) patch.content = body.content;
    if (body.kind !== undefined) patch.kind = body.kind;
    if (body.importance !== undefined) patch.importance = body.importance;
    if (body.confidence !== undefined) patch.confidence = body.confidence;
    if (body.tags !== undefined) patch.tags = body.tags;
    if (body.metadata !== undefined) patch.metadata = body.metadata;

    deps.db.update(schema.memoryEntries).set(patch).where(eq(schema.memoryEntries.id, id)).run();
    const updated = { ...existing, ...patch };
    return c.json({ memory: updated });
  });

  app.delete('/:id', (c) => {
    const ws = getWorkspace(c);
    const id = c.req.param('id');
    const existing = deps.db
      .select()
      .from(schema.memoryEntries)
      .where(and(eq(schema.memoryEntries.id, id), eq(schema.memoryEntries.workspaceId, ws.workspaceId)))
      .get();
    if (!existing) throw new AgentisError('RESOURCE_NOT_FOUND', `memory entry '${id}' not found`);

    const archivedAt = new Date().toISOString();
    deps.db
      .update(schema.memoryEntries)
      .set({ archivedAt, updatedAt: archivedAt })
      .where(eq(schema.memoryEntries.id, id))
      .run();
    return c.json({ id, archived: true });
  });

  // ────────────────────────────────────────────────────────
  // Complex memory system (only registered when services are injected)
  // ────────────────────────────────────────────────────────

  if (deps.memory && deps.episodes && deps.promotion && deps.rollingBaselines) {
    const { memory, episodes, promotion, rollingBaselines } = deps;

  // ────────────────────────────────────────────────────────
  // Layer 1: Working memory
  // ────────────────────────────────────────────────────────

  app.get('/working/:runId', (c) => {
    const runId = c.req.param('runId');
    const entries = memory.snapshotWorking(runId);
    const summary = memory.summarizeWorking(runId);
    return c.json({ runId, entries, summary });
  });

  app.get('/working/:runId/summary', (c) => {
    const runId = c.req.param('runId');
    const summary = memory.summarizeWorking(runId);
    return c.json({ summary });
  });

  app.post('/working/:runId/compact', (c) => {
    const runId = c.req.param('runId');
    const summary = memory.compactWorking(runId);
    return c.json({ summary });
  });

  app.get('/working/:runId/:namespace/:kind/:key', (c) => {
    const runId = c.req.param('runId');
    const namespace = c.req.param('namespace') as WorkingMemoryNamespace;
    const kind = c.req.param('kind') as WorkingMemoryKind;
    const key = c.req.param('key');
    if (!NAMESPACE.includes(namespace)) {
      throw new AgentisError('VALIDATION_FAILED', `unknown namespace '${namespace}'`);
    }
    if (!KIND.includes(kind)) {
      throw new AgentisError('VALIDATION_FAILED', `unknown kind '${kind}'`);
    }
    const value = memory.readWorking(runId, namespace, kind, key);
    return c.json({ runId, namespace, kind, key, value });
  });

  app.put('/working/:runId/:namespace/:kind/:key', async (c) => {
    const runId = c.req.param('runId');
    const namespace = c.req.param('namespace') as WorkingMemoryNamespace;
    const kind = c.req.param('kind') as WorkingMemoryKind;
    const key = c.req.param('key');
    if (!NAMESPACE.includes(namespace)) {
      throw new AgentisError('VALIDATION_FAILED', `unknown namespace '${namespace}'`);
    }
    if (!KIND.includes(kind)) {
      throw new AgentisError('VALIDATION_FAILED', `unknown kind '${kind}'`);
    }
    const body = writeWorkingSchema.parse(await c.req.json());
    memory.writeWorking(runId, namespace, kind, key, body.payload);
    return c.json({ ok: true });
  });

  app.delete('/working/:runId/:namespace/:kind/:key', (c) => {
    const runId = c.req.param('runId');
    const namespace = c.req.param('namespace') as WorkingMemoryNamespace;
    const kind = c.req.param('kind') as WorkingMemoryKind;
    const key = c.req.param('key');
    if (!NAMESPACE.includes(namespace)) {
      throw new AgentisError('VALIDATION_FAILED', `unknown namespace '${namespace}'`);
    }
    if (!KIND.includes(kind)) {
      throw new AgentisError('VALIDATION_FAILED', `unknown kind '${kind}'`);
    }
    memory.deleteWorking(runId, namespace, kind, key);
    return c.json({ ok: true });
  });

  // ────────────────────────────────────────────────────────
  // Layer 3: Episodes
  // ────────────────────────────────────────────────────────

  app.get('/episodes', (c) => {
    const ws = getWorkspace(c);
    const appId = c.req.query('appId') ?? undefined;
    const workflowId = c.req.query('workflowId') ?? undefined;
    const runId = c.req.query('runId') ?? undefined;
    const includeArchived = c.req.query('includeArchived') === 'true';
    const limit = parseIntOr(c.req.query('limit'));
    const typeParam = c.req.query('type');
    const types = typeParam && EPISODE_TYPE.includes(typeParam as RuntimeEpisodeType)
      ? [typeParam as RuntimeEpisodeType] : undefined;
    const args: Parameters<typeof episodes.list>[0] = {
      workspaceId: ws.workspaceId,
      includeArchived,
    };
    if (appId) args.appId = appId;
    if (workflowId) args.workflowId = workflowId;
    if (runId) args.runId = runId;
    if (types) args.types = types;
    if (limit !== undefined) args.limit = limit;
    const episodeList = episodes.list(args);
    return c.json({ count: episodeList.length, episodes: episodeList });
  });

  app.post('/episodes', async (c) => {
    const ws = getWorkspace(c);
    const body = writeEpisodeSchema.parse(await c.req.json());
    const episode = memory.writeEpisode({
      workspaceId: ws.workspaceId,
      type: body.type,
      title: body.title,
      summary: body.summary,
      source: 'operator_write',
      ...(body.appId !== undefined ? { appId: body.appId } : {}),
      ...(body.workflowId !== undefined ? { workflowId: body.workflowId } : {}),
      ...(body.runId !== undefined ? { runId: body.runId } : {}),
      ...(body.agentId !== undefined ? { agentId: body.agentId } : {}),
      ...(body.details !== undefined ? { details: body.details } : {}),
      ...(body.confidence !== undefined ? { confidence: body.confidence } : {}),
      ...(body.importance !== undefined ? { importance: body.importance } : {}),
      ...(body.trust !== undefined ? { trust: body.trust } : {}),
      ...(body.tags !== undefined ? { tags: body.tags } : {}),
      ...(body.entities !== undefined ? { entities: body.entities } : {}),
      ...(body.outcomeStatus !== undefined ? { outcomeStatus: body.outcomeStatus as RuntimeEpisodeOutcome | null } : {}),
      ...(body.metadata !== undefined ? { metadata: body.metadata } : {}),
    });
    return c.json({ episode }, 201);
  });

  app.get('/episodes/:id', (c) => {
    const ws = getWorkspace(c);
    const id = c.req.param('id');
    const ep = episodes.byId(ws.workspaceId, id);
    if (!ep) throw new AgentisError('RESOURCE_NOT_FOUND', `episode '${id}' not found`);
    return c.json({ episode: ep });
  });

  app.patch('/episodes/:id', async (c) => {
    const ws = getWorkspace(c);
    const id = c.req.param('id');
    const body = updateEpisodeSchema.parse(await c.req.json());
    const updated = episodes.update(ws.workspaceId, id, body);
    if (!updated) throw new AgentisError('RESOURCE_NOT_FOUND', `episode '${id}' not found`);
    return c.json({ episode: updated });
  });

  app.delete('/episodes/:id', (c) => {
    const ws = getWorkspace(c);
    const id = c.req.param('id');
    const ok = episodes.archive(ws.workspaceId, id);
    if (!ok) throw new AgentisError('RESOURCE_NOT_FOUND', `episode '${id}' not found`);
    return c.json({ id, archived: true });
  });

  app.post('/episodes/:id/reinforce', async (c) => {
    const ws = getWorkspace(c);
    const id = c.req.param('id');
    const body = (await c.req.json().catch(() => ({}))) as {
      confidenceDelta?: number;
      trustDelta?: number;
      importanceDelta?: number;
    };
    const ep = episodes.reinforce(ws.workspaceId, id, body);
    if (!ep) throw new AgentisError('RESOURCE_NOT_FOUND', `episode '${id}' not found`);
    return c.json({ episode: ep });
  });

  app.post('/episodes/search', async (c) => {
    const ws = getWorkspace(c);
    const body = searchEpisodesSchema.parse(await c.req.json());
    const args: Parameters<typeof episodes.searchEpisodes>[0] = {
      workspaceId: ws.workspaceId,
    };
    if (body.appId) args.appId = body.appId;
    if (body.workflowId) args.workflowId = body.workflowId;
    if (body.query) args.query = body.query;
    if (body.types) args.types = body.types;
    if (body.tags) args.tags = body.tags;
    if (body.entities) args.entities = body.entities;
    if (body.outcomeStatus) args.outcomeStatus = body.outcomeStatus as RuntimeEpisodeOutcome;
    if (body.includeArchived !== undefined) args.includeArchived = body.includeArchived;
    if (body.includeSuperseded !== undefined) args.includeSuperseded = body.includeSuperseded;
    if (body.limit) args.limit = body.limit;
    const hits = episodes.searchEpisodes(args);
    return c.json({ count: hits.length, episodes: hits });
  });

  // ────────────────────────────────────────────────────────
  // Promotion
  // ────────────────────────────────────────────────────────

  app.post('/promotions/promote', async (c) => {
    const ws = getWorkspace(c);
    const body = promoteSchema.parse(await c.req.json());
    const decisions = body.candidates.map((candidate) => {
      const args: Parameters<typeof promotion.promoteCandidate>[0] = {
        workspaceId: ws.workspaceId,
        candidate: candidate as PromotionCandidate,
      };
      if (body.appId !== undefined) args.appId = body.appId;
      if (body.workflowId !== undefined) args.workflowId = body.workflowId;
      if (body.runId !== undefined) args.runId = body.runId;
      if (body.agentId !== undefined) args.agentId = body.agentId;
      return promotion.promoteCandidate(args);
    });
    const summary = {
      promoted: decisions.filter((d) => d.decision === 'promoted').length,
      merged: decisions.filter((d) => d.decision === 'merged').length,
      superseded: decisions.filter((d) => d.decision === 'superseded').length,
      rejected: decisions.filter((d) => d.decision === 'rejected').length,
    };
    return c.json({ summary, decisions });
  });

  app.get('/promotions', (c) => {
    const ws = getWorkspace(c);
    const args: Parameters<typeof promotion.listEvents>[0] = {
      workspaceId: ws.workspaceId,
    };
    const appId = c.req.query('appId');
    const runId = c.req.query('runId');
    const limit = parseIntOr(c.req.query('limit'));
    if (appId) args.appId = appId;
    if (runId) args.runId = runId;
    if (limit) args.limit = limit;
    const events = promotion.listEvents(args);
    return c.json({ count: events.length, events });
  });

  // ────────────────────────────────────────────────────────
  // Layer 5: Composed retrieval
  // ────────────────────────────────────────────────────────

  app.post('/retrieval/context', async (c) => {
    const ws = getWorkspace(c);
    const body = buildContextSchema.parse(await c.req.json());
    const params: Parameters<typeof memory.buildContext>[0] = {
      workspaceId: ws.workspaceId,
      taskDescription: body.taskDescription,
    };
    if (body.appId) params.appId = body.appId;
    if (body.workflowId) params.workflowId = body.workflowId;
    if (body.runId) params.runId = body.runId;
    if (body.agentId) params.agentId = body.agentId;
    if (body.budgetClass) params.budgetClass = body.budgetClass as RetrievalBudgetClass;
    if (body.tokenBudget) params.tokenBudget = body.tokenBudget;
    if (body.mode) params.mode = body.mode as RetrievalMode;
    if (body.caps) params.caps = body.caps;
    if (body.includeWorkingSummary !== undefined) params.includeWorkingSummary = body.includeWorkingSummary;
    const context = memory.buildContext(params);
    return c.json({ context });
  });

  // ────────────────────────────────────────────────────────
  // Layer 4: Rolling baselines
  // ────────────────────────────────────────────────────────

  app.get('/baselines/:workflowId', (c) => {
    const ws = getWorkspace(c);
    const workflowId = c.req.param('workflowId');
    const latest = rollingBaselines.latest(ws.workspaceId, workflowId);
    return c.json({ workflowId, latest });
  });

  app.get('/baselines/:workflowId/history', (c) => {
    const ws = getWorkspace(c);
    const workflowId = c.req.param('workflowId');
    const window = (c.req.query('window') ?? 'rolling_30d') as BaselineWindow;
    if (!BASELINE_WINDOW.includes(window)) {
      throw new AgentisError('VALIDATION_FAILED', `window must be one of ${BASELINE_WINDOW.join('|')}`);
    }
    const limit = parseIntOr(c.req.query('limit'));
    const args: Parameters<typeof rollingBaselines.history>[0] = {
      workspaceId: ws.workspaceId,
      workflowId,
      window,
    };
    if (limit) args.limit = limit;
    const history = rollingBaselines.history(args);
    return c.json({ workflowId, window, count: history.length, history });
  });

  app.post('/baselines/:workflowId/capture', async (c) => {
    const ws = getWorkspace(c);
    const workflowId = c.req.param('workflowId');
    const body = captureBaselineSchema.parse(await c.req.json());
    const snapshot = rollingBaselines.capture({
      workspaceId: ws.workspaceId,
      workflowId,
      ...(body.appId !== undefined ? { appId: body.appId } : {}),
      window: body.window as BaselineWindow,
      successRate: body.successRate,
      p50LatencyMs: body.p50LatencyMs,
      p95LatencyMs: body.p95LatencyMs,
      avgCostMicros: body.avgCostMicros,
      avgReplayCount: body.avgReplayCount,
      avgApprovalCount: body.avgApprovalCount,
      evaluatorPassRate: body.evaluatorPassRate,
      sampleSize: body.sampleSize,
      windowStart: body.windowStart,
      windowEnd: body.windowEnd,
    });
    return c.json({ snapshot }, 201);
  });

  app.post('/baselines/:workflowId/anomalies', async (c) => {
    const ws = getWorkspace(c);
    const workflowId = c.req.param('workflowId');
    const body = anomalyCheckSchema.parse(await c.req.json());
    const observed: Parameters<typeof rollingBaselines.detectAnomalies>[1] = {
      workflowId,
      latencyMs: body.latencyMs,
      costMicros: body.costMicros,
      replayCount: body.replayCount,
      approvalCount: body.approvalCount,
    };
    if (body.appId !== undefined) observed.appId = body.appId;
    if (body.successRate !== undefined) observed.successRate = body.successRate;
    if (body.evaluatorPassRate !== undefined) observed.evaluatorPassRate = body.evaluatorPassRate;
    const anomalies = rollingBaselines.detectAnomalies(ws.workspaceId, observed);
    return c.json({ workflowId, count: anomalies.length, anomalies });
  });

  } // end if (deps.memory && deps.episodes && deps.promotion && deps.rollingBaselines)

  return app;
}

// ────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────

function parseIntOr(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}
