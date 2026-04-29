/**
 * /v1/runs — list, get, cancel, ledger, snapshot.
 */

import { Hono } from 'hono';
import { and, eq } from 'drizzle-orm';
import { AgentisError } from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { AuthService } from '../services/auth.js';
import type { WorkflowEngine } from '../engine/WorkflowEngine.js';
import type { LedgerService } from '../services/ledger.js';
import { requireAuth } from '../middleware/auth.js';
import { requireWorkspace, getWorkspace } from '../middleware/workspace.js';

export function buildRunRoutes(deps: {
  db: AgentisSqliteDb;
  auth: AuthService;
  engine: WorkflowEngine;
  ledger: LedgerService;
}) {
  const app = new Hono();
  app.use('*', requireAuth(deps), requireWorkspace(deps));

  app.get('/', (c) => {
    const ws = getWorkspace(c);
    const limit = Math.min(Math.max(Number(c.req.query('limit') ?? 50), 1), 200);
    const rows = deps.db
      .select()
      .from(schema.workflowRuns)
      .where(eq(schema.workflowRuns.workspaceId, ws.workspaceId))
      .all()
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
      .slice(0, limit);
    return c.json({ runs: rows });
  });

  app.get('/:id', (c) => {
    const ws = getWorkspace(c);
    const id = c.req.param('id');
    const run = loadRun(deps.db, ws.workspaceId, id);
    return c.json({ run });
  });

  app.post('/:id/cancel', async (c) => {
    const ws = getWorkspace(c);
    const id = c.req.param('id');
    loadRun(deps.db, ws.workspaceId, id);
    await deps.engine.cancelRun(id);
    return c.json({ ok: true });
  });

  app.get('/:id/ledger', async (c) => {
    const ws = getWorkspace(c);
    const id = c.req.param('id');
    loadRun(deps.db, ws.workspaceId, id);
    const after = c.req.query('after_sequence')
      ? Number(c.req.query('after_sequence'))
      : undefined;
    const limit = c.req.query('limit') ? Number(c.req.query('limit')) : undefined;
    const events = await deps.ledger.listForRun({ runId: id, afterSequence: after, limit });
    return c.json({ events });
  });

  return app;
}

function loadRun(db: AgentisSqliteDb, workspaceId: string, id: string) {
  const run = db
    .select()
    .from(schema.workflowRuns)
    .where(and(eq(schema.workflowRuns.id, id), eq(schema.workflowRuns.workspaceId, workspaceId)))
    .get();
  if (!run) throw new AgentisError('WORKFLOW_RUN_NOT_FOUND', 'Run not found');
  return run;
}
