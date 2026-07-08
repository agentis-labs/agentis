/**
 * Live-operations blocks (APP-INTERFACE-10X Â§2.2/Â§2.3) â€” the agentic heartbeat
 * of an App Interface, registered on the open block seam:
 *
 *   OrchestrationPanel â€” multi-workflow control BY RULE: live status, schedule /
 *                        depends-on / concurrency editing, enable-pause, run-all.
 *   RunMonitor         â€” the App's runs, live: pulse, node progress, elapsed,
 *                        cancel/pause/resume, expandable per-run activity.
 *   AgentFeed          â€” watch the agents think: reasoning/tool/node stream.
 *   ApprovalsInbox     â€” pending human gates, approve/deny inline.
 *
 * All four consume the SAME live substrate the platform already runs on
 * (run rooms + `/v1/runs/:id/activity` backfill + RUN_/NODE_/APPROVAL_ events);
 * none of them invent a data path. The exported *View components are reused by
 * the App Shell ops drawer, so a surface block and the drawer never drift.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import clsx from 'clsx';
import {
  Activity, AlertTriangle, ArrowDownToLine, Bot, Brain, CalendarClock, Check, ChevronDown, ChevronRight,
  CircleDot, GitBranch, Link2, Loader2, Pause, Play, ShieldCheck, Workflow, Wrench, X, Zap,
} from 'lucide-react';
import type { AppWorkflowSummary } from '@agentis/core';
import { REALTIME_EVENTS } from '@agentis/core';
import { appsApi } from '../../../lib/appsApi';
import { opsApi, isActiveRunStatus, type ApprovalRequest, type RunSummary } from '../../../lib/opsApi';
import { rtSubscribe, useRealtime, type RealtimeEnvelope } from '../../../lib/realtime';
import { useRunActivity } from '../../../lib/useRunActivity';
import type { RealtimeActivity } from '../../../lib/realtimeActivity';
import { ApprovalPreviewCard, ApprovalReviewModal, type ApprovalReview } from '../../shared/ApprovalReviewModal';
import { registerBlock } from './registry';
import { EmptyState, PanelShell, SkeletonRows, relativeTime, useRuntime } from '../ViewRenderer';

// â”€â”€ shared: live app workflows â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const RUN_EVENTS = [
  REALTIME_EVENTS.RUN_CREATED, REALTIME_EVENTS.RUN_RUNNING, REALTIME_EVENTS.RUN_PAUSED,
  REALTIME_EVENTS.RUN_CANCELLED, REALTIME_EVENTS.RUN_COMPLETED, REALTIME_EVENTS.RUN_FAILED,
  REALTIME_EVENTS.RUN_RECOVERED, REALTIME_EVENTS.RUN_QUEUED, REALTIME_EVENTS.RUN_DEQUEUED,
];

/**
 * Hold a workspace realtime-room subscription while mounted â€” run status events
 * fan out to the workspace room (engine publishes run+workspace), and approvals
 * publish there too. Without this the socket never receives them.
 */
function useWorkspaceRoom(): void {
  useEffect(() => rtSubscribe('workspace', {}), []);
}

/** Load + live-refresh the App's workflow control plane (bindings, active runs). */
export function useAppWorkflows(appId: string): {
  workflows: AppWorkflowSummary[] | null;
  error: string | null;
  reload: () => Promise<void>;
} {
  useWorkspaceRoom();
  const [workflows, setWorkflows] = useState<AppWorkflowSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const idsRef = useRef<Set<string>>(new Set());

  const reload = useCallback(async () => {
    try {
      const rows = await appsApi.listWorkflows(appId);
      idsRef.current = new Set(rows.map((r) => r.id));
      setWorkflows(rows);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load workflows');
    }
  }, [appId]);

  useEffect(() => { void reload(); }, [reload]);

  // Refresh on any run transition for one of OUR workflows (debounced).
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useRealtime(RUN_EVENTS, (env: RealtimeEnvelope) => {
    const wfId = (env.payload as { workflowId?: string } | undefined)?.workflowId;
    if (!wfId || !idsRef.current.has(wfId)) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => { void reload(); }, 400);
  });
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  return { workflows, error, reload };
}

