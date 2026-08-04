import { Hono } from 'hono';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { schema, type AgentisSqliteDb } from '@agentis/db/sqlite';
import { requireAuth } from '../middleware/auth.js';
import { getWorkspace, requireWorkspace } from '../middleware/workspace.js';
import type { AuthService } from '../services/auth.js';
import {
  warmLocalEmbeddingModel,
} from '../services/embedding/embeddingProvider.js';
import { embeddingRuntimeManager } from '../services/embedding/embeddingRuntimeManager.js';

const retrySchema = z.object({ repair: z.boolean().optional().default(false) });

export function buildEmbeddingRuntimeRoutes(deps: { db: AgentisSqliteDb; auth: AuthService }) {
  const app = new Hono();
  app.use('*', requireAuth(deps), requireWorkspace(deps));

  app.get('/', (c) => {
    const { workspaceId } = getWorkspace(c);
    return c.json({ ...embeddingRuntimeManager.snapshot(), pending: pendingCounts(deps.db, workspaceId) });
  });

  app.post('/retry', async (c) => {
    const { workspaceId } = getWorkspace(c);
    const body = retrySchema.parse(await c.req.json().catch(() => ({})));
    const result = await warmLocalEmbeddingModel(undefined, { force: true, repair: body.repair });
    return c.json({
      ok: true,
      backupDir: result.backupDir,
      runtime: embeddingRuntimeManager.snapshot(),
      pending: pendingCounts(deps.db, workspaceId),
    });
  });

  return app;
}

function pendingCounts(db: AgentisSqliteDb, workspaceId: string) {
  const memories = db.select({ count: sql<number>`count(*)` }).from(schema.memoryEpisodes)
    .where(and(eq(schema.memoryEpisodes.workspaceId, workspaceId), eq(schema.memoryEpisodes.needsReembed, true)))
    .get()?.count ?? 0;
  const sessionMoments = db.select({ count: sql<number>`count(*)` }).from(schema.sessionMoments)
    .where(and(eq(schema.sessionMoments.workspaceId, workspaceId), eq(schema.sessionMoments.needsReembed, true)))
    .get()?.count ?? 0;
  return { memories: Number(memories), sessionMoments: Number(sessionMoments), total: Number(memories) + Number(sessionMoments) };
}
