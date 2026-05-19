/**
 * Durable job queue (AGENTIS-PLATFORM-10X §A4).
 *
 * The previous `DatabaseJobQueue` dispatched with `queueMicrotask` — jobs were
 * lost on a server restart and there was no worker-pool model. Long-running
 * multi-day jobs (codebase migrations, continuous monitoring) need a queue
 * that survives restarts.
 *
 * This implementation is a polling-based durable queue backed by the existing
 * SQLite `async_jobs` table:
 *   - `enqueueWorkflowRun()` inserts a `pending` row and returns immediately.
 *   - A background poller (every `pollIntervalMs`) claims `pending` rows whose
 *     `scheduled_for` has passed, marks them `running`, and dispatches them.
 *   - On failure the job is retried with exponential backoff up to
 *     `maxAttempts`, then marked `failed`.
 *   - Orphaned `running` jobs (a crash mid-run) are reclaimed once their lease
 *     expires.
 *
 * `JobQueueBackend` keeps the interface stable so a future BullMQ + Redis
 * backend is a drop-in replacement.
 */

import { randomUUID } from 'node:crypto';
import { and, asc, eq, lte } from 'drizzle-orm';
import type { WorkflowGraph, WorkflowRunState } from '@agentis/core';
import { schema, type AgentisSqliteDb } from '@agentis/db/sqlite';
import type { WorkflowEngine } from '../engine/WorkflowEngine.js';
import type { Logger } from '../logger.js';

export interface WorkflowRunJobPayload {
  workspaceId: string;
  ambientId: string | null;
  workflowId: string;
  userId: string;
  triggerId: string | null;
  inputs: Record<string, unknown>;
  initialState: WorkflowRunState;
  graph: WorkflowGraph;
}

export interface JobQueueBackend {
  enqueueWorkflowRun(payload: WorkflowRunJobPayload, priority?: JobPriority): Promise<string>;
  getStatus(jobId: string): { status: string; attempts: number; lastError: string | null } | null;
}

export type JobPriority = 'low' | 'normal' | 'high';

interface DurableJobQueueDeps {
  db: AgentisSqliteDb;
  engine: WorkflowEngine;
  logger: Logger;
  /** Poll cadence in ms (default 5000). */
  pollIntervalMs?: number;
  /** Lease duration before a `running` job is considered orphaned (default 10 min). */
  leaseMs?: number;
}

const PRIORITY_RANK: Record<JobPriority, number> = { high: 0, normal: 1, low: 2 };

export class DurableJobQueue implements JobQueueBackend {
  #timer: NodeJS.Timeout | null = null;
  #draining = false;
  readonly #pollIntervalMs: number;
  readonly #leaseMs: number;

  constructor(private readonly deps: DurableJobQueueDeps) {
    this.#pollIntervalMs = deps.pollIntervalMs ?? 5000;
    this.#leaseMs = deps.leaseMs ?? 10 * 60 * 1000;
  }

