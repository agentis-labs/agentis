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

  app.get('/:id', (c) => {
    const ws = getWorkspace(c);
    const approval = deps.approvals.get(ws.workspaceId, c.req.param('id'));
    if (!approval) throw new AgentisError('RESOURCE_NOT_FOUND', 'Approval not found');
    return c.json({ approval });
  });

  app.post('/:id/resolve', async (c) => {
    const ws = getWorkspace(c);
    const id = c.req.param('id');
    const body = (await c.req.json().catch(() => ({}))) as {
      decision?: 'approve' | 'reject' | 'revise';
      reason?: string;
      /** Operator instruction sent back to the waiting agent for a `revise` decision. */
      feedback?: string;
      /** Submitted form values for a human_input node. */
      data?: Record<string, unknown>;
    };
    if (body.decision !== 'approve' && body.decision !== 'reject' && body.decision !== 'revise') {
      throw new AgentisError('VALIDATION_FAILED', 'decision must be approve|reject|revise');
    }
    // A `revise` decision is meaningless without an instruction to send back.
    const feedback = typeof body.feedback === 'string' ? body.feedback.trim() : '';
    if (body.decision === 'revise' && !feedback) {
      throw new AgentisError('VALIDATION_FAILED', 'revise requires a non-empty feedback instruction');
    }
    const result = await deps.approvals.resolve({
      workspaceId: ws.workspaceId,
      approvalId: id,
      decision: body.decision,
      reason: body.reason,
      ...(body.decision === 'revise' ? { feedback } : {}),
      ...(body.data && typeof body.data === 'object' && !Array.isArray(body.data) ? { data: body.data } : {}),
    });
    return c.json({ approval: result });
  });

  return app;
}
