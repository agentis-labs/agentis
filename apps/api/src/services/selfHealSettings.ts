/**
 * Self-healing workflow settings (AGENT-AUTONOMY-10X §W7 UX).
 *
 * Persisted per-workspace in `workspace_kv` under `selfheal.config`. Surfaced in
 * the profile dropdown (quick toggle) and Settings → Automation. Default: ON
 * within budget, with STRUCTURAL graph repairs gated behind approval — plus a
 * guarded autonomy plus a deliberately explicit full bypass.
 */

import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';

export interface SelfHealConfig {
  /** Master switch — when false, a failed node follows the legacy path. */
  enabled: boolean;
  /** Guarded = internal repairs apply; bypass = every certified repair applies. */
  mode: 'guarded' | 'bypass';
  /** Max distinct repair plans in one failure lineage before escalation. */
  maxRepairPlans: number;
  /**
   * The agent that performs/backs self-healing: it grounds the diagnosis and is
   * the reroute target when a step's own agent has no connected runtime.
   * `null` = the workspace orchestrator (the default healer).
   */
  healerAgentId: string | null;
}

export const DEFAULT_SELF_HEAL: SelfHealConfig = {
  enabled: true,
  mode: 'guarded',
  maxRepairPlans: 3,
  healerAgentId: null,
};

const KV_KEY = 'selfheal.config';

export function getSelfHealConfig(db: AgentisSqliteDb, workspaceId: string): SelfHealConfig {
  try {
    const row = db
      .select({ value: schema.workspaceKv.value })
      .from(schema.workspaceKv)
      .where(and(eq(schema.workspaceKv.workspaceId, workspaceId), eq(schema.workspaceKv.key, KV_KEY)))
      .get();
    if (!row?.value || typeof row.value !== 'object') return { ...DEFAULT_SELF_HEAL };
    const v = row.value as Partial<SelfHealConfig> & { structuralMode?: unknown; maxRepairAttempts?: unknown };
    return {
      enabled: typeof v.enabled === 'boolean' ? v.enabled : DEFAULT_SELF_HEAL.enabled,
      // Compatibility is contained at this persistence boundary. The engine and
      // web app only use the ladder vocabulary below.
      mode: v.mode === 'bypass' || v.structuralMode === 'autonomous' ? 'bypass' : 'guarded',
      maxRepairPlans: clampPlans(v.maxRepairPlans ?? v.maxRepairAttempts),
      healerAgentId: typeof v.healerAgentId === 'string' && v.healerAgentId.trim() ? v.healerAgentId : null,
    };
  } catch {
    return { ...DEFAULT_SELF_HEAL };
  }
}

export function setSelfHealConfig(db: AgentisSqliteDb, workspaceId: string, patch: Partial<SelfHealConfig>): SelfHealConfig {
  const current = getSelfHealConfig(db, workspaceId);
  const next: SelfHealConfig = {
    enabled: typeof patch.enabled === 'boolean' ? patch.enabled : current.enabled,
    mode: patch.mode === 'guarded' || patch.mode === 'bypass' ? patch.mode : current.mode,
    maxRepairPlans: patch.maxRepairPlans !== undefined ? clampPlans(patch.maxRepairPlans) : current.maxRepairPlans,
    healerAgentId: patch.healerAgentId !== undefined
      ? (typeof patch.healerAgentId === 'string' && patch.healerAgentId.trim() ? patch.healerAgentId : null)
      : current.healerAgentId,
  };
  const now = new Date().toISOString();
  const existing = db
    .select({ id: schema.workspaceKv.id })
    .from(schema.workspaceKv)
    .where(and(eq(schema.workspaceKv.workspaceId, workspaceId), eq(schema.workspaceKv.key, KV_KEY)))
    .get();
  if (existing) {
    db.update(schema.workspaceKv).set({ value: next, updatedAt: now }).where(eq(schema.workspaceKv.id, existing.id)).run();
  } else {
    db.insert(schema.workspaceKv).values({ id: randomUUID(), workspaceId, key: KV_KEY, value: next, createdAt: now, updatedAt: now }).run();
  }
  return next;
}

function clampPlans(n: unknown): number {
  const v = typeof n === 'number' && Number.isFinite(n) ? Math.floor(n) : DEFAULT_SELF_HEAL.maxRepairPlans;
  return Math.max(0, Math.min(5, v));
}
