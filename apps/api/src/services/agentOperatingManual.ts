/**
 * Agent Operating Manual (AGENT-AUTONOMY-10X §W2) — the "system.md" for Agentis
 * agents. The missing layer that tells every agent its FULL agentic surface, so
 * it acts like an operator, not a script.
 *
 * Composed in layers (D1): workspace default → role-tier → per-agent persona
 * (the persona is injected separately as the agent's instructions). This module
 * owns the capabilities + role-tier layers and the workspace override.
 */

import { and, eq } from 'drizzle-orm';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';

/** The capability briefing every agent receives. Capabilities + the hard rules. */
export const DEFAULT_CAPABILITIES_MANUAL = [
  '## Your operating manual',
  'You are an Agentis agent — an autonomous operator, not a fixed script. You have real power; use it deliberately:',
  '- **Delegate & spawn teams** — hand a subtask to a specialist (`delegate_task`); when an expert role does not exist, create it. Spawn multiple specialists for parallel work and synthesize their results.',
  '- **Use workflows as tools** — build and run a workflow as a reusable subroutine when a task is repeatable or multi-step; read its result and continue. A workflow is a tool you reach for, not a cage.',
  '- **Use the Brain** — search memory before acting; write only durable, reusable lessons (never transient work product).',
  '- **Reflect & replan** — if the work in front of you is unusable (bad upstream input, wrong assumptions), say so and change course. Re-scope, repair, or escalate. Do not dutifully process garbage to satisfy a shape.',
  '',
  '### Rules you must never break',
  '- **Never fabricate.** Do not invent data, sources, or outputs to make a step "pass". If a value is not real, say it is missing.',
  '- **Preserve intent.** You may change HOW a goal is met, never WHAT the goal is. Do not redefine the objective or the meaning of declared outputs.',
  '- **Ground every claim** in real evidence (the task, the data, the error). When you cannot ground an answer, abstain and escalate honestly.',
  '- **Respect budget & approvals.** Outward or irreversible actions go through approval. Stay within your budget; stop and report when exhausted.',
].join('\n');

/** Role-tier emphasis layered on top of the capabilities manual (D1). */
export const ROLE_TIER_MANUAL: Record<string, string> = {
  orchestrator:
    '### Your role: orchestrator\nYou own outcomes, not keystrokes. Decompose the goal, spawn and coordinate the team you need, delegate broadly, and synthesize. Prefer orchestration over doing every step yourself.',
  manager:
    '### Your role: manager\nYou run a domain. Plan the work, delegate to your specialists, keep them unblocked, and report a coherent result upward.',
  worker:
    '### Your role: specialist\nYou execute focused work with depth and rigor. Delegate only what is genuinely outside your expertise; otherwise do the work well and return a clean, grounded result.',
};

const WORKSPACE_MANUAL_KEY = 'operating_manual.workspace';

const ROUTING_INTELLIGENCE_MANUAL = [
  '### Runtime Routing Intelligence',
  '- Use the minimum sufficient runtime/model for the task. Explicit model pins are respected; workspace defaults are candidates.',
  '- If a task needs browser, web, integration, listener, reusable code, or a specialist skill, create or resolve that capability instead of escalating model size.',
  '- Use agentis.routing.preview when runtime/model choice is unclear before spawning, dispatching, or escalating.',
].join('\n');

/** Read a workspace's custom operating-manual override, if any. */
export function getWorkspaceManual(db: AgentisSqliteDb, workspaceId: string): string | null {
  try {
    const row = db.select({ value: schema.workspaceKv.value }).from(schema.workspaceKv)
      .where(and(eq(schema.workspaceKv.workspaceId, workspaceId), eq(schema.workspaceKv.key, WORKSPACE_MANUAL_KEY))).get();
    const v = row?.value;
    return typeof v === 'string' && v.trim().length > 0 ? v.trim() : null;
  } catch {
    return null;
  }
}

export function setWorkspaceManual(db: AgentisSqliteDb, workspaceId: string, text: string | null): void {
  const now = new Date().toISOString();
  const existing = db.select({ id: schema.workspaceKv.id }).from(schema.workspaceKv)
    .where(and(eq(schema.workspaceKv.workspaceId, workspaceId), eq(schema.workspaceKv.key, WORKSPACE_MANUAL_KEY))).get();
  const value = (text ?? '').trim();
  if (existing) {
    db.update(schema.workspaceKv).set({ value, updatedAt: now }).where(eq(schema.workspaceKv.id, existing.id)).run();
  } else {
    db.insert(schema.workspaceKv).values({ id: cryptoRandomId(), workspaceId, key: WORKSPACE_MANUAL_KEY, value, createdAt: now, updatedAt: now }).run();
  }
}

/**
 * Compose the operating manual for an agent run: capabilities (or the workspace
 * override) + the role-tier layer. The per-agent persona is injected separately.
 */
export function composeOperatingManual(input: { role?: string | null; workspaceManual?: string | null }): string {
  const base = input.workspaceManual?.trim() || DEFAULT_CAPABILITIES_MANUAL;
  const routedBase = `${base}\n\n${ROUTING_INTELLIGENCE_MANUAL}`;
  const roleKey = (input.role ?? '').toLowerCase();
  const roleTier = ROLE_TIER_MANUAL[roleKey];
  return roleTier ? `${routedBase}\n\n${roleTier}` : routedBase;
}

function cryptoRandomId(): string {
  // Lazy import avoids a top-level node:crypto dep where unused.
  return (globalThis.crypto?.randomUUID?.() ?? `wm_${Date.now()}_${Math.random().toString(36).slice(2)}`);
}
