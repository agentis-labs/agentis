/**
 * /v1/approvals — V1-SPEC §11.10 inbox + resolve.
 */

import { Hono } from 'hono';
import { AgentisError } from '@agentis/core';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { AuthService } from '../services/auth.js';
import type { ApprovalInboxService } from '../services/approvalInbox.js';
import { requireAuth } from '../middleware/auth.js';
import { requireWorkspace, getWorkspace } from '../middleware/workspace.js';

export function buildApprovalRoutes(deps: {
  db: AgentisSqliteDb;
  auth: AuthService;
  approvals: ApprovalInboxService;
}) {
  const app = new Hono();
  app.use('*', requireAuth(deps), requireWorkspace(deps));

  app.get('/', (c) => {
    const ws = getWorkspace(c);
    const status = (c.req.query('status') ?? 'pending') as 'pending' | 'all';
    return c.json({ approvals: deps.approvals.list(ws.workspaceId, status) });
  });

  app.post('/:id/resolve', async (c) => {
    const ws = getWorkspace(c);
    const id = c.req.param('id');
    const body = (await c.req.json().catch(() => ({}))) as {
      decision?: 'approve' | 'reject';
      reason?: string;
    };
    if (body.decision !== 'approve' && body.decision !== 'reject') {
      throw new AgentisError('VALIDATION_FAILED', 'decision must be approve|reject');
    }
    const result = await deps.approvals.resolve({
      workspaceId: ws.workspaceId,
      approvalId: id,
      decision: body.decision,
      reason: body.reason,
    });
    return c.json({ approval: result });
  });

  return app;
}
