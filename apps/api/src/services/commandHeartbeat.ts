/**
 * CommandHeartbeat — proactivity (COMMAND-MODEL Layer C).
 *
 * On a cadence, for each orchestrator/manager, build its Command Model and detect
 * what needs it (failed runs, in-scope approvals). Two postures:
 *
 *   • SURFACE (default, safe, zero spend) — log the attention signal + emit an
 *     event. The manager's next chat turn already leads with the same attention in
 *     its Command Briefing, so nothing is lost; the heartbeat just makes it timely.
 *   • ACT (opt-in) — when autonomy is enabled AND a turn-runner is wired, drive a
 *     bounded autonomous review turn so the manager acts unbidden through the reach
 *     layer (resolve approvals, replay failed runs, dispatch specialists).
 *
 * De-duped per agent on an attention signature so a standing failure is not
 * re-surfaced every tick. Bounded per tick. Never throws out of a sweep.
 */

import { randomUUID } from 'node:crypto';
import { and, eq, isNotNull } from 'drizzle-orm';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { Logger } from '../logger.js';
import type { CommandModelService } from './commandModel.js';
import { isOrchestratorRole } from './commandScope.js';

export interface CommandHeartbeatDeps {
  db: AgentisSqliteDb;
  logger?: Logger;
  commandModel: CommandModelService;
  /** Whether autonomous action is enabled for a workspace (default: off). */
  autonomyEnabled?: (workspaceId: string) => boolean;
  /**
   * Drives a bounded autonomous review turn for a manager (wired to
   * ChatSessionExecutor in bootstrap). Absent ⇒ surface-only. Should self-bound.
   */
  runManagerTurn?: (args: { workspaceId: string; agentId: string; message: string }) => Promise<void>;
}

const MAX_MANAGERS_PER_TICK = 25;

export class CommandHeartbeat {
  /** Agents with an autonomous turn currently in flight — prevents double-running. */
  readonly #inFlight = new Set<string>();

  constructor(private readonly deps: CommandHeartbeatDeps) {}

  /** One sweep. Returns how many managers had attention surfaced/acted on. */
  async tick(): Promise<number> {
    let handled = 0;
    let managers: Array<{ workspaceId: string; agentId: string }>;
    try {
      managers = this.#managers();
    } catch (err) {
      this.deps.logger?.warn?.('command_heartbeat.enumerate_failed', { err: (err as Error).message });
      return 0;
    }
    for (const m of managers.slice(0, MAX_MANAGERS_PER_TICK)) {
      try {
        if (await this.#reviewOne(m.workspaceId, m.agentId)) handled += 1;
      } catch (err) {
        this.deps.logger?.warn?.('command_heartbeat.review_failed', { agentId: m.agentId, err: (err as Error).message });
      }
    }
    return handled;
  }

  // ── internals ──────────────────────────────────────────────────────────

  async #reviewOne(workspaceId: string, agentId: string): Promise<boolean> {
    const model = this.deps.commandModel.build(workspaceId, agentId);
    const attention = model.progress.attention.length;
    const approvals = model.progress.pendingApprovals.length;
    if (attention === 0 && approvals === 0) return false;

    // De-dupe: only surface/act when the attention picture CHANGED since last tick.
    const signature = `${attention}:${approvals}:${model.progress.attention[0] ?? ''}:${model.progress.pendingApprovals[0]?.id ?? ''}`;
    const last = readHeartbeat(this.deps.db, workspaceId, agentId);
    if (last === signature) return false;
    writeHeartbeat(this.deps.db, workspaceId, agentId, signature);

    const summary = [
      attention > 0 ? `${attention} failed/blocked run(s)` : '',
      approvals > 0 ? `${approvals} approval(s) awaiting you` : '',
    ].filter(Boolean).join(' and ');
    this.deps.logger?.info?.('command_heartbeat.attention', { workspaceId, agentId, scope: model.scope.kind, attention, approvals });

    if (this.deps.autonomyEnabled?.(workspaceId) && this.deps.runManagerTurn) {
      const key = `${workspaceId}:${agentId}`;
      // Re-entrancy guard: never start a second autonomous turn for an agent while
      // its previous one is still running (a hung turn must not fan out).
      if (this.#inFlight.has(key)) {
        this.deps.logger?.info?.('command_heartbeat.skip_in_flight', { workspaceId, agentId });
        return true;
      }
      this.#inFlight.add(key);
      const message =
        `[Autonomous heartbeat] Review your command model and handle what needs you: ${summary}. `
        + 'Call agentis.command.review first, then act through your tools — resolve approvals, replay/fix failed runs, dispatch specialists. '
        + 'If nothing truly needs action, record a brief agentis.command.note and stop.';
      this.deps.logger?.info?.('command_heartbeat.act.start', { workspaceId, agentId, scope: model.scope.kind, summary });
      try {
        await this.deps.runManagerTurn({ workspaceId, agentId, message });
        this.deps.logger?.info?.('command_heartbeat.act.done', { workspaceId, agentId });
      } finally {
        this.#inFlight.delete(key);
      }
    }
    return true;
  }

