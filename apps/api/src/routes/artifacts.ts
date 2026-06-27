import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { AgentisError, REALTIME_EVENTS, REALTIME_ROOMS, artifactTypeSchema, isArtifactType } from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { AuthService } from '../services/auth.js';
import type { EventBus } from '../event-bus.js';
import { requireAuth } from '../middleware/auth.js';
import { getWorkspace, requireWorkspace } from '../middleware/workspace.js';
import { deriveArtifactOrigin } from '../services/artifactService.js';

const ARTIFACT_ORIGINS = ['agent', 'app', 'workflow', 'channel', 'manual'] as const;

const createArtifactSchema = z.object({
  type: artifactTypeSchema.default('document'),
  title: z.string().trim().min(1).max(200),
  content: z.string().max(2_000_000).default(''),
  thumbnailUrl: z.string().url().max(2048).nullable().optional(),
  runId: z.string().uuid().nullable().optional(),
  workflowId: z.string().uuid().nullable().optional(),
  agentId: z.string().uuid().nullable().optional(),
  appId: z.string().uuid().nullable().optional(),
  conversationId: z.string().uuid().nullable().optional(),
  nodeId: z.string().max(120).nullable().optional(),
  origin: z.enum(ARTIFACT_ORIGINS).optional(),
  metadata: z.record(z.unknown()).default({}),
});

const updateArtifactSchema = createArtifactSchema.partial();
const pinSchema = z.object({ pinned: z.boolean().default(true) });

export function buildArtifactRoutes(deps: { db: AgentisSqliteDb; auth: AuthService; bus: EventBus }) {
  const app = new Hono();
  app.use('*', requireAuth(deps), requireWorkspace(deps));

  app.get('/', (c) => {
    const ws = getWorkspace(c);
    const type = c.req.query('type');
    const origin = c.req.query('origin');
    const runId = c.req.query('runId');
    const conversationId = c.req.query('conversationId');
    const agentId = c.req.query('agentId');
    const appId = c.req.query('appId');
    const workflowId = c.req.query('workflowId');
    const limit = Math.min(Math.max(Number(c.req.query('limit') ?? 100), 1), 500);
    const filters = [eq(schema.artifacts.workspaceId, ws.workspaceId)];
    if (isArtifactType(type)) filters.push(eq(schema.artifacts.type, type));
    if (isArtifactOrigin(origin)) filters.push(eq(schema.artifacts.origin, origin));
    if (runId) filters.push(eq(schema.artifacts.runId, runId));
    if (conversationId) filters.push(eq(schema.artifacts.conversationId, conversationId));
    if (agentId) filters.push(eq(schema.artifacts.agentId, agentId));
    if (appId) filters.push(eq(schema.artifacts.appId, appId));
    if (workflowId) filters.push(eq(schema.artifacts.workflowId, workflowId));
    if (c.req.query('pinned') === 'true') filters.push(eq(schema.artifacts.pinned, true));
    const rows = deps.db.select().from(schema.artifacts)
      .where(and(...filters))
      .orderBy(desc(schema.artifacts.createdAt))
      .limit(limit)
      .all();
    return c.json({ artifacts: rows });
  });

  app.post('/', async (c) => {
    const ws = getWorkspace(c);
    const body = createArtifactSchema.parse(await c.req.json());
    const now = new Date().toISOString();
    const artifact = {
      id: randomUUID(),
      workspaceId: ws.workspaceId,
      userId: ws.user.id,
      runId: body.runId ?? null,
      workflowId: body.workflowId ?? null,
      agentId: body.agentId ?? null,
      appId: body.appId ?? null,
      conversationId: body.conversationId ?? null,
      nodeId: body.nodeId ?? null,
      origin: deriveArtifactOrigin(body),
      type: body.type,
      title: body.title,
      content: body.content,
      thumbnailUrl: body.thumbnailUrl ?? null,
      metadata: body.metadata,
      createdAt: now,
      updatedAt: now,
    };
    deps.db.insert(schema.artifacts).values(artifact).run();
    deps.bus.publish(REALTIME_ROOMS.workspace(ws.workspaceId), REALTIME_EVENTS.ARTIFACT_CREATED, { artifact });
    return c.json({ artifact }, 201);
  });

  app.get('/:id', (c) => {
    const ws = getWorkspace(c);
    return c.json({ artifact: loadArtifact(deps.db, ws.workspaceId, c.req.param('id')) });
  });

  app.patch('/:id', async (c) => {
    const ws = getWorkspace(c);
    const existing = loadArtifact(deps.db, ws.workspaceId, c.req.param('id'));
    const body = updateArtifactSchema.parse(await c.req.json());
    const next = {
      type: body.type ?? existing.type,
      title: body.title ?? existing.title,
      content: body.content ?? existing.content,
      thumbnailUrl: body.thumbnailUrl === undefined ? existing.thumbnailUrl : body.thumbnailUrl ?? null,
      metadata: body.metadata ?? (existing.metadata as Record<string, unknown>),
      updatedAt: new Date().toISOString(),
    };
    deps.db.update(schema.artifacts).set(next).where(eq(schema.artifacts.id, existing.id)).run();
    const artifact = { ...existing, ...next };
    deps.bus.publish(REALTIME_ROOMS.workspace(ws.workspaceId), REALTIME_EVENTS.ARTIFACT_UPDATED, { artifact });
    return c.json({ artifact });
  });

  app.post('/:id/pin', async (c) => {
    const ws = getWorkspace(c);
    const existing = loadArtifact(deps.db, ws.workspaceId, c.req.param('id'));
    const pinned = pinSchema.parse(await c.req.json().catch(() => ({}))).pinned;
    deps.db.update(schema.artifacts).set({ pinned, updatedAt: new Date().toISOString() }).where(eq(schema.artifacts.id, existing.id)).run();
    const artifact = { ...existing, pinned };
    deps.bus.publish(REALTIME_ROOMS.workspace(ws.workspaceId), REALTIME_EVENTS.ARTIFACT_UPDATED, { artifact });
    return c.json({ artifact });
  });

  app.delete('/:id', (c) => {
    const ws = getWorkspace(c);
    const existing = loadArtifact(deps.db, ws.workspaceId, c.req.param('id'));
    deps.db.delete(schema.artifacts).where(eq(schema.artifacts.id, existing.id)).run();
    deps.bus.publish(REALTIME_ROOMS.workspace(ws.workspaceId), REALTIME_EVENTS.ARTIFACT_DELETED, { id: existing.id });
    return c.json({ ok: true, id: existing.id });
  });

  return app;
}

function isArtifactOrigin(value: string | undefined): value is typeof ARTIFACT_ORIGINS[number] {
  return ARTIFACT_ORIGINS.includes(value as typeof ARTIFACT_ORIGINS[number]);
}

function loadArtifact(db: AgentisSqliteDb, workspaceId: string, id: string) {
  const row = db.select().from(schema.artifacts)
    .where(and(eq(schema.artifacts.id, id), eq(schema.artifacts.workspaceId, workspaceId)))
    .get();
  if (!row) throw new AgentisError('RESOURCE_NOT_FOUND', 'Artifact not found');
  return row;
}
