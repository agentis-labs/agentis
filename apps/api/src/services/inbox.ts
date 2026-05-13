import { randomUUID } from 'node:crypto';
import { and, eq, isNotNull } from 'drizzle-orm';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';

export class InboxService {
  constructor(private readonly db: AgentisSqliteDb) {}

  getItems(workspaceId: string, userId: string) {
    const dismissed = new Set(
      this.db
        .select()
        .from(schema.inboxDismissals)
        .where(and(eq(schema.inboxDismissals.workspaceId, workspaceId), eq(schema.inboxDismissals.userId, userId)))
        .all()
        .map((row) => row.itemKey),
    );

    const approvals = this.db
      .select()
      .from(schema.approvalRequests)
      .where(and(eq(schema.approvalRequests.workspaceId, workspaceId), eq(schema.approvalRequests.status, 'pending')))
      .all()
      .map((approval) => ({
        key: `approval:${approval.id}`,
        kind: 'approval' as const,
        urgency: approval.source === 'budget_limit' ? 100 : 80,
        createdAt: approval.createdAt,
        title: approval.title,
        summary: approval.summary,
        payload: approval,
      }));

    const failedRuns = this.db
      .select()
      .from(schema.workflowRuns)
      .where(and(eq(schema.workflowRuns.workspaceId, workspaceId), eq(schema.workflowRuns.status, 'FAILED')))
      .all()
      .map((run) => ({
        key: `failed_run:${run.id}`,
        kind: 'failed_run' as const,
        urgency: 70,
        createdAt: run.completedAt ?? run.updatedAt,
        title: 'Workflow run failed',
        summary: `Run ${run.id.slice(0, 8)} failed and can be replayed.`,
        payload: run,
      }));

    const reviewIssues = this.db
      .select()
      .from(schema.issues)
      .where(and(eq(schema.issues.workspaceId, workspaceId), eq(schema.issues.status, 'in_review')))
      .all()
      .map((issue) => ({
        key: `issue_review:${issue.id}`,
        kind: 'issue_review' as const,
        urgency: issue.priority === 'urgent' ? 90 : 60,
        createdAt: issue.updatedAt,
        title: `${issue.identifier}: ${issue.title}`,
        summary: 'Issue is ready for operator review.',
        payload: issue,
      }));

    const agentErrors = this.db
      .select()
      .from(schema.agents)
      .where(and(eq(schema.agents.workspaceId, workspaceId), eq(schema.agents.status, 'error')))
      .all()
      .map((agent) => ({
        key: `agent_error:${agent.id}`,
        kind: 'agent_error' as const,
        urgency: 95,
        createdAt: agent.updatedAt,
        title: `${agent.name} needs attention`,
        summary: 'Agent status is error.',
        payload: agent,
      }));

    const routineFailures = this.db
      .select()
      .from(schema.routines)
      .where(and(eq(schema.routines.workspaceId, workspaceId), isNotNull(schema.routines.lastRunId)))
      .all()
      .filter((routine) => {
        if (!routine.lastRunId) return false;
        const run = this.db.select().from(schema.workflowRuns).where(eq(schema.workflowRuns.id, routine.lastRunId)).get();
        return run?.status === 'FAILED';
      })
      .map((routine) => ({
        key: `routine_failure:${routine.id}`,
        kind: 'routine_failure' as const,
        urgency: 75,
        createdAt: routine.lastRunAt ?? routine.updatedAt,
        title: `${routine.title} failed`,
        summary: 'Routine last run failed and can be retried.',
        payload: routine,
      }));

    return [...approvals, ...failedRuns, ...reviewIssues, ...agentErrors, ...routineFailures]
      .filter((item) => !dismissed.has(item.key))
      .sort((a, b) => b.urgency - a.urgency || (a.createdAt < b.createdAt ? 1 : -1));
  }

  badgeCounts(workspaceId: string, userId: string) {
    const items = this.getItems(workspaceId, userId);
    return {
      total: items.length,
      approvals: items.filter((item) => item.kind === 'approval').length,
      failedRuns: items.filter((item) => item.kind === 'failed_run').length,
      agentErrors: items.filter((item) => item.kind === 'agent_error').length,
      inReview: items.filter((item) => item.kind === 'issue_review').length,
      routineFailures: items.filter((item) => item.kind === 'routine_failure').length,
    };
  }

  dismiss(workspaceId: string, userId: string, itemKey: string) {
    const row = { id: randomUUID(), workspaceId, userId, itemKey, createdAt: new Date().toISOString() };
    this.db.insert(schema.inboxDismissals).values(row).run();
    return row;
  }
}
