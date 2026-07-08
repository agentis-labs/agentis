/**
 * CommandModel — the fractal management mind (COMMAND-MODEL Layer B).
 *
 * Fuses three things Agentis already has but never joined into one view for an
 * agent that MANAGES rather than merely responds:
 *
 *   1. Inventory  — what this agent owns (scoped via CommandScope).
 *   2. Progress   — run outcomes in a window + the DELTA since the agent last
 *                   reviewed (a persisted watermark), + what needs it now.
 *   3. Minds      — the App minds (appLearning.recentLearnings) that never reached
 *                   chat before, so the manager sees what its products have learned.
 *
 * The result is a resident Command Briefing (scoped, progress-aware, clamped) plus
 * an explicit USE-YOUR-MIND doctrine. Same code serves the orchestrator (whole
 * workspace) and a domain manager (its sector) — a fractal.
 */

import { randomUUID } from 'node:crypto';
import { and, desc, eq, gte, inArray } from 'drizzle-orm';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { WorkflowRunState } from '@agentis/core';
import type { Logger } from '../../logger.js';
import type { RecentLearnings } from '../app/appLearning.js';
import { resolveCommandScope, type CommandScope } from './commandScope.js';

const TERMINAL_OK = new Set(['COMPLETED', 'COMPLETED_WITH_CONTRACT_VIOLATION']);
const TERMINAL_FAIL = new Set(['FAILED', 'COMPLETED_WITH_ERRORS']);
const IN_MOTION = new Set(['RUNNING', 'CREATED', 'WAITING', 'PENDING']);
const DAY_MS = 24 * 60 * 60 * 1000;
const WINDOW_MS = 7 * DAY_MS;          // 7d — the primary progress window (counts/attention/delta).
const OUTCOME_WINDOW_MS = 30 * DAY_MS; // 30d — the widest window, for the outcome momentum trend.
const MAX_ATTENTION = 6;
const MAX_APP_MINDS = 5;
const OUTCOME_TREND_LABELS = 5;

export interface CommandProgress {
  windowLabel: string;
  runsCompleted: number;
  runsFailed: number;
  runsInMotion: number;
  sinceLastReview: { at: string; runsCompleted: number; runsFailed: number } | null;
  pendingApprovals: Array<{ id: string; title: string }>;
  attention: string[];
  /**
   * Semantic outcomes — declared workflow output labels (leads_qualified,
   * meetings_booked, …) counted per COMPLETED run in-window. This is what the
   * work ACHIEVED, not just how many runs finished. Same source as space.summary.
   * This is the 7d slice; `outcomeWindows` carries the full 24h/7d/30d trend.
   */
  outcomes: Array<{ label: string; count: number }>;
  /** Outcome counts across 24h / 7d / 30d — the momentum of achieved work. */
  outcomeWindows: Array<{ window: '24h' | '7d' | '30d'; outcomes: Array<{ label: string; count: number }> }>;
}

export interface CommandModel {
  scope: CommandScope;
  inventory: { apps: number; workflows: number; specialists: number; scopeLabel: string };
  progress: CommandProgress;
  appLearnings: Array<{ app: string; lessons: string[] }>;
}

/** Minimal structural view of the App-mind service (avoids an import cycle). */
export interface AppLearningLike {
  recentLearnings(workspaceId: string, appId: string, limit?: number): RecentLearnings;
}

export interface CommandModelDeps {
  db: AgentisSqliteDb;
  logger?: Logger;
  appLearning?: AppLearningLike;
}

export class CommandModelService {
  constructor(private readonly deps: CommandModelDeps) {}

  /** Build the full model for an agent. Never throws — degrades to inventory-only. */
  build(workspaceId: string, agentId: string): CommandModel {
    const scope = resolveCommandScope(this.deps.db, workspaceId, agentId);
    const workflowIds = scope.kind === 'workspace' ? null : scope.workflowIds;
    const progress = this.#progress(workspaceId, agentId, scope, workflowIds);
    const inventory = this.#inventory(workspaceId, scope);
    const appLearnings = this.#appLearnings(workspaceId, scope);
    return { scope, inventory, progress, appLearnings };
  }

