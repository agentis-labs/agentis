import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { REALTIME_EVENTS, REALTIME_ROOMS, type NormalizedTask, type WorkflowGraph } from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { EventBus } from '../event-bus.js';
import type { WorkflowEngine } from '../engine/WorkflowEngine.js';
import type { AdapterManager } from '../adapters/AdapterManager.js';
import type { Logger } from '../logger.js';
import type { LedgerService } from './ledger.js';
import type { ConversationStore } from './conversation/conversationStore.js';
import { publishAgentWorkStep } from './agent/agentWorkProgress.js';
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
  scheduledFor?: string | null;
  recurrenceCron?: string | null;
}

export interface IssueUpdateArgs {
  assigneeAgentId?: string | null;
  linkedWorkflowId?: string | null;
  title?: string;
  description?: string | null;
  status?: string;
  priority?: string;
  labels?: string[];
  scheduledFor?: string | null;
  recurrenceCron?: string | null;
}

export class IssueService {
  constructor(private readonly deps: {
    db: AgentisSqliteDb;
    bus: EventBus;
    engine: WorkflowEngine;
    ledger: LedgerService;
    conversations: ConversationStore;
    /** Optional — lets an agent-assigned issue (no linked workflow) actually dispatch. */
    adapters?: AdapterManager;
    logger?: Logger;
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
      scheduledFor: args.scheduledFor ?? null,
      recurrenceCron: args.recurrenceCron ?? null,
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
      scheduledFor: patch.scheduledFor === undefined ? existing.scheduledFor : patch.scheduledFor,
      recurrenceCron: patch.recurrenceCron === undefined ? existing.recurrenceCron : patch.recurrenceCron,
      updatedAt: new Date().toISOString(),
    };
    this.deps.db.update(schema.issues).set(next).where(eq(schema.issues.id, id)).run();
    const issue = { ...existing, ...next };
    this.deps.bus.publish(REALTIME_ROOMS.workspace(workspaceId), REALTIME_EVENTS.ISSUE_UPDATED, issue);
    return issue;
  }