/** Load + live-refresh recent runs across the App's workflows. */
export function useAppRuns(workflowIds: Set<string>, limit: number): { runs: RunSummary[]; loading: boolean; reload: () => void } {
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const idsKey = [...workflowIds].sort().join(',');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const reload = useCallback(() => {
    if (workflowIds.size === 0) { setRuns([]); setLoading(false); return; }
    // Fetch recent runs AND active runs separately: an active run can be older
    // than the recent-runs window (e.g. a run parked WAITING/PAUSED for days).
    // still counted as "active", instead of a phantom the run list never surfaces.
    Promise.all([
      opsApi.listRuns({ limit: 100 }),
      opsApi.listRuns({ status: 'active', limit: 50 }),
    ])
      .then(([recent, active]) => {
        const mine = (runs: RunSummary[]) => runs.filter((r) => workflowIds.has(r.workflowId));
        const activeMine = mine(active);
        const seen = new Set(activeMine.map((r) => r.id));
        // Active runs first (so they're never sliced off), then recent history.
        const merged = [...activeMine, ...mine(recent).filter((r) => !seen.has(r.id))];
        setRuns(merged.slice(0, Math.max(limit, activeMine.length)));
      })
      .catch(() => setRuns([]))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idsKey, limit]);

  useEffect(() => { setLoading(true); reload(); }, [reload]);

  useRealtime(RUN_EVENTS, (env: RealtimeEnvelope) => {
    const wfId = (env.payload as { workflowId?: string } | undefined)?.workflowId;
    if (wfId && !workflowIds.has(wfId)) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(reload, 400);
  });
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  return { runs, loading, reload };
}

// â”€â”€ shared: presentation â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function runTone(status: string): { chip: string; dot: string; label: string } {
  const s = status.toUpperCase();
  if (s === 'RUNNING') return { chip: 'bg-success-soft text-success', dot: 'bg-success s-pulse text-success', label: 'running' };
  if (s === 'WAITING' || s === 'PAUSED') return { chip: 'bg-warn-soft text-warn', dot: 'bg-warn', label: s.toLowerCase() };
  if (s === 'CREATED' || s === 'PLANNING' || s === 'QUEUED') return { chip: 'bg-warn-soft text-warn', dot: 'bg-warn', label: s.toLowerCase() };
  if (s === 'COMPLETED') return { chip: 'bg-success-soft text-success', dot: 'bg-success', label: 'completed' };
  if (s === 'CANCELLED') return { chip: 'bg-surface-2 text-text-muted', dot: 'bg-text-disabled', label: 'cancelled' };
  return { chip: 'bg-danger-soft text-danger', dot: 'bg-danger', label: s.toLowerCase().replace(/_/g, ' ') };
}

function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

/** Ticking elapsed label for an in-flight run. */
function Elapsed({ startedAt, done }: { startedAt: string; done?: string | null }) {
  const [, force] = useState(0);
  useEffect(() => {
    if (done) return;
    const t = setInterval(() => force((n) => n + 1), 1_000);
    return () => clearInterval(t);
  }, [done]);
  const end = done ? Date.parse(done) : Date.now();
  return <span className="tabular-nums">{formatElapsed(end - Date.parse(startedAt))}</span>;
}

/** Human hint for a cron expression (client-side mirror of the server's describeCron). */
export function cronHint(cron: string): string {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return cron;
  const [m, h, dom, , dow] = parts as [string, string, string, string, string];
  const pad = (v: string) => v.padStart(2, '0');
  if (/^\*\/(\d+)$/.test(m) && h === '*') return `every ${m.slice(2)} min`;
  if (/^\d+$/.test(m) && h === '*') return `hourly at :${pad(m)}`;
  if (/^\d+$/.test(m) && /^\d+$/.test(h)) {
    const days = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
    if (dow !== '*' && /^\d$/.test(dow)) return `${days[Number(dow)]} ${pad(h)}:${pad(m)}`;
    if (dom !== '*' && /^\d+$/.test(dom)) return `day ${dom} Â· ${pad(h)}:${pad(m)}`;
    return `daily ${pad(h)}:${pad(m)}`;
  }
  return cron;
}

const SCHEDULE_PRESETS: Array<{ label: string; cron: string | null }> = [
  { label: 'No schedule', cron: null },
  { label: 'Every 15 min', cron: '*/15 * * * *' },
  { label: 'Hourly', cron: '0 * * * *' },
  { label: 'Daily 09:00', cron: '0 9 * * *' },
  { label: 'Weekdays 09:00', cron: '0 9 * * 1-5' },
  { label: 'Weekly Mon 08:00', cron: '0 8 * * 1' },
];