  /** Begin polling. Idempotent. */
  start(): void {
    if (this.#timer) return;
    this.#reclaimOrphans();
    this.#timer = setInterval(() => {
      void this.#drain().catch((err) => {
        this.deps.logger.error('job_queue.drain.unhandled', { err: (err as Error).message });
      });
    }, this.#pollIntervalMs);
    // Don't keep the process alive solely for the poller.
    this.#timer.unref?.();
    // Kick an immediate drain so freshly enqueued jobs don't wait a full tick.
    void this.#drain().catch(() => {});
  }

  stop(): void {
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
  }

  async enqueueWorkflowRun(
    payload: WorkflowRunJobPayload,
    priority: JobPriority = 'normal',
  ): Promise<string> {
    const jobId = randomUUID();
    const now = new Date().toISOString();
    this.deps.db
      .insert(schema.asyncJobs)
      .values({
        id: jobId,
        workspaceId: payload.workspaceId,
        type: 'workflow.run',
        payload: payload as unknown as object,
        status: 'pending',
        priority,
        attempts: 0,
        maxAttempts: 3,
        scheduledFor: now,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    // Nudge the poller so latency stays low without waiting for the interval.
    if (this.#timer) void this.#drain().catch(() => {});
    return jobId;
  }

  getStatus(jobId: string): { status: string; attempts: number; lastError: string | null } | null {
    const row = this.deps.db
      .select()
      .from(schema.asyncJobs)
      .where(eq(schema.asyncJobs.id, jobId))
      .get();
    return row ? { status: row.status, attempts: row.attempts, lastError: row.lastError } : null;
  }

  // ────────────────────────────────────────────────────────────
  // Internals
  // ────────────────────────────────────────────────────────────

  /** Reset `running` jobs whose lease expired (server crashed mid-run). */
  #reclaimOrphans(): void {
    const cutoff = new Date(Date.now() - this.#leaseMs).toISOString();
    const orphans = this.deps.db
      .select()
      .from(schema.asyncJobs)
      .where(eq(schema.asyncJobs.status, 'running'))
      .all()
      .filter((j) => !j.leasedAt || j.leasedAt < cutoff);
    for (const job of orphans) {
      this.deps.db
        .update(schema.asyncJobs)
        .set({ status: 'pending', leasedAt: null, updatedAt: new Date().toISOString() })
        .where(eq(schema.asyncJobs.id, job.id))
        .run();
      this.deps.logger.warn('job_queue.orphan_reclaimed', { jobId: job.id, attempts: job.attempts });
    }
  }

  async #drain(): Promise<void> {
    if (this.#draining) return;
    this.#draining = true;
    try {
      const now = new Date().toISOString();
      const pending = this.deps.db
        .select()
        .from(schema.asyncJobs)
        .where(and(eq(schema.asyncJobs.status, 'pending'), lte(schema.asyncJobs.scheduledFor, now)))
        .orderBy(asc(schema.asyncJobs.scheduledFor))
        .all()
        .sort(
          (a, b) =>
            PRIORITY_RANK[(a.priority as JobPriority) ?? 'normal'] -
            PRIORITY_RANK[(b.priority as JobPriority) ?? 'normal'],
        );
      for (const job of pending) {
        await this.#run(job.id);
      }
    } finally {
      this.#draining = false;
    }
  }

  async #run(jobId: string): Promise<void> {
    const claimedAt = new Date().toISOString();
    // Atomic claim: only transition pending → running.
    const claim = this.deps.db
      .update(schema.asyncJobs)
      .set({ status: 'running', leasedAt: claimedAt, startedAt: claimedAt, updatedAt: claimedAt })
      .where(and(eq(schema.asyncJobs.id, jobId), eq(schema.asyncJobs.status, 'pending')))
      .run();
    if (claim.changes === 0) return; // another poller / re-entrancy claimed it

    const row = this.deps.db
      .select()
      .from(schema.asyncJobs)
      .where(eq(schema.asyncJobs.id, jobId))
      .get();
    if (!row) return;
    const attempts = row.attempts + 1;

    try {
      const payload = row.payload as unknown as WorkflowRunJobPayload;
      await this.deps.engine.startRun(payload);
      const doneAt = new Date().toISOString();
      this.deps.db
        .update(schema.asyncJobs)
        .set({
          status: 'completed',
          attempts,
          leasedAt: null,
          completedAt: doneAt,
          updatedAt: doneAt,
        })
        .where(eq(schema.asyncJobs.id, jobId))
        .run();
    } catch (err) {
      const failedAt = new Date().toISOString();
      const terminal = attempts >= row.maxAttempts;
      // Exponential backoff: 10s, 40s, 90s ...
      const backoffMs = attempts * attempts * 10_000;
      this.deps.db
        .update(schema.asyncJobs)
        .set({
          status: terminal ? 'failed' : 'pending',
          attempts,
          leasedAt: null,
          lastError: (err as Error).message,
          scheduledFor: terminal
            ? row.scheduledFor
            : new Date(Date.now() + backoffMs).toISOString(),
          updatedAt: failedAt,
        })
        .where(eq(schema.asyncJobs.id, jobId))
        .run();
      this.deps.logger[terminal ? 'error' : 'warn']('job_queue.workflow_run.failed', {
        jobId,
        attempts,
        terminal,
        err: (err as Error).message,
      });
    }
  }
}

/**
 * Decide whether a workflow run should be queued (durable) or run inline.
 * Long-running / human-gated graphs go through the durable queue so they
 * survive a restart.
 */
export function shouldQueueWorkflowRun(
  graph: WorkflowGraph,
  mode: 'auto' | 'inline' | 'async',
): boolean {
  if (mode === 'inline') return false;
  if (mode === 'async') return true;
  return graph.nodes.some(
    (node) =>
      node.type === 'checkpoint' ||
      node.type === 'subflow' ||
      node.type === 'agent_swarm',
  );
}
