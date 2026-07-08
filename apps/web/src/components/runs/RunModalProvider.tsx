import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import {
  AlertTriangle,
  ArrowRight,
  Braces,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock,
  Code2,
  ExternalLink,
  FileText,
  Flag,
  GitBranch,
  ListTree,
  Maximize2,
  MessageSquare,
  Play,
  Repeat,
  RotateCcw,
  Square,
  X,
  ArrowDownRight,
  ArrowUpRight,
} from 'lucide-react';
import clsx from 'clsx';
import { REALTIME_EVENTS } from '@agentis/core';
import { api, apiErrorMessage } from '../../lib/api';
import {
  closeRunModal,
  dispatchFocusWorkflowNode,
  OPEN_RUN_MODAL_EVENT,
  openRunModal,
  useRunModalSnapshot,
  type OpenRunModalDetail,
} from '../../lib/runModal';
import { rtSubscribe, useRealtime } from '../../lib/realtime';
import { REALTIME_ACTIVITY_EVENTS, describeRealtimeActivity, type RealtimeActivity } from '../../lib/realtimeActivity';
import { refreshWorkspaceSnapshot } from '../../lib/workspaceData';
import { Button, IconButton } from '../shared/Button';
import { Skeleton, SkeletonText } from '../shared/Skeleton';
import { StatusBadge } from '../shared/StatusBadge';
import { useToast } from '../shared/Toast';

interface RunNode {
  id: string;
  nodeId: string;
  title: string;
  type: string;
  kind?: string;
  status: 'completed' | 'failed' | 'running' | 'skipped' | 'pending' | 'waiting';
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  output?: unknown;
  outputSummary?: string;
  inputs?: unknown;
  error?: string;
  blockedReason?: string;
}

interface RunDetail {
  run: {
    id: string;
    workflowId: string;
    workflowName?: string;
    status: 'running' | 'completed' | 'failed' | 'pending' | 'cancelled' | 'paused' | 'waiting';
    blockedReason?: string;
    startedAt: string;
    finishedAt?: string;
    durationMs?: number;
    triggeredBy?: string;
    keyMetrics?: Array<{ label: string; value: string | number }>;
    tokenUsage?: { input: number; output: number; total: number };
    nodes: RunNode[];
  };
}

interface RunSummary {
  id: string;
  workflowId?: string;
  workflowName?: string;
  status: string;
  startedAt?: string;
  createdAt?: string;
  completedAt?: string | null;
  finishedAt?: string | null;
  durationMs?: number;
  currentStep?: string;
  failedNode?: string;
  failedNodeId?: string;
  failureReason?: string | null;
  tokenUsage?: { input: number; output: number; total: number };
}

interface LedgerEntry {
  id?: string;
  sequence?: number;
  event?: string;
  type?: string;
  message?: string;
  summary?: string;
  payload?: unknown;
  createdAt?: string;
  emittedAt?: string;
}

interface BlackboardAuthor {
  agentId?: string | null;
  runtime?: string | null;
  label?: string | null;
}

interface BlackboardEntry {
  id: string;
  runId?: string;
  namespace: string;
  kind: 'fact' | 'message' | 'claim' | 'artifact_ref';
  key?: string | null;
  channel?: string | null;
  author: BlackboardAuthor;
  iteration: number;
  confidence?: number | null;
  supersedes?: string | null;
  value: unknown;
  at: string;
}

/** One pass of a `converge` loop — drives the iteration timeline. */
interface ConvergeIteration {
  nodeId: string;
  iteration: number;
  verdict: string;
  continue?: boolean;
  score?: number;
  stallStreak?: number;
  durationMs?: number;
  spendMs?: number;
  maxIterations?: number;
}

interface ConvergeSettled {
  nodeId: string;
  verdict: string;
  iterations: number;
  preserved?: { preserved?: boolean; branch?: string; prUrl?: string; changedFiles?: number };
}

type ModalTab = 'nodes' | 'ledger' | 'blackboard';

export function RunModalProvider({ children }: { children: React.ReactNode }) {
  const modal = useRunModalSnapshot();

  useEffect(() => {
    function onOpen(event: Event) {
      openRunModal((event as CustomEvent<OpenRunModalDetail>).detail ?? {});
    }
    window.addEventListener(OPEN_RUN_MODAL_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_RUN_MODAL_EVENT, onOpen);
  }, []);

  return (
    <>
      {children}
      {modal.open && createPortal(<RunModal key={modal.openedAt} />, document.body)}
    </>
  );
}