// â”€â”€ OrchestrationPanel â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export function OrchestrationPanelView({ appId, title, controls = true }: { appId: string; title?: string; controls?: boolean }) {
  const { workflows, error, reload } = useAppWorkflows(appId);
  const [busy, setBusy] = useState<string | null>(null);
  const [openRules, setOpenRules] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const run = useCallback(async (wfId: string) => {
    setBusy(wfId);
    setActionError(null);
    try { await appsApi.runAppWorkflow(appId, wfId); await reload(); }
    catch (e) { setActionError(e instanceof Error ? e.message : 'Could not start the workflow'); }
    finally { setBusy(null); }
  }, [appId, reload]);

  const runAll = useCallback(async () => {
    setBusy('__all');
    setActionError(null);
    try { await appsApi.runAllAppWorkflows(appId); await reload(); }
    catch (e) { setActionError(e instanceof Error ? e.message : 'Could not start the pipeline'); }
    finally { setBusy(null); }
  }, [appId, reload]);

  const patchBinding = useCallback(async (wfId: string, patch: Record<string, unknown>) => {
    setActionError(null);
    try { await appsApi.updateWorkflowBinding(appId, wfId, patch); await reload(); }
    catch (e) { setActionError(e instanceof Error ? e.message : 'Could not update the rule'); }
  }, [appId, reload]);

  const icon = <Workflow size={14} />;
  const heading = title ?? 'Orchestration';
  if (error) return <PanelShell title={heading} icon={icon}><EmptyState label="Couldn't load workflows" hint={error} /></PanelShell>;
  if (workflows === null) return <PanelShell title={heading} icon={icon}><SkeletonRows /></PanelShell>;
  if (workflows.length === 0) return <PanelShell title={heading} icon={icon}><EmptyState label="No workflows yet" hint="Adopt or build a workflow to give this app logic." /></PanelShell>;

  const titleById = new Map(workflows.map((w) => [w.id, w.title]));
  const activeWfs = workflows.filter((w) => w.activeRun && isActiveRunStatus(w.activeRun.status));
  const running = activeWfs.filter((w) => (w.activeRun?.status ?? '').toUpperCase() === 'RUNNING').length;
  const waiting = activeWfs.length - running;

  return (
    <PanelShell
      title={heading}
      icon={icon}
      action={controls ? (
        <div className="flex items-center gap-2">
          {running > 0 ? (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-success-soft px-2.5 py-1 text-[11px] font-medium text-success">
              <span className="s-pulse h-1.5 w-1.5 rounded-full bg-success text-success" /> {running} running
            </span>
          ) : waiting > 0 ? (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-warn-soft px-2.5 py-1 text-[11px] font-medium text-warn">
              <span className="h-1.5 w-1.5 rounded-full bg-warn" /> {waiting} waiting
            </span>
          ) : null}
          <button
            type="button"
            onClick={() => void runAll()}
            disabled={busy !== null}
            className="inline-flex h-7 items-center gap-1.5 rounded-full bg-accent px-3 text-[12px] font-semibold text-on-accent transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {busy === '__all' ? <Loader2 size={13} className="animate-spin" /> : <Zap size={13} />} Run pipeline
          </button>
        </div>
      ) : undefined}
    >
      {actionError ? (
        <div className="mb-2 flex items-center gap-2 rounded-btn border border-danger/30 bg-danger-soft px-2.5 py-1.5 text-[11px] text-danger">
          <AlertTriangle size={12} /> {actionError}
        </div>
      ) : null}
      <div className="flex flex-col">
        {workflows.map((wf, i) => {
          const live = wf.activeRun && isActiveRunStatus(wf.activeRun.status) ? runTone(wf.activeRun.status) : null;
          const last = wf.lastRun ? runTone(wf.lastRun.status) : null;
          const rulesOpen = openRules === wf.id;
          return (
            <div key={wf.id} className={clsx(i > 0 && 'border-t border-line')}>
              <div className="flex items-center gap-3.5 py-3">
                <span className={clsx('h-2 w-2 shrink-0 rounded-full', live ? live.dot : wf.enabled === false ? 'bg-text-disabled' : last ? last.dot : 'bg-text-muted')} aria-hidden />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                    <span className={clsx('truncate text-[14px] font-medium', wf.enabled === false ? 'text-text-muted' : 'text-text-primary')}>{wf.title}</span>
                    {live ? (
                      <span className={clsx('inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium', live.chip)}>
                        <span className={clsx('h-1.5 w-1.5 rounded-full', live.dot)} /> {live.label}
                      </span>
                    ) : null}
                    {wf.schedule ? (
                      <span className="inline-flex items-center gap-1.5 rounded-full bg-surface-2 px-2 py-0.5 text-[11px] text-text-secondary" title={`cron: ${wf.schedule.cron}${wf.nextRunAt ? ` Â· next ${new Date(wf.nextRunAt).toLocaleString()}` : ''}`}>
                        <CalendarClock size={10} /> {cronHint(wf.schedule.cron)}
                      </span>
                    ) : wf.triggerKind && wf.triggerKind !== 'manual' ? (
                      <span className="inline-flex items-center gap-1.5 rounded-full bg-surface-2 px-2 py-0.5 text-[11px] text-text-secondary"><Zap size={10} /> {wf.triggerKind}</span>
                    ) : null}
                    {wf.dependsOn.length > 0 ? (
                      <span className="inline-flex items-center gap-1.5 rounded-full bg-surface-2 px-2 py-0.5 text-[11px] text-text-secondary" title={wf.dependsOn.map((id) => titleById.get(id) ?? id).join(', ')}>
                        <Link2 size={10} /> after {wf.dependsOn.map((id) => titleById.get(id) ?? '?').join(', ')}
                      </span>
                    ) : null}
                    {wf.concurrency === 'exclusive' ? <span className="rounded-full bg-surface-2 px-2 py-0.5 text-[11px] text-text-secondary">exclusive</span> : null}
                    {wf.enabled === false ? <span className="rounded-full border border-line px-2 py-0.5 text-[11px] text-text-muted">paused</span> : null}
                  </div>
                  {wf.purpose ? <div className="mt-1 truncate text-[12px] text-text-muted">{wf.purpose}</div> : null}
                </div>
                <span className="hidden shrink-0 text-right text-[12px] tabular-nums text-text-muted sm:inline" title={wf.lastRun ? `last: ${wf.lastRun.status}` : undefined}>
                  {wf.nextRunAt ? <>next {relativeFuture(wf.nextRunAt)}</> : wf.lastRun ? relativeTime(wf.lastRun.at) : 'never run'}
                </span>
                {controls ? (
                  <div className="flex shrink-0 items-center gap-1">
                    <button
                      type="button"
                      onClick={() => setOpenRules(rulesOpen ? null : wf.id)}
                      className={clsx('inline-flex h-7 w-7 items-center justify-center rounded-btn border transition-colors', rulesOpen ? 'border-accent/40 bg-accent-soft text-accent' : 'border-line text-text-secondary hover:bg-surface-2 hover:text-text-primary')}
                      title="Rules (schedule, chain, concurrency)"
                      aria-label={`Rules for ${wf.title}`}
                    >
                      <GitBranch size={13} />
                    </button>
                    <button
                      type="button"
                      onClick={() => void patchBinding(wf.id, { enabled: wf.enabled === false })}
                      className="inline-flex h-7 w-7 items-center justify-center rounded-btn border border-line text-text-secondary transition-colors hover:bg-surface-2 hover:text-text-primary"
                      title={wf.enabled === false ? 'Resume automation' : 'Pause automation'}
                      aria-label={`${wf.enabled === false ? 'Enable' : 'Pause'} ${wf.title}`}
                    >
                      {wf.enabled === false ? <Play size={13} /> : <Pause size={13} />}
                    </button>
                    <button
                      type="button"
                      disabled={busy === wf.id}
                      onClick={() => void run(wf.id)}
                      className="inline-flex h-7 items-center gap-1 rounded-btn border border-line px-2 text-[11px] font-medium text-text-secondary transition-colors hover:bg-surface-2 hover:text-text-primary disabled:opacity-50"
                      aria-label={`Run ${wf.title}`}
                    >
                      {busy === wf.id ? <Loader2 size={12} className="animate-spin" /> : <Play size={12} />} Run
                    </button>
                  </div>
                ) : null}
              </div>
              {rulesOpen && controls ? (
                <RulesEditor
                  workflow={wf}
                  siblings={workflows.filter((s) => s.id !== wf.id)}
                  onPatch={(patch) => void patchBinding(wf.id, patch)}
                />
              ) : null}
            </div>
          );
        })}
      </div>
    </PanelShell>
  );
}