  /** Orchestrators + domain managers across all workspaces (deduped). */
  #managers(): Array<{ workspaceId: string; agentId: string }> {
    const seen = new Set<string>();
    const out: Array<{ workspaceId: string; agentId: string }> = [];

    const managedDomains = this.deps.db
      .select({ workspaceId: schema.domains.workspaceId, managerId: schema.domains.managerId })
      .from(schema.domains)
      .where(isNotNull(schema.domains.managerId))
      .all();
    for (const d of managedDomains) {
      if (!d.managerId) continue;
      const key = `${d.workspaceId}:${d.managerId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ workspaceId: d.workspaceId, agentId: d.managerId });
    }

    // Orchestrator-role agents (may have no domain row yet but still manage all).
    const agents = this.deps.db
      .select({ id: schema.agents.id, workspaceId: schema.agents.workspaceId, role: schema.agents.role })
      .from(schema.agents)
      .all();
    for (const a of agents) {
      if (!isOrchestratorRole(a.role)) continue;
      const key = `${a.workspaceId}:${a.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ workspaceId: a.workspaceId, agentId: a.id });
    }
    return out;
  }
}

// ── heartbeat signature (workspace_kv) ──────────────────────────────────────

function heartbeatKey(agentId: string): string {
  return `command:heartbeat:${agentId}`;
}

function readHeartbeat(db: AgentisSqliteDb, workspaceId: string, agentId: string): string | null {
  const row = db.select({ value: schema.workspaceKv.value }).from(schema.workspaceKv)
    .where(and(eq(schema.workspaceKv.workspaceId, workspaceId), eq(schema.workspaceKv.key, heartbeatKey(agentId)))).get();
  const v = row?.value as { sig?: string } | null | undefined;
  return v?.sig ?? null;
}

function writeHeartbeat(db: AgentisSqliteDb, workspaceId: string, agentId: string, sig: string): void {
  const key = heartbeatKey(agentId);
  const now = new Date().toISOString();
  const existing = db.select({ id: schema.workspaceKv.id }).from(schema.workspaceKv)
    .where(and(eq(schema.workspaceKv.workspaceId, workspaceId), eq(schema.workspaceKv.key, key))).get();
  if (existing) {
    db.update(schema.workspaceKv).set({ value: { sig, at: now }, updatedAt: now }).where(eq(schema.workspaceKv.id, existing.id)).run();
  } else {
    db.insert(schema.workspaceKv).values({ id: randomUUID(), workspaceId, key, value: { sig, at: now }, createdAt: now, updatedAt: now }).run();
  }
}

// ── per-workspace autonomy opt-in (workspace_kv) ────────────────────────────
// Autonomous action requires TWO switches ON: the global env master
// (AGENTIS_COMMAND_AUTONOMY) AND this per-workspace opt-in — so enabling autonomy
// for the deployment never silently turns it on for every workspace.

const AUTONOMY_KEY = 'command:autonomy';

export function isWorkspaceAutonomyEnabled(db: AgentisSqliteDb, workspaceId: string): boolean {
  const row = db.select({ value: schema.workspaceKv.value }).from(schema.workspaceKv)
    .where(and(eq(schema.workspaceKv.workspaceId, workspaceId), eq(schema.workspaceKv.key, AUTONOMY_KEY))).get();
  return (row?.value as { enabled?: boolean } | null | undefined)?.enabled === true;
}

export function setWorkspaceAutonomy(db: AgentisSqliteDb, workspaceId: string, enabled: boolean): void {
  const now = new Date().toISOString();
  const existing = db.select({ id: schema.workspaceKv.id }).from(schema.workspaceKv)
    .where(and(eq(schema.workspaceKv.workspaceId, workspaceId), eq(schema.workspaceKv.key, AUTONOMY_KEY))).get();
  if (existing) {
    db.update(schema.workspaceKv).set({ value: { enabled }, updatedAt: now }).where(eq(schema.workspaceKv.id, existing.id)).run();
  } else {
    db.insert(schema.workspaceKv).values({ id: randomUUID(), workspaceId, key: AUTONOMY_KEY, value: { enabled }, createdAt: now, updatedAt: now }).run();
  }
}
