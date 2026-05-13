import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { REALTIME_EVENTS, REALTIME_ROOMS, type WorkflowGraph } from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { EventBus } from '../event-bus.js';
import type { WorkflowEngine } from '../engine/WorkflowEngine.js';
import type { LedgerService } from './ledger.js';
import type { ConversationStore } from './conversationStore.js';
import { buildInitialRunState } from '../engine/initialRunState.js';

export interface IssueCreateArgs {
  workspaceId: string;
  userId: string;
  assigneeAgentId?: string | null;
  linkedWorkflowId?: string | null;
  title: string;
  description?: string | null;
  status?: string;
  priority?: string;
  labels?: string[];
}

export interface IssueUpdateArgs {
  assigneeAgentId?: string | null;
  linkedWorkflowId?: string | null;
  title?: string;
  description?: string | null;
  status?: string;
  priority?: string;
  labels?: string[];
}

export class IssueService {
  constructor(private readonly deps: {
    db: AgentisSqliteDb;
    bus: EventBus;
    engine: WorkflowEngine;
    ledger: LedgerService;
    conversations: ConversationStore;
  }) {}

  list(workspaceId: string) {
    return this.deps.db
      .select()
      .from(schema.issues)
      .where(eq(schema.issues.workspaceId, workspaceId))
      .all()
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  }

  get(workspaceId: string, id: string) {
    return this.deps.db
      .select()
      .from(schema.issues)
      .where(and(eq(schema.issues.id, id), eq(schema.issues.workspaceId, workspaceId)))
      .get();
  }

  create(args: IssueCreateArgs) {
    const now = new Date().toISOString();
    const row = {
      id: randomUUID(),
      workspaceId: args.workspaceId,
      userId: args.userId,
      assigneeAgentId: args.assigneeAgentId ?? null,
      linkedWorkflowId: args.linkedWorkflowId ?? null,
      activeRunId: null,
      identifier: this.nextIdentifier(args.workspaceId),
      title: args.title,
      description: args.description ?? null,
      status: args.status ?? 'backlog',
      priority: args.priority ?? 'medium',
      labels: args.labels ?? [],
      createdAt: now,
      updatedAt: now,
    };
    this.deps.db.insert(schema.issues).values(row).run();
    this.deps.bus.publish(REALTIME_ROOMS.workspace(args.workspaceId), REALTIME_EVENTS.ISSUE_CREATED, row);
    return row;
  }

  update(workspaceId: string, id: string, patch: IssueUpdateArgs) {
    const existing = this.get(workspaceId, id);
    if (!existing) return null;
    const next = {
      assigneeAgentId:
        patch.assigneeAgentId === undefined ? existing.assigneeAgentId : patch.assigneeAgentId,
      linkedWorkflowId:
        patch.linkedWorkflowId === undefined ? existing.linkedWorkflowId : patch.linkedWorkflowId,
      title: patch.title ?? existing.title,
      description: patch.description === undefined ? existing.description : patch.description,
      status: patch.status ?? existing.status,
      priority: patch.priority ?? existing.priority,
      labels: patch.labels ?? (existing.labels as string[]),
      updatedAt: new Date().toISOString(),
    };
    this.deps.db.update(schema.issues).set(next).where(eq(schema.issues.id, id)).run();
    const issue = { ...existing, ...next };
    this.deps.bus.publish(REALTIME_ROOMS.workspace(workspaceId), REALTIME_EVENTS.ISSUE_UPDATED, issue);
    return issue;
  }

  async accept(args: { workspaceId: string; userId: string; issueId: string; agentId?: string | null }) {
    const issue = this.get(args.workspaceId, args.issueId);
    if (!issue) return null;
    const assigneeAgentId = args.agentId ?? issue.assigneeAgentId;
    let runId: string | null = null;

    if (issue.linkedWorkflowId) {
      const workflow = this.deps.db
        .select()
        .from(schema.workflows)
        .where(and(eq(schema.workflows.id, issue.linkedWorkflowId), eq(schema.workflows.workspaceId, args.workspaceId)))
        .get();
      if (workflow) {
        runId = randomUUID();
        const graph = workflow.graph as WorkflowGraph;
        const inputs = { issue: { ...issue, assigneeAgentId } };
        await this.deps.engine.startRun({
          workspaceId: args.workspaceId,
          ambientId: workflow.ambientId,
          workflowId: workflow.id,
          userId: args.userId,
          triggerId: null,
          inputs,
          initialState: buildInitialRunState({ runId, workflowId: workflow.id, graph, inputs }),
          graph,
        });
      }
    }

    const updated = this.update(args.workspaceId, args.issueId, {
      assigneeAgentId,
      status: 'in_progress',
    });
    if (runId) {
      this.deps.db.update(schema.issues).set({ activeRunId: runId }).where(eq(schema.issues.id, args.issueId)).run();
    }
    return { issue: updated ? { ...updated, activeRunId: runId ?? updated.activeRunId } : null, runId };
  }

  async thread(workspaceId: string, issueId: string) {
    const issue = this.get(workspaceId, issueId);
    if (!issue) return [];
    const messages = this.deps.db
      .select()
      .from(schema.conversationMessages)
      .where(and(eq(schema.conversationMessages.workspaceId, workspaceId), eq(schema.conversationMessages.issueId, issueId)))
      .all()
      .map((message) => ({ kind: 'message' as const, at: message.createdAt, item: message }));
    const events = issue.activeRunId
      ? (await this.deps.ledger.listForRun({ runId: issue.activeRunId, limit: 1000 })).map((event) => ({
          kind: 'ledger' as const,
          at: event.createdAt,
          item: event,
        }))
      : [];
    return [...messages, ...events].sort((a, b) => (a.at > b.at ? 1 : -1));
  }

  private nextIdentifier(workspaceId: string) {
    const workspace = this.deps.db.select().from(schema.workspaces).where(eq(schema.workspaces.id, workspaceId)).get();
    const prefix = workspace?.issuePrefix ?? 'AGT';
    const counter = this.deps.db
      .select()
      .from(schema.workspaceCounters)
      .where(and(eq(schema.workspaceCounters.workspaceId, workspaceId), eq(schema.workspaceCounters.counterName, 'issue_seq')))
      .get();
    const next = (counter?.counterValue ?? 0) + 1;
    if (counter) {
      this.deps.db
        .update(schema.workspaceCounters)
        .set({ counterValue: next, updatedAt: new Date().toISOString() })
        .where(and(eq(schema.workspaceCounters.workspaceId, workspaceId), eq(schema.workspaceCounters.counterName, 'issue_seq')))
        .run();
    } else {
      this.deps.db
        .insert(schema.workspaceCounters)
        .values({ workspaceId, counterName: 'issue_seq', counterValue: next, updatedAt: new Date().toISOString() })
        .run();
    }
    return `${prefix}-${next}`;
  }
}
