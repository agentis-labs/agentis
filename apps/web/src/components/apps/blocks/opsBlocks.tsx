/**
 * Live-operations blocks (APP-INTERFACE-10X §2.2/§2.3) — the agentic heartbeat
 * of an App Interface, registered on the open block seam:
 *
 *   OrchestrationPanel — multi-workflow control BY RULE: live status, schedule /
 *                        depends-on / concurrency editing, enable-pause, run-all.
 *   RunMonitor         — the App's runs, live: pulse, node progress, elapsed,
 *                        cancel/pause/resume, expandable per-run activity.
 *   AgentFeed          — watch the agents think: reasoning/tool/node stream.
 *   ApprovalsInbox     — pending human gates, approve/deny inline.
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
  CircleDot, GitBranch, Link2, Loader2, Pause, Play, Power, Radio, ShieldCheck, Workflow, Wrench, X, Zap,
} from 'lucide-react';
import type { AppWorkflowSummary } from '@agentis/core';
import { REALTIME_EVENTS } from '@agentis/core';
import { appsApi, type AppCompileReport, type AppDoctorReport, type AppOrchestrationRule } from '../../../lib/appsApi';
import { opsApi, isActiveRunStatus, type ApprovalRequest, type RunSummary } from '../../../lib/opsApi';
import { rtSubscribe, useRealtime, useRealtimeStatus, type RealtimeEnvelope } from '../../../lib/realtime';
import { useRunActivity } from '../../../lib/useRunActivity';
import type { RealtimeActivity } from '../../../lib/realtimeActivity';
import { ApprovalPreviewCard, ApprovalReviewModal, type ApprovalReview } from '../../shared/ApprovalReviewModal';
import { registerBlock } from './registry';
import { OrchestrationRuleControlPlane } from './OrchestrationRuleEditor';
import { EmptyState, PanelShell, SkeletonRows, relativeTime, useRuntime } from '../ViewRenderer';

// ── shared: live app workflows ────────────────────────────────

const RUN_EVENTS = [
  REALTIME_EVENTS.RUN_CREATED, REALTIME_EVENTS.RUN_RUNNING, REALTIME_EVENTS.RUN_PAUSED,
  REALTIME_EVENTS.RUN_CANCELLED, REALTIME_EVENTS.RUN_COMPLETED, REALTIME_EVENTS.RUN_FAILED,
  REALTIME_EVENTS.RUN_RECOVERED, REALTIME_EVENTS.RUN_QUEUED, REALTIME_EVENTS.RUN_DEQUEUED,
];

// Structural changes an AGENT can make to the App's control plane — a workflow
// created/deleted, or its binding (run order / dependsOn chaining) rewritten via
// agentis.workflow.chain, or the App itself updated. Without live-reacting to
// these, the agent's delete/reorder is invisible until a manual page refresh.
const STRUCTURE_EVENTS = [
  REALTIME_EVENTS.WORKFLOW_CREATED, REALTIME_EVENTS.WORKFLOW_UPDATED, REALTIME_EVENTS.WORKFLOW_DELETED,
  REALTIME_EVENTS.APP_UPDATED, REALTIME_EVENTS.APP_DELETED,
];

/**
 * Hold a workspace realtime-room subscription while mounted — run status events
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
  const bump = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => { void reload(); }, 400);
  }, [reload]);
  useRealtime(RUN_EVENTS, (env: RealtimeEnvelope) => {
    const wfId = (env.payload as { workflowId?: string } | undefined)?.workflowId;
    if (!wfId || !idsRef.current.has(wfId)) return;
    bump();
  });
  // Refresh when the agent restructures this App: a workflow deleted/created, the
  // run order (dependsOn) rewritten, or the App updated. Match by our appId or one
  // of our workflow ids so an unrelated App's change never triggers a reload.
  useRealtime(STRUCTURE_EVENTS, (env: RealtimeEnvelope) => {
    const p = env.payload as { appId?: string; workflowId?: string } | undefined;
    const pertains = (p?.appId != null && p.appId === appId) || (p?.workflowId != null && idsRef.current.has(p.workflowId));
    if (pertains) bump();
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

// ── shared: presentation ──────────────────────────────────────

function runTone(status: string, outcome?: string | null, verified?: boolean): { chip: string; dot: string; label: string } {
  const s = status.toUpperCase();
  if (s === 'RUNNING') return { chip: 'bg-success-soft text-success', dot: 'bg-success s-pulse text-success', label: 'running' };
  if (s === 'WAITING' || s === 'PAUSED') return { chip: 'bg-warn-soft text-warn', dot: 'bg-warn', label: s.toLowerCase() };
  if (s === 'CREATED' || s === 'PLANNING' || s === 'QUEUED') return { chip: 'bg-warn-soft text-warn', dot: 'bg-warn', label: s.toLowerCase() };
  if (s === 'COMPLETED' && verified && outcome !== 'accomplished') {
    return { chip: 'bg-danger-soft text-danger', dot: 'bg-danger', label: `not accomplished · ${outcome ?? 'missing verdict'}` };
  }
  if (s === 'COMPLETED' && outcome === 'accomplished') return { chip: 'bg-success-soft text-success', dot: 'bg-success', label: 'accomplished' };
  if (s === 'COMPLETED') return { chip: 'bg-warn-soft text-warn', dot: 'bg-warn', label: 'completed · unverified' };
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
    if (dom !== '*' && /^\d+$/.test(dom)) return `day ${dom} · ${pad(h)}:${pad(m)}`;
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

// ── OrchestrationPanel ────────────────────────────────────────

export function OrchestrationPanelView({ appId, title, controls = true }: { appId: string; title?: string; controls?: boolean }) {
  const { workflows, error, reload } = useAppWorkflows(appId);
  const [busy, setBusy] = useState<string | null>(null);
  const [openRules, setOpenRules] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [doctor, setDoctor] = useState<AppDoctorReport | null>(null);
  const [compiler, setCompiler] = useState<AppCompileReport | null>(null);
  const [eventRules, setEventRules] = useState<AppOrchestrationRule[]>([]);
  const orchestrationRevision = JSON.stringify((workflows ?? []).map((workflow) => ({
    id: workflow.id,
    enabled: workflow.enabled,
    operatorEntrypoint: workflow.operatorEntrypoint,
    dependsOn: workflow.dependsOn,
    triggerKind: workflow.triggerKind,
    deployment: workflow.deployment?.status ?? null,
  })));

  const refreshOrchestration = useCallback(async () => {
    const [report, compile, rules] = await Promise.all([appsApi.doctor(appId), appsApi.compile(appId), appsApi.orchestrationRules(appId)]);
    setDoctor(report ?? null);
    setCompiler(compile ?? null);
    setEventRules(Array.isArray(rules) ? rules : []);
  }, [appId]);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([appsApi.doctor(appId), appsApi.compile(appId), appsApi.orchestrationRules(appId)])
      .then(([report, compile, rules]) => {
        if (cancelled) return;
        setDoctor(report ?? null);
        setCompiler(compile ?? null);
        setEventRules(Array.isArray(rules) ? rules : []);
      })
      .catch(() => {
        if (!cancelled) {
          setDoctor(null);
          setCompiler(null);
          setEventRules([]);
        }
      });
    return () => { cancelled = true; };
  }, [appId, orchestrationRevision]);

  const run = useCallback(async (wfId: string) => {
    setBusy(wfId);
    setActionError(null);
    try { await appsApi.runAppWorkflow(appId, wfId); await reload(); }
    catch (e) { setActionError(e instanceof Error ? e.message : 'Could not start the workflow'); }
    finally { setBusy(null); }
  }, [appId, reload]);

  const runPipeline = useCallback(async () => {
    setBusy('__pipeline');
    setActionError(null);
    try {
      await appsApi.runAllAppWorkflows(appId, 'continue');
      await reload();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : 'Could not continue the pipeline');
    } finally {
      setBusy(null);
    }
  }, [appId, reload]);

  const patchBinding = useCallback(async (wfId: string, patch: Record<string, unknown>) => {
    setActionError(null);
    try { await appsApi.updateWorkflowBinding(appId, wfId, patch); await reload(); }
    catch (e) { setActionError(e instanceof Error ? e.message : 'Could not update the rule'); }
  }, [appId, reload]);

  // ── Always-on lifecycle: arm/disarm unattended triggers ──────
  const [deployBusy, setDeployBusy] = useState<string | null>(null);

  const armApp = useCallback(async () => {
    setDeployBusy('__app'); setActionError(null);
    try {
      const { results } = await appsApi.activate(appId);
      const failed = results.filter((r) => r.outcome === 'blocked' || r.outcome === 'error');
      const armed = results.filter((r) => r.outcome === 'armed').length;
      if (failed.length > 0) {
        setActionError(`${armed} armed · ${failed.length} couldn't arm — ${failed[0]!.message ?? 'see workflow'}`);
      }
    } catch (e) { setActionError(e instanceof Error ? e.message : 'Could not go live'); }
    finally { setDeployBusy(null); await reload(); }
  }, [appId, reload]);

  const disarmApp = useCallback(async () => {
    setDeployBusy('__app'); setActionError(null);
    try { await appsApi.deactivate(appId); }
    catch (e) { setActionError(e instanceof Error ? e.message : 'Could not disarm'); }
    finally { setDeployBusy(null); await reload(); }
  }, [appId, reload]);

  const armWorkflow = useCallback(async (wfId: string) => {
    setDeployBusy(wfId); setActionError(null);
    try { await appsApi.armWorkflow(appId, wfId); }
    catch (e) { setActionError(e instanceof Error ? e.message : 'Could not arm this trigger'); }
    finally { setDeployBusy(null); await reload(); }
  }, [appId, reload]);

  const disarmWorkflow = useCallback(async (wfId: string) => {
    setDeployBusy(wfId); setActionError(null);
    try { await appsApi.disarmWorkflow(appId, wfId); }
    catch (e) { setActionError(e instanceof Error ? e.message : 'Could not disarm this trigger'); }
    finally { setDeployBusy(null); await reload(); }
  }, [appId, reload]);

  const icon = <Workflow size={14} />;
  const heading = title ?? 'Orchestration';
  const loadedWorkflows = workflows ?? [];
  const titleById = new Map(loadedWorkflows.map((w) => [w.id, w.title]));
  const activeWfs = loadedWorkflows.filter((w) => w.activeRun && isActiveRunStatus(w.activeRun.status));
  const operatorEntrypoints = loadedWorkflows.filter((workflow) => workflow.enabled && workflow.operatorEntrypoint);
  const running = activeWfs.filter((w) => (w.activeRun?.status ?? '').toUpperCase() === 'RUNNING').length;
  const waiting = activeWfs.length - running;
  // Always-on: workflows whose graph authors an unattended trigger (schedule / webhook / listener).
  const armable = loadedWorkflows.filter((w) => w.deployment);
  const armedCount = armable.filter((w) => w.deployment?.status === 'active').length;
  const listenerEvents = armable.reduce((sum, w) => {
    const h = w.deployment?.health as { eventCount?: number } | undefined;
    return sum + Number(h?.eventCount ?? 0);
  }, 0);
  const doctorTone = compiler?.ready
    ? 'bg-success-soft text-success border-success/30'
    : compiler?.readyForExecution ? 'bg-warn-soft text-warn border-warn/30'
      : compiler ? 'bg-danger-soft text-danger border-danger/30'
      : doctor?.health === 'healthy' ? 'bg-success-soft text-success border-success/30'
        : 'bg-warn-soft text-warn border-warn/30';

  useEffect(() => {
    if (activeWfs.length > 0 || actionError || openRules) setExpanded(true);
  }, [actionError, activeWfs.length, openRules]);

  if (error) return <PanelShell title={heading} icon={icon}><EmptyState label="Couldn't load workflows" hint={error} /></PanelShell>;
  if (workflows === null) return <PanelShell title={heading} icon={icon}><SkeletonRows /></PanelShell>;
  if (workflows.length === 0) return <PanelShell title={heading} icon={icon}><EmptyState label="No workflows yet" hint="Adopt or build a workflow to give this app logic." /></PanelShell>;

  return (
    <PanelShell
      title={heading}
      icon={icon}
      collapsed={!expanded}
      onToggle={() => setExpanded((value) => !value)}
      action={controls ? (
        <div className="flex items-center gap-2">
          <span className="hidden rounded-full bg-surface-2 px-2.5 py-1 text-[11px] font-medium text-text-muted sm:inline-flex">
            {workflows.length} {workflows.length === 1 ? 'workflow' : 'workflows'}
          </span>
          {running > 0 ? (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-success-soft px-2.5 py-1 text-[11px] font-medium text-success">
              <span className="s-pulse h-1.5 w-1.5 rounded-full bg-success text-success" /> {running} running
            </span>
          ) : waiting > 0 ? (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-warn-soft px-2.5 py-1 text-[11px] font-medium text-warn">
              <span className="h-1.5 w-1.5 rounded-full bg-warn" /> {waiting} waiting
            </span>
          ) : null}
          {armable.length > 0 ? (
            armedCount > 0 ? (
              <button
                type="button"
                onClick={() => void disarmApp()}
                disabled={deployBusy !== null}
                title={`${armedCount} of ${armable.length} triggers armed${listenerEvents > 0 ? ` · ${listenerEvents} events seen` : ''} — click to take offline`}
                className="inline-flex h-7 items-center gap-1.5 rounded-full bg-success-soft px-3 text-[12px] font-semibold text-success transition-opacity hover:opacity-90 disabled:opacity-50"
              >
                {deployBusy === '__app' ? <Loader2 size={13} className="animate-spin" /> : <span className="s-pulse h-2 w-2 rounded-full bg-success text-success" />}
                {armedCount === armable.length ? 'Live' : `Live ${armedCount}/${armable.length}`}
              </button>
            ) : (
              <button
                type="button"
                onClick={() => void armApp()}
                disabled={deployBusy !== null}
                title={`Arm ${armable.length} always-on ${armable.length === 1 ? 'trigger' : 'triggers'} so this app runs on its own`}
                className="inline-flex h-7 items-center gap-1.5 rounded-full border border-success/40 px-3 text-[12px] font-semibold text-success transition-colors hover:bg-success-soft disabled:opacity-50"
              >
                {deployBusy === '__app' ? <Loader2 size={13} className="animate-spin" /> : <Radio size={13} />} Go Live
              </button>
            )
          ) : null}
          {operatorEntrypoints.length > 0 ? (
            <button
              type="button"
              onClick={() => void runPipeline()}
              disabled={busy !== null || compiler?.readyForExecution === false}
              title={compiler?.readyForExecution === false ? compiler.summary : 'Continue from the first unresolved verified business stage'}
              className="inline-flex h-7 items-center gap-1.5 rounded-btn bg-accent px-3 text-[12px] font-semibold text-canvas transition-colors hover:bg-accent-hover disabled:opacity-50"
            >
              {busy === '__pipeline' ? <Loader2 size={13} className="animate-spin" /> : <Play size={13} />}
              Run Pipeline
            </button>
          ) : null}
          {compiler || doctor ? (
            <span
              className={clsx('inline-flex h-7 items-center gap-1.5 rounded-full border px-3 text-[11px] font-semibold', doctorTone)}
              title={compiler ? compiler.summary : doctor!.readyForUnattended ? 'All required orchestration layers are executable' : `${doctor!.summary.critical + doctor!.summary.error} blocking findings`}
            >
              {compiler?.ready ? <ShieldCheck size={13} /> : <AlertTriangle size={13} />}
              {compiler
                ? compiler.ready
                  ? 'Production ready'
                  : compiler.readyForExecution
                    ? `${compiler.evidencePendingCount} proof pending`
                    : `${compiler.executionBlockerCount} blockers`
                : doctor!.readyForUnattended ? 'Doctor ready' : `${doctor!.summary.critical + doctor!.summary.error} blockers`}
            </span>
          ) : null}
        </div>
      ) : undefined}
    >
      {actionError ? (
        <div className="mb-2 flex items-center gap-2 rounded-btn border border-danger/30 bg-danger-soft px-2.5 py-1.5 text-[11px] text-danger">
          <AlertTriangle size={12} /> {actionError}
        </div>
      ) : null}
      <OrchestrationRuleControlPlane
        appId={appId}
        workflows={loadedWorkflows}
        rules={eventRules}
        doctor={doctor}
        compiler={compiler}
        onChanged={refreshOrchestration}
      />
      <div className="flex flex-col">
        {workflows.map((wf, i) => {
          const live = wf.activeRun && isActiveRunStatus(wf.activeRun.status) ? runTone(wf.activeRun.status) : null;
          const last = wf.lastRun ? runTone(wf.lastRun.status, wf.lastRun.outcome, wf.lastRun.verified) : null;
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
                    ) : last ? (
                      <span className={clsx('inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium', last.chip)}>
                        <span className={clsx('h-1.5 w-1.5 rounded-full', last.dot)} /> {last.label}
                      </span>
                    ) : null}
                    {wf.deployment ? (
                      <TriggerStateChip deployment={wf.deployment} />
                    ) : wf.schedule ? (
                      <span className="inline-flex items-center gap-1.5 rounded-full bg-surface-2 px-2 py-0.5 text-[11px] text-text-secondary" title={`cron: ${wf.schedule.cron}${wf.nextRunAt ? ` · next ${new Date(wf.nextRunAt).toLocaleString()}` : ''}`}>
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
                    {!wf.operatorEntrypoint && wf.dependsOn.length === 0 ? <span className="rounded-full bg-info-soft px-2 py-0.5 text-[11px] text-info">event only</span> : null}
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
                    {wf.deployment ? (
                      wf.deployment.status === 'active' ? (
                        <button
                          type="button"
                          disabled={deployBusy === wf.id}
                          onClick={() => void disarmWorkflow(wf.id)}
                          className="inline-flex h-7 items-center gap-1 rounded-btn border border-success/40 bg-success-soft px-2 text-[11px] font-semibold text-success transition-colors hover:opacity-90 disabled:opacity-50"
                          title="Trigger is armed and listening — click to disarm"
                          aria-label={`Disarm ${wf.title}`}
                        >
                          {deployBusy === wf.id ? <Loader2 size={12} className="animate-spin" /> : <Power size={12} />} Disarm
                        </button>
                      ) : (
                        <button
                          type="button"
                          disabled={deployBusy === wf.id}
                          onClick={() => void armWorkflow(wf.id)}
                          className="inline-flex h-7 items-center gap-1 rounded-btn border border-success/40 px-2 text-[11px] font-semibold text-success transition-colors hover:bg-success-soft disabled:opacity-50"
                          title={wf.deployment.status === 'error' ? 'Trigger errored — click to re-arm' : 'Arm this trigger so it runs on its own'}
                          aria-label={`Arm ${wf.title}`}
                        >
                          {deployBusy === wf.id ? <Loader2 size={12} className="animate-spin" /> : <Radio size={12} />} Arm
                        </button>
                      )
                    ) : null}
                    <button
                      type="button"
                      disabled={busy === wf.id}
                      onClick={() => void run(wf.id)}
                      className="inline-flex h-7 items-center gap-1 rounded-btn border border-line px-2 text-[11px] font-medium text-text-secondary transition-colors hover:bg-surface-2 hover:text-text-primary disabled:opacity-50"
                      aria-label={`Run ${wf.title}${wf.deployment ? ' once now' : ''}`}
                      title={wf.deployment ? 'Run once now (a manual test run)' : undefined}
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

const TRIGGER_LABEL: Record<string, string> = {
  cron: 'schedule',
  webhook: 'webhook',
  persistent_listener: 'listener',
};

/** Always-on trigger state — how a workflow is armed, distinct from a one-off run. */
function TriggerStateChip({ deployment }: { deployment: NonNullable<AppWorkflowSummary['deployment']> }) {
  const kind = TRIGGER_LABEL[deployment.triggerType] ?? deployment.triggerType;
  const health = deployment.health as { eventCount?: number; connected?: boolean } | null | undefined;
  if (deployment.status === 'active') {
    const events = Number(health?.eventCount ?? 0);
    return (
      <span
        className="inline-flex items-center gap-1.5 rounded-full bg-success-soft px-2 py-0.5 text-[11px] font-medium text-success"
        title={`Armed ${kind}${events > 0 ? ` · ${events} events seen` : ''}`}
      >
        <span className="s-pulse h-1.5 w-1.5 rounded-full bg-success text-success" />
        {deployment.triggerType === 'persistent_listener' ? 'listening' : `${kind} armed`}
        {events > 0 ? <span className="tabular-nums opacity-70">· {events}</span> : null}
      </span>
    );
  }
  if (deployment.status === 'error') {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-danger-soft px-2 py-0.5 text-[11px] font-medium text-danger" title="Trigger failed to arm">
        <AlertTriangle size={10} /> {kind} error
      </span>
    );
  }
  // unarmed | paused
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full border border-line px-2 py-0.5 text-[11px] text-text-muted"
      title={deployment.status === 'unarmed' ? `${kind} trigger — not armed yet` : `${kind} trigger — paused`}
    >
      <Radio size={10} /> {deployment.status === 'unarmed' ? `${kind} · off` : `${kind} · paused`}
    </span>
  );
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
    <div className="mb-2.5 grid gap-3 rounded-btn border border-line bg-canvas/60 p-3 sm:grid-cols-2 lg:grid-cols-5">
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
          <option value="__custom">Custom cron…</option>
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
        <span className={label}>Run Pipeline</span>
        <select className={select} value={workflow.operatorEntrypoint ? 'operator' : 'event'} onChange={(e) => onPatch({ operatorEntrypoint: e.target.value === 'operator' })}>
          <option value="operator">Operator entrypoint</option>
          <option value="event">Event only</option>
        </select>
        <span className="text-[10.5px] leading-tight text-text-muted">Event-only roots wait for a rule, channel, listener, or schedule.</span>
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