  /** The resident COMMAND MODEL prompt block. */
  briefingBlock(workspaceId: string, agentId: string): string {
    try {
      return formatBriefing(this.build(workspaceId, agentId));
    } catch (err) {
      this.deps.logger?.warn?.('command_model.briefing_failed', { workspaceId, agentId, err: (err as Error).message });
      return '';
    }
  }

  /** Stamp the review watermark to now (called by command.review / heartbeat). */
  markReviewed(workspaceId: string, agentId: string): void {
    writeWatermark(this.deps.db, workspaceId, agentId, new Date().toISOString());
  }


  #inventory(workspaceId: string, scope: CommandScope): CommandModel['inventory'] {
    if (scope.kind === 'workspace') {
      const apps = this.deps.db.select({ id: schema.apps.id }).from(schema.apps).where(eq(schema.apps.workspaceId, workspaceId)).all().length;
      const workflows = this.deps.db.select({ id: schema.workflows.id }).from(schema.workflows).where(eq(schema.workflows.workspaceId, workspaceId)).all().length;
      const specialists = this.deps.db.select({ id: schema.agents.id }).from(schema.agents).where(eq(schema.agents.workspaceId, workspaceId)).all().length;
      return { apps, workflows, specialists, scopeLabel: 'the entire workspace' };
    }
    return {
      apps: scope.appIds.length,
      workflows: scope.workflowIds.length,
      specialists: scope.specialistIds.length,
      scopeLabel: scope.domainNames.length > 0 ? scope.domainNames.join(', ') : 'your owned work',
    };
  }

  #progress(workspaceId: string, agentId: string, scope: CommandScope, workflowIds: string[] | null): CommandProgress {
    const nowMs = Date.now();
    const since7 = new Date(nowMs - WINDOW_MS).toISOString();
    const since30 = new Date(nowMs - OUTCOME_WINDOW_MS).toISOString();
    // Empty scope filter with a non-workspace scope means "nothing owned yet".
    const noneOwned = scope.kind !== 'workspace' && (workflowIds?.length ?? 0) === 0;
    // Fetch the widest window once; the 7d slice drives counts/attention.
    const runs30 = noneOwned ? [] : this.#runsSince(workspaceId, workflowIds, since30);
    const runs7 = runs30.filter((r) => r.createdAt >= since7);

    let runsCompleted = 0;
    let runsFailed = 0;
    let runsInMotion = 0;
    for (const r of runs7) {
      if (TERMINAL_OK.has(r.status)) runsCompleted += 1;
      else if (TERMINAL_FAIL.has(r.status)) runsFailed += 1;
      else if (IN_MOTION.has(r.status)) runsInMotion += 1;
    }

    // Delta since the agent last reviewed its command model (persisted watermark).
    // Computed over the 30d set so a review older than a week is still accurate.
    const watermark = readWatermark(this.deps.db, workspaceId, agentId);
    let sinceLastReview: CommandProgress['sinceLastReview'] = null;
    if (watermark) {
      let c = 0;
      let f = 0;
      for (const r of runs30) {
        if (r.createdAt <= watermark) continue;
        if (TERMINAL_OK.has(r.status)) c += 1;
        else if (TERMINAL_FAIL.has(r.status)) f += 1;
      }
      sinceLastReview = { at: watermark, runsCompleted: c, runsFailed: f };
    }

    // What needs the manager: recent failed runs (title + first error).
    const titles = this.#workflowTitles(workspaceId);
    const attention: string[] = [];
    for (const r of runs7) {
      if (attention.length >= MAX_ATTENTION) break;
      if (!TERMINAL_FAIL.has(r.status)) continue;
      const err = firstError(r.runState);
      attention.push(`run ${r.id.slice(0, 8)} of "${titles.get(r.workflowId ?? '') ?? r.workflowId ?? 'workflow'}" FAILED${err ? ` — ${err}` : ''}`);
    }

    const pendingApprovals = this.#pendingApprovals(workspaceId, scope, workflowIds);
    const outcomeWindows = this.#outcomeTrend(workspaceId, workflowIds, runs30, nowMs);
    const outcomes = outcomeWindows.find((w) => w.window === '7d')?.outcomes ?? [];

    return {
      windowLabel: 'last 7 days',
      runsCompleted,
      runsFailed,
      runsInMotion,
      sinceLastReview,
      pendingApprovals,
      attention,
      outcomes,
      outcomeWindows,
    };
  }

  /**
   * Semantic outcomes across 24h / 7d / 30d: count each COMPLETED run's declared
   * output labels (the same `workflow.settings.outputLabels` space.summary
   * aggregates) per window. Answers "what is the work ACHIEVING, and is it
   * accelerating" — not just how many runs finished. `runs` is the 30d set.
   */
  #outcomeTrend(
    workspaceId: string,
    workflowIds: string[] | null,
    runs: Array<{ workflowId: string | null; status: string; createdAt: string }>,
    nowMs: number,
  ): CommandProgress['outcomeWindows'] {
    const rows = workflowIds === null
      ? this.deps.db.select({ id: schema.workflows.id, settings: schema.workflows.settings }).from(schema.workflows).where(eq(schema.workflows.workspaceId, workspaceId)).all()
      : workflowIds.length === 0 ? []
        : this.deps.db.select({ id: schema.workflows.id, settings: schema.workflows.settings }).from(schema.workflows)
            .where(and(eq(schema.workflows.workspaceId, workspaceId), inArray(schema.workflows.id, workflowIds))).all();
    const labelsByWorkflow = new Map<string, string[]>();
    for (const w of rows) {
      const settings = (w.settings as Record<string, unknown> | null) ?? {};
      labelsByWorkflow.set(w.id, Array.isArray(settings.outputLabels) ? settings.outputLabels.map(String) : []);
    }
    const windows: Array<{ window: '24h' | '7d' | '30d'; ms: number }> = [
      { window: '24h', ms: DAY_MS },
      { window: '7d', ms: WINDOW_MS },
      { window: '30d', ms: OUTCOME_WINDOW_MS },
    ];
    return windows.map(({ window, ms }) => {
      const since = new Date(nowMs - ms).toISOString();
      const counts: Record<string, number> = {};
      for (const r of runs) {
        if (r.status !== 'COMPLETED' || !r.workflowId || r.createdAt < since) continue;
        for (const label of labelsByWorkflow.get(r.workflowId) ?? []) counts[label] = (counts[label] ?? 0) + 1;
      }
      return { window, outcomes: Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([label, count]) => ({ label, count })) };
    });
  }

  #runsSince(workspaceId: string, workflowIds: string[] | null, sinceIso: string): Array<{ id: string; workflowId: string | null; status: string; createdAt: string; runState: WorkflowRunState | null }> {
    const cols = { id: schema.workflowRuns.id, workflowId: schema.workflowRuns.workflowId, status: schema.workflowRuns.status, createdAt: schema.workflowRuns.createdAt, runState: schema.workflowRuns.runState };
    const rows = workflowIds
      ? (workflowIds.length === 0 ? [] : this.deps.db.select(cols).from(schema.workflowRuns)
          .where(and(eq(schema.workflowRuns.workspaceId, workspaceId), gte(schema.workflowRuns.createdAt, sinceIso), inArray(schema.workflowRuns.workflowId, workflowIds)))
          .orderBy(desc(schema.workflowRuns.createdAt)).limit(500).all())
      : this.deps.db.select(cols).from(schema.workflowRuns)
          .where(and(eq(schema.workflowRuns.workspaceId, workspaceId), gte(schema.workflowRuns.createdAt, sinceIso)))
          .orderBy(desc(schema.workflowRuns.createdAt)).limit(500).all();
    return rows.map((r) => ({ id: r.id, workflowId: r.workflowId, status: r.status, createdAt: r.createdAt, runState: (r.runState ?? null) as WorkflowRunState | null }));
  }

  #workflowTitles(workspaceId: string): Map<string, string> {
    return new Map(
      this.deps.db.select({ id: schema.workflows.id, title: schema.workflows.title }).from(schema.workflows)
        .where(eq(schema.workflows.workspaceId, workspaceId)).all().map((w) => [w.id, w.title]),
    );
  }

  #pendingApprovals(workspaceId: string, scope: CommandScope, workflowIds: string[] | null): Array<{ id: string; title: string }> {
    const rows = this.deps.db
      .select({ id: schema.approvalRequests.id, title: schema.approvalRequests.title, runId: schema.approvalRequests.runId })
      .from(schema.approvalRequests)
      .where(and(eq(schema.approvalRequests.workspaceId, workspaceId), eq(schema.approvalRequests.status, 'pending')))
      .orderBy(desc(schema.approvalRequests.createdAt))
      .limit(20)
      .all();
    if (workflowIds === null) return rows.slice(0, 8).map((r) => ({ id: r.id, title: r.title }));
    // Domain scope: keep only approvals whose run belongs to an in-scope workflow.
    const wfSet = new Set(workflowIds);
    const out: Array<{ id: string; title: string }> = [];
    for (const r of rows) {
      if (!r.runId) continue;
      const run = this.deps.db.select({ workflowId: schema.workflowRuns.workflowId }).from(schema.workflowRuns).where(eq(schema.workflowRuns.id, r.runId)).get();
      if (run?.workflowId && wfSet.has(run.workflowId)) out.push({ id: r.id, title: r.title });
      if (out.length >= 8) break;
    }
    return out;
  }

  #appLearnings(workspaceId: string, scope: CommandScope): Array<{ app: string; lessons: string[] }> {
    if (!this.deps.appLearning) return [];
    const appIds = scope.kind === 'workspace'
      ? this.deps.db.select({ id: schema.apps.id }).from(schema.apps).where(eq(schema.apps.workspaceId, workspaceId)).orderBy(desc(schema.apps.updatedAt)).limit(MAX_APP_MINDS).all().map((a) => a.id)
      : scope.appIds.slice(0, MAX_APP_MINDS);
    const names = new Map(this.deps.db.select({ id: schema.apps.id, name: schema.apps.name }).from(schema.apps).where(eq(schema.apps.workspaceId, workspaceId)).all().map((a) => [a.id, a.name]));
    const out: Array<{ app: string; lessons: string[] }> = [];
    for (const appId of appIds) {
      try {
        const learned = this.deps.appLearning.recentLearnings(workspaceId, appId, 3);
        if (learned.lessons.length === 0) continue;
        out.push({ app: names.get(appId) ?? appId, lessons: learned.lessons.map((l) => oneLine(l.summary || l.title)).slice(0, 3) });
      } catch { /* App mind is best-effort — never break the briefing. */ }
    }
    return out;
  }
}

