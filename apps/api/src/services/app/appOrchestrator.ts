/**
 * AppOrchestrator — multi-workflow control BY RULE for an Agentic App
 * (APP-INTERFACE-10X-MASTERPLAN §2.3).
 *
 * The E0 control plane stored rules on `settings.appBinding` (order / enabled /
 * dependsOn) but nothing EXECUTED them. This service is the missing executor:
 *
 *  1. **Chains** — when a run of workflow W (owned by app A) settles, every
 *     enabled sibling whose `dependsOn` includes W is queued — through the same
 *     `queueWorkflowRun` seam as every other start (never a forked path).
 *     `chainOn` on the *dependent* decides eligibility: `success` (default) fires
 *     after clean COMPLETED for legacy workflows, and only after an ACCOMPLISHED
 *     world verdict when the upstream carries a definition-of-done spec;
 *     `always` fires on any terminal settle for explicit finally/failure paths.
 *     `dependsOn` is a CONJUNCTION, not a list of independent triggers: a
 *     dependent on [A, C] fires once, when the last of A and C is satisfied —
 *     never once per upstream. The settling run only opens the question; the
 *     join answers it by reading every other dependency's current-graph run.
 *  2. **Schedules** — `binding.schedule.cron` fires on the SchedulerService sweep
 *     seam. Graph-authored triggers stay authoritative where present; this is the
 *     App-level "run this at…" layer for workflows without their own trigger.
 *  3. **Concurrency** — `binding.concurrency === 'exclusive'` skips an
 *     orchestrated start while a run of that workflow is still active (manual
 *     starts are never blocked — the operator outranks the rule).
 *  4. **Run-all** — start every enabled root (no dependsOn) in `order`; chains
 *     cascade from there.
 *
 * Safety: chain depth is capped per lineage (parentRunId walk), so dependsOn
 * cycles terminate instead of ping-ponging forever.
 */

import { and, desc, eq, inArray, isNotNull } from 'drizzle-orm';
import {
  appWorkflowBindingSchema,
  REALTIME_EVENTS,
  REALTIME_ROOMS,
  type AppWorkflowBinding,
  type WorkflowGraph,
} from '@agentis/core';
import { schema, type AgentisSqliteDb } from '@agentis/db/sqlite';
import type { BusMessage, EventBus } from '../../event-bus.js';
import type { Logger } from '../../logger.js';
import type { WorkflowEngine } from '../../engine/WorkflowEngine.js';
import { queueWorkflowRun, type SchedulerDeps } from '../scheduler.js';
import { nextCronFire } from '../cronNextFire.js';
import { readWorkflowSpec } from '../workflow/workflowSpec.js';
import { evaluateRunOutcome } from '../workflow/runOutcome.js';
import { resolveStartAt } from '../workflow/deferredStart.js';
import { readRunTerminalOutput } from '../workflow/runOutput.js';
import { evalCondition } from '../../engine/SafeConditionParser.js';
import { graphContentHash } from '../workflow/workflowCompass.js';

/** Statuses that mean "a run is still in flight" (concurrency guard). */
const ACTIVE_RUN_STATUSES = ['CREATED', 'PLANNING', 'RUNNING', 'WAITING', 'PAUSED'] as const;
/** Cap on app-chain lineage depth — a dependsOn cycle terminates here. */
const APP_CHAIN_MAX_DEPTH = 16;

const SETTLE_EVENTS = new Set<string>([
  REALTIME_EVENTS.RUN_COMPLETED,
  REALTIME_EVENTS.RUN_FAILED,
  REALTIME_EVENTS.RUN_CANCELLED,
]);

interface AppOrchestratorDeps {
  db: AgentisSqliteDb;
  bus: EventBus;
  engine: WorkflowEngine;
  logger: Logger;
}

interface WorkflowBindingRow {
  id: string;
  workspaceId: string;
  ambientId: string | null;
  userId: string;
  appId: string | null;
  title: string;
  graph: WorkflowGraph;
  settings?: unknown;
  binding: AppWorkflowBinding;
}

export function readAppBinding(settings: unknown): AppWorkflowBinding {
  const raw = (settings as { appBinding?: unknown } | null | undefined)?.appBinding;
  const parsed = appWorkflowBindingSchema.safeParse(raw ?? {});
  return parsed.success ? parsed.data : { dependsOn: [] };
}