  delete(workspaceId: string, id: string): boolean {
    const existing = this.get(workspaceId, id);
    if (!existing) return false;
    this.deps.db.delete(schema.issues).where(and(eq(schema.issues.id, id), eq(schema.issues.workspaceId, workspaceId))).run();
    this.deps.bus.publish(REALTIME_ROOMS.workspace(workspaceId), REALTIME_EVENTS.ISSUE_DELETED, { id, workspaceId });
    return true;
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

    // No linked workflow but an assigned agent → dispatch the issue to that
    // agent directly (the "schedule a task for agent X" path). Uses the same
    // adapter dispatch the agentis.agent.dispatch tool uses; no workflow row, so
    // no run id is recorded.
    if (!runId && assigneeAgentId && this.deps.adapters) {
      await this.dispatchToAgent({ workspaceId: args.workspaceId, issue: { ...issue, assigneeAgentId } });
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

  /**
   * Due sweep — dispatch issues whose `scheduledFor` has arrived. Called each
   * scheduler tick. Recurring issues reschedule `scheduledFor`; one-shot issues
   * clear it. Returns the number fired.
   */
  async sweepDue(now = new Date()): Promise<number> {
    const nowIso = now.toISOString();
    const due = this.deps.db
      .select()
      .from(schema.issues)
      .where(eq(schema.issues.status, 'backlog'))
      .all()
      .concat(this.deps.db.select().from(schema.issues).where(eq(schema.issues.status, 'todo')).all())
      .filter((issue) => issue.scheduledFor != null && issue.scheduledFor <= nowIso);

    let fired = 0;
    for (const issue of due) {
      try {
        const recurring = Boolean(issue.recurrenceCron);
        // Advance/clear the schedule FIRST (via update → emits ISSUE_UPDATED) so a
        // slow dispatch can't double-fire and the UI reflects it immediately.
        const nextScheduledFor = recurring ? nextCronOccurrence(issue.recurrenceCron!, now) : null;
        this.update(issue.workspaceId, issue.id, { scheduledFor: nextScheduledFor });
        await this.accept({ workspaceId: issue.workspaceId, userId: issue.userId, issueId: issue.id, agentId: issue.assigneeAgentId });
        // A one-shot scheduled task fired — move it out of the active backlog into
        // history (done). Recurring tasks return to todo for their next run.
        // (Workflow-linked issues keep accept's in_progress so the live run tracks.)
        this.update(issue.workspaceId, issue.id, { status: recurring ? 'todo' : issue.linkedWorkflowId ? 'in_progress' : 'done' });
        fired += 1;
      } catch (err) {
        this.deps.logger?.warn('issues.sweep_fire_failed', { issueId: issue.id, err: (err as Error).message });
        // Never leave it stuck "due in the past" — clear the one-shot schedule.
        if (!issue.recurrenceCron) this.update(issue.workspaceId, issue.id, { scheduledFor: null, status: 'blocked' });
      }
    }
    return fired;
  }

  private async dispatchToAgent(args: { workspaceId: string; issue: { id: string; title: string; description: string | null; assigneeAgentId: string | null } }): Promise<void> {
    const adapters = this.deps.adapters;
    const agentId = args.issue.assigneeAgentId;
    if (!adapters || !agentId) return;
    const registration = adapters.get(agentId);
    if (!registration) {
      this.deps.logger?.warn('issues.dispatch_no_adapter', { issueId: args.issue.id, agentId });
      return;
    }
    const agent = this.deps.db.select().from(schema.agents).where(eq(schema.agents.id, agentId)).get();
    const taskId = randomUUID();
    const brief = [args.issue.title, args.issue.description].filter(Boolean).join('\n\n');
    // The agent runs autonomously — give it the freedom (and the explicit
    // instruction) to act and to report the result back to the operator over
    // whatever channel it has, and to publish its steps so progress is visible.
    const task = [
      brief,
      '',
      'You are running this as a scheduled task with no operator watching live. '
      + 'Call agentis.task.set_steps with your plan, advance it as you go, and do the actual work. '
      + 'When you finish (or if you are blocked), message the operator with the outcome using agentis.channel.send '
      + '(or your available channel). Do not just stop silently.',
    ].join('\n');
    publishAgentWorkStep(this.deps.bus, {
      workspaceId: args.workspaceId,
      agentId,
      agentName: agent?.name ?? undefined,
      taskId,
      phase: 'start',
      description: `Scheduled task: ${args.issue.title}`,
    });
    const normalized: NormalizedTask = {
      taskId,
      // Agent-scoped ids only — no synthetic workflow/run id, so the Live
      // Workspace renders ONE agent task card, not a phantom "workflow" card.
      runId: taskId,
      workflowId: `agent:${agentId}`,
      nodeId: taskId,
      title: args.issue.title.slice(0, 120) || 'Scheduled task',
      description: task,
      inputData: { issueId: args.issue.id, task: brief },
      scratchpadSnapshot: {},
      capabilityTags: Array.isArray(agent?.capabilityTags) ? agent!.capabilityTags.map(String) : [],
      timeoutMs: 120_000,
    };
    // Fire-and-forget: the agent task can run for minutes — never block the
    // scheduler sweep (and its #running guard) on completion, or one long task
    // would freeze every future tick and no other scheduled task would fire.
    void adapters.dispatchTask(normalized, agentId).catch((err) => {
      this.deps.logger?.warn('issues.dispatch_failed', { issueId: args.issue.id, agentId, err: (err as Error).message });
      publishAgentWorkStep(this.deps.bus, {
        workspaceId: args.workspaceId,
        agentId,
        agentName: agent?.name ?? undefined,
        taskId,
        phase: 'fail',
        description: `Scheduled task failed to start: ${(err as Error).message}`,
      });
    });
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

/**
 * Minimal, dependency-free next-occurrence for a 5-field cron expression
 * (`minute hour day-of-month month day-of-week`). Supports `*`, integers,
 * comma lists, and `*​/n` steps — enough for "every day at 9", "every hour",
 * "Mondays". Steps minute-by-minute from `from`+1m, capped at 366 days; returns
 * null when the expression can't be parsed or no match is found.
 */
export function nextCronOccurrence(expr: string, from: Date): string | null {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return null;
  let matchers: Array<(value: number) => boolean>;
  try {
    matchers = fields.map((field, index) => cronFieldMatcher(field, index));
  } catch {
    return null;
  }
  const [minute, hour, dom, month, dow] = matchers as [
    (v: number) => boolean, (v: number) => boolean, (v: number) => boolean, (v: number) => boolean, (v: number) => boolean,
  ];
  const candidate = new Date(from.getTime());
  candidate.setUTCSeconds(0, 0);
  candidate.setUTCMinutes(candidate.getUTCMinutes() + 1);
  const capMinutes = 366 * 24 * 60;
  for (let i = 0; i < capMinutes; i += 1) {
    if (
      minute(candidate.getUTCMinutes())
      && hour(candidate.getUTCHours())
      && dom(candidate.getUTCDate())
      && month(candidate.getUTCMonth() + 1)
      && dow(candidate.getUTCDay())
    ) {
      return candidate.toISOString();
    }
    candidate.setUTCMinutes(candidate.getUTCMinutes() + 1);
  }
  return null;
}

function cronFieldMatcher(field: string, index: number): (value: number) => boolean {
  const [min, max] = CRON_FIELD_BOUNDS[index]!;
  if (field === '*') return () => true;
  const allowed = new Set<number>();
  for (const part of field.split(',')) {
    const stepMatch = part.match(/^(\*|\d+(?:-\d+)?)\/(\d+)$/);
    if (stepMatch) {
      const step = Number(stepMatch[2]);
      if (!Number.isInteger(step) || step <= 0) throw new Error('invalid step');
      for (let value = min; value <= max; value += step) allowed.add(value);
      continue;
    }
    const rangeMatch = part.match(/^(\d+)-(\d+)$/);
    if (rangeMatch) {
      for (let value = Number(rangeMatch[1]); value <= Number(rangeMatch[2]); value += 1) allowed.add(value);
      continue;
    }
    const value = Number(part);
    if (!Number.isInteger(value) || value < min || value > max) throw new Error('invalid field');
    allowed.add(value);
  }
  return (value: number) => allowed.has(value);
}

const CRON_FIELD_BOUNDS: Array<[number, number]> = [
  [0, 59], // minute
  [0, 23], // hour
  [1, 31], // day of month
  [1, 12], // month
  [0, 6], // day of week (0 = Sunday)
];