// ── watermark (workspace_kv) ─────────────────────────────────────────────────

function watermarkKey(agentId: string): string {
  return `command:watermark:${agentId}`;
}

function readWatermark(db: AgentisSqliteDb, workspaceId: string, agentId: string): string | null {
  const row = db.select({ value: schema.workspaceKv.value }).from(schema.workspaceKv)
    .where(and(eq(schema.workspaceKv.workspaceId, workspaceId), eq(schema.workspaceKv.key, watermarkKey(agentId)))).get();
  const v = row?.value as { lastReviewedAt?: string } | null | undefined;
  return v?.lastReviewedAt ?? null;
}

function writeWatermark(db: AgentisSqliteDb, workspaceId: string, agentId: string, iso: string): void {
  const key = watermarkKey(agentId);
  const now = new Date().toISOString();
  const existing = db.select({ id: schema.workspaceKv.id }).from(schema.workspaceKv)
    .where(and(eq(schema.workspaceKv.workspaceId, workspaceId), eq(schema.workspaceKv.key, key))).get();
  if (existing) {
    db.update(schema.workspaceKv).set({ value: { lastReviewedAt: iso }, updatedAt: now }).where(eq(schema.workspaceKv.id, existing.id)).run();
  } else {
    db.insert(schema.workspaceKv).values({ id: randomUUID(), workspaceId, key, value: { lastReviewedAt: iso }, createdAt: now, updatedAt: now }).run();
  }
}

