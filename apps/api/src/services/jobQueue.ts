import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
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
  enqueueWorkflowRun(payload: WorkflowRunJobPayload): Promise<string>;
  getStatus(jobId: string): { status: string; attempts: number; lastError: string | null } | null;
}

export class DatabaseJobQueue implements JobQueueBackend {
  constructor(
    private readonly deps: { db: AgentisSqliteDb; engine: WorkflowEngine; logger: Logger },
  ) {}

  async enqueueWorkflowRun(payload: WorkflowRunJobPayload): Promise<string> {
    const jobId = randomUUID();
    this.deps.db.insert(schema.asyncJobs).values({
      id: jobId,
      workspaceId: payload.workspaceId,
      type: 'workflow.run',
      payload: payload as unknown as object,
      status: 'pending',
      attempts: 0,
      maxAttempts: 3,
    }).run();

    queueMicrotask(() => {
      void this.process(jobId).catch((err) => {
        this.deps.logger.error('job_queue.workflow_run.unhandled', { jobId, err: (err as Error).message });
      });
    });
    return jobId;
  }

  getStatus(jobId: string): { status: string; attempts: number; lastError: string | null } | null {
    const row = this.deps.db.select().from(schema.asyncJobs).where(eq(schema.asyncJobs.id, jobId)).get();
    return row ? { status: row.status, attempts: row.attempts, lastError: row.lastError } : null;
  }

  async process(jobId: string): Promise<void> {
    const row = this.deps.db.select().from(schema.asyncJobs).where(eq(schema.asyncJobs.id, jobId)).get();
    if (!row || row.status !== 'pending') return;
    const now = new Date().toISOString();
    this.deps.db.update(schema.asyncJobs).set({
      status: 'running',
      startedAt: now,
      attempts: row.attempts + 1,
      updatedAt: now,
    }).where(eq(schema.asyncJobs.id, jobId)).run();

    try {
      const payload = row.payload as unknown as WorkflowRunJobPayload;
      await this.deps.engine.startRun(payload);
      const doneAt = new Date().toISOString();
      this.deps.db.update(schema.asyncJobs).set({
        status: 'completed',
        completedAt: doneAt,
        updatedAt: doneAt,
      }).where(eq(schema.asyncJobs.id, jobId)).run();
    } catch (err) {
      const failedAt = new Date().toISOString();
      const attempts = row.attempts + 1;
      const terminal = attempts >= row.maxAttempts;
      this.deps.db.update(schema.asyncJobs).set({
        status: terminal ? 'failed' : 'pending',
        attempts,
        lastError: (err as Error).message,
        updatedAt: failedAt,
      }).where(eq(schema.asyncJobs.id, jobId)).run();
    }
  }
}

export function shouldQueueWorkflowRun(graph: WorkflowGraph, mode: 'auto' | 'inline' | 'async'): boolean {
  if (mode === 'inline') return false;
  if (mode === 'async') return true;
  return graph.nodes.some((node) =>
    node.type === 'human_in_the_loop' ||
    node.type === 'wait' ||
    node.type === 'subflow' ||
    node.type === 'parallel' ||
    node.type === 'loop',
  );
}
