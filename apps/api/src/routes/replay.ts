/**
 * /v1/runs/:id/replay — partial replay (V1-SPEC §6.7).
 *
 * Body:
 *   { mode: ReplayMode, targetNodeId?: string, nodeConfigPatch?: object }
 *
 * Always creates a new run row with parentRunId pointing at the source.
 * Returns the new runId; the dashboard navigates to /runs/:newId.
 */

import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { AgentisError } from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { AuthService } from '../services/auth.js';
import type { WorkflowEngine } from '../engine/WorkflowEngine.js';
import type { PartialReplayService } from '../services/partialReplay.js';
import { requireAuth } from '../middleware/auth.js';
import { requireWorkspace, getWorkspace } from '../middleware/workspace.js';

const replaySchema = z.object({
  mode: z.enum(['replay-from-node', 'replay-failed-branch', 'replay-with-edited-node', 'replay-from-checkpoint']),
  targetNodeId: z.string().optional(),
  nodeConfigPatch: z.record(z.unknown()).optional(),
});

export function buildReplayRoutes(deps: {
  db: AgentisSqliteDb;
  auth: AuthService;
  engine: WorkflowEngine;
  replay: PartialReplayService;
}) {
  const app = new Hono();
  app.use('*', requireAuth(deps), requireWorkspace(deps));

  app.post('/:runId/replay', async (c) => {
    const ws = getWorkspace(c);
    const sourceRunId = c.req.param('runId');
    const body = replaySchema.parse(await c.req.json());
    const source = deps.db.select().from(schema.workflowRuns).where(eq(schema.workflowRuns.id, sourceRunId)).get();
    if (!source || source.workspaceId !== ws.workspaceId) {
      throw new AgentisError('WORKFLOW_RUN_NOT_FOUND', `source run ${sourceRunId} not found`);
    }
    const prepared = deps.replay.prepare({
      workspaceId: ws.workspaceId,
      sourceRunId,
      mode: body.mode,
      ...(body.targetNodeId ? { targetNodeId: body.targetNodeId } : {}),
      ...(body.nodeConfigPatch ? { nodeConfigPatch: body.nodeConfigPatch } : {}),
      userId: ws.user.id,
    });
    deps.replay.persistChildRun({
      runId: prepared.runId,
      workspaceId: prepared.workspaceId,
      ambientId: prepared.ambientId,
      workflowId: prepared.workflowId,
      userId: ws.user.id,
      parentRunId: sourceRunId,
      initialState: prepared.initialState,
      parentReplanCount: source.replanCount,
    });
    await deps.engine.startRun({ ...prepared, triggerId: null });
    return c.json({ runId: prepared.runId, parentRunId: sourceRunId, mode: body.mode }, 202);
  });

  return app;
}