// ── RunMonitor ────────────────────────────────────────────────

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
  if (runs.length === 0) return <PanelShell title={heading} icon={icon}><EmptyState label="No runs yet" hint="Start a workflow from the orchestration panel — every run shows up here, live." /></PanelShell>;

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
                  {active ? (
                    progress !== null ? (
                      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-surface-2">
                        <div className="h-full rounded-full bg-success transition-[width] duration-500" style={{ width: `${Math.round(progress * 100)}%` }} />
                      </div>
                    ) : (
                      // Indeterminate work in flight — a pulsing pending line (the "still
                      // working" heartbeat) when the step count is unknown.
                      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-surface-2">
                        <div className="h-full w-full animate-pulse rounded-full bg-success/50" />
                      </div>
                    )
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

/**
 * Honest liveness badge: green "live" only when the realtime link is actually up.
 * On fallback/reconnect it reads amber "reconnecting"; when the socket is down it
 * reads gray "offline" — the anti-dead-dashboard signal (a still-but-green panel
 * lies about being live). Truthful liveness, never a false pulse.
 */
function LiveDot() {
  const status = useRealtimeStatus();
  if (status === 'connected') {
    return (
      <span className="inline-flex items-center gap-1.5 text-[11px] font-medium text-success">
        <span className="s-pulse h-1.5 w-1.5 rounded-full bg-success text-success" /> live
      </span>
    );
  }
  if (status === 'disconnected') {
    return (
      <span className="inline-flex items-center gap-1.5 text-[11px] font-medium text-text-muted" title="The live link is down — this view may be stale.">
        <span className="h-1.5 w-1.5 rounded-full bg-text-disabled" /> offline
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 text-[11px] font-medium text-warn" title="Reconnecting to the live link…">
      <span className="s-pulse h-1.5 w-1.5 rounded-full bg-warn text-warn" /> reconnecting
    </span>
  );
}

/** Expanded run row → the run's live reasoning/steps feed (backfilled). */
function RunActivityFeed({ runId }: { runId: string }) {
  const feed = useRunActivity(runId, { cap: 40 });
  return (
    <div className="mb-2.5 max-h-64 overflow-auto rounded-btn border border-line bg-canvas/70">
      {feed.length === 0 ? (
        <div className="px-3 py-4 text-center text-[11px] text-text-muted">Waiting for activity…</div>
      ) : (
        <ul className="divide-y divide-line/60">
          {feed.map((item) => <ActivityRow key={item.id} item={item} />)}
        </ul>
      )}
    </div>
  );
}

// ── AgentFeed ─────────────────────────────────────────────────

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
        <div className="px-1 py-5 text-center text-[11px] text-text-muted">Waiting for the agent…</div>
      ) : (
        <ul className="-mx-1 max-h-[420px] divide-y divide-line/60 overflow-auto">
          {feed.map((item) => <ActivityRow key={item.id} item={item} />)}
        </ul>
      )}
    </PanelShell>
  );
}

// ── ApprovalsInbox ────────────────────────────────────────────

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

// ── registrations (open block seam) ───────────────────────────

registerBlock('OrchestrationPanel', (node) => {
  if (node.type !== 'OrchestrationPanel') return null;
  return <OrchestrationPanelBlock title={node.title} controls={node.controls} />;
});

// WorkflowControl (E0/E3) is superseded — alias it to the OrchestrationPanel so
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


