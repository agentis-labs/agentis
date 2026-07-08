import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, ArrowRight, Bot, ChevronDown, ChevronRight, ExternalLink, MessageCircle, Settings, X } from 'lucide-react';
import clsx from 'clsx';
import { api } from '../../lib/api';
import { useRealtime } from '../../lib/realtime';
import { useRunActivity } from '../../lib/useRunActivity';
import { openRunModal } from '../../lib/runModal';
import {
  REALTIME_ACTIVITY_EVENTS,
  describeRealtimeActivity,
  type RealtimeActivity,
} from '../../lib/realtimeActivity';
import {
  isActiveObservation,
  type ObservationTone,
  type ObservabilityEvent,
} from '../../lib/observability';
import { SelectedAgentModelControl } from '../agents/SelectedAgentModelControl';
import { ApprovalPreviewCard, ApprovalReviewModal } from '../shared/ApprovalReviewModal';
import type { CanvasNode } from './homeCanvasTypes';

export function CanvasNodeDetailPanel({
  node,
  observabilityEvents = [],
  onClose,
  onNavigate,
  onOpenChat,
  onRefresh,
}: {
  node: CanvasNode | null;
  observabilityEvents?: ObservabilityEvent[];
  onClose: () => void;
  onNavigate: (route: string) => void;
  onOpenChat: (node: CanvasNode) => void;
  onRefresh: () => void;
}) {
  const [selectedApproval, setSelectedApproval] = useState<CanvasNode['approval'] | null>(null);

  if (!node) return null;
  const hasRoute = Boolean(node.route);
  const canChat = Boolean(node.agent);
  const state = node.operationalState ?? (node.warn ? 'attention' : node.active ? 'active' : 'idle');
  const nodeEvents = observabilityEvents.filter((event) => eventMatchesNode(event, node)).slice(0, 8);

  return (
    <div data-canvas-control className="pointer-events-none absolute inset-y-0 right-0 z-50 flex w-full max-w-[380px] items-stretch p-3">
      <aside className="pointer-events-auto flex min-h-0 w-full flex-col rounded-xl border border-line/90 bg-surface/96 shadow-xl backdrop-blur-xl">
        <header className="flex items-start gap-2.5 border-b border-line/80 px-3 py-3">
          <div
            className={clsx(
              'flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-card border',
              state === 'error'
                ? 'border-danger/45 bg-danger/10 text-danger'
                : state === 'attention'
                  ? 'border-warn/40 bg-warn-soft text-warn'
                  : state === 'active'
                    ? 'border-white/40 bg-white/10 text-text-primary'
                    : 'border-line bg-surface-2 text-text-secondary',
            )}
            style={{ color: node.accent ?? undefined }}
          >
            {node.imageUrl ? <img src={node.imageUrl} alt="" className="h-full w-full object-cover" /> : node.icon ?? <Bot size={18} />}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase text-text-muted">
              <span>{node.kindLabel ?? node.kind}</span>
              {state === 'active' && <span className="rounded-pill bg-white/10 px-1.5 py-0.5 text-text-primary">executing</span>}
              {state === 'attention' && <span className="rounded-pill bg-warn-soft px-1.5 py-0.5 text-warn">attention</span>}
              {state === 'error' && <span className="rounded-pill bg-danger-soft px-1.5 py-0.5 text-danger">error</span>}
            </div>
            <h2 className="mt-1 truncate text-[15px] font-semibold leading-tight text-text-primary">{node.title}</h2>
            <p className="mt-0.5 truncate text-[11px] text-text-secondary">{node.subtitle}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close detail panel"
            title="Close"
            className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-text-muted hover:bg-surface-2 hover:text-text-primary"
          >
            <X size={14} />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
          {node.agent && (
            <SelectedAgentModelControl
              agentId={node.agent.id}
              adapterType={node.agent.adapterType}
              onUpdated={onRefresh}
              variant="rail"
            />
          )}
          <NodeRealtimeSummary node={node} state={state} events={nodeEvents} />
          {(node.agent || node.workflow) && <NodeLiveFeed node={node} />}
          {node.agent && <AgentLiveState node={node} />}
          {node.workflow && <WorkflowRuntimeSection workflowId={node.workflow.id} onNavigate={onNavigate} />}

          {/* Workflow and agent nodes already have live state above; keep static
              metadata for quieter resource/knowledge nodes only. */}
          {!node.workflow && !node.agent && node.tooltipLines.length > 0 && (
            <section className="space-y-2">
              {node.tooltipLines.map((line) => (
                <div key={line} className="rounded-card border border-line bg-canvas/35 px-3 py-2 text-[12px] text-text-secondary">
                  {line}
                </div>
              ))}
            </section>
          )}

          {node.kind === 'approval' && (
            <section className="mt-4">
              {node.approval ? (
                <ApprovalPreviewCard approval={node.approval} onReview={setSelectedApproval} />
              ) : (
                <div className="rounded-card border border-warn/25 bg-warn-soft px-3 py-3 text-[12px] text-text-secondary">
                  This run is waiting for an operator decision.
                </div>
              )}
            </section>
          )}

          {node.ghost && (
            <section className="mt-4 rounded-card border border-dashed border-line bg-canvas/35 px-3 py-3 text-[12px] text-text-secondary">
              This slot is reserved for the next layer of the command tree.
            </section>
          )}
        </div>

        <footer className="flex flex-wrap items-center gap-2 border-t border-line/80 px-3 py-2.5">
          {canChat && (
            <button
              type="button"
              onClick={() => onOpenChat(node)}
              className="inline-flex h-8 items-center gap-1.5 rounded-btn bg-text-primary px-2.5 text-[12px] font-medium text-canvas hover:bg-white active:scale-[0.98]"
            >
              <MessageCircle size={14} />
              Give instruction
            </button>
          )}
          {hasRoute && (
            <button
              type="button"
              onClick={() => node.route && onNavigate(node.route)}
              className="inline-flex h-8 items-center gap-1.5 rounded-btn border border-line bg-surface-2 px-2.5 text-[12px] font-medium text-text-secondary hover:bg-surface-3 hover:text-text-primary"
            >
              <ExternalLink size={14} />
              Open
            </button>
          )}
          {/* App nodes: jump straight to the engine/settings (Domain Â· Owner)
              without drilling through the editor first. */}
          {node.workflow?.app && (
            <button
              type="button"
              onClick={() => onNavigate(`/apps/${node.workflow!.app!.id}?engine=1`)}
              className="inline-flex h-8 items-center gap-1.5 rounded-btn border border-line bg-surface-2 px-2.5 text-[12px] font-medium text-text-secondary hover:bg-surface-3 hover:text-text-primary"
            >
              <Settings size={14} />
              Settings
            </button>
          )}
          {node.ghost && (
            <button
              type="button"
              onClick={() => onNavigate('/agents')}
              className="inline-flex h-8 items-center gap-1.5 rounded-btn border border-line bg-surface-2 px-2.5 text-[12px] font-medium text-text-secondary hover:bg-surface-3 hover:text-text-primary"
            >
              <ArrowRight size={14} />
              Configure agents
            </button>
          )}
        </footer>
      </aside>
      <ApprovalReviewModal
        approval={selectedApproval ?? null}
        open={Boolean(selectedApproval)}
        onClose={() => setSelectedApproval(null)}
        onResolved={() => onRefresh()}
      />
    </div>
  );
}

