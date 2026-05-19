/**
 * AppDispatchSurface — the redesigned operator Surface
 * (docs/UIUX-refactor/SURFACE-PAGE-REDESIGN.md).
 *
 * App-aware, always-alive, approval-first. Layout:
 *   1. Domain status strip   — live status per declared domain
 *   2. Action inbox          — pending human decisions, top of page
 *   3. Work feed (70%)       — unified run + data + conversation timeline
 *   4. Signals panel (30%)   — auto-derived business metrics
 *
 * The operator talks to the app's own Brain (the thread); the workspace
 * Orchestrator is a small escape-hatch link, not the primary CTA.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import clsx from 'clsx';
import { REALTIME_EVENTS } from '@agentis/core';
import { api, streamSse } from '../../lib/api';
import { rtSubscribe, useRealtime, type RealtimeEnvelope } from '../../lib/realtime';
import { Skeleton } from '../shared/Skeleton';
import { useToast } from '../shared/Toast';
import { AppDomainStrip } from './AppDomainStrip';
import { AppActionInbox } from './AppActionInbox';
import { AppWorkFeed } from './AppWorkFeed';
import { AppSignalsPanel } from './AppSignalsPanel';
import { AppSetupChecklist } from './AppSetupChecklist';
import {
  asTime,
  normalizeRunStatus,
  type SurfaceApp,
  type SurfaceApproval,
  type SurfaceDomain,
  type SurfaceRecord,
  type SurfaceRun,
  type SurfaceSignal,
  type SurfaceIntentHealth,
  type SurfaceThreadMessage,
} from './appSurfaceShared';

const INITIAL_SKELETON_MS = 600;

interface PerformanceResponse {
  runCount: number;
  successRate: number;
  totalCost: number;
  pendingApprovals: SurfaceApproval[];
  recentRuns: SurfaceRun[];
  budget: {
    monthlyBudgetCents?: number | null;
    currentSpendCents: number;
    remainingCents?: number | null;
    usageRatio?: number | null;
    status: string;
  };
}

interface ThreadResponse {
  messages: SurfaceThreadMessage[];
}

interface SignalsResponse {
  signals: SurfaceSignal[];
  recentRecords: SurfaceRecord[];
}

interface IntentHealthResponse {
  health: SurfaceIntentHealth;
}

function sortRuns(runs: SurfaceRun[]): SurfaceRun[] {
  return [...runs].sort((a, b) => asTime(b.startedAt) - asTime(a.startedAt));
}

/**
 * When the app declares no domains, synthesize one card per workflow so the
 * status strip is still app-aware instead of empty.
 */
function effectiveDomains(app: SurfaceApp): SurfaceDomain[] {
  if (app.domains.length > 0) return app.domains;
  return app.workflows.slice(0, 6).map((wf) => ({
    id: `wf_${wf.id}`,
    name: wf.name,
    workflowIds: [wf.id],
  }));
}

