import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { AgentisError, REALTIME_EVENTS, REALTIME_ROOMS } from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { EventBus } from '../event-bus.js';
import type { ApprovalInboxService } from './approvalInbox.js';

export class BudgetService {
  constructor(private readonly deps: {
    db: AgentisSqliteDb;
    bus: EventBus;
    approvals: ApprovalInboxService;
  }) {}

  list(workspaceId: string) {
    const agents = this.deps.db.select().from(schema.agents).where(eq(schema.agents.workspaceId, workspaceId)).all();
    const events = this.deps.db
      .select()
      .from(schema.budgetEvents)
      .where(eq(schema.budgetEvents.workspaceId, workspaceId))
      .all()
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    return { agents, events };
  }

  /**
   * Workspace-level pre-spend gate.
   *
   * Returns the available headroom in cents across every agent in the workspace
   * that has a `monthlyBudgetCents` cap. Agents with no cap (`null`) are
   * treated as having infinite headroom for the purposes of the workspace cap
   * check.
   *
   * Throws `BUDGET_LIMIT_EXCEEDED` if the requested amount exceeds the total
   * remaining workspace budget.
   */
  assertCanSpend(workspaceId: string, estimatedCents: number): void {
    if (estimatedCents <= 0) return;
    const agents = this.deps.db
      .select({
        cap: schema.agents.monthlyBudgetCents,
        spent: schema.agents.currentMonthSpendCents,
      })
      .from(schema.agents)
      .where(eq(schema.agents.workspaceId, workspaceId))
      .all();
    if (agents.length === 0) return; // No agents → no caps to enforce.
    let totalHeadroom = 0;
    for (const a of agents) {
      if (a.cap === null || a.cap === undefined) {
        return; // Any uncapped agent → workspace is uncapped.
      }
      totalHeadroom += Math.max(0, a.cap - a.spent);
    }
    if (estimatedCents > totalHeadroom) {
      throw new AgentisError(
        'BUDGET_LIMIT_EXCEEDED',
        `Estimated spend (${estimatedCents}¢) exceeds remaining workspace budget (${totalHeadroom}¢).`,
        {
          details: { estimatedCents, remainingCents: totalHeadroom, workspaceId },
        },
      );
    }
  }

  async checkAndReserve(args: {
    workspaceId: string;
    ambientId: string | null;
    userId: string;
    agentId: string;
    runId: string;
    taskId: string;
    estimatedCents: number;
  }): Promise<'ok' | 'approval_required'> {
    if (args.estimatedCents <= 0) return 'ok';
    const agent = this.deps.db
      .select()
      .from(schema.agents)
      .where(and(eq(schema.agents.id, args.agentId), eq(schema.agents.workspaceId, args.workspaceId)))
      .get();
    if (!agent || agent.monthlyBudgetCents === null) return 'ok';
    const nextSpend = agent.currentMonthSpendCents + args.estimatedCents;
    if (nextSpend <= agent.monthlyBudgetCents) return 'ok';

    const event = this.recordEvent({
      workspaceId: args.workspaceId,
      agentId: args.agentId,
      runId: args.runId,
      eventType: 'limit_hit',
      amountCents: args.estimatedCents,
      balanceAfterCents: agent.monthlyBudgetCents - agent.currentMonthSpendCents,
    });
    await this.deps.approvals.create({
      workspaceId: args.workspaceId,
      ambientId: args.ambientId,
      userId: args.userId,
      runId: args.runId,
      taskId: args.taskId,
      gatewayId: null,
      source: 'budget_limit',
      title: `Budget limit reached for ${agent.name}`,
      summary: `Estimated spend would exceed this agent's monthly budget by ${nextSpend - agent.monthlyBudgetCents} cents.`,
      confidence: null,
    });
    this.deps.bus.publish(REALTIME_ROOMS.workspace(args.workspaceId), REALTIME_EVENTS.BUDGET_EVENT_CREATED, event);
    this.deps.bus.publish(REALTIME_ROOMS.workspace(args.workspaceId), REALTIME_EVENTS.INBOX_UPDATED, { reason: 'budget_limit' });
    return 'approval_required';
  }

  recordSpend(args: { workspaceId: string; agentId: string; runId?: string | null; amountCents: number }) {
    const agent = this.deps.db
      .select()
      .from(schema.agents)
      .where(and(eq(schema.agents.id, args.agentId), eq(schema.agents.workspaceId, args.workspaceId)))
      .get();
    if (!agent) return null;
    const nextSpend = agent.currentMonthSpendCents + Math.max(0, args.amountCents);
    this.deps.db
      .update(schema.agents)
      .set({ currentMonthSpendCents: nextSpend, updatedAt: new Date().toISOString() })
      .where(eq(schema.agents.id, agent.id))
      .run();
    const event = this.recordEvent({
      workspaceId: args.workspaceId,
      agentId: args.agentId,
      runId: args.runId ?? null,
      eventType: 'spend',
      amountCents: args.amountCents,
      balanceAfterCents: (agent.monthlyBudgetCents ?? nextSpend) - nextSpend,
    });
    this.deps.bus.publish(REALTIME_ROOMS.workspace(args.workspaceId), REALTIME_EVENTS.BUDGET_EVENT_CREATED, event);
    return event;
  }

  grantExtension(args: { workspaceId: string; agentId: string; amountCents: number; runId?: string | null }) {
    const agent = this.deps.db
      .select()
      .from(schema.agents)
      .where(and(eq(schema.agents.id, args.agentId), eq(schema.agents.workspaceId, args.workspaceId)))
      .get();
    if (!agent) return null;
    const nextBudget = (agent.monthlyBudgetCents ?? 0) + Math.max(0, args.amountCents);
    this.deps.db
      .update(schema.agents)
      .set({ monthlyBudgetCents: nextBudget, updatedAt: new Date().toISOString() })
      .where(eq(schema.agents.id, agent.id))
      .run();
    return this.recordEvent({
      workspaceId: args.workspaceId,
      agentId: args.agentId,
      runId: args.runId ?? null,
      eventType: 'extension_granted',
      amountCents: args.amountCents,
      balanceAfterCents: nextBudget - agent.currentMonthSpendCents,
    });
  }

  private recordEvent(args: {
    workspaceId: string;
    agentId: string;
    runId?: string | null;
    eventType: string;
    amountCents: number;
    balanceAfterCents: number;
  }) {
    const event = { id: randomUUID(), createdAt: new Date().toISOString(), ...args, runId: args.runId ?? null };
    this.deps.db.insert(schema.budgetEvents).values(event).run();
    return event;
  }
}
