/**
 * ApprovalInboxService — V1-SPEC §11.10 approval lifecycle.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { AgentisError, REALTIME_EVENTS } from '@agentis/core';
import { openSqlite, type AgentisSqliteDb } from '@agentis/db/sqlite';
import { ApprovalInboxService } from '../src/services/approvalInbox.js';
import { createInProcessEventBus, type EventBus } from '../src/event-bus.js';

let db: AgentisSqliteDb;
let bus: EventBus;
let svc: ApprovalInboxService;
const baseArgs = {
  workspaceId: 'ws1',
  ambientId: null,
  userId: 'u1',
  runId: 'r1',
  taskId: 't1',
  gatewayId: null,
  source: 'checkpoint' as const,
  title: 'Confirm step',
  summary: 'About to delete a thing',
  confidence: 0.9,
};

beforeEach(() => {
  const opened = openSqlite({ path: ':memory:' });
  db = opened.db;
  opened.sqlite.pragma('foreign_keys = OFF');
  bus = createInProcessEventBus();
  svc = new ApprovalInboxService(db, bus);
});

describe('ApprovalInboxService', () => {
  it('creates pending approvals and emits APPROVAL_REQUESTED', async () => {
    const events: string[] = [];
    bus.subscribe((m) => {
      if (m.room === 'workspace:ws1') events.push(m.envelope.event);
    });
    const created = await svc.create(baseArgs);
    expect(created.status).toBe('pending');
    expect(events).toContain(REALTIME_EVENTS.APPROVAL_REQUESTED);
  });

  it('lists pending vs all', async () => {
    await svc.create(baseArgs);
    expect(svc.list('ws1', 'pending')).toHaveLength(1);
    expect(svc.list('ws1', 'all')).toHaveLength(1);
  });

  it('resolve(approve) on a checkpoint fires the resume handler with decision', async () => {
    let handlerCalled: { runId: string; approvalId: string; source: string; decision: string } | null = null;
    svc.bindCheckpointHandler(async (a) => {
      handlerCalled = a;
    });
    const created = await svc.create(baseArgs);
    const resolved = await svc.resolve({
      workspaceId: 'ws1',
      approvalId: created.id,
      decision: 'approve',
    });
    expect(resolved.status).toBe('approved');
    // Human-gate enforcement: the handler carries source + decision so the
    // engine can resume the held run.
    expect(handlerCalled).toMatchObject({ runId: 'r1', approvalId: created.id, source: 'checkpoint', decision: 'approve' });
  });

  it('resolve(reject) fires the handler so the run-gate can fail deterministically', async () => {
    let handlerCalled: { decision: string } | null = null;
    svc.bindCheckpointHandler(async (a) => {
      handlerCalled = a;
    });
    const created = await svc.create(baseArgs);
    const resolved = await svc.resolve({
      workspaceId: 'ws1',
      approvalId: created.id,
      decision: 'reject',
      reason: 'no thanks',
    });
    expect(resolved.status).toBe('rejected');
    expect(resolved.resolutionReason).toBe('no thanks');
    // Reject must reach the engine (failRunForGate) — not silently drop.
    expect(handlerCalled).toMatchObject({ decision: 'reject' });
  });

  it('throws RESOURCE_CONFLICT when resolving an already-resolved approval', async () => {
    const created = await svc.create(baseArgs);
    await svc.resolve({ workspaceId: 'ws1', approvalId: created.id, decision: 'approve' });
    await expect(
      svc.resolve({ workspaceId: 'ws1', approvalId: created.id, decision: 'approve' }),
    ).rejects.toThrow(AgentisError);
  });

  it('throws RESOURCE_NOT_FOUND for unknown approvals', async () => {
    await expect(
      svc.resolve({ workspaceId: 'ws1', approvalId: 'nope', decision: 'approve' }),
    ).rejects.toThrow(AgentisError);
  });
});