function RunModal() {
  const modal = useRunModalSnapshot();
  const toast = useToast();
  const nav = useNavigate();
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [ledger, setLedger] = useState<LedgerEntry[]>([]);
  const [blackboard, setBlackboard] = useState<BlackboardEntry[]>([]);
  const [convergeIters, setConvergeIters] = useState<ConvergeIteration[]>([]);
  const [convergeSettled, setConvergeSettled] = useState<ConvergeSettled | null>(null);
  const [activity, setActivity] = useState<RealtimeActivity[]>([]);
  const [tab, setTab] = useState<ModalTab>('nodes');
  const [loading, setLoading] = useState(true);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const runId = modal.runId ?? null;
  const workflowId = modal.workflowId ?? detail?.run.workflowId ?? null;

  useEffect(() => {
    const unsubs: Array<() => void> = [];
    if (runId) unsubs.push(rtSubscribe('run', { runId }));
    if (workflowId) unsubs.push(rtSubscribe('workflow', { workflowId }));
    return () => unsubs.forEach((unsubscribe) => unsubscribe());
  }, [runId, workflowId]);

  const nodeTitle = useMemo(() => {
    const map = new Map<string, string>();
    for (const node of detail?.run.nodes ?? []) map.set(node.nodeId, node.title);
    return (nodeId: string) => map.get(nodeId);
  }, [detail]);

  useRealtime([...REALTIME_ACTIVITY_EVENTS], (event) => {
    if (!runId) return;
    const payload = event.payload as { runId?: string; id?: string };
    if (payload?.runId !== runId && payload?.id !== runId) return;
    const next = describeRealtimeActivity(event, { nodeTitle });
    if (!next) return;
    setActivity((current) => [{ ...next, id: `${next.id}:${Date.now()}` }, ...current].slice(0, 40));
    void refreshDetail();
  });

  async function refreshDetail() {
    if (!runId) return;
    try {
      const next = await api<RunDetail>(`/v1/runs/${runId}`);
      setDetail(next);
      setError(null);
    } catch (err) {
      setError(apiErrorMessage(err));
      setDetail(null);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    setDetail(null);
    setLedger([]);
    setBlackboard([]);
    setConvergeIters([]);
    setConvergeSettled(null);
    setActivity([]);
    setTab('nodes');
    setError(null);
    setLoading(Boolean(runId));
    if (runId) void refreshDetail();
  }, [runId]);

  useRealtime([REALTIME_EVENTS.BLACKBOARD_ENTRY], (event) => {
    const payload = event.payload as { runId?: string; entry?: BlackboardEntry };
    if (!runId || payload?.runId !== runId || !payload.entry) return;
    setBlackboard((current) =>
      current.some((e) => e.id === payload.entry!.id) ? current : [...current, payload.entry!].slice(-500),
    );
  });
  useRealtime([REALTIME_EVENTS.CONVERGE_ITERATION], (event) => {
    const payload = event.payload as (ConvergeIteration & { runId?: string }) | undefined;
    if (!runId || payload?.runId !== runId) return;
    setConvergeIters((current) => {
      const next = current.filter((it) => !(it.nodeId === payload.nodeId && it.iteration === payload.iteration));
      return [...next, payload].sort((a, b) => a.iteration - b.iteration);
    });
  });
  useRealtime([REALTIME_EVENTS.CONVERGE_SETTLED], (event) => {
    const payload = event.payload as (ConvergeSettled & { runId?: string }) | undefined;
    if (!runId || payload?.runId !== runId) return;
    setConvergeSettled(payload);
  });

  useEffect(() => {
    if (runId || !workflowId) return;
    let cancelled = false;
    setHistoryLoading(true);
    setLoading(false);
    void api<{ runs: RunSummary[] }>(`/v1/runs?workflowId=${encodeURIComponent(workflowId)}&limit=25`)
      .then((res) => {
        if (!cancelled) setRuns(res.runs ?? []);
      })
      .catch((err) => {
        if (!cancelled) setError(apiErrorMessage(err));
      })
      .finally(() => {
        if (!cancelled) setHistoryLoading(false);
      });
    return () => { cancelled = true; };
  }, [runId, workflowId]);

  const loadLedger = useCallback(async () => {
    if (!runId || ledger.length > 0) return;
    try {
      const res = await api<{ entries?: LedgerEntry[]; events?: LedgerEntry[] }>(`/v1/runs/${runId}/ledger`);
      setLedger(res.entries ?? res.events ?? []);
    } catch (err) {
      toast.error('Activity log unavailable', apiErrorMessage(err));
    }
  }, [ledger.length, runId, toast]);

  useEffect(() => {
    if (tab === 'ledger') void loadLedger();
  }, [tab, loadLedger]);

  useEffect(() => {
    if (!runId || tab !== 'blackboard' || blackboard.length > 0) return;
    void api<{ entries?: BlackboardEntry[] }>(`/v1/runs/${runId}/blackboard`)
      .then((res) => setBlackboard(res.entries ?? []))
      .catch((err) => toast.error('Blackboard unavailable', apiErrorMessage(err)));
  }, [runId, blackboard.length, tab, toast]);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') closeRunModal();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  async function retryRun(targetRunId: string) {
    try {
      await api(`/v1/runs/${targetRunId}/retry`, { method: 'POST' });
      toast.success('Retry started');
      await refreshWorkspaceSnapshot();
      if (runId === targetRunId) void refreshDetail();
    } catch (err) {
      toast.error('Retry failed', apiErrorMessage(err));
    }
  }

  async function retryFromNode(targetRunId: string, nodeId: string, nodeTitle?: string) {
    try {
      const res = await api<{ runId: string }>(`/v1/runs/${targetRunId}/replay`, {
        method: 'POST',
        body: JSON.stringify({ mode: 'replay-from-node', targetNodeId: nodeId }),
      });
      toast.success('Replay started', nodeTitle ? `Restarting from ${nodeTitle}.` : undefined);
      openRunModal({ runId: res.runId, workflowId, source: 'run-modal-replay' });
      await refreshWorkspaceSnapshot();
    } catch (err) {
      toast.error('Replay failed', apiErrorMessage(err));
    }
  }

  async function stopRun() {
    if (!runId) return;
    try {
      await api(`/v1/runs/${runId}/cancel`, { method: 'POST' });
      toast.success('Stopping run');
      void refreshDetail();
      void refreshWorkspaceSnapshot();
    } catch (err) {
      toast.error('Stop failed', apiErrorMessage(err));
    }
  }

  async function resumeRun() {
    if (!runId) return;
    try {
      await api(`/v1/runs/${runId}/resume`, { method: 'POST', body: JSON.stringify({}) });
      toast.success('Resuming run');
      void refreshDetail();
      void refreshWorkspaceSnapshot();
    } catch (err) {
      toast.error('Resume failed', apiErrorMessage(err));
    }
  }

  function openCanvas(nodeId?: string | null) {
    if (!workflowId) return;
    closeRunModal();
    nav(`/apps/workflows/${workflowId}`);
    const targetNodeId = nodeId ?? modal.focusNodeId ?? failedNode?.nodeId ?? null;
    if (targetNodeId) window.setTimeout(() => dispatchFocusWorkflowNode(targetNodeId), 120);
  }

  const run = detail?.run ?? null;
  const failedNode = run?.nodes.find((node) => node.status === 'failed') ?? null;
  const canCancelRun = run?.status === 'running' || run?.status === 'waiting' || run?.status === 'paused';

  return (
    <div
      className="fixed inset-0 z-[90] flex items-center justify-center bg-overlay/80 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label={run ? `Run ${run.id}` : 'Run history'}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) closeRunModal();
      }}
    >
      <div className="flex h-[min(780px,92vh)] w-[min(1080px,96vw)] flex-col overflow-hidden rounded-card border border-line bg-surface shadow-modal">
        <header className="flex min-h-14 items-center gap-3 border-b border-line px-4">
          <div className="flex h-9 w-9 items-center justify-center rounded-btn border border-line bg-surface-2 text-text-muted">
            {run ? <Code2 size={16} /> : <Clock size={16} />}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h2 className="truncate text-heading text-text-primary">
                {run ? run.workflowName ?? 'Run detail' : 'Run history'}
              </h2>
              {run && <StatusBadge status={run.status} size="sm" />}
            </div>
            <div className="truncate font-mono text-[11px] text-text-muted">
              {run ? run.id : workflowId ? `workflow:${workflowId}` : 'Recent runs'}
            </div>
          </div>
          {workflowId && (
            <Button variant="secondary" size="sm" iconLeft={<ExternalLink size={12} />} onClick={() => openCanvas()}>
              Open canvas
            </Button>
          )}
          {canCancelRun && (
            <Button variant="danger" size="sm" iconLeft={<Square size={12} />} onClick={() => void stopRun()}>
              Cancel run
            </Button>
          )}
          {run?.status === 'paused' && (
            <Button variant="primary" size="sm" iconLeft={<Play size={12} />} onClick={() => void resumeRun()}>
              Resume
            </Button>
          )}
          {run?.status === 'failed' && (
            <Button variant="secondary" size="sm" iconLeft={<RotateCcw size={12} />} onClick={() => void retryRun(run.id)}>
              Retry
            </Button>
          )}
          {run && failedNode && (
            <Button
              variant="secondary"
              size="sm"
              iconLeft={<RotateCcw size={12} />}
              onClick={() => void retryFromNode(run.id, failedNode.nodeId, failedNode.title)}
            >
              Retry from failed node
            </Button>
          )}
          <IconButton icon={<X size={15} />} label="Close run modal" variant="ghost" size="sm" onClick={closeRunModal} />
        </header>

        {run?.status === 'paused' && run.blockedReason && (
          <div className="border-b border-warn/25 bg-warn-soft px-4 py-3 text-[12px] text-text-secondary">
            <span className="font-medium text-text-primary">Run paused:</span> {run.blockedReason}
          </div>
        )}

        {!runId && workflowId ? (
          <RunHistoryList
            runs={runs}
            loading={historyLoading}
            error={error}
            onInspect={(item) => openRunModal({ runId: item.id, workflowId: item.workflowId ?? workflowId, focusNodeId: item.failedNodeId ?? null, source: 'workflow-history' })}
            onRetry={(item) => void retryRun(item.id)}
            onRetryFromNode={(item) => item.failedNodeId && void retryFromNode(item.id, item.failedNodeId, item.failedNode)}
          />
        ) : loading ? (
          <RunModalSkeleton />
        ) : error ? (
          <ModalEmpty icon={<AlertTriangle size={28} />} title="Run unavailable" body={error} />
        ) : run ? (
          <div className="flex min-h-0 flex-1">
            <aside className="w-64 shrink-0 overflow-y-auto border-r border-line bg-surface-1 p-4">
              <div className="grid grid-cols-1 gap-2">
                <Metric label="Started" value={relativeTime(run.startedAt) || '-'} />
                <Metric label="Duration" value={formatDuration(run.durationMs)} />
                <Metric label="Trigger" value={run.triggeredBy ?? 'manual'} />
                <Metric label="Nodes" value={String(run.nodes.length)} />
                {run.tokenUsage && (
                  <div className="rounded-card border border-line bg-surface-1 px-3 py-2">
                    <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-text-muted">
                      {(run.status === 'running' || run.status === 'waiting' || run.status === 'paused') && (
                        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" title="Updating live" />
                      )}
                      Tokens consumed
                    </div>
                    <div className="mt-1 truncate text-[13px] font-semibold text-text-primary">{formatTokens(run.tokenUsage.total)}</div>
                    <div className="mt-1 flex items-center gap-3 text-[10.5px] text-text-secondary">
                      <span className="inline-flex items-center gap-1"><ArrowDownRight size={10} className="text-text-muted" /> {formatTokens(run.tokenUsage.input)} in</span>
                      <span className="inline-flex items-center gap-1"><ArrowUpRight size={10} className="text-text-muted" /> {formatTokens(run.tokenUsage.output)} out</span>
                    </div>
                  </div>
                )}
              </div>
              {activity.length > 0 && (
                <div className="mt-4">
                  <div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-text-muted">Live activity</div>
                  <div className="space-y-2">
                    {activity.slice(0, 5).map((item) => (
                      <div key={item.id} className="rounded-md border border-line bg-surface px-2.5 py-2">
                        <div className="truncate text-[11px] font-medium text-text-primary">{item.nodeTitle ?? item.title}</div>
                        <div className="mt-0.5 line-clamp-2 text-[10px] text-text-muted">{item.detail}</div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </aside>
            <main className="flex min-w-0 flex-1 flex-col">
              <div className="flex gap-1 border-b border-line px-4 py-2">
                {(['nodes', 'ledger', 'blackboard'] as const).map((item) => {
                  // De-jargoned labels for non-developers (masterplan 5.3) — the
                  const label = item === 'ledger' ? 'Activity log' : item === 'blackboard' ? 'Blackboard' : 'Steps';
                  const count = item === 'blackboard' && blackboard.length > 0 ? blackboard.length : null;
                  return (
                  <button
                    key={item}
                    type="button"
                    onClick={() => setTab(item)}
                    className={clsx(
                      'inline-flex h-8 items-center gap-1.5 rounded-btn px-2.5 text-[12px] font-medium transition-colors active:scale-[0.98]',
                      tab === item ? 'bg-surface-2 text-text-primary' : 'text-text-muted hover:bg-surface-2 hover:text-text-primary',
                    )}
                  >
                    {item === 'nodes' && <ListTree size={12} />}
                    {item === 'ledger' && <FileText size={12} />}
                    {item === 'blackboard' && <Braces size={12} />}
                    {label}
                    {count !== null && (
                      <span className="rounded-full bg-accent/15 px-1.5 text-[10px] font-semibold text-accent">{count}</span>
                    )}
                  </button>
                  );
                })}
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto p-4">
                {tab === 'nodes' && (
                  <RunNodesTable
                    run={run}
                    ledger={ledger}
                    onLoadLedger={() => void loadLedger()}
                    onOpenCanvas={(nodeId) => openCanvas(nodeId)}
                    onRetryFromNode={(node) => void retryFromNode(run.id, node.nodeId, node.title)}
                  />
                )}
                {tab === 'ledger' && <RunLedger entries={ledger} />}
                {tab === 'blackboard' && (
                  <RunBlackboard entries={blackboard} iterations={convergeIters} settled={convergeSettled} />
                )}
              </div>
            </main>
          </div>
        ) : (
          <ModalEmpty icon={<AlertTriangle size={28} />} title="Run not found" body="This run may have been deleted or moved." />
        )}
      </div>
    </div>
  );
}

function RunHistoryList({
  runs,
  loading,
  error,
  onInspect,
  onRetry,
  onRetryFromNode,
}: {
  runs: RunSummary[];
  loading: boolean;
  error: string | null;
  onInspect: (run: RunSummary) => void;
  onRetry: (run: RunSummary) => void;
  onRetryFromNode: (run: RunSummary) => void;
}) {
  if (loading) return <RunModalSkeleton />;
  if (error) return <ModalEmpty icon={<AlertTriangle size={28} />} title="History unavailable" body={error} />;
  if (runs.length === 0) return <ModalEmpty icon={<Clock size={28} />} title="No runs yet" body="This workflow has not produced any run history." />;
  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-4">
      <div className="overflow-hidden rounded-card border border-line">
        {runs.map((run) => (
          <div key={run.id} className="flex items-center gap-3 border-b border-line/70 px-3 py-3 last:border-b-0">
            <StatusIcon status={run.status} />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <div className="truncate text-[13px] font-medium text-text-primary">{run.workflowName ?? 'Workflow run'}</div>
                <StatusBadge status={run.status} size="sm" />
              </div>
              <div className="mt-0.5 truncate text-[11px] text-text-muted">
                {run.failedNode ? `Failed at ${run.failedNode}` : run.currentStep ?? relativeTime(run.startedAt ?? run.createdAt)}
              </div>
            </div>
            {run.tokenUsage && (
              run.tokenUsage.total > 0 ? (
                <div className="flex flex-col items-end pr-3">
                  <div className="text-[13px] font-semibold text-text-primary">{formatTokens(run.tokenUsage.total)} <span className="text-[10px] font-normal text-text-muted">tokens</span></div>
                  <div className="flex items-center gap-2 text-[10px] text-text-muted mt-0.5">
                    <span className="inline-flex items-center gap-0.5"><ArrowDownRight size={10} /> {formatTokens(run.tokenUsage.input)}</span>
                    <span className="inline-flex items-center gap-0.5"><ArrowUpRight size={10} /> {formatTokens(run.tokenUsage.output)}</span>
                  </div>
                </div>
              ) : (
                // A run that made no model calls (deterministic path / skipped
                // agent branch) — label it so a true zero doesn't read as a
                // broken counter.
                <div className="pr-3 text-[11px] italic text-text-muted" title="This run made no model calls — its path used deterministic nodes only.">No model calls</div>
              )
            )}
            <Button variant="ghost" size="sm" iconRight={<ArrowRight size={12} />} onClick={() => onInspect(run)}>
              Inspect
            </Button>
            {run.status === 'failed' && (
              <Button variant="secondary" size="sm" iconLeft={<RotateCcw size={12} />} onClick={() => onRetry(run)}>
                Retry
              </Button>
            )}
            {run.failedNodeId && (
              <Button variant="secondary" size="sm" iconLeft={<RotateCcw size={12} />} onClick={() => onRetryFromNode(run)}>
                Retry from failed node
              </Button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function RunNodesTable({
  run,
  ledger,
  onLoadLedger,
  onOpenCanvas,
  onRetryFromNode,
}: {
  run: RunDetail['run'];
  ledger: LedgerEntry[];
  onLoadLedger: () => void;
  onOpenCanvas: (nodeId: string) => void;
  onRetryFromNode: (node: RunNode) => void;
}) {
  const [expanded, setExpanded] = useState<string | null>(null);

  function toggle(nodeId: string) {
    setExpanded((current) => {
      const next = current === nodeId ? null : nodeId;
      if (next && ledger.length === 0) onLoadLedger();
      return next;
    });
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
        {(run.keyMetrics ?? []).map((metric) => (
          <Metric key={metric.label} label={metric.label} value={String(metric.value)} />
        ))}
      </div>
      <div className="overflow-hidden rounded-card border border-line">
        <table className="w-full table-fixed">
          <colgroup>
            <col style={{ width: '34px' }} />
            <col style={{ width: '30%' }} />
            <col style={{ width: '12%' }} />
            <col style={{ width: '13%' }} />
            <col style={{ width: '12%' }} />
            <col style={{ width: '23%' }} />
            <col style={{ width: '78px' }} />
          </colgroup>
          <thead className="border-b border-line bg-surface-2 text-[10px] uppercase tracking-wider text-text-muted">
            <tr>
              <th className="px-2 py-2" />
              <th className="px-3 py-2 text-left">Node</th>
              <th className="px-3 py-2 text-left">Kind</th>
              <th className="px-3 py-2 text-left">Status</th>
              <th className="px-3 py-2 text-left">Duration</th>
              <th className="px-3 py-2 text-left">Output</th>
              <th className="px-3 py-2 text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {run.nodes.map((node) => {
              const isOpen = expanded === node.nodeId;
              // A node "already ran" once it reached a terminal of its own — those
              // can be replayed from. Pending/waiting/skipped never produced work.
              const ran = node.status === 'completed' || node.status === 'failed';
              return (
                <Fragment key={node.id}>
                  <tr
                    className={clsx('border-b border-line/70 align-top cursor-pointer hover:bg-surface-2/50', isOpen && 'bg-surface-2/40')}
                    onClick={() => toggle(node.nodeId)}
                  >
                    <td className="px-2 py-3 text-text-muted">
                      {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                    </td>
                    <td className="px-3 py-3">
                      <div className="max-w-[220px] truncate text-[13px] font-medium text-text-primary">{node.title}</div>
                      <div className="font-mono text-[10px] text-text-muted">{node.nodeId}</div>
                    </td>
                    <td className="px-3 py-3 text-[11px] text-text-muted">{humanizeKind(node.kind ?? node.type)}</td>
                    <td className="px-3 py-3"><StatusBadge status={node.status} size="sm" /></td>
                    <td className="px-3 py-3 text-[12px] text-text-muted">{formatDuration(node.durationMs)}</td>
                    <td className="px-3 py-3">
                      <div className={clsx(
                        'max-w-[260px] truncate font-mono text-[11px]',
                        node.error ? 'text-danger' : 'text-text-secondary',
                      )}>
                        {node.error ?? node.outputSummary ?? summarizeValue(node.output)}
                      </div>
                    </td>
                    <td className="px-3 py-3" onClick={(event) => event.stopPropagation()}>
                      <div className="flex justify-end gap-1.5">
                        <IconButton icon={<Maximize2 size={12} />} label="Open node on canvas" size="sm" onClick={() => onOpenCanvas(node.nodeId)} />
                        {ran && (
                          <IconButton icon={<RotateCcw size={12} />} label="Replay from this node" size="sm" onClick={() => onRetryFromNode(node)} />
                        )}
                      </div>
                    </td>
                  </tr>
                  {isOpen && (
                    <tr className="border-b border-line/70 bg-surface-1">
                      <td />
                      <td colSpan={6} className="px-3 pb-4 pt-1">
                        <NodeLogs node={node} ledger={ledger} onReplay={ran ? () => onRetryFromNode(node) : undefined} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** Expanded per-node detail: inputs, output/error, and this node's ledger events. */
function NodeLogs({ node, ledger, onReplay }: { node: RunNode; ledger: LedgerEntry[]; onReplay?: () => void }) {
  const logs = ledger.filter((entry) => {
    const payloadNode = (entry.payload as { nodeId?: string } | undefined)?.nodeId;
    return payloadNode === node.nodeId;
  });
  return (
    <div className="space-y-3 rounded-card border border-line bg-surface px-3 py-3">
      <div className="flex items-center justify-between">
        <div className="text-[10px] font-semibold uppercase tracking-wider text-text-muted">Node detail</div>
        {onReplay && (
          <Button variant="secondary" size="sm" iconLeft={<RotateCcw size={11} />} onClick={onReplay}>
            Replay from here
          </Button>
        )}
      </div>
      {node.error && (
        <LogBlock label="Error" tone="danger" body={node.error} />
      )}
      {node.blockedReason && <LogBlock label="Blocked" tone="warn" body={node.blockedReason} />}
      {node.inputs != null && <LogBlock label="Inputs" body={formatJson(node.inputs)} />}
      <LogBlock label="Output" body={node.output != null ? formatJson(node.output) : (node.outputSummary ?? '-')} />
      <div>
        <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-text-muted">Logs ({logs.length})</div>
        {logs.length === 0 ? (
          <div className="text-[11px] text-text-muted">No ledger events recorded for this node.</div>
        ) : (
          <div className="space-y-1.5">
            {logs.map((entry, index) => (
              <div key={entry.id ?? entry.sequence ?? index} className="rounded-md border border-line/70 bg-surface-1 px-2.5 py-1.5">
                <div className="flex items-center gap-2 text-[10px] text-text-muted">
                  <span>{entry.event ?? entry.type ?? 'event'}</span>
                  <span className="ml-auto">{relativeTime(entry.emittedAt ?? entry.createdAt)}</span>
                </div>
                {(entry.message ?? entry.summary) && (
                  <div className="mt-0.5 whitespace-pre-wrap break-words text-[11px] leading-relaxed text-text-secondary">
                    {entry.message ?? entry.summary}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function LogBlock({ label, body, tone }: { label: string; body: string; tone?: 'danger' | 'warn' }) {
  return (
    <div>
      <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-text-muted">{label}</div>
      <pre className={clsx(
        'max-h-52 overflow-auto whitespace-pre-wrap break-words rounded-md border border-line/70 bg-surface-1 px-2.5 py-2 font-mono text-[11px] leading-relaxed',
        tone === 'danger' ? 'text-danger' : tone === 'warn' ? 'text-warn' : 'text-text-secondary',
      )}>
        {body}
      </pre>
    </div>
  );
}

function RunLedger({ entries }: { entries: LedgerEntry[] }) {
  if (entries.length === 0) return <ModalEmpty icon={<FileText size={28} />} title="No ledger entries" body="This run has not written technical ledger events yet." />;
  return (
    <div className="space-y-2">
      {entries.map((entry, index) => (
        <div key={entry.id ?? entry.sequence ?? index} className="rounded-card border border-line bg-surface-1 p-3">
          <div className="mb-1 flex items-center gap-2 text-[11px] text-text-muted">
            <span className="font-mono">#{entry.sequence ?? index + 1}</span>
            <span>{entry.event ?? entry.type ?? 'ledger'}</span>
            <span className="ml-auto">{relativeTime(entry.emittedAt ?? entry.createdAt)}</span>
          </div>
          <pre className="max-h-52 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-text-secondary">
            {entry.message ?? entry.summary ?? formatJson(entry.payload ?? entry)}
          </pre>
        </div>
      ))}
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// (AGENT-COOPERATION-10X §Pillar 2/3). Facts (KV), the channel conversation,
// the claims ledger, and the convergence iteration timeline — each entry tagged
// with WHO on WHICH runtime, streaming in as agents write.
// ───────────────────────────────────────────────────────────────────────────

const RUNTIME_PALETTE: Array<[string, string]> = [
  ['opus', '#c084fc'], ['claude', '#c084fc'], ['anthropic', '#c084fc'],
  ['codex', '#34d399'], ['gpt', '#34d399'], ['openai', '#34d399'],
  ['cursor', '#60a5fa'],
  ['hermes', '#fbbf24'],
  ['gemini', '#f472b6'], ['google', '#f472b6'],
  ['system', '#94a3b8'],
];
function runtimeColor(runtime?: string | null): string {
  const key = (runtime ?? '').toLowerCase();
  if (!key) return '#94a3b8';
  for (const [name, color] of RUNTIME_PALETTE) if (key.includes(name)) return color;
  let h = 0;
  for (let i = 0; i < key.length; i += 1) h = (h * 31 + key.charCodeAt(i)) % 360;
  return `hsl(${h} 65% 64%)`;
}

function IdentityChip({ author }: { author: BlackboardAuthor }) {
  const color = runtimeColor(author.runtime);
  const name = author.label || author.agentId || 'agent';
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-surface-2 px-2 py-0.5 text-[11px]">
      <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: color }} />
      <span className="font-medium text-text-primary">{name}</span>
      {author.runtime && <span className="text-text-muted">· {author.runtime}</span>}
    </span>
  );
}

function verdictTone(verdict: string): { color: string; label: string } {
  switch (verdict) {
    case 'goal_met':
    case 'pass':
    case 'converged':
    case 'signalled_done':
      return { color: '#34d399', label: verdict.replace(/_/g, ' ') };
    case 'stalled':
      return { color: '#fbbf24', label: 'stalled' };
    case 'budget_exhausted':
      return { color: '#f87171', label: 'budget exhausted' };
    case 'max_iterations':
      return { color: '#94a3b8', label: 'max iterations' };
    default:
      return { color: '#94a3b8', label: verdict.replace(/_/g, ' ') };
  }
}

function ConvergeTimeline({ iterations, settled }: { iterations: ConvergeIteration[]; settled: ConvergeSettled | null }) {
  if (iterations.length === 0 && !settled) return null;
  const preserved = settled?.preserved;
  return (
    <div className="mb-4 rounded-card border border-line bg-surface-1 p-3">
      <div className="mb-2 flex items-center gap-2 text-[12px] font-medium text-text-primary">
        <Repeat size={13} className="text-text-muted" />
        Convergence loop
        {settled && (
          <span
            className="ml-auto inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold"
            style={{ color: verdictTone(settled.verdict).color, backgroundColor: `${verdictTone(settled.verdict).color}22` }}
          >
            {verdictTone(settled.verdict).label} · {settled.iterations} iter
          </span>
        )}
      </div>
      <div className="flex flex-wrap items-stretch gap-1.5">
        {iterations.map((it) => {
          const tone = verdictTone(it.verdict);
          return (
            <div
              key={`${it.nodeId}:${it.iteration}`}
              title={`Iteration ${it.iteration + 1} — ${it.verdict}${typeof it.score === 'number' ? ` · score ${it.score.toFixed(1)}` : ''}${it.stallStreak ? ` · no-progress streak ${it.stallStreak}` : ''}`}
              className={clsx(
                'flex min-w-[44px] flex-col items-center rounded-btn border px-2 py-1',
                it.stallStreak ? 'border-amber-400/50' : 'border-line',
              )}
            >
              <span className="text-[10px] text-text-muted">#{it.iteration + 1}</span>
              <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: tone.color }} />
              {typeof it.score === 'number' && <span className="mt-0.5 text-[10px] text-text-muted">{it.score.toFixed(1)}</span>}
            </div>
          );
        })}
      </div>
      {preserved?.preserved && (
        <div className="mt-2 flex flex-wrap items-center gap-2 border-t border-line pt-2 text-[11px] text-text-secondary">
          <span className="inline-flex items-center gap-1"><GitBranch size={12} className="text-text-muted" />{preserved.branch}</span>
          {preserved.prUrl && (
            <a href={preserved.prUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-accent hover:underline">
              Pull request <ExternalLink size={11} />
            </a>
          )}
          {typeof preserved.changedFiles === 'number' && <span className="text-text-muted">{preserved.changedFiles} files changed</span>}
        </div>
      )}
    </div>
  );
}

function blackboardTime(at: string): string {
  const d = new Date(at);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function RunBlackboard({
  entries,
  iterations,
  settled,
}: {
  entries: BlackboardEntry[];
  iterations: ConvergeIteration[];
  settled: ConvergeSettled | null;
}) {
  const [view, setView] = useState<'facts' | 'chat' | 'claims'>('facts');

  const facts = useMemo(() => {
    // KV semantics — latest entry per namespace+key wins.
    const map = new Map<string, BlackboardEntry>();
    for (const e of entries) if (e.kind === 'fact' && e.key) map.set(`${e.namespace}:${e.key}`, e);
    return [...map.values()].sort((a, b) => a.at.localeCompare(b.at));
  }, [entries]);
  const messages = useMemo(
    () => entries.filter((e) => e.kind === 'message').sort((a, b) => a.at.localeCompare(b.at)),
    [entries],
  );
  const claims = useMemo(() => entries.filter((e) => e.kind === 'claim'), [entries]);
  const supersededIds = useMemo(
    () => new Set(claims.map((c) => c.supersedes).filter((id): id is string => Boolean(id))),
    [claims],
  );

  if (entries.length === 0 && iterations.length === 0 && !settled) {
    return (
      <ModalEmpty
        icon={<Braces size={28} />}
        title="Blackboard empty"
        body="When agents share facts, message each other, or post claims during this run, they appear here live — tagged by who wrote them."
      />
    );
  }

  const tabs: Array<{ key: typeof view; label: string; icon: React.ReactNode; count: number }> = [
    { key: 'facts', label: 'Facts', icon: <Braces size={12} />, count: facts.length },
    { key: 'chat', label: 'Conversation', icon: <MessageSquare size={12} />, count: messages.length },
    { key: 'claims', label: 'Claims', icon: <Flag size={12} />, count: claims.length },
  ];

  return (
    <div>
      <ConvergeTimeline iterations={iterations} settled={settled} />
      <div className="mb-3 flex gap-1">
        {tabs.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setView(t.key)}
            className={clsx(
              'inline-flex h-7 items-center gap-1.5 rounded-btn px-2.5 text-[11px] font-medium transition-colors',
              view === t.key ? 'bg-surface-2 text-text-primary' : 'text-text-muted hover:bg-surface-2 hover:text-text-primary',
            )}
          >
            {t.icon}
            {t.label}
            {t.count > 0 && <span className="text-text-muted">{t.count}</span>}
          </button>
        ))}
      </div>

      {view === 'facts' && (
        facts.length === 0 ? (
          <ViewEmpty text="No shared facts yet." />
        ) : (
          <div className="space-y-2">
            {facts.map((e) => (
              <div key={e.id} className="rounded-card border border-line bg-surface-1 p-3">
                <div className="mb-1.5 flex items-center justify-between gap-2">
                  <span className="font-mono text-[11px] text-text-primary">{e.key}</span>
                  <div className="flex items-center gap-2">
                    {e.namespace !== 'run' && <NamespaceTag namespace={e.namespace} iteration={e.iteration} />}
                    <IdentityChip author={e.author} />
                  </div>
                </div>
                <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-text-secondary">
                  {formatJson(e.value)}
                </pre>
              </div>
            ))}
          </div>
        )
      )}

      {view === 'chat' && (
        messages.length === 0 ? (
          <ViewEmpty text="No channel messages yet." />
        ) : (
          <div className="space-y-1.5">
            {messages.map((e) => (
              <div key={e.id} className="flex items-start gap-2 rounded-card border border-line bg-surface-1 px-3 py-2">
                <span className="mt-0.5 h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: runtimeColor(e.author.runtime) }} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 text-[11px]">
                    <span className="font-medium text-text-primary">{e.author.label || e.author.agentId || 'agent'}</span>
                    {e.channel && <span className="rounded bg-surface-2 px-1 text-[10px] text-text-muted">#{e.channel}</span>}
                    <span className="ml-auto text-[10px] text-text-muted">{blackboardTime(e.at)}</span>
                  </div>
                  <div className="mt-0.5 whitespace-pre-wrap break-words text-[12px] text-text-secondary">{String(e.value ?? '')}</div>
                </div>
              </div>
            ))}
          </div>
        )
      )}

      {view === 'claims' && (
        claims.length === 0 ? (
          <ViewEmpty text="No claims posted yet." />
        ) : (
          <div className="space-y-2">
            {claims.map((e) => {
              const superseded = supersededIds.has(e.id);
              return (
                <div
                  key={e.id}
                  className={clsx(
                    'rounded-card border bg-surface-1 p-3',
                    superseded ? 'border-line opacity-60' : 'border-line',
                  )}
                >
                  <div className="mb-1.5 flex items-center gap-2">
                    <IdentityChip author={e.author} />
                    {e.supersedes && (
                      <span className="inline-flex items-center gap-1 rounded-full bg-amber-400/15 px-2 py-0.5 text-[10px] font-medium text-amber-500">
                        disputes prior
                      </span>
                    )}
                    {superseded && <span className="text-[10px] text-text-muted">superseded</span>}
                    <span className="ml-auto text-[10px] text-text-muted">{blackboardTime(e.at)}</span>
                  </div>
                  <div className={clsx('text-[12px] text-text-secondary', superseded && 'line-through')}>{String(e.value ?? '')}</div>
                  {typeof e.confidence === 'number' && (
                    <div className="mt-2 flex items-center gap-2">
                      <div className="h-1 w-24 overflow-hidden rounded-full bg-surface-2">
                        <div className="h-full rounded-full bg-accent" style={{ width: `${Math.round(e.confidence * 100)}%` }} />
                      </div>
                      <span className="text-[10px] text-text-muted">{Math.round(e.confidence * 100)}% confident</span>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )
      )}
    </div>
  );
}

function NamespaceTag({ namespace, iteration }: { namespace: string; iteration: number }) {
  return (
    <span className="inline-flex items-center gap-1 rounded bg-surface-2 px-1.5 py-0.5 text-[10px] text-text-muted">
      {namespace} · iter {iteration + 1}
    </span>
  );
}

function ViewEmpty({ text }: { text: string }) {
  return <div className="py-10 text-center text-[12px] text-text-muted">{text}</div>;
}

function RunModalSkeleton() {
  return (
    <div className="min-h-0 flex-1 p-5">
      <div className="grid grid-cols-4 gap-3">
        {Array.from({ length: 4 }).map((_, index) => <Skeleton key={index} height={64} rounded="lg" />)}
      </div>
      <div className="mt-5 space-y-3">
        <Skeleton height={42} rounded="lg" />
        <SkeletonText lines={6} />
      </div>
    </div>
  );
}

function ModalEmpty({ icon, title, body }: { icon: React.ReactNode; title: string; body: string }) {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center p-8">
      <div className="max-w-sm text-center">
        <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-card border border-line bg-surface-2 text-text-muted">
          {icon}
        </div>
        <div className="text-heading text-text-primary">{title}</div>
        <p className="mt-1 text-[13px] leading-relaxed text-text-muted">{body}</p>
      </div>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-card border border-line bg-surface-1 px-3 py-2">
      <div className="text-[10px] uppercase tracking-wider text-text-muted">{label}</div>
      <div className="mt-1 truncate text-[13px] font-semibold text-text-primary">{value}</div>
    </div>
  );
}

function StatusIcon({ status }: { status: string }) {
  if (/fail|error/i.test(status)) return <AlertTriangle size={15} className="text-danger" />;
  if (/complete|success/i.test(status)) return <CheckCircle2 size={15} className="text-accent" />;
  return <Clock size={15} className="text-text-muted" />;
}

/** Turn an engine node kind (`agent_task`) into a human label (`Agent task`) — masterplan 5.3. */
function humanizeKind(kind: string | undefined): string {
  if (!kind) return '—';
  return kind.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function formatDuration(ms?: number): string {
  if (!ms) return '-';
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s`;
}

function relativeTime(iso?: string | null): string {
  if (!iso) return '';
  const time = new Date(iso).getTime();
  if (!Number.isFinite(time)) return '';
  const diff = Math.max(0, Date.now() - time);
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function summarizeValue(value: unknown): string {
  if (value == null) return '-';
  if (typeof value === 'string') return value;
  return formatJson(value).slice(0, 240);
}

function formatJson(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value ?? {}, null, 2);
  } catch {
    return String(value);
  }
}

function formatTokens(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0';
  if (value < 1_000) return String(Math.round(value));
  if (value < 1_000_000) return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)}k`;
  return `${(value / 1_000_000).toFixed(value < 10_000_000 ? 1 : 0)}M`;
}



