/**
 * Approval inbox.
 *
 * Sources (V1-SPEC §11.10): checkpoint nodes, OpenClaw exec proposals,
 * package install requests, credential access prompts. The dashboard subscribes
 * to `approval.requested` / `approval.resolved` and shows an inbox row per
 * pending item.
 *
 * Resolution callback hook: when a checkpoint approval is approved, we call
 * back into the engine via the supplied `onCheckpointResolved` so the run
 * resumes deterministically.
 */

import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { AgentisError, REALTIME_EVENTS, REALTIME_ROOMS } from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { EventBus } from '../event-bus.js';

export interface ApprovalCreateArgs {
  workspaceId: string;
  ambientId: string | null;
  userId: string;
  runId: string | null;
  taskId: string | null;
  gatewayId: string | null;
  source: 'checkpoint' | 'openclaw_exec' | 'package_install' | 'credential_access';
  title: string;
  summary: string;
  confidence: number | null;
}

export type CheckpointResumeHandler = (args: { runId: string; approvalId: string }) => Promise<void>;

export class ApprovalInboxService {
  #onCheckpointResolved: CheckpointResumeHandler | null = null;

  constructor(
    private readonly db: AgentisSqliteDb,
    private readonly bus: EventBus,
  ) {}

  bindCheckpointHandler(handler: CheckpointResumeHandler): void {
    this.#onCheckpointResolved = handler;
  }

  async create(args: ApprovalCreateArgs) {
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    this.db
      .insert(schema.approvalRequests)
      .values({
        id,
        workspaceId: args.workspaceId,
        ambientId: args.ambientId,
        userId: args.userId,
        runId: args.runId,
        taskId: args.taskId,
        gatewayId: args.gatewayId,
        source: args.source,
        title: args.title,
        summary: args.summary,
        confidence: args.confidence,
        status: 'pending',
        createdAt,
      })
      .run();
    this.bus.publish(REALTIME_ROOMS.workspace(args.workspaceId), REALTIME_EVENTS.APPROVAL_REQUESTED, {
      id,
      ...args,
      status: 'pending',
      createdAt,
    });
    return { id, ...args, status: 'pending' as const, createdAt };
  }

  list(workspaceId: string, status: 'pending' | 'all' = 'pending') {
    const rows = this.db
      .select()
      .from(schema.approvalRequests)
      .where(eq(schema.approvalRequests.workspaceId, workspaceId))
      .all();
    return status === 'all' ? rows : rows.filter((r) => r.status === 'pending');
  }

  async resolve(args: {
    workspaceId: string;
    approvalId: string;
    decision: 'approve' | 'reject';
    reason?: string;
  }) {
    const row = this.db
      .select()
      .from(schema.approvalRequests)
      .where(
        and(
          eq(schema.approvalRequests.id, args.approvalId),
          eq(schema.approvalRequests.workspaceId, args.workspaceId),
        ),
      )
      .get();
    if (!row) throw new AgentisError('RESOURCE_NOT_FOUND', 'Approval not found');
    if (row.status !== 'pending') {
      throw new AgentisError('RESOURCE_CONFLICT', `Approval already ${row.status}`);
    }
    const next = args.decision === 'approve' ? 'approved' : 'rejected';
    const resolvedAt = new Date().toISOString();
    this.db
      .update(schema.approvalRequests)
      .set({
        status: next,
        resolutionReason: args.reason ?? null,
        resolvedAt,
      })
      .where(eq(schema.approvalRequests.id, row.id))
      .run();
    this.bus.publish(REALTIME_ROOMS.workspace(row.workspaceId), REALTIME_EVENTS.APPROVAL_RESOLVED, {
      id: row.id,
      status: next,
      resolvedAt,
    });
    if (
      args.decision === 'approve' &&
      row.source === 'checkpoint' &&
      row.runId &&
      this.#onCheckpointResolved
    ) {
      await this.#onCheckpointResolved({ runId: row.runId, approvalId: row.id });
    }
    return { ...row, status: next, resolvedAt, resolutionReason: args.reason ?? null };
  }
}
