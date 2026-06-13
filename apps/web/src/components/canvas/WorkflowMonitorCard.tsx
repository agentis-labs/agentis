import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Circle,
  Crosshair,
  Maximize2,
  Minimize2,
  RadioTower,
  Square,
  X,
} from 'lucide-react';
import clsx from 'clsx';
import { REALTIME_EVENTS } from '@agentis/core';
import { api } from '../../lib/api';
import { rtSubscribe, useRealtime, type RealtimeEnvelope } from '../../lib/realtime';
import {
  REALTIME_ACTIVITY_EVENTS,
  describeRealtimeActivity,
  type RealtimeActivity,
  type RealtimeActivityTone,
} from '../../lib/realtimeActivity';
import {
  refreshWorkspaceSnapshot,
  useWorkspaceData,
  type WorkspaceApproval,
} from '../../lib/workspaceData';

type MonitorMode = 'minimized' | 'expanded';
type MonitorStatus = 'idle' | 'running' | 'waiting' | 'completed' | 'failed';

const DEFAULT_VISIBLE_EVENTS = 4;

export function WorkflowMonitorCard({
  workflowId,
  workflowTitle,
  activeRunId,
  nodeTitles,
  onFocusNode,
  onOpenRun,
}: {
  workflowId: string;
  workflowTitle: string;
  activeRunId: string | null;
  nodeTitles: Map<string, string>;
  onFocusNode: (nodeId: string) => void;
  onOpenRun: () => void;
}) {
  const { workspaceId, approvals } = useWorkspaceData();
  const [mode, setMode] = useState<MonitorMode>(() => (activeRunId ? 'expanded' : 'minimized'));
  const [feed, setFeed] = useState<RealtimeActivity[]>([]);
  const [status, setStatus] = useState<MonitorStatus>(() => (activeRunId ? 'running' : 'idle'));
  const [trackedRunId, setTrackedRunId] = useState<string | null>(activeRunId);
  const [terminalKind, setTerminalKind] = useState<'run' | 'build' | null>(null);
  const [showEarlier, setShowEarlier] = useState(false);
  const [resolving, setResolving] = useState(false);
  const [stopping, setStopping] = useState(false);
  const previousRunId = useRef<string | null>(activeRunId);

  useEffect(() => {
    if (!activeRunId || activeRunId === previousRunId.current) return;
    previousRunId.current = activeRunId;
    setTrackedRunId(activeRunId);
    setFeed([]);
    setStatus('running');
    setTerminalKind(null);
    setMode('expanded');
    setShowEarlier(false);
  }, [activeRunId]);

  useEffect(() => {
    const unsubs: Array<() => void> = [];
    if (workspaceId) unsubs.push(rtSubscribe('workspace', { workspaceId }));
    if (activeRunId) unsubs.push(rtSubscribe('run', { runId: activeRunId }));
    else unsubs.push(rtSubscribe('workflow', { workflowId }));
    return () => unsubs.forEach((fn) => fn());
  }, [activeRunId, workflowId, workspaceId]);

  useRealtime([...REALTIME_ACTIVITY_EVENTS], (env) => {
    const activity = describeRealtimeActivity(env, {
      nodeTitle: (nodeId) => nodeTitles.get(nodeId),
    });
    if (!activity || !matchesWorkflowActivity(activity, workflowId, trackedRunId ?? activeRunId)) return;
    upsertActivity(setFeed, activity);
    updateMonitorStatus(env, setStatus, setTerminalKind);
    if (activity.runId) setTrackedRunId(activity.runId);
  });

  useEffect(() => {
    if (!activeRunId) return;
    let cancelled = false;
    void api<{ activity: Array<{ event: string; payload: Record<string, unknown>; emittedAt: string }> }>(
      `/v1/runs/${activeRunId}/activity`,
    )
      .then((res) => {
        if (cancelled) return;
        const historical = (res.activity ?? [])
          .map((env) => {
            updateMonitorStatus({ event: env.event, payload: env.payload }, setStatus, setTerminalKind);
            return describeRealtimeActivity(
              { event: env.event, payload: env.payload, emittedAt: env.emittedAt },
              { nodeTitle: (nodeId) => nodeTitles.get(nodeId) },
            );
          })
          .filter((activity): activity is RealtimeActivity => (
            Boolean(activity) && matchesWorkflowActivity(activity!, workflowId, activeRunId)
          ));
        setFeed(dedupeActivities(historical).reverse());
      })
      .catch(() => { /* historical activity is best-effort */ });
    return () => { cancelled = true; };
  }, [activeRunId, nodeTitles, workflowId]);

  const workflowApprovals = useMemo(
    () => approvals.filter((approval) => (
      approval.runId === (activeRunId ?? trackedRunId) || approval.workflowName === workflowTitle
    )),
    [activeRunId, approvals, trackedRunId, workflowTitle],
  );
  const topApproval = workflowApprovals[0] ?? null;

  useEffect(() => {
    if (topApproval && status === 'running') setStatus('waiting');
    if (!topApproval && status === 'waiting' && activeRunId) setStatus('running');
  }, [activeRunId, status, topApproval]);

  const displayFeed = (status === 'completed' || status === 'failed'
    ? feed.filter((item) => item.kind !== 'run')
    : feed
  ).filter((item) => !(
    terminalKind === 'build'
    && item.kind === 'agent'
    && /workflow ready|response ready|finished this turn/i.test(item.detail)
  ));
  const visibleFeed = showEarlier ? displayFeed : displayFeed.slice(0, DEFAULT_VISIBLE_EVENTS);
  const hiddenCount = Math.max(0, displayFeed.length - visibleFeed.length);
  const tone: RealtimeActivityTone = status === 'failed'
    ? 'danger'
    : status === 'completed'
      ? 'success'
      : status === 'waiting'
        ? 'warn'
        : status === 'running'
          ? 'accent'
          : 'muted';

  async function resolveApproval(approval: WorkspaceApproval, decision: 'approve' | 'reject') {
    setResolving(true);
    try {
      await api(`/v1/approvals/${approval.id}/resolve`, {
        method: 'POST',
        body: JSON.stringify({ decision }),
      });
      await refreshWorkspaceSnapshot();
    } finally {
      setResolving(false);
    }
  }

  async function stopRun() {
    if (!activeRunId || stopping) return;
    setStopping(true);
    try {
      await api(`/v1/runs/${activeRunId}/cancel`, { method: 'POST' });
      await refreshWorkspaceSnapshot();
    } catch (err) {
      console.warn('[agentis] failed to stop run from monitor', err);
    } finally {
      setStopping(false);
    }
  }

  const headerLabel = statusLabel(status, workflowTitle, terminalKind);
  const canControlRun = (status === 'running' || status === 'waiting')
    && Boolean(activeRunId)
    && terminalKind !== 'build';

  return (
    <section
      data-canvas-control
      data-testid="workflow-realtime-monitor"
      className={clsx(
        'pointer-events-auto w-full max-w-[360px] overflow-hidden rounded-xl border border-white/10 bg-canvas/90 text-text-primary',
        'shadow-[inset_0_1px_0_rgba(255,255,255,0.06),0_18px_45px_rgba(0,0,0,0.32)] backdrop-blur-xl',
        mode === 'minimized' && 'md:max-w-[300px]',
      )}
      aria-label="Workflow realtime monitor"
    >
      <header className={clsx('flex min-h-10 items-center gap-2 px-3 py-2', mode === 'expanded' && 'border-b border-white/10')}>
        <StatusIcon status={status} tone={tone} />
        <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-text-primary">{headerLabel}</span>
        {canControlRun && activeRunId && (
          <button
            type="button"
            onClick={() => void stopRun()}
            disabled={stopping}
            className="inline-flex h-6 w-6 items-center justify-center rounded text-text-muted transition hover:bg-danger-soft hover:text-danger active:scale-95 disabled:opacity-50"
            aria-label="Stop run"
            title="Stop run"
          >
            <Square size={11} />
          </button>
        )}
        {(activeRunId || trackedRunId) && terminalKind !== 'build' && (
          <button
            type="button"
            onClick={onOpenRun}
            className="inline-flex h-6 w-6 items-center justify-center rounded text-text-muted transition hover:bg-surface-2 hover:text-text-primary active:scale-95"
            aria-label="Open run drawer"
            title="Open run drawer"
          >
            <Maximize2 size={12} />
          </button>
        )}
        <button
          type="button"
          onClick={() => setMode((current) => current === 'expanded' ? 'minimized' : 'expanded')}
          className="inline-flex h-6 w-6 items-center justify-center rounded text-text-muted transition hover:bg-surface-2 hover:text-text-primary active:scale-95"
          aria-label={mode === 'expanded' ? 'Minimize monitor' : 'Expand monitor'}
        >
          {mode === 'expanded' ? <Minimize2 size={12} /> : <ChevronDown size={12} />}
        </button>
      </header>

      {mode === 'expanded' && (
        <div className="max-h-[min(440px,calc(100vh-190px))] overflow-y-auto px-3 py-2.5">
          {topApproval && (
            <div className="mb-3 border-l border-warn/60 pl-3">
              <div className="text-[12px] font-medium text-text-primary">
                {topApproval.agentName ?? 'Approval requested'}
              </div>
              <p className="mt-0.5 text-[11px] leading-4 text-text-muted">
                {topApproval.summary ?? topApproval.workflowName ?? 'This run needs an operator decision.'}
              </p>
              <div className="mt-2 flex gap-3 text-[11px]">
                <button
                  type="button"
                  disabled={resolving}
                  onClick={() => void resolveApproval(topApproval, 'approve')}
                  className="inline-flex items-center gap-1 font-medium text-accent hover:underline disabled:opacity-50"
                >
                  <Check size={11} /> Approve
                </button>
                <button
                  type="button"
                  disabled={resolving}
                  onClick={() => void resolveApproval(topApproval, 'reject')}
                  className="inline-flex items-center gap-1 font-medium text-danger hover:underline disabled:opacity-50"
                >
                  <X size={11} /> Reject
                </button>
              </div>
            </div>
          )}

          {visibleFeed.length === 0 ? (
            <div className="py-2 text-[11px] text-text-muted">
              {status === 'idle' ? 'No run activity yet.' : 'Waiting for the first activity.'}
            </div>
          ) : (
            <div className="space-y-2">
              {visibleFeed.map((item) => (
                <button
                  key={activityKey(item)}
                  type="button"
                  onClick={() => item.nodeId && onFocusNode(item.nodeId)}
                  disabled={!item.nodeId}
                  className={clsx(
                    'group flex w-full items-start gap-2 text-left',
                    !item.nodeId && 'cursor-default',
                  )}
                >
                  <ActivityDot tone={item.tone} active={status === 'running' && item === visibleFeed[0]} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className="min-w-0 flex-1 truncate text-[12px] text-text-secondary">
                        {item.nodeTitle ?? item.title}
                      </span>
                      {item.nodeId && (
                        <Crosshair size={11} className="shrink-0 text-text-muted opacity-0 transition-opacity group-hover:opacity-100" />
                      )}
                    </div>
                    {item.detail && (
                      <div className="mt-0.5 line-clamp-2 text-[10.5px] leading-4 text-text-muted">
                        {item.detail}
                      </div>
                    )}
                  </div>
                </button>
              ))}
            </div>
          )}

          {hiddenCount > 0 && (
            <button
              type="button"
              onClick={() => setShowEarlier(true)}
              className="mt-3 inline-flex items-center gap-1 text-[11px] text-text-muted transition-colors hover:text-text-secondary"
            >
              <ChevronUp size={11} />
              Show {hiddenCount} earlier event{hiddenCount === 1 ? '' : 's'}
            </button>
          )}
          {showEarlier && displayFeed.length > DEFAULT_VISIBLE_EVENTS && (
            <button
              type="button"
              onClick={() => setShowEarlier(false)}
              className="mt-3 inline-flex items-center gap-1 text-[11px] text-text-muted transition-colors hover:text-text-secondary"
            >
              <ChevronDown size={11} />
              Show latest only
            </button>
          )}
        </div>
      )}
    </section>
  );
}

