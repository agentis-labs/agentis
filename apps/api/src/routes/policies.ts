import { Hono } from 'hono';
import { z } from 'zod';
import type { AuthService } from '../services/auth.js';
import type { PolicyService } from '../services/policies.js';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import { requireAuth } from '../middleware/auth.js';
import { requireWorkspace, getWorkspace } from '../middleware/workspace.js';

const policyRuleSchema = z.object({
  condition: z.string().max(2000).optional(),
  decision: z.enum(['allow', 'deny', 'require_approval']).optional(),
  reason: z.string().max(1000).optional(),
});

const policyBodySchema = z.object({
  name: z.string().trim().min(1).max(255),
  description: z.string().max(2000).nullable().optional(),
  subjectKind: z.string().trim().min(1).max(80).default('workspace').optional(),
  subjectId: z.string().nullable().optional(),
  effect: z.enum(['allow', 'deny', 'require_approval']).default('allow').optional(),
  rules: z.array(policyRuleSchema).default([]).optional(),
  status: z.enum(['active', 'paused']).default('active').optional(),
  priority: z.number().int().min(-1000).max(1000).default(0).optional(),
});

const evaluateSchema = z.object({
  subjectKind: z.string().trim().min(1).max(80).optional(),
  subjectId: z.string().nullable().optional(),
  input: z.record(z.string(), z.unknown()).default({}).optional(),
  runId: z.string().uuid().nullable().optional(),
  nodeId: z.string().nullable().optional(),
});

export function buildPolicyRoutes(deps: { db: AgentisSqliteDb; auth: AuthService; policies: PolicyService }) {
  const app = new Hono();
  app.use('*', requireAuth(deps), requireWorkspace(deps));

  app.get('/', (c) => {
    const ws = getWorkspace(c);
    return c.json({ policies: deps.policies.list(ws.workspaceId) });
  });

  app.post('/', async (c) => {
    const ws = getWorkspace(c);
    const body = policyBodySchema.parse(await c.req.json());
    const policy = deps.policies.create({ workspaceId: ws.workspaceId, userId: ws.user.id, ...body });
    return c.json({ policy }, 201);
  });

  app.post('/evaluate', async (c) => {
    const ws = getWorkspace(c);
    const body = evaluateSchema.parse(await c.req.json());
    return c.json(deps.policies.evaluate({
      workspaceId: ws.workspaceId,
      subjectKind: body.subjectKind,
      subjectId: body.subjectId,
      input: body.input,
      runId: body.runId,
      nodeId: body.nodeId,
    }));
  });

  app.get('/decisions', (c) => {
    const ws = getWorkspace(c);
    return c.json({ decisions: deps.policies.listDecisions(ws.workspaceId) });
  });

  app.get('/:id', (c) => {
    const ws = getWorkspace(c);
    return c.json({ policy: deps.policies.get(ws.workspaceId, c.req.param('id')) });
  });

  app.patch('/:id', async (c) => {
    const ws = getWorkspace(c);
    const body = policyBodySchema.partial().parse(await c.req.json());
    const policy = deps.policies.update(ws.workspaceId, c.req.param('id'), body);
    return c.json({ policy });
  });

  return app;
}