type NodeDetailState = NonNullable<CanvasNode['operationalState']>;

const NODE_TONE_TEXT: Record<ObservationTone, string> = {
  accent: 'text-accent',
  success: 'text-emerald-400',
  warn: 'text-warn',
  danger: 'text-danger',
  muted: 'text-text-muted',
};

function NodeRealtimeSummary({
  node,
  state,
  events,
}: {
  node: CanvasNode;
  state: NodeDetailState;
  events: ObservabilityEvent[];
}) {
  const live = events.filter(isActiveObservation).length + (node.active ? 1 : 0);
  const waiting = events.filter((event) => event.status === 'waiting' || event.status === 'blocked' || event.kind === 'approval').length;
  const risk = events.filter((event) => event.status === 'failed').length + (state === 'error' || node.warn ? 1 : 0);
  const evidence = events.filter((event) => event.evidence.length > 0 || event.kind === 'tool' || event.kind === 'artifact' || event.kind === 'brain').length;
  const focus = events[0] ?? null;
  const tone = nodeSummaryTone(state, focus);
  const summary =
    focus?.summary ||
    focus?.detail ||
    focus?.title ||
    node.currentTask ||
    (state === 'idle' ? 'No active work in this node.' : 'Waiting for the next live signal.');

  return (
    <section className="mb-3 border-b border-line/70 pb-3">
      <div className="grid grid-cols-4 gap-1">
        <NodeSignalMetric value={live} label="work" tone={live > 0 ? 'accent' : 'muted'} />
        <NodeSignalMetric value={waiting} label="wait" tone={waiting > 0 ? 'warn' : 'muted'} />
        <NodeSignalMetric value={risk} label="risk" tone={risk > 0 ? 'danger' : 'muted'} />
        <NodeSignalMetric value={node.artifactCount ?? evidence} label="made" tone="muted" />
      </div>
      <div className="mt-2 flex items-center gap-2 rounded-md bg-canvas/35 px-2 py-1.5">
        <span className={clsx('h-1.5 w-1.5 shrink-0 rounded-full', nodeToneDot(tone), tone === 'accent' && 'animate-pulse')} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[11px] font-medium text-text-primary">{nodeStateLabel(state)}</div>
          <div className="truncate text-[10px] text-text-secondary">{summary}</div>
        </div>
        {focus && <span className="shrink-0 font-mono text-[9px] text-text-muted tabular-nums">{relTime(focus.createdAt)}</span>}
      </div>
    </section>
  );
}