export function AppDispatchSurface({
  app,
  onManage,
  onOpenCanvas,
  onOpenData,
}: {
  app: SurfaceApp;
  onManage: () => void;
  onOpenCanvas: () => void;
  onOpenData: (table?: string) => void;
}) {
  const nav = useNavigate();
  const toast = useToast();
  const mountedRef = useRef(true);

  const [runs, setRuns] = useState<SurfaceRun[]>([]);
  const [approvals, setApprovals] = useState<SurfaceApproval[]>([]);
  const [messages, setMessages] = useState<SurfaceThreadMessage[]>([]);
  const [signals, setSignals] = useState<SurfaceSignal[]>([]);
  const [records, setRecords] = useState<SurfaceRecord[]>([]);
  const [intentHealth, setIntentHealth] = useState<SurfaceIntentHealth | null>(app.intentHealth ?? null);
  const [budget, setBudget] = useState<PerformanceResponse['budget'] | null>(null);
  const [composerValue, setComposerValue] = useState('');
  const [sending, setSending] = useState(false);
  const [loading, setLoading] = useState(true);
  const [allowEmpty, setAllowEmpty] = useState(false);

  useEffect(() => () => {
    mountedRef.current = false;
  }, []);

  useEffect(() => {
    setIntentHealth(app.intentHealth ?? null);
  }, [app.id, app.intentHealth]);

  useEffect(() => {
    setAllowEmpty(false);
    const timer = window.setTimeout(() => setAllowEmpty(true), INITIAL_SKELETON_MS);
    return () => window.clearTimeout(timer);
  }, [app.slug]);

  const loadResults = useCallback(async () => {
    try {
      const data = await api<PerformanceResponse>(`/v1/apps/${app.slug}/results?window=30d`);
      if (!mountedRef.current) return;
      setRuns(sortRuns(data.recentRuns ?? []));
      setApprovals(data.pendingApprovals ?? []);
      setBudget(data.budget ?? null);
    } catch {
      if (mountedRef.current) {
        setRuns([]);
        setApprovals([]);
      }
    }
  }, [app.slug]);

  const loadThread = useCallback(async () => {
    try {
      const data = await api<ThreadResponse>(`/v1/apps/${app.slug}/thread`);
      if (mountedRef.current) setMessages(data.messages ?? []);
    } catch {
      if (mountedRef.current) setMessages([]);
    }
  }, [app.slug]);

  const loadSignals = useCallback(async () => {
    try {
      const data = await api<SignalsResponse>(`/v1/apps/${app.id}/data/signals`);
      if (!mountedRef.current) return;
      setSignals(data.signals ?? []);
      setRecords(data.recentRecords ?? []);
    } catch {
      if (mountedRef.current) {
        setSignals([]);
        setRecords([]);
      }
    }
  }, [app.id]);

  const loadIntentHealth = useCallback(async () => {
    try {
      const data = await api<IntentHealthResponse>(`/v1/apps/${app.slug}/health-summary`);
      if (mountedRef.current) setIntentHealth(data.health ?? null);
    } catch {
      if (mountedRef.current) setIntentHealth(app.intentHealth ?? null);
    }
  }, [app.slug, app.intentHealth]);

  useEffect(() => {
    setLoading(true);
    void Promise.all([loadResults(), loadThread(), loadSignals(), loadIntentHealth()]).finally(() => {
      if (mountedRef.current) setLoading(false);
    });
  }, [loadResults, loadThread, loadSignals, loadIntentHealth]);

  // Realtime rooms — entry workflow (thread + result events) and the app room
  // (Data layer + workflow-chain events).
  useEffect(() => {
    if (!app.entryWorkflowId) return;
    return rtSubscribe('workflow', { workflowId: app.entryWorkflowId });
  }, [app.entryWorkflowId]);

  useEffect(() => rtSubscribe('app', { appId: app.id }), [app.id]);

  const activeRunIds = useMemo(
    () => runs.filter((run) => normalizeRunStatus(run.status) === 'running').map((run) => run.id),
    [runs],
  );
  useEffect(() => {
    const unsubs = activeRunIds.map((runId) => rtSubscribe('run', { runId }));
    return () => unsubs.forEach((u) => u());
  }, [activeRunIds.join('|')]);

  useRealtime(
    [
      REALTIME_EVENTS.RUN_CREATED,
      REALTIME_EVENTS.RUN_RUNNING,
      REALTIME_EVENTS.RUN_COMPLETED,
      REALTIME_EVENTS.RUN_FAILED,
      REALTIME_EVENTS.APP_THREAD_MESSAGE_APPENDED,
      REALTIME_EVENTS.APP_RESULT_CREATED,
      REALTIME_EVENTS.DATA_RECORD_CHANGED,
      REALTIME_EVENTS.APP_WORKFLOW_COMPLETED,
      REALTIME_EVENTS.APP_WORKFLOW_FAILED,
    ],
    (env: RealtimeEnvelope) => {
      const payload = env.payload as Record<string, unknown>;

      if (env.event === REALTIME_EVENTS.APP_THREAD_MESSAGE_APPENDED) {
        if (payload.appId && payload.appId !== app.id) return;
        const msg = payload as unknown as SurfaceThreadMessage;
        setMessages((prev) => (prev.some((m) => m.id === msg.id) ? prev : [...prev, msg]));
        return;
      }

      if (env.event === REALTIME_EVENTS.APP_RESULT_CREATED) {
        if (payload.appId && payload.appId !== app.id) return;
        void loadSignals();
        return;
      }

      if (env.event === REALTIME_EVENTS.DATA_RECORD_CHANGED) {
        if (payload.appId !== app.id) return;
        const recordId = typeof payload.recordId === 'string' ? payload.recordId : '';
        const table = typeof payload.table === 'string' ? payload.table : '';
        const eventType = payload.event;
        if (eventType === 'delete') {
          setRecords((prev) => prev.filter((r) => !(r.table === table && r.recordId === recordId)));
          return;
        }
        const record = (payload.record as Record<string, unknown>) ?? {};
        const entry: SurfaceRecord = {
          table,
          recordId,
          record,
          createdAt: typeof record.created_at === 'string' ? record.created_at : new Date().toISOString(),
        };
        setRecords((prev) => [entry, ...prev.filter((r) => !(r.table === table && r.recordId === recordId))].slice(0, 24));
        void loadSignals();
        return;
      }

      if (env.event === REALTIME_EVENTS.APP_WORKFLOW_COMPLETED || env.event === REALTIME_EVENTS.APP_WORKFLOW_FAILED) {
        if (payload.appId && payload.appId !== app.id) return;
        void loadResults();
        void loadIntentHealth();
        return;
      }

      // Run lifecycle events.
      const runId = typeof payload.runId === 'string' ? payload.runId : null;
      const workflowId = typeof payload.workflowId === 'string' ? payload.workflowId : null;
      if (!runId) return;
      if (workflowId && app.entryWorkflowId && workflowId !== app.entryWorkflowId) return;

      if (env.event === REALTIME_EVENTS.RUN_CREATED || env.event === REALTIME_EVENTS.RUN_RUNNING) {
        const status = env.event === REALTIME_EVENTS.RUN_RUNNING
          ? normalizeRunStatus(typeof payload.status === 'string' ? payload.status : undefined)
          : 'pending';
        const startedAt = typeof payload.startedAt === 'string' ? payload.startedAt : new Date().toISOString();
        setRuns((prev) =>
          prev.some((r) => r.id === runId)
            ? prev.map((r) => (r.id === runId ? { ...r, status } : r))
            : sortRuns([{ id: runId, status, startedAt, workflowId: workflowId ?? undefined }, ...prev]),
        );
        return;
      }

      if (env.event === REALTIME_EVENTS.RUN_COMPLETED || env.event === REALTIME_EVENTS.RUN_FAILED) {
        const status = env.event === REALTIME_EVENTS.RUN_COMPLETED ? 'completed' : 'failed';
        setRuns((prev) =>
          sortRuns(
            prev.map((r) =>
              r.id === runId
                ? {
                    ...r,
                    status,
                    durationMs: typeof payload.durationMs === 'number' ? payload.durationMs : r.durationMs,
                    cost: typeof payload.cost === 'number' ? payload.cost : r.cost,
                  }
                : r,
            ),
          ),
        );
        void loadResults();
        void loadSignals();
        void loadIntentHealth();
      }
    },
  );

  const resolveApproval = useCallback(
    async (id: string, decision: 'approve' | 'reject') => {
      await api(`/v1/approvals/${id}/resolve`, {
        method: 'POST',
        body: JSON.stringify({ decision }),
      });
      setApprovals((prev) => prev.filter((a) => a.id !== id));
      toast.success(decision === 'approve' ? 'Approval recorded' : 'Rejection recorded');
    },
    [toast],
  );

  const cancelRun = useCallback(
    async (runId: string) => {
      try {
        await api(`/v1/runs/${runId}/cancel`, { method: 'POST' });
        toast.success('Run cancelled');
        setRuns((prev) => prev.map((r) => (r.id === runId ? { ...r, status: 'failed' } : r)));
      } catch (err) {
        toast.error('Could not cancel run', String(err));
      }
    },
    [toast],
  );

  const sendInstruction = useCallback(async () => {
    const text = composerValue.trim();
    if (!text || sending) return;
    setSending(true);
    try {
      await streamSse(
        `/v1/apps/${app.slug}/thread/send`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ body: text }),
        },
        {
          onEvent: (event, data) => {
            if (event === 'message') {
              const msg = data as SurfaceThreadMessage;
              setMessages((prev) => (prev.some((m) => m.id === msg.id) ? prev : [...prev, msg]));
            }
          },
        },
      );
      setComposerValue('');
    } catch (err) {
      toast.error('Could not send instruction', String(err));
    } finally {
      if (mountedRef.current) setSending(false);
    }
  }, [app.slug, composerValue, sending, toast]);

  const continueInWorkspace = useCallback(() => {
    const params = new URLSearchParams({ context: 'app', slug: app.slug, appName: app.name });
    nav(`/chat?${params.toString()}`);
  }, [app.name, app.slug, nav]);

  const openRun = useCallback((runId: string) => nav(`/runs/${runId}`), [nav]);

  const workflowNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const wf of app.workflows) map.set(wf.id, wf.name);
    return map;
  }, [app.workflows]);

  const finishedRuns = runs.filter((r) => {
    const s = normalizeRunStatus(r.status);
    return s === 'completed' || s === 'failed';
  });
  const successRate =
    finishedRuns.length > 0
      ? Math.round((finishedRuns.filter((r) => normalizeRunStatus(r.status) === 'completed').length / finishedRuns.length) * 100)
      : null;
  const runsToday = runs.filter((r) => Date.now() - asTime(r.startedAt) < 86_400_000).length;
  const triggerActive = app.triggers.some((t) => t.status === 'active');
  const showSetup = !loading && runs.length === 0 && messages.length === 0 && !triggerActive;

  if (loading && !allowEmpty) {
    return (
      <div className="space-y-4">
        <Skeleton height={96} />
        <Skeleton height={240} />
        <Skeleton height={180} />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <AppDomainStrip
        domains={effectiveDomains(app)}
        workflows={app.workflows}
        triggers={app.triggers}
        runs={runs}
      />

      <AppActionInbox approvals={approvals} onResolve={resolveApproval} />

      {showSetup ? (
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_300px]">
          <div className="space-y-4">
            <AppSetupChecklist app={app} onOpenCanvas={onOpenCanvas} onOpenConfig={onManage} />
            <AppWorkFeed
              appName={app.name}
              runs={[]}
              messages={messages}
              records={[]}
              dataTables={app.dataTables}
              workflowNameById={workflowNameById}
              composerValue={composerValue}
              sending={sending}
              onComposerChange={setComposerValue}
              onSend={sendInstruction}
              onContinueInWorkspace={continueInWorkspace}
              onOpenRun={openRun}
              onOpenDataTable={onOpenData}
              onCancelRun={cancelRun}
            />
          </div>
          <div className="space-y-4">
            <AppIntentHealthPanel health={intentHealth} onManage={onManage} />
            <AppSignalsPanel
              signals={signals}
              runsToday={runsToday}
              successRate={successRate}
              budget={budget ?? undefined}
              deployTarget={app.deployTarget}
              installedAt={app.installedAt}
              onOpenTable={onOpenData}
            />
          </div>
        </div>
      ) : (
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_300px]">
          <AppWorkFeed
            appName={app.name}
            runs={runs}
            messages={messages}
            records={records}
            dataTables={app.dataTables}
            workflowNameById={workflowNameById}
            composerValue={composerValue}
            sending={sending}
            onComposerChange={setComposerValue}
            onSend={sendInstruction}
            onContinueInWorkspace={continueInWorkspace}
            onOpenRun={openRun}
            onOpenDataTable={onOpenData}
            onCancelRun={cancelRun}
          />
          <div className="space-y-4">
            <AppIntentHealthPanel health={intentHealth} onManage={onManage} />
            <AppSignalsPanel
              signals={signals}
              runsToday={runsToday}
              successRate={successRate}
              budget={budget ?? undefined}
              deployTarget={app.deployTarget}
              installedAt={app.installedAt}
              onOpenTable={onOpenData}
            />
          </div>
        </div>
      )}
    </div>
  );
}

