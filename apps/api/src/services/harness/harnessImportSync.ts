/**
 * HarnessImportSyncService — P4 continuous transition (AGENT-TRANSITION §9).
 *
 * Periodically re-scans already-imported agents and, when their harness files
 * have accumulated new memory, emits a `harness.import.updates` event so the UI
 * stages versioned source changes for review or applies only policy-eligible
 * changes when the operator has selected trusted auto-sync.
 *
 * Filesystem watchers provide fast detection; the periodic pass is the durable
 * recovery path for missed/coalesced events. Cadence is env-overridable.
 */

import { sql } from 'drizzle-orm';
import { existsSync, watch, type FSWatcher } from 'node:fs';
import { REALTIME_ROOMS, REALTIME_EVENTS } from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import type { EventBus } from '../../event-bus.js';
import type { Logger } from '../../logger.js';
import { checkImportUpdates, syncImportedAgents, type HarnessImportDeps } from './harnessAgentImport.js';
import type { AgentOwnershipSyncService } from './agentOwnershipSync.js';

const DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6h

export const HARNESS_IMPORT_UPDATES_EVENT = REALTIME_EVENTS.HARNESS_IMPORT_UPDATES;

export class HarnessImportSyncService {
  #timer: ReturnType<typeof setInterval> | undefined;
  #running = false;
  #watchers = new Map<string, FSWatcher>();
  #watchDebounce: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly deps: HarnessImportDeps,
    private readonly bus: EventBus,
    private readonly logger: Logger,
    private readonly intervalMs = envInterval() ?? DEFAULT_INTERVAL_MS,
    private readonly ownership?: AgentOwnershipSyncService,
  ) {}

  start(): void {
    if (this.#timer || this.intervalMs <= 0) return;
    void this.runOnce();
    this.#timer = setInterval(() => { void this.runOnce(); }, this.intervalMs);
    this.#timer.unref?.();
    this.#refreshWatchers();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
    if (this.#watchDebounce) clearTimeout(this.#watchDebounce);
    this.#watchDebounce = undefined;
    for (const watcher of this.#watchers.values()) watcher.close();
    this.#watchers.clear();
  }

  /** Scan every workspace that has imported agents; emit updates where found. */
  async runOnce(): Promise<void> {
    if (this.#running) return;
    this.#running = true;
    try {
      for (const workspaceId of this.#workspacesWithImports()) {
        try {
          if (this.ownership) {
            const runs = await this.ownership.scanWorkspace(workspaceId, 'scheduled');
            if (runs.length > 0) this.bus.publish(REALTIME_ROOMS.workspace(workspaceId), HARNESS_IMPORT_UPDATES_EVENT, { runs });
            continue;
          }
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
      this.#refreshWatchers();
    } finally {
      this.#running = false;
    }
  }

  #refreshWatchers(): void {
    if (!this.ownership) return;
    const roots = new Set(this.ownership.watchRoots().filter((root) => existsSync(root)));
    for (const [root, watcher] of this.#watchers) if (!roots.has(root)) { watcher.close(); this.#watchers.delete(root); }
    for (const root of roots) {
      if (this.#watchers.has(root)) continue;
      try {
        const watcher = watch(root, { persistent: false }, () => {
          if (this.#watchDebounce) clearTimeout(this.#watchDebounce);
          this.#watchDebounce = setTimeout(() => { void this.#runWatched(); }, 750);
          this.#watchDebounce.unref?.();
        });
        watcher.on('error', (error) => this.logger.warn('agent.sync.watch_failed', { root, message: error.message }));
        this.#watchers.set(root, watcher);
      } catch (error) {
        this.logger.warn('agent.sync.watch_failed', { root, message: (error as Error).message });
      }
    }
  }

  async #runWatched(): Promise<void> {
    if (!this.ownership || this.#running) return;
    this.#running = true;
    try {
      for (const workspaceId of this.#workspacesWithImports()) await this.ownership.scanWorkspace(workspaceId, 'watch');
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
