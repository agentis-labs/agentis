import { Hono } from 'hono';
import { z } from 'zod';
import type { AuthService } from '../services/auth.js';
import type { EvalService } from '../services/evals.js';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import { requireAuth } from '../middleware/auth.js';
import { requireWorkspace, getWorkspace } from '../middleware/workspace.js';

const caseSchema = z.object({
  name: z.string().trim().min(1).max(255).optional(),
  input: z.unknown().optional(),
  expected: z.unknown().optional(),
  metadata: z.unknown().optional(),
});

const createSuiteSchema = z.object({
  appInstanceId: z.string().uuid().nullable().optional(),
  workflowId: z.string().uuid().nullable().optional(),
  name: z.string().trim().min(1).max(255),
  description: z.string().max(2000).nullable().optional(),
  datasetKey: z.string().min(1).nullable().optional(),
  rubric: z.unknown().optional(),
  config: z.record(z.string(), z.unknown()).default({}).optional(),
  cases: z.array(caseSchema).default([]).optional(),
});

const runSuiteSchema = z.object({
  syncTimeoutMs: z.number().int().min(0).max(10_000).optional(),
});

export function buildEvalRoutes(deps: { db: AgentisSqliteDb; auth: AuthService; evals: EvalService }) {
  const app = new Hono();
  app.use('*', requireAuth(deps), requireWorkspace(deps));

  app.get('/', (c) => {
    const ws = getWorkspace(c);
    return c.json({ suites: deps.evals.listSuites(ws.workspaceId) });
  });

  app.post('/', async (c) => {
    const ws = getWorkspace(c);
    const body = createSuiteSchema.parse(await c.req.json());
    const suite = deps.evals.createSuite({
      workspaceId: ws.workspaceId,
      userId: ws.user.id,
      appInstanceId: body.appInstanceId,
      workflowId: body.workflowId,
      name: body.name,
      description: body.description,
      datasetKey: body.datasetKey,
      rubric: body.rubric,
      config: body.config,
      cases: body.cases,
    });
    return c.json(suite, 201);
  });

  app.get('/:suiteId', (c) => {
    const ws = getWorkspace(c);
    return c.json(deps.evals.getSuite(ws.workspaceId, c.req.param('suiteId')));
  });

  app.post('/:suiteId/cases', async (c) => {
    const ws = getWorkspace(c);
    const body = caseSchema.extend({ name: z.string().trim().min(1).max(255) }).parse(await c.req.json());
    const item = deps.evals.addCase(ws.workspaceId, c.req.param('suiteId'), {
      name: body.name,
      input: body.input ?? {},
      expected: body.expected ?? {},
      metadata: body.metadata ?? {},
    });
    return c.json({ case: item }, 201);
  });

  app.get('/:suiteId/results', (c) => {
    const ws = getWorkspace(c);
    return c.json({ results: deps.evals.listResults(ws.workspaceId, c.req.param('suiteId')) });
  });

  app.post('/:suiteId/run', async (c) => {
    const ws = getWorkspace(c);
    const body = runSuiteSchema.parse(await c.req.json().catch(() => ({})));
    const result = await deps.evals.runSuite({
      workspaceId: ws.workspaceId,
      userId: ws.user.id,
      suiteId: c.req.param('suiteId'),
      syncTimeoutMs: body.syncTimeoutMs,
    });
    return c.json({ result });
  });

  return app;
}