// ── formatting ───────────────────────────────────────────────────────────────

function firstError(state: WorkflowRunState | null): string | null {
  if (!state?.nodeStates) return null;
  for (const ns of Object.values(state.nodeStates)) {
    const err = (ns as { error?: string | null })?.error;
    if (err) return oneLine(err).slice(0, 120);
  }
  return null;
}

function oneLine(text: string): string {
  const t = (text ?? '').replace(/\s+/g, ' ').trim();
  return t.length > 140 ? `${t.slice(0, 137)}...` : t;
}

function ago(iso: string): string {
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return 'recently';
  const h = Math.floor(ms / 3_600_000);
  if (h < 1) return 'under an hour ago';
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export function formatBriefing(m: CommandModel): string {
  const roleLabel = m.scope.kind === 'workspace' ? 'ORCHESTRATOR (whole workspace)'
    : m.scope.kind === 'domain' ? `MANAGER of ${m.inventory.scopeLabel}`
    : 'OWNER of your work';
  const lines: string[] = [
    `COMMAND MODEL — you are the ${roleLabel}.`,
    `You manage ${m.inventory.apps} app(s), ${m.inventory.workflows} workflow(s), and ${m.inventory.specialists} specialist(s) across ${m.inventory.scopeLabel}. This is YOURS to run — manage it, don't just answer questions about it.`,
    `Progress (${m.progress.windowLabel}): ${m.progress.runsCompleted} completed · ${m.progress.runsFailed} failed · ${m.progress.runsInMotion} in motion.`,
  ];
  if (m.progress.sinceLastReview) {
    lines.push(`Since you last reviewed (${ago(m.progress.sinceLastReview.at)}): ${m.progress.sinceLastReview.runsCompleted} completed, ${m.progress.sinceLastReview.runsFailed} failed.`);
  }
  const trend = m.progress.outcomeWindows;
  const wideLabels = trend.find((w) => w.window === '30d')?.outcomes ?? [];
  if (wideLabels.length > 0) {
    const at = (win: '24h' | '7d' | '30d', label: string) =>
      trend.find((w) => w.window === win)?.outcomes.find((o) => o.label === label)?.count ?? 0;
    lines.push('Outcomes achieved (24h · 7d · 30d) — is the work accelerating?');
    for (const { label } of wideLabels.slice(0, OUTCOME_TREND_LABELS)) {
      lines.push(`- ${label}: ${at('24h', label)} · ${at('7d', label)} · ${at('30d', label)}`);
    }
  }
  if (m.progress.attention.length > 0 || m.progress.pendingApprovals.length > 0) {
    lines.push('Needs you now:');
    for (const a of m.progress.attention) lines.push(`- ${a}`);
    for (const ap of m.progress.pendingApprovals) lines.push(`- pending approval: ${ap.title} (id ${ap.id})`);
  }
  if (m.appLearnings.length > 0) {
    lines.push('What your apps have learned (App minds — use these, they are yours):');
    for (const al of m.appLearnings) lines.push(`- ${al.app}: ${al.lessons.join(' | ')}`);
  }
  lines.push(
    'USE YOUR MIND. Before acting, recall what you already know (agentis.memory.read, agentis.capability.search). '
    + 'As you manage, record decisions and what you learn (agentis.command.note, agentis.memory.write) and refresh your picture (agentis.command.review). '
    + 'Reach for anything you own as a live tool — apps, deep nodes, specialists, integrations/MCP — via agentis.capability.invoke. Progress the work; do not wait to be asked twice.',
  );
  return lines.join('\n');
}
