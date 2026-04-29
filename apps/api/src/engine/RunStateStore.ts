/**
 * RunStateStore — V1-SPEC §3.3, §6.4 spec-named module.
 *
 * Persists / restores `WorkflowRunState` snapshots so an in-flight run can
 * be cold-resumed after a process restart. The canonical state lives in
 * `WorkflowEngine` (`#runs` map keyed by runId). On checkpoint boundaries
 * the engine asks this store to write the snapshot to the
 * `workflow_runs.runtimeState` JSON column. On bootstrap, the
 * `ActiveWorkflowRegistry` rehydrates pending runs through `load()`.
 *
 * V1 keeps the implementation deliberately simple: snapshots are full
 * (no diff log) and stored alongside the run row. The append-only ledger
 * remains the source of truth for replay; this snapshot is a fast-path
 * cache.
 */

import { eq } from 'drizzle-orm';
import type { WorkflowRunState } from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';

export class RunStateStore {
  constructor(private readonly db: AgentisSqliteDb) {}

  /** Persist the full run-state snapshot for resume-after-restart. */
  save(state: WorkflowRunState): void {
    this.db
      .update(schema.workflowRuns)
      .set({
        runState: state as unknown as Record<string, unknown>,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(schema.workflowRuns.id, state.runId))
      .run();
  }

  /** Read back a previously persisted snapshot. Returns null if missing. */
  load(runId: string): WorkflowRunState | null {
    const row = this.db
      .select()
      .from(schema.workflowRuns)
      .where(eq(schema.workflowRuns.id, runId))
      .get();
    if (!row || !row.runState) return null;
    return row.runState as unknown as WorkflowRunState;
  }
}