function relativeFuture(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const s = Math.floor((t - Date.now()) / 1000);
  if (s <= 0) return 'now';
  if (s < 3600) return `in ${Math.max(1, Math.floor(s / 60))}m`;
  if (s < 86400) return `in ${Math.floor(s / 3600)}h`;
  return `in ${Math.floor(s / 86400)}d`;
}

/** Inline rule editor: schedule preset/custom cron, depends-on chain, concurrency, chain trigger. */
function RulesEditor({ workflow, siblings, onPatch }: {
  workflow: AppWorkflowSummary;
  siblings: AppWorkflowSummary[];
  onPatch: (patch: Record<string, unknown>) => void;
}) {
  const currentCron = workflow.schedule?.cron ?? null;
  const isPreset = SCHEDULE_PRESETS.some((p) => p.cron === currentCron);
  const [customCron, setCustomCron] = useState(isPreset ? '' : currentCron ?? '');
  const select = 'h-8 rounded-btn border border-line bg-canvas px-2.5 text-[12.5px] text-text-primary outline-none focus:border-accent/50';
  const label = 's-label';

  return (
    <div className="mb-2.5 grid gap-3 rounded-btn border border-line bg-canvas/60 p-3 sm:grid-cols-2 lg:grid-cols-4">
      <div className="flex flex-col gap-1">
        <span className={label}>Schedule</span>
        <select
          className={select}
          value={isPreset ? (currentCron ?? '') : '__custom'}
          onChange={(e) => {
            const v = e.target.value;
            if (v === '__custom') return; // custom edited below
            onPatch({ schedule: v ? { cron: v, enabled: true } : null });
          }}
        >
          {SCHEDULE_PRESETS.map((p) => <option key={p.label} value={p.cron ?? ''}>{p.label}</option>)}
          <option value="__custom">Custom cronâ€¦</option>
        </select>
        {!isPreset || customCron ? (
          <div className="flex items-center gap-1">
            <input
              className={clsx(select, 'w-full font-mono')}
              placeholder="*/30 * * * *"
              value={customCron}
              onChange={(e) => setCustomCron(e.target.value)}
            />
            <button
              type="button"
              className="inline-flex h-7 items-center rounded-btn border border-line px-2 text-[11px] text-text-secondary hover:bg-surface-2 hover:text-text-primary"
              onClick={() => onPatch({ schedule: customCron.trim() ? { cron: customCron.trim(), enabled: true } : null })}
            >
              Set
            </button>
          </div>
        ) : null}
      </div>
      <div className="flex flex-col gap-1">
        <span className={label}>Runs after</span>
        <div className="flex flex-col gap-1 overflow-auto" style={{ maxHeight: 96 }}>
          {siblings.length === 0 ? <span className="text-[11px] text-text-muted">No sibling workflows</span> : siblings.map((s) => {
            const checked = workflow.dependsOn.includes(s.id);
            return (
              <label key={s.id} className="flex cursor-pointer items-center gap-2 text-[12.5px] text-text-secondary">
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => onPatch({ dependsOn: checked ? workflow.dependsOn.filter((id) => id !== s.id) : [...workflow.dependsOn, s.id] })}
                  className="h-3 w-3 accent-[var(--color-accent)]"
                />
                <span className="truncate">{s.title}</span>
              </label>
            );
          })}
        </div>
      </div>
      <div className="flex flex-col gap-1">
        <span className={label}>Chain fires</span>
        <select className={select} value={workflow.chainOn} onChange={(e) => onPatch({ chainOn: e.target.value })}>
          <option value="success">After success only</option>
          <option value="always">On any settle</option>
        </select>
      </div>
      <div className="flex flex-col gap-1">
        <span className={label}>Concurrency</span>
        <select className={select} value={workflow.concurrency} onChange={(e) => onPatch({ concurrency: e.target.value })}>
          <option value="parallel">Parallel starts OK</option>
          <option value="exclusive">One run at a time</option>
        </select>
      </div>
    </div>
  );
}