function updateMonitorStatus(
  env: Pick<RealtimeEnvelope, 'event' | 'payload'>,
  setStatus: React.Dispatch<React.SetStateAction<MonitorStatus>>,
  setTerminalKind: React.Dispatch<React.SetStateAction<'run' | 'build' | null>>,
) {
  if (env.event === REALTIME_EVENTS.RUN_COMPLETED) {
    setTerminalKind('run');
    setStatus('completed');
    return;
  }
  if (env.event === REALTIME_EVENTS.RUN_FAILED) {
    setTerminalKind('run');
    setStatus('failed');
    return;
  }
  if (env.event === REALTIME_EVENTS.CANVAS_BUILD_COMPLETE) {
    setTerminalKind('build');
    setStatus('completed');
    return;
  }
  if (env.event === REALTIME_EVENTS.NODE_WAITING_FOR_INPUT || env.event === REALTIME_EVENTS.APPROVAL_REQUESTED) {
    setStatus('waiting');
    return;
  }
  if (
    env.event === REALTIME_EVENTS.RUN_CREATED
    || env.event === REALTIME_EVENTS.RUN_RUNNING
    || env.event === REALTIME_EVENTS.NODE_STARTED
    || env.event === REALTIME_EVENTS.AGENT_WORK_STEP
  ) {
    setStatus((current) => current === 'completed' || current === 'failed' ? current : 'running');
  }
}

