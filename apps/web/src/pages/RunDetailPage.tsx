/**
 * RunDetailPage — Story / Technical dual-mode view.
 *
 * Story mode (default): natural-language summary, key results, readable timeline.
 * Technical mode: raw I/O, JSON, block data — the debug surface.
 *
 * Stays inside Shell. Back link is context-aware via document.referrer.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  ArrowLeft, FileText, Code as CodeIcon, BookOpen, RotateCcw, ChevronRight, Square, Play, RadioTower,
} from 'lucide-react';
import clsx from 'clsx';
import { REALTIME_EVENTS } from '@agentis/core';
import { api, workspace as wsStore } from '../lib/api';
import { rtSubscribe, useRealtime } from '../lib/realtime';
import {
  REALTIME_ACTIVITY_EVENTS,
  describeRealtimeActivity,
  type RealtimeActivity,
} from '../lib/realtimeActivity';
import { useToast } from '../components/shared/Toast';
import { Button } from '../components/shared/Button';
import { Skeleton } from '../components/shared/Skeleton';
import { StatusBadge } from '../components/shared/StatusBadge';
import { EmptyState } from '../components/shared/EmptyState';

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
}

interface RunDetail {
  run: {
    id: string;
    workflowId: string;
    workflowName?: string;
    appSlug?: string;
    appName?: string;
    status: 'running' | 'completed' | 'failed' | 'pending' | 'cancelled' | 'paused' | 'waiting';
    blockedReason?: string;
    startedAt: string;
    finishedAt?: string;
    durationMs?: number;
    cost?: number;
    triggeredBy?: string;
    summary?: string;
    keyMetrics?: Array<{ label: string; value: string | number }>;
    nodes: RunNode[];
  };
}

type Mode = 'story' | 'technical';

function formatDuration(ms?: number): string {
  if (!ms) return '—';
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${s % 60}s`;
}

function relativeTime(iso?: string): string {
  if (!iso) return '';
  try {
    const d = Date.now() - new Date(iso).getTime();
    if (d < 60000) return 'just now';
    if (d < 3600_000) return `${Math.floor(d / 60000)}m ago`;
    if (d < 86_400_000) return `${Math.floor(d / 3600_000)}h ago`;
    return `${Math.floor(d / 86_400_000)}d ago`;
  } catch { return ''; }
}

function formatJsonForDisplay(value: unknown): string {
  if (typeof value === 'string') return value;
  const str = JSON.stringify(value ?? {}, null, 2);
  return str.replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\"/g, '"');
}

export function RunDetailPage() {
  const { id } = useParams<{ id: string }>();
  const nav = useNavigate();
  const toast = useToast();
  const [data, setData] = useState<RunDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [mode, setMode] = useState<Mode>('story');
  const [selectedNode, setSelectedNode] = useState<RunNode | null>(null);
  const [activityFeed, setActivityFeed] = useState<RealtimeActivity[]>([]);
  const activitySeqRef = useRef(0);

  async function refresh() {
    if (!id) return;
    try {
      const d = await api<RunDetail>(`/v1/runs/${id}`);
      setData(d);
    } catch { setData(null); }
    finally { setLoading(false); }
  }

  useEffect(() => {
    const ws = wsStore.get();
    const unsubs: Array<() => void> = [];
    if (ws) unsubs.push(rtSubscribe('workspace', { workspaceId: ws }));
    if (id) unsubs.push(rtSubscribe('run', { runId: id }));
    void refresh();
    return () => unsubs.forEach((unsubscribe) => unsubscribe());
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, [id]);

  useRealtime([
    REALTIME_EVENTS.RUN_COMPLETED,
    REALTIME_EVENTS.RUN_FAILED,
    REALTIME_EVENTS.RUN_RUNNING,
    REALTIME_EVENTS.NODE_COMPLETED,
    REALTIME_EVENTS.NODE_FAILED,
    REALTIME_EVENTS.NODE_WAITING_FOR_INPUT,
  ], (evt) => {
    const payload = evt.payload as { runId?: string; id?: string };
    if (payload?.runId === id || payload?.id === id) void refresh();
  });

  useRealtime([...REALTIME_ACTIVITY_EVENTS], (evt) => {
    const payload = evt.payload as { runId?: string; id?: string };
    if (payload?.runId !== id && payload?.id !== id) return;
    const activity = describeRealtimeActivity(evt, {
      nodeTitle: (nodeId) => data?.run.nodes.find((node) => node.nodeId === nodeId || node.id === nodeId)?.title,
    });
    if (!activity) return;
    activitySeqRef.current += 1;
    setActivityFeed((current) => [
      { ...activity, id: `${activity.id}:${activitySeqRef.current}` },
      ...current,
    ].slice(0, 60));
  });

  async function handleRetry() {
    if (!data) return;
    try { await api(`/v1/runs/${data.run.id}/retry`, { method: 'POST' }); toast.success('Retry started'); void refresh(); }
    catch (e) { toast.error('Retry failed', String(e)); }
  }

  async function handleStop() {
    if (!data) return;
    try { await api(`/v1/runs/${data.run.id}/cancel`, { method: 'POST' }); toast.success('Stopping run…'); void refresh(); }
    catch (e) { toast.error('Stop failed', String(e)); }
  }

  async function handleResume() {
    if (!data) return;
    try { await api(`/v1/runs/${data.run.id}/resume`, { method: 'POST' }); toast.success('Resuming run…'); void refresh(); }
    catch (e) { toast.error('Resume failed', String(e)); }
  }

  async function handleReplayFromNode(node: RunNode) {
    if (!data) return;
    try {
      const res = await api<{ runId: string }>(`/v1/runs/${data.run.id}/replay`, {
        method: 'POST',
        body: JSON.stringify({ mode: 'replay-from-node', targetNodeId: node.nodeId }),
      });
      toast.success('Replay started', `Restarting from ${node.title}.`);
      nav(`/runs/${res.runId}`);
    } catch (e) {
      toast.error('Replay failed', String(e));
    }
  }

  if (loading && !data) return <div className="p-6"><Skeleton height={500} /></div>;

  if (!data) {
    return (
      <div className="p-8">
        <EmptyState
          icon={<FileText size={48} />}
          title="Run not found"
          body="This run may have been deleted or you don't have access."
          primaryAction={<Button variant="primary" size="md" onClick={() => nav('/history')}>Back to history</Button>}
          variant="page"
        />
      </div>
    );
  }

  const r = data.run;
  const nodes = r.nodes ?? [];
  const failedNode = nodes.find((n) => n.status === 'failed');

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="border-b border-line px-6 py-4">
        <button
          onClick={() => nav(r.appSlug ? `/apps/${r.appSlug}` : r.workflowId ? `/workflows/${r.workflowId}` : '/history')}
          className="mb-3 inline-flex items-center gap-1 text-[12px] text-text-muted hover:text-text-primary"
        >
          <ArrowLeft size={12} />
          {r.appName ? `${r.appName} · Performance` : r.workflowName ?? 'Back'}
        </button>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-display text-text-primary">
            {r.workflowName ?? 'Run'}{' '}
            <span className="font-mono text-[16px] font-normal text-text-muted">#{r.id.slice(-6)}</span>
          </h1>
          <StatusBadge status={r.status} />
          <div className="text-[12px] text-text-muted">
            {formatDuration(r.durationMs)}
            {r.cost != null && ` · $${r.cost.toFixed(2)}`}
            {' · '}{relativeTime(r.startedAt)}
          </div>
          <div className="ml-auto flex items-center gap-2">
            {(r.status === 'running' || r.status === 'waiting') && (
              <Button variant="secondary" size="sm" iconLeft={<Square size={11} />} onClick={() => void handleStop()}>Stop</Button>
            )}
            {r.status === 'paused' && (
              <Button variant="primary" size="sm" iconLeft={<Play size={11} />} onClick={() => void handleResume()}>Resume</Button>
            )}
            {r.status === 'failed' && (
              <Button variant="secondary" size="sm" iconLeft={<RotateCcw size={11} />} onClick={() => void handleRetry()}>Retry</Button>
            )}
            {failedNode && (
              <Button variant="secondary" size="sm" iconLeft={<RotateCcw size={11} />} onClick={() => void handleReplayFromNode(failedNode)}>
                Retry from failed node
              </Button>
            )}
            <div className="flex h-9 items-center gap-0.5 rounded-btn border border-line bg-surface-2 p-0.5">
              <button
                type="button"
                onClick={() => setMode('story')}
                className={clsx(
                  'inline-flex h-7 items-center gap-1 rounded-md px-2.5 text-[12px] font-medium transition-colors',
                  mode === 'story' ? 'bg-surface-3 text-text-primary' : 'text-text-muted hover:text-text-primary',
                )}
              >
                <BookOpen size={11} /> Story
              </button>
              <button
                type="button"
                onClick={() => setMode('technical')}
                className={clsx(
                  'inline-flex h-7 items-center gap-1 rounded-md px-2.5 text-[12px] font-medium transition-colors',
                  mode === 'technical' ? 'bg-surface-3 text-text-primary' : 'text-text-muted hover:text-text-primary',
                )}
              >
                <CodeIcon size={11} /> Technical
              </button>
            </div>
          </div>
        </div>
      </div>

      {r.status === 'paused' && r.blockedReason && (
        <div className="border-b border-warn/30 bg-warn-soft px-6 py-3">
          <div className="flex items-start gap-2">
            <Square size={14} className="mt-0.5 shrink-0 text-warn" />
            <div className="min-w-0">
              <div className="text-[12px] font-medium text-text-primary">Run paused — action needed</div>
              <div className="mt-0.5 text-[11px] leading-relaxed text-text-muted">{r.blockedReason}</div>
            </div>
            <Button variant="primary" size="sm" className="ml-auto" iconLeft={<Play size={11} />} onClick={() => void handleResume()}>Resume</Button>
          </div>
        </div>
      )}

      <div className="flex-1 overflow-y-auto px-6 py-5">
        {(r.status === 'running' || r.status === 'waiting' || r.status === 'paused' || activityFeed.length > 0) && (
          <LiveRunActivity feed={activityFeed} />
        )}

        {mode === 'story' ? <StoryView run={r} onSelectNode={setSelectedNode} /> : <TechnicalView run={r} onSelectNode={setSelectedNode} />}

        {/* Node Inspector (slides in from right via DetailPanel pattern, but inline for simplicity) */}
        {selectedNode && (
          <div className="mt-6 rounded-card border border-line bg-surface p-5">
            <div className="mb-3 flex items-center gap-2">
              <h2 className="text-heading text-text-primary">{selectedNode.title}</h2>
              <span className="font-mono text-[11px] text-text-muted">{selectedNode.kind ?? selectedNode.type}</span>
              {selectedNode.status === 'failed' && (
                <Button
                  variant="secondary"
                  size="sm"
                  className="ml-auto"
                  iconLeft={<RotateCcw size={11} />}
                  onClick={() => void handleReplayFromNode(selectedNode)}
                >
                  Retry from this node
                </Button>
              )}
              <button
                type="button"
                onClick={() => setSelectedNode(null)}
                className={clsx(selectedNode.status === 'failed' ? '' : 'ml-auto', '-m-1 rounded-md p-1 text-text-muted hover:bg-surface-2 hover:text-text-primary')}
              >
                <span aria-label="Close">×</span>
              </button>
            </div>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-[2fr_3fr]">
              <div className="min-w-0">
                <div className="mb-1.5 text-[11px] font-medium uppercase tracking-wider text-text-muted">Input</div>
                <pre className="w-full max-h-72 overflow-y-auto whitespace-pre-wrap break-words rounded-input border border-line bg-surface-2 p-3 font-mono text-[12px] leading-relaxed text-text-primary">
                  {formatJsonForDisplay(selectedNode.inputs)}
                </pre>
              </div>
              <div className="min-w-0">
                <div className="mb-1.5 text-[11px] font-medium uppercase tracking-wider text-text-muted">Output</div>
                {selectedNode.error ? (
                  <pre className="w-full max-h-72 overflow-y-auto whitespace-pre-wrap break-words rounded-input border border-danger/20 bg-danger-soft p-3 font-mono text-[12px] leading-relaxed text-danger">
                    {selectedNode.error}
                  </pre>
                ) : (
                  <pre className="w-full max-h-72 overflow-y-auto whitespace-pre-wrap break-words rounded-input border border-line bg-surface-2 p-3 font-mono text-[12px] leading-relaxed text-text-primary">
                    {formatJsonForDisplay(selectedNode.output)}
                  </pre>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function StoryView({ run, onSelectNode }: { run: RunDetail['run']; onSelectNode: (n: RunNode) => void }) {
  // Synthesize a story summary from node statuses if no summary provided
  const story = useMemo(() => {
    if (run.summary) return run.summary;
    const lines: string[] = [];
    if (run.status === 'completed') lines.push(`This workflow ran successfully in ${formatDuration(run.durationMs)}.`);
    else if (run.status === 'failed') lines.push(`This workflow failed after ${formatDuration(run.durationMs)}.`);
    else if (run.status === 'running') lines.push('This workflow is currently running.');
    else if (run.status === 'paused') lines.push('This workflow is paused and needs operator action.');
    else if (run.status === 'waiting') lines.push('This workflow is waiting before it can continue.');
    return lines.join(' ');
  }, [run]);

  const nodes = run.nodes ?? [];
  const completedNodes = nodes.filter((n) => n.status === 'completed');
  const failedNode = nodes.find((n) => n.status === 'failed');

  return (
    <div className="space-y-6">
      {/* Narrative */}
      <p className="max-w-3xl text-[14px] leading-relaxed text-text-primary">{story}</p>

      {/* What happened */}
      {completedNodes.length > 0 && (
        <div>
          <h3 className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-text-muted">What happened</h3>
          <ol className="space-y-1.5">
            {nodes.map((n, i) => (
              <li
                key={n.id}
                onClick={() => onSelectNode(n)}
                className="flex cursor-pointer items-center gap-3 rounded-md border border-line bg-surface px-4 py-2.5 text-[13px] transition-colors hover:bg-surface-2"
              >
                <span className="font-mono text-[11px] text-text-muted">{i + 1}.</span>
                <StatusBadge status={n.status} size="sm" />
                <span className="flex-1 truncate text-text-primary">
                  {n.title}
                  {n.outputSummary && <span className="ml-2 text-text-muted">— {n.outputSummary}</span>}
                </span>
                <span className="text-[11px] text-text-muted">{formatDuration(n.durationMs)}</span>
              </li>
            ))}
          </ol>
        </div>
      )}

      {/* Key results */}
      {run.keyMetrics && run.keyMetrics.length > 0 && (
        <div>
          <h3 className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-text-muted">Key results</h3>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            {run.keyMetrics.map((m, i) => (
              <div key={i} className="rounded-card border border-line bg-surface p-4">
                <div className="text-display text-text-primary">{m.value}</div>
                <div className="mt-0.5 text-[11px] uppercase tracking-wider text-text-muted">{m.label}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {failedNode && (
        <div className="rounded-card border border-danger/20 bg-danger-soft p-4">
          <h3 className="text-subheading text-danger">Failed at "{failedNode.title}"</h3>
          {failedNode.error && (
            <pre className="w-full mt-2 max-h-40 overflow-y-auto whitespace-pre-wrap break-words rounded-input bg-surface-2 p-3 font-mono text-[12px] text-danger">
              {failedNode.error}
            </pre>
          )}
          <p className="mt-2 text-[12px] text-text-secondary">Click the node above to inspect its input.</p>
        </div>
      )}

      <p className="text-[12px] text-text-muted">Click any step above to inspect its inputs and outputs.</p>
    </div>
  );
}

function LiveRunActivity({ feed }: { feed: RealtimeActivity[] }) {
  return (
    <section className="mb-5 overflow-hidden rounded-card border border-line bg-surface">
      <header className="flex items-center gap-2 border-b border-line bg-surface-2 px-4 py-3">
        <span className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-accent/30 bg-accent-soft text-accent">
          <RadioTower size={14} />
        </span>
        <div className="min-w-0">
          <div className="text-[12px] font-semibold text-text-primary">Live execution</div>
          <div className="text-[11px] text-text-muted">Runtime trace</div>
        </div>
      </header>
      {feed.length === 0 ? (
        <div className="px-4 py-4 text-[12px] text-text-muted">No live events yet.</div>
      ) : (
        <div className="max-h-64 overflow-y-auto divide-y divide-line/70">
          {feed.slice(0, 12).map((item) => (
            <div key={item.id} className="grid grid-cols-[88px_1fr] gap-3 px-4 py-2.5">
              <span className="font-mono text-[10px] uppercase tracking-wide text-text-muted">{item.kind}</span>
              <div className="min-w-0">
                <div className="truncate text-[12px] font-medium text-text-primary">{item.nodeTitle ?? item.title}</div>
                <div className="mt-0.5 line-clamp-2 font-mono text-[10px] leading-snug text-text-secondary">{item.detail}</div>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function TechnicalView({ run, onSelectNode }: { run: RunDetail['run']; onSelectNode: (n: RunNode) => void }) {
  const nodes = run.nodes ?? [];
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Run ID" value={<span className="font-mono">{run.id}</span>} />
        <Stat label="Status" value={run.status} />
        <Stat label="Duration" value={formatDuration(run.durationMs)} />
        <Stat label="Cost" value={run.cost != null ? `$${run.cost.toFixed(4)}` : '—'} />
      </div>

      <div>
        <h3 className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-text-muted">Timeline</h3>
        <div className="overflow-hidden rounded-card border border-line bg-surface">
          <table className="w-full">
            <thead>
              <tr className="border-b border-line bg-surface-2 text-[11px] font-medium uppercase tracking-wider text-text-muted">
                <th className="px-4 py-2.5 text-left">#</th>
                <th className="px-4 py-2.5 text-left">Node</th>
                <th className="px-4 py-2.5 text-left">Type</th>
                <th className="px-4 py-2.5 text-left">Status</th>
                <th className="px-4 py-2.5 text-left">Duration</th>
                <th className="px-4 py-2.5 text-left">Output</th>
              </tr>
            </thead>
            <tbody>
              {nodes.map((n, i) => (
                <tr
                  key={n.id}
                  onClick={() => onSelectNode(n)}
                  className="cursor-pointer border-b border-line/60 last:border-b-0 hover:bg-surface-2"
                >
                  <td className="px-4 py-3 font-mono text-[12px] text-text-muted">{i + 1}</td>
                  <td className="px-4 py-3 text-[13px] text-text-primary">{n.title}</td>
                  <td className="px-4 py-3 font-mono text-[11px] text-text-muted">{n.kind ?? n.type}</td>
                  <td className="px-4 py-3"><StatusBadge status={n.status} size="sm" /></td>
                  <td className="px-4 py-3 text-[12px] text-text-muted">{formatDuration(n.durationMs)}</td>
                  <td className="px-4 py-3">
                    <div className="flex max-w-[300px] items-center gap-1 truncate font-mono text-[11px] text-text-secondary">
                      {n.outputSummary ?? (n.output ? JSON.stringify(n.output).slice(0, 40) + '…' : '—')}
                      <ChevronRight size={10} className="shrink-0 text-text-muted" />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="rounded-card border border-line bg-surface p-4">
      <div className="text-[11px] font-medium uppercase tracking-wider text-text-muted">{label}</div>
      <div className="mt-1 capitalize text-text-primary">{value}</div>
    </div>
  );
}
