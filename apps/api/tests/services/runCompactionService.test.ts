/**
 * RunCompactionService — periodic cleanup of old run state.
 *
 * Verifies the two production-critical contracts:
 *   1. Old terminal runs get their heavy runState replaced with a compact
 *      summary, and the original runState is gone (no second compaction).
 *   2. Recent runs and still-active runs are untouched.
 */
import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { schema } from '@agentis/db/sqlite';
import { RunCompactionService } from '../../src/services/run/runCompactionService.js';
import { createTestContext } from '../_helpers/createTestContext.js';

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

describe('RunCompactionService', () => {
  it('compacts COMPLETED runs older than keepFullStateDays', async () => {
    const ctx = await createTestContext();
    try {
      const oldRunId = randomUUID();
      const oldRunState = {
        runId: oldRunId,
        workflowId: null,
        status: 'COMPLETED',
        readyQueue: [],
        waitingInputs: {},
        nodeStates: {
          n1: { nodeId: 'n1', status: 'COMPLETED', outputData: { huge: 'payload'.repeat(500) } },
        },
        activeExecutions: {},
        completedNodeIds: ['n1'],
        failedNodeIds: [],
        skippedNodeIds: [],
        graphRevision: 1,
        replanCount: 0,
        lastLedgerSequence: 0,
      };
      ctx.db.insert(schema.workflowRuns).values({
        id: oldRunId,
        workspaceId: ctx.workspace.id,
        ambientId: ctx.ambient.id,
        userId: ctx.user.id,
        status: 'COMPLETED',
        runState: oldRunState,
        updatedAt: isoDaysAgo(60),
        completedAt: isoDaysAgo(60),
      }).run();

      const recentRunId = randomUUID();
      ctx.db.insert(schema.workflowRuns).values({
        id: recentRunId,
        workspaceId: ctx.workspace.id,
        ambientId: ctx.ambient.id,
        userId: ctx.user.id,
        status: 'COMPLETED',
        runState: { ...oldRunState, runId: recentRunId },
        updatedAt: isoDaysAgo(1),
        completedAt: isoDaysAgo(1),
      }).run();

      const compaction = new RunCompactionService({ db: ctx.db, logger: ctx.logger, keepFullStateDays: 30 });
      const summary = await compaction.compact();
      expect(summary.compactedRunStates).toBe(1);

      const oldAfter = ctx.db.select().from(schema.workflowRuns).where(eq(schema.workflowRuns.id, oldRunId)).get()!;
      const oldState = oldAfter.runState as Record<string, unknown>;
      expect(oldState._compacted).toBe(true);
      expect(oldState.completedNodeIds).toEqual(['n1']);
      // Heavy node payload is gone after compaction.
      expect(JSON.stringify(oldState)).not.toContain('payloadpayload');

      const recentAfter = ctx.db.select().from(schema.workflowRuns).where(eq(schema.workflowRuns.id, recentRunId)).get()!;
      const recentState = recentAfter.runState as Record<string, unknown>;
      expect(recentState._compacted).toBeUndefined();
      // Recent state still has the full nodeStates blob.
      expect(JSON.stringify(recentState)).toContain('payload');
    } finally {
      ctx.close();
    }
  });

  it('does not touch active runs', async () => {
    const ctx = await createTestContext();
    try {
      const activeRunId = randomUUID();
      const runState = {
        runId: activeRunId,
        workflowId: null,
        status: 'RUNNING',
        readyQueue: [],
        waitingInputs: {},
        nodeStates: {},
        activeExecutions: {},
        completedNodeIds: [],
        failedNodeIds: [],
        skippedNodeIds: [],
        graphRevision: 1,
        replanCount: 0,
        lastLedgerSequence: 0,
      };
      ctx.db.insert(schema.workflowRuns).values({
        id: activeRunId,
        workspaceId: ctx.workspace.id,
        ambientId: ctx.ambient.id,
        userId: ctx.user.id,
        status: 'RUNNING',
        runState,
        updatedAt: isoDaysAgo(60), // old enough by age, but not terminal
      }).run();

      const compaction = new RunCompactionService({ db: ctx.db, logger: ctx.logger, keepFullStateDays: 30 });
      const summary = await compaction.compact();
      expect(summary.compactedRunStates).toBe(0);

      const after = ctx.db.select().from(schema.workflowRuns).where(eq(schema.workflowRuns.id, activeRunId)).get()!;
      const state = after.runState as Record<string, unknown>;
      expect(state._compacted).toBeUndefined();
    } finally {
      ctx.close();
    }
  });

  it('is idempotent — second pass is a no-op on already-compacted runs', async () => {
    const ctx = await createTestContext();
    try {
      const runId = randomUUID();
      ctx.db.insert(schema.workflowRuns).values({
        id: runId,
        workspaceId: ctx.workspace.id,
        ambientId: ctx.ambient.id,
        userId: ctx.user.id,
        status: 'COMPLETED',
        runState: { _compacted: true, status: 'COMPLETED', completedNodeIds: ['n1'], failedNodeIds: [], skippedNodeIds: [], compactedAt: isoDaysAgo(45) } as object,
        updatedAt: isoDaysAgo(60),
        completedAt: isoDaysAgo(60),
      }).run();

      const compaction = new RunCompactionService({ db: ctx.db, logger: ctx.logger, keepFullStateDays: 30 });
      const summary = await compaction.compact();
      expect(summary.compactedRunStates).toBe(0);
    } finally {
      ctx.close();
    }
  });
});
