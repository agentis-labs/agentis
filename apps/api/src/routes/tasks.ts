/**
 * /v1/tasks — V1-SPEC §3.3 spec-named entry point.
 *
 * Read-only task surface. Tasks are agent-execution units derived from the
 * adapter dispatch pipeline (see adapters/AdapterManager.ts). The engine
 * writes task rows; this surface lets the dashboard query open tasks per
 * workspace + agent.
 */

import { Hono } from 'hono';
import { and, desc, eq } from 'drizzle-orm';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { AuthService } from '../services/auth.js';
import type { PlanService } from '../services/planService.js';
import type { AgentSessionService } from '../services/agent/agentSession.js';
import { requireAuth } from '../middleware/auth.js';
import { requireWorkspace, getWorkspace } from '../middleware/workspace.js';

export function buildTaskRoutes(deps: {
  db: AgentisSqliteDb;
  auth: AuthService;
  plans?: PlanService;
  sessions?: AgentSessionService;
}) {
  const app = new Hono();
  app.use('*', requireAuth(deps), requireWorkspace(deps));

  app.get('/spines', (c) => {
    const ws = getWorkspace(c);
    const limit = Math.min(Math.max(Number(c.req.query('limit') ?? 50), 1), 200);
    const rows = deps.db
      .select()
      .from(schema.plans)
      .where(eq(schema.plans.workspaceId, ws.workspaceId))
      .orderBy(desc(schema.plans.updatedAt))
      .limit(limit)
      .all();
    return c.json({ tasks: rows });
  });

  app.get('/spines/:id', (c) => {
    if (!deps.plans) return c.json({ error: { code: 'SERVICE_UNAVAILABLE', message: 'Task spine service not available.' } }, 503);
    const ws = getWorkspace(c);
    try {
      return c.json({ task: deps.plans.get(ws.workspaceId, c.req.param('id')) });
    } catch {
      return c.json({ error: { code: 'RESOURCE_NOT_FOUND', message: 'Task spine not found.' } }, 404);
    }
  });

  app.post('/spines/:id/redirect', async (c) => {
    if (!deps.plans) return c.json({ error: { code: 'SERVICE_UNAVAILABLE', message: 'Task spine service not available.' } }, 503);
    const ws = getWorkspace(c);
    const body = await c.req.json().catch(() => ({})) as { instruction?: unknown; reason?: unknown };
    const instruction = String(body.instruction ?? '').trim();
    const reason = String(body.reason ?? '').trim();
    if (!instruction) {
      return c.json({ error: { code: 'VALIDATION_FAILED', message: 'instruction is required.' } }, 422);
    }
    let task;
    try {
      task = deps.plans.recordDecision(ws.workspaceId, ws.user.id, c.req.param('id'), {
        summary: 'Operator redirected task',
        rationale: reason ? `${reason}\n\n${instruction}` : instruction,
        actorId: ws.user.id,
      });
      task = deps.plans.setStatus(ws.workspaceId, ws.user.id, task.id, 'executing');
    } catch {
      return c.json({ error: { code: 'RESOURCE_NOT_FOUND', message: 'Task spine not found.' } }, 404);
    }

    let injected = false;
    if (task.sessionId && deps.sessions) {
      const session = deps.sessions.get(task.sessionId);
      if (session) {
        const stamp = new Date().toISOString();
        const addition = `## Operator redirect (${stamp})\n${reason ? `Reason: ${reason}\n` : ''}Instruction: ${instruction}`;
        deps.sessions.updateMemoryBlock(
          session.id,
          'observations',
          session.observationsBlock ? `${session.observationsBlock}\n\n${addition}` : addition,
        );
        if (session.status === 'waiting') deps.sessions.wake(session.id);
        injected = true;
      }
    }
    deps.plans.emitRedirect(ws.workspaceId, task, {
      instruction,
      reason: reason || undefined,
      injected,
      actorId: ws.user.id,
    });
    return c.json({ task, injected });
  });

  app.get('/', (c) => {
    const ws = getWorkspace(c);
    const agentId = c.req.query('agentId');
    const limit = Math.min(Math.max(Number(c.req.query('limit') ?? 100), 1), 500);
    // Tasks bind to executors via (executorType, executorRef). Filtering by
    // an agent id therefore narrows to executorType='agent' AND executorRef.
    const where = agentId
      ? and(
          eq(schema.tasks.workspaceId, ws.workspaceId),
          eq(schema.tasks.executorType, 'agent'),
          eq(schema.tasks.executorRef, agentId),
        )
      : eq(schema.tasks.workspaceId, ws.workspaceId);
    const rows = deps.db
      .select()
      .from(schema.tasks)
      .where(where)
      .all()
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
      .slice(0, limit);
    return c.json({ tasks: rows });
  });

  return app;
}