export class AppOrchestratorService {
  #unsubscribe: (() => void) | undefined;
  /** workflowId → next scheduled fire (ms epoch). Rebuilt on boot + rearm(). */
  #nextFire = new Map<string, number>();
  /** workflowIds whose schedule could not be parsed (logged once, skipped). */
  #badCron = new Set<string>();

  constructor(private readonly deps: AppOrchestratorDeps) {}

  // ── lifecycle ──────────────────────────────────────────────

  start(): void {
    if (this.#unsubscribe) return;
    this.#unsubscribe = this.deps.bus.subscribe((message) => {
      void this.handleMessage(message).catch((err) => {
        this.deps.logger.warn('app_orchestrator.chain_failed', { err: (err as Error).message });
      });
    });
    this.rearmAll();
  }

  shutdown(): void {
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    this.#nextFire.clear();
  }

  // ── 1. dependsOn chains ────────────────────────────────────

  async handleMessage(message: BusMessage): Promise<{ fired: number }> {
    if (!SETTLE_EVENTS.has(message.envelope.event)) return { fired: 0 };
    if (!message.room.startsWith('run:')) return { fired: 0 };
    const payload = (message.envelope.payload ?? {}) as Record<string, unknown>;
    const runId = typeof payload.runId === 'string' ? payload.runId : message.room.slice('run:'.length);
    return this.handleRunSettled(runId);
  }

  async handleRunSettled(runId: string): Promise<{ fired: number }> {
    const run = this.deps.db.select().from(schema.workflowRuns).where(eq(schema.workflowRuns.id, runId)).get();
    if (!run?.workflowId) return { fired: 0 };
    const source = this.deps.db
      .select({ id: schema.workflows.id, appId: schema.workflows.appId, workspaceId: schema.workflows.workspaceId, settings: schema.workflows.settings })
      .from(schema.workflows)
      .where(eq(schema.workflows.id, run.workflowId))
      .get();
    if (!source?.appId) return { fired: 0 };

    const depth = this.lineageDepth(runId);
    if (depth >= APP_CHAIN_MAX_DEPTH) {
      this.deps.logger.warn('app_orchestrator.chain_depth_capped', { runId, workflowId: source.id, depth });
      return { fired: 0 };
    }

    const sourceHasDefinitionOfDone = Boolean(readWorkflowSpec(source.settings));
    const outcome = evaluateRunOutcome({
      status: run.status,
      runState: run.runState,
      hasDefinitionOfDone: sourceHasDefinitionOfDone,
    });
    const siblings = this.appWorkflows(source.workspaceId, source.appId);
    // Read the upstream's terminal output ONCE for all dependents — both the
    // `when` predicate and the passed inputs need it.
    const chained = readRunTerminalOutput(run.graphSnapshot, run.runState);
    let fired = 0;
    for (const sibling of siblings) {
      if (sibling.id === source.id) continue;
      if (sibling.binding.enabled === false) continue;
      if (!(sibling.binding.dependsOn ?? []).includes(source.id)) continue;
      const join = this.dependenciesSatisfied(sibling, siblings, { workflowId: source.id, outcome });
      if (!join.ok) {
        // Blocked by the upstream that just settled = the classic outcome gate.
        // Blocked by anything else = a real fan-in wait, worth a distinct event.
        const onlySettled = join.pending.length === 1 && join.pending[0] === source.id;
        this.deps.logger.info(
          onlySettled ? 'app_orchestrator.chain_blocked_outcome' : 'app_orchestrator.chain_join_pending',
          {
            appId: source.appId,
            from: source.id,
            to: sibling.id,
            runId,
            status: run.status,
            verdict: outcome.verdict ?? outcome.reason,
            pending: join.pending,
          },
        );
        continue;
      }
      if (!this.whenHolds(sibling, source, run, outcome, chained)) continue;
      if (this.skipForConcurrency(sibling)) continue;
      try {
        const queued = await queueWorkflowRun(this.schedulerDeps(), {
          workflowId: sibling.id,
          workspaceId: sibling.workspaceId,
          ambientId: sibling.ambientId,
          userId: run.userId ?? sibling.userId,
          triggerId: null,
          inputs: {
            triggerType: 'app_chain',
            appId: source.appId,
            upstreamWorkflowId: source.id,
            upstreamRunId: runId,
            upstreamStatus: run.status,
            upstreamOutcome: outcome.verdict ?? outcome.reason,
            // The upstream's actual result, not just a pointer to it. Bounded —
            // an oversized/absent output falls back to the id-only shape, which
            // is what every dependent handled before.
            ...(chained.output ? { upstreamOutput: chained.output } : {}),
            ...(chained.omitted ? { upstreamOutputOmitted: chained.omitted } : {}),
          },
          reason: 'app_chain',
          parentRunId: runId,
          chainDepth: depth + 1,
          // Link-level wait. Null (no delay configured) preserves the immediate
          // start every existing chain has today.
          scheduledAt: resolveStartAt(
            sibling.binding.delay
              ? { delayMs: sibling.binding.delay.ms, jitterMs: sibling.binding.delay.jitterMs }
              : null,
          ),
        });
        fired += 1;
        this.deps.bus.publish(REALTIME_ROOMS.workflow(sibling.id), REALTIME_EVENTS.RUN_QUEUED, {
          runId: queued.runId,
          workflowId: sibling.id,
          reason: 'app_chain',
          appId: source.appId,
          upstreamWorkflowId: source.id,
        });
        this.deps.logger.info('app_orchestrator.chain_fired', {
          appId: source.appId, from: source.id, to: sibling.id, runId: queued.runId, depth: depth + 1,
        });
      } catch (err) {
        this.deps.logger.warn('app_orchestrator.chain_start_failed', {
          appId: source.appId, workflowId: sibling.id, err: (err as Error).message,
        });
      }
    }
    return { fired };
  }

  // ── 2. binding schedules (cron) ────────────────────────────

  /** Recompute the in-memory next-fire map for every scheduled binding. */
  rearmAll(now = new Date()): void {
    this.#nextFire.clear();
    this.#badCron.clear();
    for (const row of this.scheduledWorkflows()) this.arm(row, now);
  }

  /** Re-arm one workflow after its binding changed (or was removed). */
  rearm(workflowId: string, now = new Date()): void {
    this.#nextFire.delete(workflowId);
    this.#badCron.delete(workflowId);
    const row = this.workflowBindingRow(workflowId);
    if (row) this.arm(row, now);
  }

  /** Next scheduled fire for a workflow (display), null when none/invalid. */
  nextScheduledFire(workflowId: string): string | null {
    const at = this.#nextFire.get(workflowId);
    return at ? new Date(at).toISOString() : null;
  }

  /**
   * SchedulerService sweep hook — fire every due binding schedule. Missed windows
   * (downtime) collapse to ONE fire, then re-arm from now.
   */
  async sweepSchedules(now = new Date()): Promise<number> {
    let fired = 0;
    for (const [workflowId, dueAt] of [...this.#nextFire.entries()]) {
      if (dueAt > now.getTime()) continue;
      const row = this.workflowBindingRow(workflowId);
      // Binding vanished or was disabled since arming — drop silently.
      if (!row?.appId || !row.binding.schedule || row.binding.schedule.enabled === false || row.binding.enabled === false) {
        this.#nextFire.delete(workflowId);
        continue;
      }
      this.arm(row, new Date(now.getTime() + 1_000)); // re-arm first so a start failure can't hot-loop
      if (this.skipForConcurrency(row)) {
        this.deps.logger.info('app_orchestrator.schedule_skipped_concurrency', { workflowId });
        continue;
      }
      try {
        const queued = await queueWorkflowRun(this.schedulerDeps(), {
          workflowId: row.id,
          workspaceId: row.workspaceId,
          ambientId: row.ambientId,
          userId: row.userId,
          triggerId: null,
          inputs: { triggerType: 'app_schedule', cron: row.binding.schedule.cron, firedAt: now.toISOString() },
          reason: 'app_schedule',
          scheduledAt: now.toISOString(),
        });
        fired += 1;
        this.deps.logger.info('app_orchestrator.schedule_fired', { workflowId, runId: queued.runId, cron: row.binding.schedule.cron });
      } catch (err) {
        this.deps.logger.warn('app_orchestrator.schedule_fire_failed', { workflowId, err: (err as Error).message });
      }
    }
    return fired;
  }

  // ── 4. run-all ─────────────────────────────────────────────

  /**
   * Continue the App from its first unresolved business frontier. A current-
   * graph run that is already accomplished is reused; it is not paid for and
   * executed again. `fresh` is the explicit operator escape hatch when inputs
   * or external state require a root restart.
   */
  async runAll(
    workspaceId: string,
    appId: string,
    userId: string,
    mode: 'continue' | 'fresh' = 'continue',
    overrideAck?: string,
  ): Promise<Array<{ workflowId: string; runId: string | null; skipped?: string; reusedRunId?: string }>> {
    const enabled = this.appWorkflows(workspaceId, appId)
      .filter((row) => row.binding.enabled !== false)
      .sort((a, b) => (a.binding.order ?? 0) - (b.binding.order ?? 0) || a.title.localeCompare(b.title));
    const latest = mode === 'continue'
      ? new Map(enabled.map((row) => [row.id, this.latestCurrentGraphRun(row)] as const))
      : new Map<string, ReturnType<AppOrchestratorService['latestCurrentGraphRun']>>();
    // `satisfied` = this row is itself already done (reported as reused).
    // `outcomes` keeps the raw verdict so a DEPENDENT can judge its upstreams by
    // its own chainOn — the same rule the reactive chain applies.
    const outcomes = new Map<string, ReturnType<typeof evaluateRunOutcome>>();
    const satisfied = new Set<string>();
    if (mode === 'continue') {
      for (const row of enabled) {
        const run = latest.get(row.id);
        if (!run) continue;
        const outcome = evaluateRunOutcome({
          status: run.status,
          runState: run.runState,
          hasDefinitionOfDone: Boolean(readWorkflowSpec(row.settings)),
        });
        outcomes.set(row.id, outcome);
        if (this.outcomeAccepts(outcome, row.binding.chainOn ?? 'success')) satisfied.add(row.id);
      }
    }
    const rows = enabled.filter((row) => {
      if (mode === 'fresh') return (row.binding.dependsOn ?? []).length === 0 && row.binding.operatorEntrypoint !== false;
      if (satisfied.has(row.id)) return true; // reported as reused below
      const dependencies = row.binding.dependsOn ?? [];
      if (dependencies.length === 0 && row.binding.operatorEntrypoint === false) return false;
      return dependencies.every((dependencyId) => {
        const outcome = outcomes.get(dependencyId);
        return outcome ? this.outcomeAccepts(outcome, row.binding.chainOn ?? 'success') : false;
      });
    });
    const results: Array<{ workflowId: string; runId: string | null; skipped?: string; reusedRunId?: string }> = [];
    for (const row of rows) {
      if (satisfied.has(row.id)) {
        results.push({ workflowId: row.id, runId: null, skipped: 'current_graph_accomplished', reusedRunId: latest.get(row.id)?.id });
        continue;
      }
      if (this.skipForConcurrency(row)) {
        results.push({ workflowId: row.id, runId: null, skipped: 'active_run_exclusive' });
        continue;
      }
      const currentRun = latest.get(row.id);
      if (mode === 'continue' && currentRun && ACTIVE_RUN_STATUSES.includes(currentRun.status as typeof ACTIVE_RUN_STATUSES[number])) {
        results.push({ workflowId: row.id, runId: null, skipped: 'active_run_in_progress', reusedRunId: currentRun.id });
        continue;
      }
      try {
        const queued = await queueWorkflowRun(this.schedulerDeps(), {
          workflowId: row.id,
          workspaceId,
          ambientId: row.ambientId,
          userId,
          triggerId: null,
          inputs: {
            triggerType: mode === 'fresh' ? 'app_run_all_fresh' : 'app_run_continue',
            appId,
            ...(overrideAck ? { conformanceOverrideAck: overrideAck.slice(0, 300) } : {}),
          },
          reason: mode === 'fresh' ? 'app_run_all_fresh' : 'app_run_continue',
          parentRunId: mode === 'continue'
            ? (row.binding.dependsOn ?? []).map((id) => latest.get(id)?.id).find(Boolean) ?? undefined
            : undefined,
        });
        results.push({ workflowId: row.id, runId: queued.runId });
      } catch (err) {
        results.push({ workflowId: row.id, runId: null, skipped: (err as Error).message });
      }
    }
    return results;
  }


  #schedulerDeps: SchedulerDeps | undefined;
  private schedulerDeps(): SchedulerDeps {
    this.#schedulerDeps ??= {
      db: this.deps.db,
      bus: this.deps.bus,
      engine: this.deps.engine,
      logger: this.deps.logger,
    };
    return this.#schedulerDeps;
  }

  private arm(row: WorkflowBindingRow, from: Date): void {
    const schedule = row.binding.schedule;
    if (!row.appId || !schedule || schedule.enabled === false || row.binding.enabled === false) return;
    const next = nextCronFire(schedule.cron, from);
    if (!next) {
      if (!this.#badCron.has(row.id)) {
        this.#badCron.add(row.id);
        this.deps.logger.warn('app_orchestrator.invalid_cron', { workflowId: row.id, cron: schedule.cron });
      }
      return;
    }
    this.#nextFire.set(row.id, next.getTime());
  }

  private skipForConcurrency(row: WorkflowBindingRow): boolean {
    if ((row.binding.concurrency ?? 'parallel') !== 'exclusive') return false;
    const active = this.deps.db
      .select({ id: schema.workflowRuns.id })
      .from(schema.workflowRuns)
      .where(and(
        eq(schema.workflowRuns.workflowId, row.id),
        inArray(schema.workflowRuns.status, [...ACTIVE_RUN_STATUSES]),
      ))
      .limit(1)
      .get();
    return Boolean(active);
  }

  private lineageDepth(runId: string): number {
    let depth = 0;
    let cursor: string | null = runId;
    const seen = new Set<string>();
    while (cursor && !seen.has(cursor) && depth <= APP_CHAIN_MAX_DEPTH) {
      seen.add(cursor);
      const row = this.deps.db
        .select({ parentRunId: schema.workflowRuns.parentRunId })
        .from(schema.workflowRuns)
        .where(eq(schema.workflowRuns.id, cursor))
        .get();
      cursor = row?.parentRunId ?? null;
      if (cursor) depth += 1;
    }
    return depth;
  }

  private appWorkflows(workspaceId: string, appId: string): WorkflowBindingRow[] {
    return this.deps.db
      .select({
        id: schema.workflows.id,
        workspaceId: schema.workflows.workspaceId,
        ambientId: schema.workflows.ambientId,
        userId: schema.workflows.userId,
        appId: schema.workflows.appId,
        title: schema.workflows.title,
        graph: schema.workflows.graph,
        settings: schema.workflows.settings,
      })
      .from(schema.workflows)
      .where(and(eq(schema.workflows.workspaceId, workspaceId), eq(schema.workflows.appId, appId)))
      .all()
      .map((row) => ({ ...row, graph: row.graph as WorkflowGraph, binding: readAppBinding(row.settings) }));
  }

  private scheduledWorkflows(): WorkflowBindingRow[] {
    return this.deps.db
      .select({
        id: schema.workflows.id,
        workspaceId: schema.workflows.workspaceId,
        ambientId: schema.workflows.ambientId,
        userId: schema.workflows.userId,
        appId: schema.workflows.appId,
        title: schema.workflows.title,
        graph: schema.workflows.graph,
        settings: schema.workflows.settings,
      })
      .from(schema.workflows)
      .where(isNotNull(schema.workflows.appId))
      .all()
      .map((row) => ({ ...row, graph: row.graph as WorkflowGraph, binding: readAppBinding(row.settings) }))
      .filter((row) => Boolean(row.binding.schedule?.cron));
  }

  /** Latest terminal/current run whose immutable snapshot matches today's graph. */
  private latestCurrentGraphRun(row: WorkflowBindingRow): {
    id: string;
    status: string;
    runState: unknown;
  } | undefined {
    const currentHash = graphContentHash(row.graph);
    const candidates = this.deps.db
      .select({
        id: schema.workflowRuns.id,
        status: schema.workflowRuns.status,
        runState: schema.workflowRuns.runState,
        graphSnapshot: schema.workflowRuns.graphSnapshot,
      })
      .from(schema.workflowRuns)
      .where(eq(schema.workflowRuns.workflowId, row.id))
      .orderBy(desc(schema.workflowRuns.createdAt))
      .limit(25)
      .all();
    return candidates.find((run) => {
      if (!run.graphSnapshot) return false;
      try {
        return graphContentHash(run.graphSnapshot as WorkflowGraph) === currentHash;
      } catch {
        return false;
      }
    });
  }

  /**
   * Does this outcome satisfy a dependent whose policy is `chainOn`? `success`
   * demands the world verdict (ACCOMPLISHED where the upstream carries a
   * definition-of-done spec, clean COMPLETED otherwise); `always` accepts any
   * terminal settle so explicit finally/failure paths still join. Single
   * definition — the reactive chain and the operator run-all path share it.
   */
  private outcomeAccepts(
    outcome: ReturnType<typeof evaluateRunOutcome>,
    chainOn: 'success' | 'failure' | 'always',
  ): boolean {
    if (chainOn === 'always') return outcome.terminal;
    // A true error branch: settled AND did not succeed. Distinct from `always`,
    // which also fires on success — the difference between "cleanup" and
    // "handle the failure".
    if (chainOn === 'failure') return outcome.terminal && !outcome.canAdvanceOnSuccess;
    return outcome.canAdvanceOnSuccess;
  }

  /**
   * Evaluate a link's `when` predicate against the upstream result. Absent =
   * always true.
   *
   * Fails CLOSED: a malformed expression holds the link rather than firing it.
   * A chain that silently ignores its own guard is worse than one that does not
   * fire — the guard is usually there to stop unwanted outward side effects.
   */
  private whenHolds(
    dependent: WorkflowBindingRow,
    source: { id: string; appId: string | null },
    run: { status: string },
    outcome: ReturnType<typeof evaluateRunOutcome>,
    chained: ReturnType<typeof readRunTerminalOutput>,
  ): boolean {
    const expression = dependent.binding.when?.trim();
    if (!expression) return true;
    const scope = {
      upstream: {
        workflowId: source.id,
        status: run.status,
        verdict: outcome.verdict ?? outcome.reason ?? null,
        output: chained.output ?? {},
      },
      app: { id: source.appId },
    };
    try {
      const holds = Boolean(evalCondition(expression, scope));
      if (!holds) {
        this.deps.logger.info('app_orchestrator.chain_blocked_when', {
          appId: source.appId, from: source.id, to: dependent.id, when: expression,
        });
      }
      return holds;
    } catch (err) {
      this.deps.logger.warn('app_orchestrator.chain_when_invalid', {
        appId: source.appId,
        from: source.id,
        to: dependent.id,
        when: expression,
        err: (err as Error).message,
      });
      return false;
    }
  }

  /** Outcome of a workflow's latest current-graph run, or null when it has none. */
  private outcomeFor(row: WorkflowBindingRow): ReturnType<typeof evaluateRunOutcome> | null {
    const run = this.latestCurrentGraphRun(row);
    if (!run) return null;
    return evaluateRunOutcome({
      status: run.status,
      runState: run.runState,
      hasDefinitionOfDone: Boolean(readWorkflowSpec(row.settings)),
    });
  }

  /**
   * Fan-in join: `dependsOn` is a conjunction, so EVERY dependency must be
   * satisfied before the dependent starts. Without this a dependent on [A, C]
   * fires twice — once per upstream settle.
   *
   * The dependent's `chainOn` governs every dependency, matching the rule that
   * the dependent decides its own eligibility. The upstream that just settled is
   * passed in rather than re-read: the bus event already carries its outcome, and
   * re-querying could pick up a newer run that started after it.
   */
  private dependenciesSatisfied(
    dependent: WorkflowBindingRow,
    siblings: WorkflowBindingRow[],
    settled: { workflowId: string; outcome: ReturnType<typeof evaluateRunOutcome> },
  ): { ok: true } | { ok: false; pending: string[] } {
    const chainOn = dependent.binding.chainOn ?? 'success';
    const pending: string[] = [];
    for (const dependencyId of dependent.binding.dependsOn ?? []) {
      if (dependencyId === settled.workflowId) {
        if (!this.outcomeAccepts(settled.outcome, chainOn)) pending.push(dependencyId);
        continue;
      }
      const dependency = siblings.find((row) => row.id === dependencyId);
      // A dependency that left the App (or was deleted) can never report
      // satisfaction. Hold the join rather than silently dropping it from the
      // conjunction — a vanished upstream must not look like a met one.
      if (!dependency) {
        pending.push(dependencyId);
        continue;
      }
      const outcome = this.outcomeFor(dependency);
      if (!outcome || !this.outcomeAccepts(outcome, chainOn)) pending.push(dependencyId);
    }
    return pending.length === 0 ? { ok: true } : { ok: false, pending };
  }

  private workflowBindingRow(workflowId: string): WorkflowBindingRow | null {
    const row = this.deps.db
      .select({
        id: schema.workflows.id,
        workspaceId: schema.workflows.workspaceId,
        ambientId: schema.workflows.ambientId,
        userId: schema.workflows.userId,
        appId: schema.workflows.appId,
        title: schema.workflows.title,
        graph: schema.workflows.graph,
        settings: schema.workflows.settings,
      })
      .from(schema.workflows)
      .where(eq(schema.workflows.id, workflowId))
      .get();
    return row ? { ...row, graph: row.graph as WorkflowGraph, binding: readAppBinding(row.settings) } : null;
  }
}