function NodeSignalMetric({ value, label, tone }: { value: number; label: string; tone: ObservationTone }) {
  return (
    <div className="min-w-0 px-1 py-0.5">
      <div className={clsx('font-mono text-[12px] leading-none tabular-nums', NODE_TONE_TEXT[tone])}>{value}</div>
      <div className="mt-0.5 truncate text-[8px] uppercase tracking-[0.08em] text-text-muted">{label}</div>
    </div>
  );
}

function eventMatchesNode(event: ObservabilityEvent, node: CanvasNode): boolean {
  if (node.workflow?.id && event.workflowId === node.workflow.id) return true;
  if (node.agent?.id && (event.agentId === node.agent.id || event.actorId === node.agent.id)) return true;
  if (node.approval?.id && event.approvalId === node.approval.id) return true;
  return false;
}

function nodeSummaryTone(state: NodeDetailState, focus: ObservabilityEvent | null): ObservationTone {
  if (focus?.status === 'failed' || state === 'error') return 'danger';
  if (focus?.status === 'waiting' || focus?.status === 'blocked' || state === 'attention') return 'warn';
  if (focus && isActiveObservation(focus)) return 'accent';
  if (state === 'active') return 'accent';
  if (state === 'idle') return 'muted';
  return 'success';
}

function nodeToneDot(tone: ObservationTone): string {
  switch (tone) {
    case 'accent': return 'bg-accent';
    case 'success': return 'bg-emerald-400';
    case 'warn': return 'bg-warn';
    case 'danger': return 'bg-danger';
    default: return 'bg-text-muted/60';
  }
}

function nodeStateLabel(state: NodeDetailState): string {
  switch (state) {
    case 'active': return 'Working';
    case 'attention': return 'Needs operator';
    case 'error': return 'Failed';
    case 'offline': return 'Offline';
    default: return 'Available';
  }
}

