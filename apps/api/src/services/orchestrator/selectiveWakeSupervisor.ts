/**
 * SelectiveWakeSupervisor — ORCHESTRATOR-SUSPEND-10X Phase 3.
 *
 * The other half of "start an app, sleep, wake when it concludes." A resident
 * agent parks its working context to disk (zero tokens) after launching apps; this
 * supervisor is what REVIVES it — but only when it genuinely needs to act:
 *
 *   - RUN_ACCOMPLISHED / RUN_COMPLETED — an app it owns finished (continue / reply).
 *   - RUN_FAILED                       — a decision: self-heal couldn't proceed.
 *   - APPROVAL_REQUESTED               — a decision the run raised.
 *   - WATCHDOG_TIMEOUT / BUDGET_*      — a hard stall needs judgment.
 *
 * Routine progress (NODE_COMPLETED, LOOP_PROGRESS, …) is deliberately ignored — the
 * agent is not woken tick-by-tick, only at a judgment point or completion. Waking is
 * WARM (the owning agent's resident session resumes with its goal + context intact,
 * via the injected `wakeOwner`), gated by the two-switch autonomy gate, and
 * DEBOUNCED so a fan-in of many runs settling at once wakes the owner ONCE.
 *
 * This is distinct from OrchestratorEventBridge, which pushes proactive CARDS to the
 * human operator. This one re-engages the AGENT so it acts on its own long work.
 */

import { and, eq, isNull } from 'drizzle-orm';
import { REALTIME_EVENTS, REALTIME_ROOMS } from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { EventBus, BusMessage } from '../../event-bus.js';
import type { Logger } from '../../logger.js';
import { RESIDENT_NODE_ID } from '../agent/agentSession.js';

/** The lifecycle events that warrant waking the owning agent. */
const WAKE_EVENTS: ReadonlySet<string> = new Set([
  REALTIME_EVENTS.RUN_ACCOMPLISHED,
  REALTIME_EVENTS.RUN_COMPLETED,
  REALTIME_EVENTS.RUN_FAILED,
  REALTIME_EVENTS.APPROVAL_REQUESTED,
  REALTIME_EVENTS.WATCHDOG_TIMEOUT,
  REALTIME_EVENTS.BUDGET_PHASE_EXCEEDED,
  REALTIME_EVENTS.BUDGET_RUN_EXCEEDED,
  REALTIME_EVENTS.BUDGET_WORKSPACE_EXCEEDED,
]);

/** Human-readable reason per event, for the coalesced wake message. */
const EVENT_REASON: Record<string, string> = {
  [REALTIME_EVENTS.RUN_ACCOMPLISHED]: 'accomplished',
  [REALTIME_EVENTS.RUN_COMPLETED]: 'completed',
  [REALTIME_EVENTS.RUN_FAILED]: 'failed — needs a decision',
  [REALTIME_EVENTS.APPROVAL_REQUESTED]: 'is waiting for your approval',
  [REALTIME_EVENTS.WATCHDOG_TIMEOUT]: 'hit a watchdog timeout — needs a decision',
  [REALTIME_EVENTS.BUDGET_PHASE_EXCEEDED]: 'exceeded its phase budget — needs a decision',
  [REALTIME_EVENTS.BUDGET_RUN_EXCEEDED]: 'exceeded its run budget — needs a decision',
  [REALTIME_EVENTS.BUDGET_WORKSPACE_EXCEEDED]: 'hit the workspace budget ceiling — needs a decision',
};

export interface SelectiveWakeSupervisorDeps {
  db: AgentisSqliteDb;
  bus: EventBus;
  logger: Logger;
  /** Wake the owning agent WARM (its resident session resumes). Bootstrap wires this to runResidentWake. */
  wakeOwner: (args: { workspaceId: string; agentId: string; message: string }) => Promise<void> | void;
  /** Two-switch autonomy gate — an owner is only woken when its workspace has autonomy on. */
  autonomyEnabled: (workspaceId: string) => boolean;
  /** Coalesce window: events for the same owner within this window wake it once. Default 1500ms. */
  debounceMs?: number;
}

interface PendingWake {
  workspaceId: string;
  /** runId → the reason it needs attention (last write wins per run). */
  runs: Map<string, string>;
  timer: ReturnType<typeof setTimeout> | null;
}

