import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { AgentisError, REALTIME_EVENTS, REALTIME_ROOMS } from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { AuthService } from '../services/auth.js';
import type { EventBus } from '../event-bus.js';
import { requireAuth } from '../middleware/auth.js';
import { getWorkspace, requireWorkspace } from '../middleware/workspace.js';

const ARTIFACT_TYPES = ['html', 'image', 'document', 'code', 'data'] as const;

const createArtifactSchema = z.object({
  type: z.enum(ARTIFACT_TYPES).default('document'),
  title: z.string().trim().min(1).max(200),
  content: z.string().max(2_000_000).default(''),
  thumbnailUrl: z.string().url().max(2048).nullable().optional(),
  runId: z.string().uuid().nullable().optional(),
  workflowId: z.string().uuid().nullable().optional(),
  agentId: z.string().uuid().nullable().optional(),
  conversationId: z.string().uuid().nullable().optional(),
  nodeId: z.string().max(120).nullable().optional(),
  metadata: z.record(z.unknown()).default({}),
});

const updateArtifactSchema = createArtifactSchema.partial();

export function buildArtifactRoutes(deps: { db: AgentisSqliteDb; auth: AuthService; bus: EventBus }) {
  const app = new Hono();
  app.use('*', requireAuth(deps), requireWorkspace(deps));

  app.get('/', (c) => {
    const ws = getWorkspace(c);
    const type = c.req.query('type');
    const runId = c.req.query('runId');
    const conversationId = c.req.query('conversationId');
    const agentId = c.req.query('agentId');
    const limit = Math.min(Math.max(Number(c.req.query('limit') ?? 100), 1), 500);
    const filters = [eq(schema.artifacts.workspaceId, ws.workspaceId)];
    if (isArtifactType(type)) filters.push(eq(schema.artifacts.type, type));
    if (runId) filters.push(eq(schema.artifacts.runId, runId));
    if (conversationId) filters.push(eq(schema.artifacts.conversationId, conversationId));
    if (agentId) filters.push(eq(schema.artifacts.agentId, agentId));
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
      conversationId: body.conversationId ?? null,
      nodeId: body.nodeId ?? null,
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

  app.delete('/:id', (c) => {
    const ws = getWorkspace(c);
    const existing = loadArtifact(deps.db, ws.workspaceId, c.req.param('id'));
    deps.db.delete(schema.artifacts).where(eq(schema.artifacts.id, existing.id)).run();
    deps.bus.publish(REALTIME_ROOMS.workspace(ws.workspaceId), REALTIME_EVENTS.ARTIFACT_DELETED, { id: existing.id });
    return c.json({ ok: true, id: existing.id });
  });

  return app;
}

function isArtifactType(value: string | undefined): value is typeof ARTIFACT_TYPES[number] {
  return ARTIFACT_TYPES.includes(value as typeof ARTIFACT_TYPES[number]);
}

function loadArtifact(db: AgentisSqliteDb, workspaceId: string, id: string) {
  const row = db.select().from(schema.artifacts)
    .where(and(eq(schema.artifacts.id, id), eq(schema.artifacts.workspaceId, workspaceId)))
    .get();
  if (!row) throw new AgentisError('RESOURCE_NOT_FOUND', 'Artifact not found');
  return row;
}