// â”€â”€ RunMonitor â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export function RunMonitorView({ appId, title, workflowIds, limit = 8, controls = true }: {
  appId: string; title?: string; workflowIds?: string[]; limit?: number; controls?: boolean;
}) {
  const { workflows } = useAppWorkflows(appId);
  const idSet = useMemo(() => {
    const all = new Set((workflows ?? []).map((w) => w.id));
    if (!workflowIds || workflowIds.length === 0) return all;
    return new Set(workflowIds.filter((id) => all.has(id)));
  }, [workflows, workflowIds]);
  const { runs, loading, reload } = useAppRuns(idSet, limit);
  const [expanded, setExpanded] = useState<string | null>(null);
  const titleById = useMemo(() => new Map((workflows ?? []).map((w) => [w.id, w.title])), [workflows]);

  const icon = <Activity size={14} />;
  const heading = title ?? 'Runs';
  if (workflows === null || (loading && runs.length === 0)) return <PanelShell title={heading} icon={icon}><SkeletonRows /></PanelShell>;
  if (runs.length === 0) return <PanelShell title={heading} icon={icon}><EmptyState label="No runs yet" hint="Start a workflow from the orchestration panel â€” every run shows up here, live." /></PanelShell>;

  return (
    <PanelShell title={heading} icon={icon} action={<LiveDot />}>
      <div className="flex flex-col">
        {runs.map((run, i) => {
          const tone = runTone(run.status);
          const active = isActiveRunStatus(run.status);
          const progress = run.totalSteps && run.stepIndex != null ? Math.min(1, run.stepIndex / run.totalSteps) : null;
          const open = expanded === run.id;
          return (
            <div key={run.id} className={clsx(i > 0 && 'border-t border-line')}>
              <button
                type="button"
                onClick={() => setExpanded(open ? null : run.id)}
                className="flex w-full items-center gap-3.5 py-3 text-left"
                aria-expanded={open}
              >
                <span className={clsx('h-2 w-2 shrink-0 rounded-full', tone.dot)} aria-hidden />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-[14px] font-medium text-text-primary">{run.workflowName ?? titleById.get(run.workflowId) ?? 'Workflow'}</span>
                    <span className={clsx('rounded-full px-2 py-0.5 text-[11px] font-medium', tone.chip)}>{tone.label}</span>
                  </div>
                  <div className="mt-1 flex items-center gap-2.5 text-[12px] text-text-muted">
                    {active && run.currentStep ? <span className="truncate">{run.currentStep}</span> : null}
                    {!active && run.failureReason ? <span className="truncate text-danger/80">{run.failureReason}</span> : null}
                    {run.totalSteps ? <span className="shrink-0 tabular-nums">{Math.min(run.stepIndex ?? 0, run.totalSteps)}/{run.totalSteps}</span> : null}
                    <span className="shrink-0"><Elapsed startedAt={run.startedAt} done={run.completedAt} /></span>
                    <span className="shrink-0">{relativeTime(run.startedAt)}</span>
                  </div>
                  {progress !== null && active ? (
                    <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-surface-2">
                      <div className="h-full rounded-full bg-success transition-[width] duration-500" style={{ width: `${Math.round(progress * 100)}%` }} />
                    </div>
                  ) : null}
                </div>
                {controls && active ? (
                  <span className="flex shrink-0 items-center gap-1" onClick={(e) => e.stopPropagation()} role="presentation">
                    {run.status.toUpperCase() === 'PAUSED' ? (
                      <RunControl title="Resume" onClick={() => opsApi.resumeRun(run.id).then(reload)}><Play size={12} /></RunControl>
                    ) : (
                      <RunControl title="Pause" onClick={() => opsApi.pauseRun(run.id).then(reload)}><Pause size={12} /></RunControl>
                    )}
                    <RunControl title="Cancel" danger onClick={() => opsApi.cancelRun(run.id).then(reload)}><X size={12} /></RunControl>
                  </span>
                ) : null}
                <span className="shrink-0 text-text-muted">{open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</span>
              </button>
              {open ? <RunActivityFeed runId={run.id} /> : null}
            </div>
          );
        })}
      </div>
    </PanelShell>
  );
}

function RunControl({ title, danger, onClick, children }: { title: string; danger?: boolean; onClick: () => Promise<unknown> | void; children: React.ReactNode }) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      disabled={busy}
      onClick={async () => { setBusy(true); try { await onClick(); } finally { setBusy(false); } }}
      className={clsx(
        'inline-flex h-6 w-6 items-center justify-center rounded-btn border border-line transition-colors disabled:opacity-50',
        danger ? 'text-text-secondary hover:border-danger/40 hover:bg-danger-soft hover:text-danger' : 'text-text-secondary hover:bg-surface-2 hover:text-text-primary',
      )}
    >
      {busy ? <Loader2 size={11} className="animate-spin" /> : children}
    </button>
  );
}