function upsertActivity(
  setFeed: React.Dispatch<React.SetStateAction<RealtimeActivity[]>>,
  activity: RealtimeActivity,
) {
  const key = activityKey(activity);
  setFeed((current) => [
    activity,
    ...current.filter((item) => activityKey(item) !== key),
  ].slice(0, 80));
}

function dedupeActivities(activities: RealtimeActivity[]): RealtimeActivity[] {
  const deduped = new Map<string, RealtimeActivity>();
  for (const activity of activities) deduped.set(activityKey(activity), activity);
  return [...deduped.values()];
}

function activityKey(activity: RealtimeActivity): string {
  if (activity.nodeId) return `${activity.runId ?? activity.workflowId ?? 'activity'}:node:${activity.nodeId}`;
  if (activity.kind === 'run') return `${activity.runId ?? activity.workflowId ?? 'activity'}:run`;
  if (activity.kind === 'approval') return `approval:${activity.approvalId ?? activity.detail}`;
  if (activity.kind === 'agent') {
    return `${activity.runId ?? activity.workflowId ?? 'activity'}:agent:${activity.agentId ?? activity.agentName ?? 'update'}`;
  }
  if (activity.event === REALTIME_EVENTS.CANVAS_BUILD_COMPLETE) {
    return `${activity.runId ?? activity.workflowId ?? 'activity'}:build:complete`;
  }
  return [
    activity.runId ?? activity.workflowId ?? 'activity',
    activity.kind,
    activity.agentId ?? activity.agentName ?? activity.title,
    activity.detail,
  ].join(':');
}

