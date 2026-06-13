/**
 * CORA Runtime — the continuous learning tick (RFC §10.8 Learning Plan).
 *
 * Every tick, for each workspace with a launched learning plan:
 *   incremental sync (ready connections) → deterministic/adaptive extraction
 *   → model snapshot → plan stage health.
 *
 * Restart-durability comes from the data, not the scheduler: sync cursors and
 * extraction statuses are committed per batch, so a crashed tick resumes
 * exactly where it stopped. The interval loop is intentionally simple — the
 * platform's DurableJobQueue is a workflow-run queue, and §0.2 forbids
 * duplicating it into a second generic queue; if a generic job backend lands,
 * this tick body becomes its handler unchanged.
 */

import { eq } from 'drizzle-orm';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import { schema } from '@agentis/db/sqlite';
import type { Logger } from '../logger.js';
import type { CoraSourceFabric } from './sourceFabric.js';
import type { CoraExtractionService } from './extractionService.js';
import type { CoraModelService } from './modelService.js';
import type { CoraDiscoveryService } from './discovery.js';

const DEFAULT_INTERVAL_MS = 5 * 60_000;

export interface CoraRuntimeDeps {
  db: AgentisSqliteDb;
  logger: Logger;
  fabric: CoraSourceFabric;
  extraction: CoraExtractionService;
  model: CoraModelService;
  discovery: CoraDiscoveryService;
  intervalMs?: number;
}

export class CoraRuntime {
  #timer: ReturnType<typeof setInterval> | null = null;
  #ticking = false;

  constructor(private readonly deps: CoraRuntimeDeps) {}

  start(): void {
    if (this.#timer) return;
    const interval = this.deps.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.#timer = setInterval(() => { void this.tick(); }, interval);
    // unref so the loop never holds the process open on shutdown.
    if (typeof this.#timer === 'object' && 'unref' in this.#timer) this.#timer.unref();
    this.deps.logger.info('cora.runtime.started', { intervalMs: interval });
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }

  /** One full learning pass. Public so launch and tests can run it directly. */
  async tick(): Promise<void> {
    if (this.#ticking) return; // never overlap passes
    this.#ticking = true;
    try {
      const plans = this.deps.db.select().from(schema.coraLearningPlans)
        .where(eq(schema.coraLearningPlans.status, 'active'))
        .all();
      for (const plan of plans) {
        await this.tickWorkspace(plan.workspaceId);
      }
    } catch (error) {
      this.deps.logger.warn('cora.runtime.tick_failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.#ticking = false;
    }
  }

  async tickWorkspace(workspaceId: string): Promise<void> {
    const connections = this.deps.fabric.listConnections(workspaceId)
      .filter((c) => c.status === 'ready');
    let syncHealthy = connections.length > 0;
    for (const connection of connections) {
      const outcome = await this.deps.fabric.runSync({
        workspaceId,
        connectionId: connection.id,
        mode: 'incremental',
      }).catch(() => ({ status: 'failed' as const }));
      if (outcome.status === 'failed') syncHealthy = false;
    }
    this.deps.discovery.updateLearningPlanStage(workspaceId, 'sync', syncHealthy ? 'healthy' : 'attention');
    this.deps.discovery.updateLearningPlanStage(workspaceId, 'normalize', syncHealthy ? 'healthy' : 'attention');
    this.deps.discovery.updateLearningPlanStage(workspaceId, 'secure', 'healthy');

    const extraction = await this.deps.extraction.extractPending(workspaceId);
    this.deps.discovery.updateLearningPlanStage(workspaceId, 'extract', 'healthy');
    this.deps.discovery.updateLearningPlanStage(
      workspaceId,
      'reason',
      extraction.adaptiveSkipped > 0 ? 'attention' : 'healthy',
    );

    this.deps.model.buildSnapshot(workspaceId);
    this.deps.discovery.updateLearningPlanStage(workspaceId, 'publish', 'healthy');
  }
}