function LiveDot() {
  return (
    <span className="inline-flex items-center gap-1.5 text-[11px] font-medium text-success">
      <span className="s-pulse h-1.5 w-1.5 rounded-full bg-success text-success" /> live
    </span>
  );
}

/** Expanded run row â†’ the run's live reasoning/steps feed (backfilled). */
function RunActivityFeed({ runId }: { runId: string }) {
  const feed = useRunActivity(runId, { cap: 40 });
  return (
    <div className="mb-2.5 max-h-64 overflow-auto rounded-btn border border-line bg-canvas/70">
      {feed.length === 0 ? (
        <div className="px-3 py-4 text-center text-[11px] text-text-muted">Waiting for activityâ€¦</div>
      ) : (
        <ul className="divide-y divide-line/60">
          {feed.map((item) => <ActivityRow key={item.id} item={item} />)}
        </ul>
      )}
    </div>
  );
}

// â”€â”€ AgentFeed â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const FEED_ICON: Record<string, React.ReactNode> = {
  run: <Workflow size={12} />,
  node: <CircleDot size={12} />,
  agent: <Bot size={12} />,
  tool: <Wrench size={12} />,
  message: <Brain size={12} />,
  task: <Check size={12} />,
  approval: <ShieldCheck size={12} />,
  status: <Activity size={12} />,
  progress: <ArrowDownToLine size={12} />,
};