function statusLabel(status: MonitorStatus, workflowTitle: string, terminalKind: 'run' | 'build' | null): string {
  if (status === 'completed') return terminalKind === 'build' ? 'Workflow ready' : 'Run completed';
  if (status === 'failed') return 'Run failed';
  if (status === 'waiting') return 'Waiting for approval';
  if (status === 'running') return 'Run in progress';
  return `${workflowTitle} ready`;
}

function StatusIcon({ status, tone }: { status: MonitorStatus; tone: RealtimeActivityTone }) {
  if (status === 'completed') return <CheckCircle2 size={13} className="shrink-0 text-success" />;
  if (status === 'failed') return <AlertTriangle size={13} className="shrink-0 text-danger" />;
  if (status === 'waiting') return <Circle size={12} className="shrink-0 text-warn" />;
  return (
    <RadioTower
      size={13}
      className={clsx('shrink-0', tone === 'accent' ? 'text-accent' : 'text-text-muted')}
    />
  );
}

function matchesWorkflowActivity(
  activity: RealtimeActivity,
  workflowId: string,
  trackedRunId: string | null,
): boolean {
  if (trackedRunId && activity.runId === trackedRunId) return true;
  return activity.workflowId === workflowId;
}

function ActivityDot({ tone, active }: { tone: RealtimeActivityTone; active: boolean }) {
  return (
    <span className={clsx(
      'mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full',
      tone === 'success' && 'bg-success',
      tone === 'warn' && 'bg-warn',
      tone === 'danger' && 'bg-danger',
      tone === 'accent' && 'bg-accent',
      tone === 'muted' && 'bg-text-muted/60',
      active && 'animate-pulse',
    )} />
  );
}
