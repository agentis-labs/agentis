/**
 * DeploySupervisor — keeps `always_on` apps running (§Layer 5).
 *
 * Agentis is a single-process embedded runtime — there is no OS-level process
 * to restart. "Always-on" is therefore supervised *in process*: the supervisor
 * polls every `always_on` app on an interval and, when its entry workflow has
 * no active run, decides whether to (re)start it based on `restartPolicy`:
 *
 *   - `always`     — keep a run going at all times; restart whenever idle.
 *   - `on_failure` — restart only when the last run ended in FAILED.
 *   - `never`      — never auto-restart (the operator drives it).
 *
 * Restarts are debounced per app so a fast-failing workflow cannot spin.
 * Runs are dispatched through `TriggerRuntime.startWorkflowRun`, so they pick
 * up the durable job queue and the full run lifecycle like any other run.
 */

import { and, desc, eq, inArray } from 'drizzle-orm';
import type { AppDeployConfig } from '@agentis/core';
import { schema, type AgentisSqliteDb } from '@agentis/db/sqlite';
import type { TriggerRuntime } from '../engine/TriggerRuntime.js';
import type { Logger } from '../logger.js';

const ACTIVE_RUN_STATUSES = ['RUNNING'];
/** Minimum gap between two supervised restarts of the same app. */
const RESTART_DEBOUNCE_MS = 60_000;

export interface DeploySupervisorDeps {
  db: AgentisSqliteDb;
  triggerRuntime: TriggerRuntime;
  logger: Logger;
  /** Poll cadence in ms (default 30s). */
  pollIntervalMs?: number;
}

export class DeploySupervisor {
  #timer: ReturnType<typeof setInterval> | null = null;
  readonly #pollIntervalMs: number;
  /** Last supervised restart per app id — debounce guard. */
  readonly #lastRestart = new Map<string, number>();

  constructor(private readonly deps: DeploySupervisorDeps) {
    this.#pollIntervalMs = deps.pollIntervalMs ?? 30_000;
  }

  start(): void {
    if (this.#timer) return;
    this.#timer = setInterval(() => {
      void this.tick().catch((err) =>
        this.deps.logger.error('deploy_supervisor.tick_failed', { err: (err as Error).message }),
      );
    }, this.#pollIntervalMs);
    this.#timer.unref?.();
  }

  stop(): void {
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
  }

  /** One supervision pass over every `always_on` app. Public for tests. */
  async tick(): Promise<void> {
    const apps = this.deps.db
      .select()
      .from(schema.appInstances)
      .where(eq(schema.appInstances.deployTarget, 'always_on'))
      .all();

    for (const app of apps) {
      if (!app.entryWorkflowId) continue;
      const policy =
        (app.packageContents as { deployConfig?: AppDeployConfig } | undefined)?.deployConfig
          ?.restartPolicy ?? 'on_failure';
      if (policy === 'never') continue;

      // An app already running needs no intervention.
      const active = this.deps.db
        .select({ id: schema.workflowRuns.id })
        .from(schema.workflowRuns)
        .where(
          and(
            eq(schema.workflowRuns.workflowId, app.entryWorkflowId),
            inArray(schema.workflowRuns.status, ACTIVE_RUN_STATUSES),
          ),
        )
        .limit(1)
        .get();
      if (active) continue;

      const last = this.deps.db
        .select({ status: schema.workflowRuns.status })
        .from(schema.workflowRuns)
        .where(eq(schema.workflowRuns.workflowId, app.entryWorkflowId))
        .orderBy(desc(schema.workflowRuns.createdAt))
        .limit(1)
        .get();

      // `on_failure` only restarts after a failure; `always` restarts whenever idle.
      if (policy === 'on_failure' && last && last.status !== 'FAILED') continue;

      const lastRestart = this.#lastRestart.get(app.id) ?? 0;
      if (Date.now() - lastRestart < RESTART_DEBOUNCE_MS) continue;

      try {
        this.#lastRestart.set(app.id, Date.now());
        const result = await this.deps.triggerRuntime.startWorkflowRun({
          workflowId: app.entryWorkflowId,
          workspaceId: app.workspaceId,
          ambientId: app.ambientId,
          userId: app.userId,
          inputs: { source: 'always_on_supervisor', policy, at: new Date().toISOString() },
        });
        this.deps.db
          .update(schema.appInstances)
          .set({ deployStatus: 'running', updatedAt: new Date().toISOString() })
          .where(eq(schema.appInstances.id, app.id))
          .run();
        this.deps.logger.info('deploy_supervisor.restarted', {
          appId: app.id,
          policy,
          runId: result.runId,
          reason: last ? `last run ${last.status}` : 'no prior run',
        });
      } catch (err) {
        this.deps.logger.warn('deploy_supervisor.restart_failed', {
          appId: app.id,
          err: (err as Error).message,
        });
      }
    }
  }
}