const FEED_TONE: Record<string, string> = {
  accent: 'text-accent',
  success: 'text-success',
  warn: 'text-warn',
  danger: 'text-danger',
  muted: 'text-text-muted',
};

function ActivityRow({ item }: { item: RealtimeActivity }) {
  return (
    <li className="flex items-start gap-2 px-3 py-2">
      <span className={clsx('mt-0.5 shrink-0', FEED_TONE[item.tone] ?? 'text-text-muted')}>{FEED_ICON[item.kind] ?? <Activity size={12} />}</span>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="truncate text-[13px] font-medium text-text-primary">{item.title}</span>
          {item.agentName ? <span className="shrink-0 rounded bg-surface-2 px-1.5 py-px text-[10px] uppercase tracking-wide text-text-muted">{item.agentName}</span> : null}
          <span className="ml-auto shrink-0 text-[11px] tabular-nums text-text-muted">{relativeTime(item.at)}</span>
        </div>
        {item.detail ? <div className="mt-1 whitespace-pre-wrap break-words text-[12px] leading-relaxed text-text-secondary">{item.detail}</div> : null}
      </div>
    </li>
  );
}

export function AgentFeedView({ appId, title, limit = 30 }: { appId: string; title?: string; limit?: number }) {
  const { workflows } = useAppWorkflows(appId);
  const idSet = useMemo(() => new Set((workflows ?? []).map((w) => w.id)), [workflows]);
  const { runs } = useAppRuns(idSet, 4);
  // Follow the most relevant run: newest ACTIVE one, else the most recent.
  const focus = useMemo(() => runs.find((r) => isActiveRunStatus(r.status)) ?? runs[0] ?? null, [runs]);
  const feed = useRunActivity(focus?.id, { cap: limit });

  const icon = <Brain size={14} />;
  const heading = title ?? 'Agent activity';
  if (workflows === null) return <PanelShell title={heading} icon={icon}><SkeletonRows /></PanelShell>;
  if (!focus) return <PanelShell title={heading} icon={icon}><EmptyState label="Nothing to watch yet" hint="When a workflow runs, the agents' reasoning and tool calls stream here in real time." /></PanelShell>;

  return (
    <PanelShell
      title={heading}
      icon={icon}
      action={(
        <span className="flex items-center gap-2">
          <span className="max-w-[160px] truncate rounded bg-surface-2 px-1.5 py-0.5 text-[10px] text-text-secondary">{focus.workflowName ?? 'run'}</span>
          {isActiveRunStatus(focus.status) ? <LiveDot /> : <span className="text-[10px] text-text-muted">{runTone(focus.status).label}</span>}
        </span>
      )}
    >
      {feed.length === 0 ? (
        <div className="px-1 py-5 text-center text-[11px] text-text-muted">Waiting for the agentâ€¦</div>
      ) : (
        <ul className="-mx-1 max-h-[420px] divide-y divide-line/60 overflow-auto">
          {feed.map((item) => <ActivityRow key={item.id} item={item} />)}
        </ul>
      )}
    </PanelShell>
  );
}

