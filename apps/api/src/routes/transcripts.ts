import { Hono } from 'hono';
import type { AuthService } from '../services/auth.js';
import type { LedgerService } from '../services/ledger.js';
import { requireAuth } from '../middleware/auth.js';
import { requireWorkspace, getWorkspace } from '../middleware/workspace.js';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import { schema } from '@agentis/db/sqlite';
import { and, eq } from 'drizzle-orm';
import { AgentisError } from '@agentis/core';

export function buildTranscriptRoutes(deps: { db: AgentisSqliteDb; auth: AuthService; ledger: LedgerService }) {
  const app = new Hono();
  app.use('*', requireAuth(deps), requireWorkspace(deps));

  app.get('/:id/transcript', async (c) => {
    const ws = getWorkspace(c);
    const runId = c.req.param('id');
    const run = deps.db
      .select()
      .from(schema.workflowRuns)
      .where(and(eq(schema.workflowRuns.id, runId), eq(schema.workflowRuns.workspaceId, ws.workspaceId)))
      .get();
    if (!run) throw new AgentisError('WORKFLOW_RUN_NOT_FOUND', 'Run not found');
    const events = await deps.ledger.listForRun({ runId, limit: 1000 });
    return c.json({ blocks: buildTranscriptBlocks(events) });
  });

  return app;
}

function buildTranscriptBlocks(events: Array<{ id: string; eventType: string; payload: Record<string, unknown>; createdAt: string; nodeId: string | null; taskId: string | null; sequenceNumber: number }>) {
  return events.map((event) => {
    if (event.eventType.startsWith('tool_call.')) {
      return { type: 'tool', id: event.id, at: event.createdAt, nodeId: event.nodeId, sequenceNumber: event.sequenceNumber, payload: event.payload };
    }
    if (event.eventType === 'agent_message') {
      return { type: 'message', id: event.id, at: event.createdAt, nodeId: event.nodeId, sequenceNumber: event.sequenceNumber, payload: event.payload };
    }
    if (event.eventType === 'file_changed') {
      return { type: 'file_diff', id: event.id, at: event.createdAt, nodeId: event.nodeId, sequenceNumber: event.sequenceNumber, payload: event.payload };
    }
    if (event.eventType.includes('failed')) {
      return { type: 'replay_anchor', id: event.id, at: event.createdAt, nodeId: event.nodeId, sequenceNumber: event.sequenceNumber, payload: event.payload };
    }
    if (event.eventType === 'approval.requested' || event.eventType === 'checkpoint.waiting') {
      return { type: 'approval_gate', id: event.id, at: event.createdAt, nodeId: event.nodeId, sequenceNumber: event.sequenceNumber, payload: event.payload };
    }
    return { type: 'activity', id: event.id, at: event.createdAt, nodeId: event.nodeId, sequenceNumber: event.sequenceNumber, eventType: event.eventType, payload: event.payload };
  });
}