function AppIntentHealthPanel({ health, onManage }: { health: SurfaceIntentHealth | null; onManage: () => void }) {
  if (!health) return null;
  const tone = intentHealthTone(health.status);
  return (
    <section className="rounded-card border border-line bg-surface p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-wider text-text-muted">Intent health</div>
          <div className="mt-1 text-[15px] font-semibold text-text-primary">{intentHealthLabel(health.status)}</div>
        </div>
        <span className={clsx('rounded-pill px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider', tone)}>
          {health.status}
        </span>
      </div>
      <p className="mt-2 text-[12px] leading-relaxed text-text-secondary">{health.summary}</p>
      <div className="mt-3 grid grid-cols-3 gap-2">
        {health.signals.map((signal) => (
          <div key={signal.label} className="rounded-md border border-line/70 bg-surface-2 px-2 py-1.5">
            <div className="truncate text-[10px] uppercase tracking-wide text-text-muted">{signal.label}</div>
            <div className={clsx('mt-0.5 text-[13px] font-semibold', signalToneClass(signal.tone))}>{signal.value}</div>
          </div>
        ))}
      </div>
      {!health.intentPresent && (
        <button type="button" onClick={onManage} className="mt-3 text-[12px] font-medium text-accent hover:underline">
          Add intent
        </button>
      )}
      {health.intentPresent && health.driftCandidates.length > 0 && (
        <div className="mt-3 space-y-1.5">
          {health.driftCandidates.slice(0, 2).map((episode) => (
            <div key={episode.id} className="truncate text-[11px] text-text-muted">
              {Math.round(episode.similarity * 100)}% match - {episode.title}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function intentHealthLabel(status: SurfaceIntentHealth['status']): string {
  switch (status) {
    case 'aligned': return 'Runs match the saved intent';
    case 'watch': return 'Some runs need attention';
    case 'drifting': return 'Runs are drifting from intent';
    case 'learning': return 'Waiting for runtime memory';
    case 'unanchored': return 'Intent not set';
    default: return 'Intent health';
  }
}

function intentHealthTone(status: SurfaceIntentHealth['status']): string {
  switch (status) {
    case 'aligned': return 'bg-accent-soft text-accent';
    case 'watch': return 'bg-warn-soft text-warn';
    case 'drifting': return 'bg-danger-soft text-danger';
    default: return 'bg-surface-2 text-text-muted';
  }
}

function signalToneClass(tone: SurfaceIntentHealth['signals'][number]['tone']): string {
  switch (tone) {
    case 'good': return 'text-accent';
    case 'warn': return 'text-warn';
    case 'danger': return 'text-danger';
    default: return 'text-text-secondary';
  }
}