export class SelectiveWakeSupervisor {
  #unsubscribe: (() => void) | null = null;
  readonly #pending = new Map<string, PendingWake>(); // keyed by owning agentId
  readonly #debounceMs: number;

  constructor(private readonly deps: SelectiveWakeSupervisorDeps) {
    this.#debounceMs = deps.debounceMs ?? 1500;
  }

  start(): void {
    if (this.#unsubscribe) return;
    this.#unsubscribe = this.deps.bus.subscribe((message) => this.#handle(message));
    this.deps.logger.info('selective_wake.started');
  }

  stop(): void {
    this.#unsubscribe?.();
    this.#unsubscribe = null;
    for (const p of this.#pending.values()) if (p.timer) clearTimeout(p.timer);
    this.#pending.clear();
  }

  #handle(message: BusMessage): void {
    const event = message.envelope.event as string;
    if (!WAKE_EVENTS.has(event)) return; // routine progress is swallowed
    const payload = (message.envelope.payload ?? {}) as { runId?: unknown };
    const runId = typeof payload.runId === 'string' ? payload.runId : null;
    if (!runId) return; // a wake must be attributable to a concrete run

    let owner: { workspaceId: string; agentId: string } | null = null;
    try {
      owner = resolveRunOwnerAgent(this.deps.db, runId);
    } catch (err) {
      this.deps.logger.warn('selective_wake.resolve_owner.failed', { runId, err: (err as Error).message });
      return;
    }
    if (!owner) return; // not an app-owned run, or the app has no owner
    if (!this.deps.autonomyEnabled(owner.workspaceId)) return; // autonomy gate
    // A resident fan-in remains asleep across routine successful completions and
    // wakes once, when the last run settles. Failures/approvals/stalls bypass the
    // gate because they require judgment immediately.
    if (event === REALTIME_EVENTS.RUN_COMPLETED || event === REALTIME_EVENTS.RUN_ACCOMPLISHED) {
      const fanIn = residentFanInState(this.deps.db, owner.agentId);
      if (fanIn.waiting && !fanIn.ready) return;
      if (fanIn.waiting && fanIn.runIds.length > 0) {
        for (const awaitedRunId of fanIn.runIds) {
          this.#enqueue(owner.agentId, owner.workspaceId, awaitedRunId, 'settled (fan-in complete)');
        }
        return;
      }
    }

    this.#enqueue(owner.agentId, owner.workspaceId, runId, EVENT_REASON[event] ?? 'settled');
  }

  #enqueue(agentId: string, workspaceId: string, runId: string, reason: string): void {
    let pending = this.#pending.get(agentId);
    if (!pending) {
      pending = { workspaceId, runs: new Map(), timer: null };
      this.#pending.set(agentId, pending);
    }
    pending.runs.set(runId, reason);
    if (pending.timer) clearTimeout(pending.timer);
    pending.timer = setTimeout(() => { void this.#flush(agentId); }, this.#debounceMs);
    // Never let the debounce timer keep the process alive on its own.
    (pending.timer as { unref?: () => void }).unref?.();
  }

  /** Flush the coalesced wake for one owner (also the seam tests drive directly). */
  async #flush(agentId: string): Promise<void> {
    const pending = this.#pending.get(agentId);
    if (!pending) return;
    this.#pending.delete(agentId);
    if (pending.timer) clearTimeout(pending.timer);
    const message = buildOwnerWakeMessage(pending.runs);
    try {
      // The reserved event is the durable public wake seam. Publishing it makes
      // wake requests observable/extendable; wakeOwner is the local consumer
      // that resumes the persisted resident session in this process.
      this.deps.bus.publish(
        REALTIME_ROOMS.workspace(pending.workspaceId),
        REALTIME_EVENTS.AGENT_WAKE_REQUESTED,
        {
          workspaceId: pending.workspaceId,
          agentId,
          runIds: [...pending.runs.keys()],
          message,
        },
      );
      await this.deps.wakeOwner({ workspaceId: pending.workspaceId, agentId, message });
    } catch (err) {
      this.deps.logger.warn('selective_wake.wake_owner.failed', { agentId, err: (err as Error).message });
    }
  }

  /** Force all pending wakes to fire now (used by tests; harmless in production). */
  async flushAll(): Promise<void> {
    await Promise.all([...this.#pending.keys()].map((agentId) => this.#flush(agentId)));
  }
}

/** True when an owner's durable resident fan-in has no run still in flight. */
export function residentFanInReady(db: AgentisSqliteDb, agentId: string): boolean {
  return residentFanInState(db, agentId).ready;
}

function residentFanInState(
  db: AgentisSqliteDb,
  agentId: string,
): { waiting: boolean; ready: boolean; runIds: string[] } {
  const resident = db
    .select({
      status: schema.agentSessions.status,
      suspendPayload: schema.agentSessions.suspendPayload,
    })
    .from(schema.agentSessions)
    .where(and(
      eq(schema.agentSessions.agentId, agentId),
      isNull(schema.agentSessions.runId),
      eq(schema.agentSessions.nodeId, RESIDENT_NODE_ID),
    ))
    .get();
  if (resident?.status !== 'waiting') return { waiting: false, ready: true, runIds: [] };
  const payload = resident.suspendPayload as Record<string, unknown> | null;
  const runIds = Array.isArray(payload?.runIds)
    ? payload.runIds.filter((value): value is string => typeof value === 'string')
    : [];
  if (runIds.length === 0) return { waiting: true, ready: true, runIds: [] };
  const terminal = new Set([
    'COMPLETED',
    'COMPLETED_WITH_ERRORS',
    'COMPLETED_WITH_CONTRACT_VIOLATION',
    'FAILED',
    'CANCELLED',
    'PAUSED',
    'WAITING',
  ]);
  const ready = runIds.every((runId) => {
    const row = db.select({ status: schema.workflowRuns.status })
      .from(schema.workflowRuns).where(eq(schema.workflowRuns.id, runId)).get();
    return !row || terminal.has(row.status);
  });
  return { waiting: true, ready, runIds };
}

/**
 * Compose the wake message an owner is revived with — the "big picture": which of
 * the runs it launched settled and why, and how to act on them.
 */
export function buildOwnerWakeMessage(runs: Map<string, string>): string {
  const lines = [...runs.entries()].map(([runId, reason]) => `- run ${runId.slice(0, 8)} ${reason}`);
  return [
    '[Work you launched has reached a decision point]',
    ...lines,
    'Review each with agentis.run.inspect, act on any that need a decision, and continue toward your objective. '
      + 'If several are still in flight, agentis.run.await_all waits for them together (zero tokens while blocked).',
  ].join('\n');
}

/**
 * Resolve the agent that OWNS a run, so we wake the right one:
 *   1. The App owner — run → workflow.appId → app.ownerAgentId (precise; an
 *      app-owned run belongs to its App's operator).
 *   2. Direct ownership — the agent whose CONVERSATION started the run
 *      (run.conversationId → conversation.agentId). This covers ad-hoc runs an
 *      agent kicks off from chat/channel that aren't behind an App.
 * Returns null when neither resolves (nothing to wake). One-shot, indexed lookups.
 */
export function resolveRunOwnerAgent(db: AgentisSqliteDb, runId: string): { workspaceId: string; agentId: string } | null {
  const run = db
    .select({
      workspaceId: schema.workflowRuns.workspaceId,
      workflowId: schema.workflowRuns.workflowId,
      conversationId: schema.workflowRuns.conversationId,
    })
    .from(schema.workflowRuns)
    .where(eq(schema.workflowRuns.id, runId))
    .get();
  if (!run) return null;
  // 1. App owner (precise) — takes precedence over the conversation.
  if (run.workflowId) {
    const wf = db
      .select({ appId: schema.workflows.appId })
      .from(schema.workflows)
      .where(eq(schema.workflows.id, run.workflowId))
      .get();
    if (wf?.appId) {
      const app = db
        .select({ ownerAgentId: schema.apps.ownerAgentId })
        .from(schema.apps)
        .where(eq(schema.apps.id, wf.appId))
        .get();
      if (app?.ownerAgentId) return { workspaceId: run.workspaceId, agentId: app.ownerAgentId };
    }
  }
  // 2. Direct ownership — the agent whose conversation launched this run.
  if (run.conversationId) {
    const conv = db
      .select({ agentId: schema.conversations.agentId })
      .from(schema.conversations)
      .where(eq(schema.conversations.id, run.conversationId))
      .get();
    if (conv?.agentId) return { workspaceId: run.workspaceId, agentId: conv.agentId };
  }
  return null;
}