/**
 * Live, streaming activity for the selected node â€” the agent's real reasoning /
 * steps / tool-calls (or its workflow's run), so the detail card shows what is
 * happening right now instead of a static snapshot. Fed by the workspace activity
 * spine; renders nothing until there's something to show.
 */
function NodeLiveFeed({ node }: { node: CanvasNode }) {
  const agentId = node.agent?.id;
  const workflowId = node.workflow?.id;
  const [feed, setFeed] = useState<RealtimeActivity[]>([]);
  const seqRef = useRef(0);

  useRealtime([...REALTIME_ACTIVITY_EVENTS], (env) => {
    const activity = describeRealtimeActivity(env);
    if (!activity) return;
    const match =
      (agentId && activity.agentId === agentId) || (workflowId && activity.workflowId === workflowId);
    if (!match) return;
    seqRef.current += 1;
    setFeed((current) => [{ ...activity, id: `${activity.id}:${seqRef.current}` }, ...current].slice(0, 6));
  });

  if (feed.length === 0) return null;

  return (
    <section className="mb-3 rounded-card border border-accent/25 bg-accent-soft/5 px-2.5 py-2.5">
      <div className="flex items-center gap-2">
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" />
        <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-accent">Live activity</span>
      </div>
      <div className="mt-2 space-y-1">
        {feed.map((item) => (
          <div key={item.id} className="flex items-start gap-2">
            <span className="mt-1 h-1 w-1 shrink-0 rounded-full bg-accent/70" />
            <span className="min-w-0 flex-1 line-clamp-2 font-mono text-[10px] leading-snug text-text-secondary">
              {item.agentName ? `${item.agentName}: ` : ''}{item.detail}
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}

// â”€â”€ Workflow runtime: latest run steps + history + live stream â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

interface RunSummaryRow {
  id: string;
  status: string;
  startedAt?: string;
  finishedAt?: string;
}
interface RunNodeRow {
  id: string;
  nodeId: string;
  title: string;
  status: string;
  durationMs?: number;
  output?: unknown;
  outputSummary?: string;
  error?: string;
}
interface RunDetail {
  id: string;
  status: string;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  nodes: RunNodeRow[];
}

function runStatusMeta(status: string | undefined): { color: string; label: string; live?: boolean } {
  switch ((status ?? '').toLowerCase()) {
    case 'running': case 'in_progress': case 'active':
      return { color: 'bg-accent', label: 'Running', live: true };
    case 'completed': case 'success':
      return { color: 'bg-emerald-500', label: 'Completed' };
    case 'failed': case 'error': case 'completed_with_errors':
      return { color: 'bg-rose-500', label: 'Failed' };
    case 'waiting': case 'paused': case 'blocked':
      return { color: 'bg-amber-500', label: 'Waiting' };
    case 'skipped': return { color: 'bg-text-muted/60', label: 'Skipped' };
    case 'pending': case 'queued': return { color: 'bg-text-muted', label: 'Pending' };
    default: return { color: 'bg-text-muted/40', label: status || 'Idle' };
  }
}

function renderOutput(output: unknown): string {
  if (output == null) return '';
  if (typeof output === 'string') return output;
  try { return JSON.stringify(output, null, 2); } catch { return String(output); }
}

/**
 * The runtime half of a workflow's canvas card â€” so a workflow node answers
 * "what did the last run do, where did it fail, what did it produce, and how
 * has it behaved" without ever opening /history or the editor. Streams live
 * while a run is active.
 */
function WorkflowRuntimeSection({ workflowId, onNavigate }: { workflowId: string; onNavigate: (route: string) => void }) {
  const [runs, setRuns] = useState<RunSummaryRow[] | null>(null);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [selectedStep, setSelectedStep] = useState<string | null>(null);
  const [showOutput, setShowOutput] = useState(true);
  const [showAllSteps, setShowAllSteps] = useState(false);

  const loadRuns = useCallback(() => {
    void api<{ runs: RunSummaryRow[] }>(`/v1/runs?workflowId=${encodeURIComponent(workflowId)}&limit=8`)
      .then((res) => {
        setRuns(res.runs ?? []);
        setSelectedRunId((current) => current ?? res.runs?.[0]?.id ?? null);
      })
      .catch(() => setRuns([]));
  }, [workflowId]);

  useEffect(() => { setRuns(null); setSelectedRunId(null); setDetail(null); loadRuns(); }, [loadRuns]);

  const loadDetail = useCallback((runId: string) => {
    void api<{ run: RunDetail }>(`/v1/runs/${runId}`)
      .then((res) => { setDetail(res.run); setSelectedStep((cur) => cur ?? res.run.nodes.find((n) => n.status === 'failed')?.nodeId ?? null); })
      .catch(() => setDetail(null));
  }, []);

  useEffect(() => { if (selectedRunId) { setSelectedStep(null); loadDetail(selectedRunId); } }, [selectedRunId, loadDetail]);

  // Live: while the selected run is active, stream its tail and refresh detail.
  const isActive = runStatusMeta(detail?.status).live ?? false;
  const liveFeed = useRunActivity(isActive ? selectedRunId : null, { cap: 8 });
  useEffect(() => {
    if (!isActive || !selectedRunId) return;
    loadDetail(selectedRunId);
    loadRuns();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveFeed.length]);

  if (runs === null) {
    return <div className="mb-3 rounded-card border border-line bg-canvas/55 px-3 py-2.5 text-[12px] text-text-muted">Loading runs...</div>;
  }
  if (runs.length === 0) {
    return (
      <div className="mb-3 rounded-card border border-line bg-canvas/55 px-3 py-2.5 text-[12px] text-text-muted">
        No runs yet. Trigger this workflow to see its steps, outputs, and live progress here.
      </div>
    );
  }

  const headMeta = runStatusMeta(detail?.status);
  const step = detail?.nodes.find((n) => n.nodeId === selectedStep) ?? detail?.nodes.find((n) => n.status === 'failed') ?? null;
  const outputText = step ? renderOutput(step.output) : '';

  return (
    <section className="mb-3 overflow-hidden rounded-card border border-line bg-canvas/55">
      {/* Latest run status */}
      <div className="flex items-center justify-between gap-2 border-b border-line/60 px-3 py-2.5">
        <span className="flex items-center gap-2 text-[12px] font-semibold text-text-primary">
          <span className={clsx('inline-block h-2 w-2 rounded-full', headMeta.color, headMeta.live && 'animate-pulse')} />
          {headMeta.label}
          {detail?.durationMs != null && <span className="font-mono text-[10px] font-normal text-text-muted">Â· {fmtDuration(detail.durationMs)}</span>}
        </span>
        <button type="button" onClick={() => selectedRunId && openRunModal({ runId: selectedRunId, workflowId, source: 'home-node-detail' })} className="inline-flex items-center gap-1 text-[10px] text-text-muted hover:text-accent">
          <ExternalLink size={10} /> Run
        </button>
      </div>

      {/* Step breakdown â€” a SUMMARY first. Big workflows have dozens of steps;
          listing them all is noise. Show counts + a segmented progress bar +
          only the steps that matter (failed / running / waiting); the full
          list stays one toggle away. */}
      {detail && detail.nodes.length > 0 && (() => {
        const total = detail.nodes.length;
        const done = detail.nodes.filter((n) => runStatusMeta(n.status).label === 'Completed').length;
        const failedSteps = detail.nodes.filter((n) => runStatusMeta(n.status).label === 'Failed');
        const liveSteps = detail.nodes.filter((n) => runStatusMeta(n.status).live);
        const waitingSteps = detail.nodes.filter((n) => runStatusMeta(n.status).label === 'Waiting');
        const interesting = [...failedSteps, ...liveSteps, ...waitingSteps];
        const shown = showAllSteps ? detail.nodes : interesting;
        return (
          <div className="px-3 py-2.5">
            {/* Segmented progress bar: one sliver per step, status-colored. */}
            <div className="flex items-center gap-2">
              <div className="flex h-1.5 flex-1 gap-px overflow-hidden rounded-pill bg-surface-2">
                {detail.nodes.map((n) => (
                  <button
                    key={n.nodeId}
                    type="button"
                    onClick={() => setSelectedStep(n.nodeId)}
                    title={`${n.title} Â· ${runStatusMeta(n.status).label}`}
                    className={clsx('h-full flex-1 transition-opacity hover:opacity-70', runStatusMeta(n.status).color, runStatusMeta(n.status).live && 'animate-pulse')}
                  />
                ))}
              </div>
              <span className="shrink-0 font-mono text-[10px] tabular-nums text-text-muted">
                {done}/{total}{failedSteps.length > 0 && <span className="text-danger"> Â· {failedSteps.length}âœ—</span>}
              </span>
            </div>
            {/* Only the steps that need attention; everything else behind a toggle. */}
            {(shown.length > 0 || total > 0) && (
              <div className="mt-2 flex flex-wrap items-center gap-1">
                {shown.map((n) => {
                  const meta = runStatusMeta(n.status);
                  const sel = n.nodeId === step?.nodeId;
                  return (
                    <button
                      key={n.nodeId}
                      type="button"
                      onClick={() => setSelectedStep(n.nodeId)}
                      title={`${n.title} Â· ${meta.label}${n.durationMs != null ? ` Â· ${fmtDuration(n.durationMs)}` : ''}`}
                      className={clsx(
                        'inline-flex max-w-[150px] items-center gap-1.5 rounded-pill border px-2 py-0.5 text-[10px]',
                        sel ? 'border-text-primary/40 bg-surface-2 text-text-primary' : 'border-line bg-canvas/40 text-text-muted hover:text-text-secondary',
                      )}
                    >
                      <span className={clsx('h-1.5 w-1.5 shrink-0 rounded-full', meta.color, meta.live && 'animate-pulse')} />
                      <span className="truncate">{n.title}</span>
                    </button>
                  );
                })}
                {!showAllSteps && shown.length === 0 && (
                  <span className="text-[10px] text-text-muted">All {total} steps completed.</span>
                )}
                <button
                  type="button"
                  onClick={() => setShowAllSteps((v) => !v)}
                  className="rounded-pill px-1.5 py-0.5 text-[10px] text-text-muted underline decoration-dotted underline-offset-2 hover:text-text-primary"
                >
                  {showAllSteps ? 'Hide steps' : `All steps (${total})`}
                </button>
              </div>
            )}
          </div>
        );
      })()}

      {/* Selected step output / error */}
      {step && (outputText || step.error) && (
        <div className="border-t border-line/60">
          <button type="button" onClick={() => setShowOutput((v) => !v)} className="flex w-full items-center gap-1 px-3 py-1.5 text-[10px] uppercase tracking-wide text-text-muted hover:text-text-secondary">
            {showOutput ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
            {step.error ? `Error Â· ${step.title}` : `Output Â· ${step.title}`}
          </button>
          {showOutput && (
            <div className="px-3 pb-2.5">
              {step.error ? (
                <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded bg-danger/10 p-2 text-[11px] leading-snug text-danger">{step.error}</pre>
              ) : (
                <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded bg-[#141414] p-2 font-mono text-[10.5px] leading-snug text-text-secondary">
                  {outputText.length > 3000 ? `${outputText.slice(0, 3000)}\nâ€¦` : outputText}
                </pre>
              )}
            </div>
          )}
        </div>
      )}

      {/* Recent-run history â€” each run is a readable row (status Â· when Â· how
          long), selectable to load its steps above. Far more legible than a
          row of anonymous dots. */}
      <div className="border-t border-line/60">
        <div className="px-3 pt-2 pb-1 text-[10px] uppercase tracking-wide text-text-muted">
          History <span className="text-text-muted/70">Â· {runs.length}</span>
        </div>
        <div className="max-h-40 overflow-y-auto pb-1.5">
          {runs.map((r) => {
            const meta = runStatusMeta(r.status);
            const when = r.finishedAt ?? r.startedAt;
            const dur = r.startedAt && r.finishedAt
              ? new Date(r.finishedAt).getTime() - new Date(r.startedAt).getTime()
              : undefined;
            const selected = r.id === selectedRunId;
            return (
              <button
                key={r.id}
                type="button"
                onClick={() => setSelectedRunId(r.id)}
                className={clsx(
                  'group flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors',
                  selected ? 'bg-surface-2' : 'hover:bg-surface-2/50',
                )}
              >
                <span className={clsx('h-2 w-2 shrink-0 rounded-full', meta.color, meta.live && 'animate-pulse')} />
                <span className={clsx('w-[64px] shrink-0 text-[11px] font-medium', selected ? 'text-text-primary' : 'text-text-secondary')}>{meta.label}</span>
                <span className="min-w-0 flex-1 truncate text-[10px] text-text-muted">{relTime(when) || 'â€”'}</span>
                {dur != null && <span className="shrink-0 font-mono text-[10px] tabular-nums text-text-muted">{fmtDuration(dur)}</span>}
                <ExternalLink
                  size={11}
                  className="shrink-0 text-text-muted opacity-0 transition-opacity group-hover:opacity-100 hover:text-accent"
                  onClick={(e) => { e.stopPropagation(); openRunModal({ runId: r.id, workflowId, source: 'home-node-history' }); }}
                />
              </button>
            );
          })}
        </div>
      </div>
    </section>
  );
}

function fmtDuration(ms?: number): string {
  if (ms == null || !Number.isFinite(ms)) return '';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

function relTime(iso?: string): string {
  if (!iso) return '';
  const diff = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(diff)) return '';
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

function AgentLiveState({ node }: { node: CanvasNode }) {
  const state = node.operationalState ?? (node.warn ? 'attention' : node.active ? 'active' : 'idle');
  const label =
    state === 'active'
      ? 'Executing'
      : state === 'error'
        ? 'Error'
        : state === 'offline'
          ? 'Offline'
          : state === 'attention'
            ? 'Waiting on operator'
            : 'Idle';
  const output = node.outputLines?.slice(-5) ?? [];

  if (state === 'idle' && !node.currentTask && !node.currentTool && !node.runtimeError && output.length === 0) {
    return null;
  }

  return (
    <section className="mb-3 rounded-card border border-line bg-canvas/55 px-2.5 py-2.5">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="font-mono text-[10px] uppercase tracking-[0.16em] text-text-muted">{label}</div>
          <div className="mt-1 text-[12px] text-text-primary">
            {node.currentTask ?? (state === 'idle' ? 'No active run. Showing last known workspace state.' : 'Awaiting live execution details.')}
          </div>
        </div>
        <span className="font-mono text-[10px] text-text-muted">{node.artifactCount ?? 0} today</span>
      </div>

      {node.currentTool && (
        <div className="mt-3 rounded-card border border-line bg-[#141414] px-3 py-2">
          <div className="font-mono text-[10px] uppercase tracking-wide text-text-muted">Current tool call</div>
          <div className="mt-1 truncate font-mono text-[12px] text-text-primary">{node.currentTool}</div>
        </div>
      )}

      {node.runtimeError && (
        <div className="mt-3 rounded-card border border-danger/30 bg-danger/5 px-3 py-2">
          <div className="font-mono text-[10px] uppercase tracking-wide text-danger">Failure detail</div>
          <div className="mt-1 text-[12px] leading-relaxed text-text-secondary">{node.runtimeError}</div>
        </div>
      )}

      {output.length > 0 && (
        <div className="mt-3 rounded-card border border-line bg-[#141414] px-3 py-2">
          <div className="font-mono text-[10px] uppercase tracking-wide text-text-muted">Output stream</div>
          <div className="mt-2 space-y-1">
            {output.map((line, index) => (
              <div key={`${line}-${index}`} className="truncate font-mono text-[12px] text-text-secondary">
                {line}
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}



