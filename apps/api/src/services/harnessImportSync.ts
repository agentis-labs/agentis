/**
 * HarnessImportSyncService — P4 continuous transition (AGENT-TRANSITION §9).
 *
 * Periodically re-scans already-imported agents and, when their harness files
 * have accumulated new memory, emits a `harness.import.updates` event so the UI
 * can surface "N new memories — pull them in". Strictly APPROVAL-GATED: this
 * never writes; the operator pulls via POST /v1/harness/import (idempotent).
 *
 * Local-first V1: the import sources read this machine's files, so a low cadence
 * is plenty. Cadence is env-overridable for tests/ops.
 */

import { sql } from 'drizzle-orm';
import { REALTIME_ROOMS, REALTIME_EVENTS } from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import type { EventBus } from '../event-bus.js';
import type { Logger } from '../logger.js';
import { checkImportUpdates, syncImportedAgents, type HarnessImportDeps } from './harnessAgentImport.js';

const DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6h

export const HARNESS_IMPORT_UPDATES_EVENT = REALTIME_EVENTS.HARNESS_IMPORT_UPDATES;

export class HarnessImportSyncService {
  #timer: ReturnType<typeof setInterval> | undefined;
  #running = false;

  constructor(
    private readonly deps: HarnessImportDeps,
    private readonly bus: EventBus,
    private readonly logger: Logger,
    private readonly intervalMs = envInterval() ?? DEFAULT_INTERVAL_MS,
  ) {}

  start(): void {
    if (this.#timer || this.intervalMs <= 0) return;
    void this.runOnce();
    this.#timer = setInterval(() => { void this.runOnce(); }, this.intervalMs);
    this.#timer.unref?.();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
  }

  /** Scan every workspace that has imported agents; emit updates where found. */
  async runOnce(): Promise<void> {
    if (this.#running) return;
    this.#running = true;
    try {
      for (const workspaceId of this.#workspacesWithImports()) {
        try {
          const updates = await checkImportUpdates(this.deps, workspaceId);
          if (updates.length > 0) {
            const sync = await syncImportedAgents(this.deps, workspaceId);
            this.bus.publish(REALTIME_ROOMS.workspace(workspaceId), HARNESS_IMPORT_UPDATES_EVENT, { updates, sync });
            this.logger.info('harness.import.synced', {
              workspaceId,
              agents: sync.synced.length,
              atoms: sync.totalAtoms,
              abilities: sync.totalAbilities,
            });
          }
        } catch (err) {
          this.logger.warn('harness.import.sync_failed', { workspaceId, message: (err as Error).message });
        }
      }
    } finally {
      this.#running = false;
    }
  }

  /** Distinct workspaces owning at least one imported agent (config.importOrigin). */
  #workspacesWithImports(): string[] {
    try {
      const rows = this.deps.db
        .selectDistinct({ workspaceId: schema.agents.workspaceId })
        .from(schema.agents)
        .where(sql`json_extract(${schema.agents.config}, '$.importOrigin') is not null`)
        .all();
      return rows.map((r) => r.workspaceId);
    } catch {
      return [];
    }
  }
}

function envInterval(): number | undefined {
  const raw = process.env.AGENTIS_HARNESS_IMPORT_SYNC_MS;
  if (!raw) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}
