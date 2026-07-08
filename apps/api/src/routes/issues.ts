import { Hono } from 'hono';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { AgentisError } from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { AuthService } from '../services/auth.js';
import type { IssueService } from '../services/issues.js';
import type { PartialReplayService } from '../services/partialReplay.js';
import type { WorkflowEngine } from '../engine/WorkflowEngine.js';
import { requireAuth } from '../middleware/auth.js';
import { requireWorkspace, getWorkspace } from '../middleware/workspace.js';

const issueSchema = z.object({
  assigneeAgentId: z.string().uuid().nullable().optional(),
  linkedWorkflowId: z.string().uuid().nullable().optional(),
  title: z.string().trim().min(1).max(255),
  description: z.string().max(8000).nullable().optional(),
  status: z.enum(['backlog', 'todo', 'in_progress', 'in_review', 'blocked', 'done', 'cancelled']).optional(),
  priority: z.enum(['urgent', 'high', 'medium', 'low', 'none']).optional(),
  labels: z.array(z.string()).optional(),
  scheduledFor: z.string().datetime().nullable().optional(),
  recurrenceCron: z.string().trim().min(1).max(120).nullable().optional(),
});
const updateIssueSchema = issueSchema.partial();
const acceptSchema = z.object({ agentId: z.string().uuid().nullable().optional() });

export function buildIssueRoutes(deps: {
  db: AgentisSqliteDb;
  auth: AuthService;
  issues: IssueService;
  replay: PartialReplayService;
  engine: WorkflowEngine;
}) {
  const app = new Hono();
  app.use('*', requireAuth(deps), requireWorkspace(deps));

  app.get('/', (c) => {
    const ws = getWorkspace(c);
    let rows = deps.issues.list(ws.workspaceId);
    const status = c.req.query('status');
    const assignee = c.req.query('assigneeAgentId');
    if (status) rows = rows.filter((issue) => issue.status === status);
    if (assignee) rows = rows.filter((issue) => issue.assigneeAgentId === assignee);
    return c.json({ issues: rows });
  });

  app.post('/', async (c) => {
    const ws = getWorkspace(c);
    const body = issueSchema.parse(await c.req.json());
    const issue = deps.issues.create({ workspaceId: ws.workspaceId, userId: ws.user.id, ...body });
    return c.json({ issue }, 201);
  });

  app.get('/:id', async (c) => {
    const ws = getWorkspace(c);
    const issue = deps.issues.get(ws.workspaceId, c.req.param('id'));
    if (!issue) throw new AgentisError('RESOURCE_NOT_FOUND', 'Issue not found');
    const thread = await deps.issues.thread(ws.workspaceId, issue.id);
    return c.json({ issue, thread });
  });

  app.patch('/:id', async (c) => {
    const ws = getWorkspace(c);
    const issue = deps.issues.update(ws.workspaceId, c.req.param('id'), updateIssueSchema.parse(await c.req.json()));
    if (!issue) throw new AgentisError('RESOURCE_NOT_FOUND', 'Issue not found');
    return c.json({ issue });
  });

  app.delete('/:id', (c) => {
    const ws = getWorkspace(c);
    const removed = deps.issues.delete(ws.workspaceId, c.req.param('id'));
    if (!removed) throw new AgentisError('RESOURCE_NOT_FOUND', 'Issue not found');
    return c.json({ ok: true });
  });

  app.post('/:id/accept', async (c) => {
    const ws = getWorkspace(c);
    const body = acceptSchema.parse(await c.req.json().catch(() => ({})));
    const result = await deps.issues.accept({ workspaceId: ws.workspaceId, userId: ws.user.id, issueId: c.req.param('id'), agentId: body.agentId });
    if (!result) throw new AgentisError('RESOURCE_NOT_FOUND', 'Issue not found');
    return c.json(result, 202);
  });

  app.get('/:id/thread', async (c) => {
    const ws = getWorkspace(c);
    return c.json({ thread: await deps.issues.thread(ws.workspaceId, c.req.param('id')) });
  });

  app.post('/:id/replay', async (c) => {
    const ws = getWorkspace(c);
    const issue = deps.issues.get(ws.workspaceId, c.req.param('id'));
    if (!issue?.activeRunId) throw new AgentisError('RESOURCE_NOT_FOUND', 'Issue has no active run');
    const prepared = deps.replay.prepare({
      workspaceId: ws.workspaceId,
      sourceRunId: issue.activeRunId,
      mode: 'replay-failed-branch',
      userId: ws.user.id,
    });
    deps.db.insert(schema.workflowRuns).values({
      id: prepared.runId,
      workspaceId: prepared.workspaceId,
      ambientId: prepared.ambientId,
      workflowId: prepared.workflowId,
      userId: prepared.userId,
      status: 'CREATED',
      runState: prepared.initialState,
      triggerId: null,
      parentRunId: issue.activeRunId,
      replanCount: 1,
    }).run();
    await deps.engine.startRun({
      workspaceId: prepared.workspaceId,
      ambientId: prepared.ambientId,
      workflowId: prepared.workflowId,
      userId: prepared.userId,
      triggerId: null,
      inputs: prepared.inputs,
      initialState: prepared.initialState,
      graph: prepared.graph,
    });
    deps.db.update(schema.issues).set({ activeRunId: prepared.runId, updatedAt: new Date().toISOString() }).where(and(eq(schema.issues.id, issue.id), eq(schema.issues.workspaceId, ws.workspaceId))).run();
    return c.json({ runId: prepared.runId }, 202);
  });

  return app;
}
