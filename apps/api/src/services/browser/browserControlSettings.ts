/**
 * Real-Chrome-control opt-in (per workspace).
 *
 * Attaching to the user's actual Chrome over CDP lets an agent act as
 * fully-logged-in them, so it is OFF by default and enabled by an explicit,
 * operator-visible switch (Settings → Governance) rather than a raw env var.
 * Stored in `workspace_kv`, mirroring the autonomy opt-in (commandHeartbeat.ts).
 *
 * The deployment env is a MASTER override, not the switch: `AGENTIS_BROWSER_ALLOW_CDP=false`
 * force-denies for the whole deployment (hosted lockdown); `=true` force-allows;
 * anything else defers to the per-workspace setting.
 */

import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';

const REAL_CHROME_KEY = 'browser:allow_real_chrome';

export function isRealChromeControlEnabled(db: AgentisSqliteDb, workspaceId: string): boolean {
  const row = db.select({ value: schema.workspaceKv.value }).from(schema.workspaceKv)
    .where(and(eq(schema.workspaceKv.workspaceId, workspaceId), eq(schema.workspaceKv.key, REAL_CHROME_KEY))).get();
  return (row?.value as { enabled?: boolean } | null | undefined)?.enabled === true;
}

export function setRealChromeControlEnabled(db: AgentisSqliteDb, workspaceId: string, enabled: boolean): void {
  const now = new Date().toISOString();
  const existing = db.select({ id: schema.workspaceKv.id }).from(schema.workspaceKv)
    .where(and(eq(schema.workspaceKv.workspaceId, workspaceId), eq(schema.workspaceKv.key, REAL_CHROME_KEY))).get();
  if (existing) {
    db.update(schema.workspaceKv).set({ value: { enabled }, updatedAt: now }).where(eq(schema.workspaceKv.id, existing.id)).run();
  } else {
    db.insert(schema.workspaceKv).values({ id: randomUUID(), workspaceId, key: REAL_CHROME_KEY, value: { enabled }, createdAt: now, updatedAt: now }).run();
  }
}

/** Env master: 'false' → force-deny, 'true' → force-allow, else null (defer to the setting). */
export function realChromeEnvMaster(): boolean | null {
  const raw = String(process.env.AGENTIS_BROWSER_ALLOW_CDP ?? '').toLowerCase();
  if (raw === 'false') return false;
  if (raw === 'true') return true;
  return null;
}

/** Final decision the session manager consults: env master wins, else the per-workspace switch. */
export function resolveRealChromeAllowed(db: AgentisSqliteDb, workspaceId: string): boolean {
  const master = realChromeEnvMaster();
  if (master !== null) return master;
  return isRealChromeControlEnabled(db, workspaceId);
}