// â”€â”€ ApprovalsInbox â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export function ApprovalsInboxView({ appId, title, limit = 10 }: { appId: string; title?: string; limit?: number }) {
  const { workflows } = useAppWorkflows(appId);
  const idSet = useMemo(() => new Set((workflows ?? []).map((w) => w.id)), [workflows]);
  const { runs } = useAppRuns(idSet, 100);
  const runIds = useMemo(() => new Set(runs.map((r) => r.id)), [runs]);
  const [approvals, setApprovals] = useState<ApprovalRequest[] | null>(null);
  const [selectedApproval, setSelectedApproval] = useState<ApprovalReview | null>(null);

  const reload = useCallback(() => {
    opsApi.listApprovals().then(setApprovals).catch(() => setApprovals([]));
  }, []);
  useEffect(() => { reload(); }, [reload]);
  useRealtime(useMemo(() => [REALTIME_EVENTS.APPROVAL_REQUESTED, REALTIME_EVENTS.APPROVAL_RESOLVED], []), reload);

  const mine = useMemo(
    () => (approvals ?? []).filter((a) => !a.runId || runIds.has(a.runId)).slice(0, limit),
    [approvals, runIds, limit],
  );

  const icon = <ShieldCheck size={14} />;
  const heading = title ?? 'Approvals';
  if (approvals === null || workflows === null) return <PanelShell title={heading} icon={icon}><SkeletonRows /></PanelShell>;
  if (mine.length === 0) return <PanelShell title={heading} icon={icon}><EmptyState label="Nothing waiting on you" hint="Human gates from this app's workflows land here for one-click approve / reject." /></PanelShell>;

  return (
    <PanelShell title={heading} icon={icon} action={<span className="rounded-full bg-warn-soft px-2.5 py-1 text-[11px] font-medium text-warn">{mine.length} pending</span>}>
      <div className="flex flex-col gap-2">
        {mine.map((a) => (
          <ApprovalPreviewCard
            key={a.id}
            approval={a}
            onReview={setSelectedApproval}
          />
        ))}
      </div>
      <ApprovalReviewModal
        approval={selectedApproval}
        open={Boolean(selectedApproval)}
        onClose={() => setSelectedApproval(null)}
        onResolved={() => reload()}
      />
    </PanelShell>
  );
}

// â”€â”€ registrations (open block seam) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

registerBlock('OrchestrationPanel', (node) => {
  if (node.type !== 'OrchestrationPanel') return null;
  return <OrchestrationPanelBlock title={node.title} controls={node.controls} />;
});

// WorkflowControl (E0/E3) is superseded â€” alias it to the OrchestrationPanel so
// every existing surface upgrades in place. (Overrides the built-in registered
// by ViewRenderer: last registration wins on the open seam.)
registerBlock('WorkflowControl', (node) => {
  if (node.type !== 'WorkflowControl') return null;
  return <OrchestrationPanelBlock title={node.title} />;
});

registerBlock('RunMonitor', (node) => {
  if (node.type !== 'RunMonitor') return null;
  return <RunMonitorBlock title={node.title} workflowIds={node.workflowIds} limit={node.limit} controls={node.controls} />;
});

registerBlock('AgentFeed', (node) => {
  if (node.type !== 'AgentFeed') return null;
  return <AgentFeedBlock title={node.title} limit={node.limit} />;
});

registerBlock('ApprovalsInbox', (node) => {
  if (node.type !== 'ApprovalsInbox') return null;
  return <ApprovalsInboxBlock title={node.title} limit={node.limit} />;
});

// Thin runtime-context adapters: blocks read the appId from the runtime, the
// shared *View components take it as a prop (so the ops drawer can reuse them).
function OrchestrationPanelBlock(props: { title?: string; controls?: boolean }) {
  const { appId } = useRuntime();
  return <OrchestrationPanelView appId={appId} {...props} />;
}
function RunMonitorBlock(props: { title?: string; workflowIds?: string[]; limit?: number; controls?: boolean }) {
  const { appId } = useRuntime();
  return <RunMonitorView appId={appId} {...props} />;
}
function AgentFeedBlock(props: { title?: string; limit?: number }) {
  const { appId } = useRuntime();
  return <AgentFeedView appId={appId} {...props} />;
}
function ApprovalsInboxBlock(props: { title?: string; limit?: number }) {
  const { appId } = useRuntime();
  return <ApprovalsInboxView appId={appId} {...props} />;
}


