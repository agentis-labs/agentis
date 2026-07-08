/**
 * HistoryPage — unified events: workflow runs + agent activity + audit.
 *
 * Replaces /runs (list), /activity, and the legacy ledger surfaces.
 * Click any event row → detail panel slides in from the right.
 */

import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  Clock, SearchX, Eye, RotateCcw, ArrowRight, AlertTriangle, Check, X, Bot,
} from 'lucide-react';
import { REALTIME_EVENTS } from '@agentis/core';
import { api, apiCached, peekCached, apiErrorMessage, workspace as wsStore } from '../lib/api';
import { useRealtime, rtSubscribe } from '../lib/realtime';
import { useToast } from '../components/shared/Toast';
import { Tabs } from '../components/shared/Tabs';
import { Button } from '../components/shared/Button';
import { SearchInput } from '../components/shared/SearchInput';
import { Skeleton } from '../components/shared/Skeleton';
import { EmptyState } from '../components/shared/EmptyState';
import { StatusBadge } from '../components/shared/StatusBadge';
import { DetailPanel } from '../components/shared/DetailPanel';
import { openRunModal } from '../lib/runModal';

type EventType = 'all' | 'runs' | 'activity' | 'audit';

interface HistoryEvent {
  id: string;
  type: typeof REALTIME_EVENTS.RUN_COMPLETED | typeof REALTIME_EVENTS.RUN_FAILED | 'agent.task' | 'audit' | string;
  title: string;
  subtitle?: string;
  timestamp: string;
  status?: string;
  runId?: string;
  workflowId?: string;
  failedNodeId?: string;
  agentId?: string;
  agentName?: string;
  workflowName?: string;
  failedNode?: string;
  context?: Record<string, unknown>;
}

function relativeTime(iso: string): string {
  try {
    const d = Date.now() - new Date(iso).getTime();
    if (d < 60000) return 'just now';
    if (d < 3600_000) return `${Math.floor(d / 60000)}m ago`;
    if (d < 86_400_000) return `${Math.floor(d / 3600_000)}h ago`;
    return `${Math.floor(d / 86_400_000)}d ago`;
  } catch { return ''; }
}

function dateBucket(iso: string): string {
  try {
    const d = new Date(iso);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const yesterday = new Date(today.getTime() - 86_400_000);
    const dStart = new Date(d); dStart.setHours(0, 0, 0, 0);
    if (dStart.getTime() === today.getTime()) return 'Today';
    if (dStart.getTime() === yesterday.getTime()) return 'Yesterday';
    return d.toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' });
  } catch { return 'Unknown date'; }
}

export function HistoryPage() {
  const nav = useNavigate();
  const toast = useToast();
  const [searchParams] = useSearchParams();
  const [tab, setTab] = useState<EventType>((searchParams.get('tab') as EventType) || 'all');
  const historyPath = (t: EventType) => `/v1/history?type=${t}&limit=200`;
  const [events, setEvents] = useState<HistoryEvent[]>(() => peekCached<{ events: HistoryEvent[] }>(historyPath(tab))?.events ?? []);
  const [loading, setLoading] = useState(() => peekCached(historyPath(tab)) === undefined);
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<HistoryEvent | null>(null);

  async function refresh() {
    // Silent revalidation when this tab is already cached on screen.
    if (peekCached(historyPath(tab)) === undefined) setLoading(true);
    try {
      const data = await apiCached<{ events: HistoryEvent[] }>(historyPath(tab));
      setEvents(data.events ?? []);
    } catch {
      // Fallback: synthesize from /v1/runs
      try {
        const runs = await api<{ runs: Array<{ id: string; status: string; workflowId?: string; workflowName?: string; finishedAt?: string; startedAt?: string; failedNode?: string; failedNodeId?: string }> }>(
          '/v1/runs?limit=100',
        );
        setEvents((runs.runs ?? []).map((r) => ({
          id: `run-${r.id}`,
          type: r.status === 'failed' ? REALTIME_EVENTS.RUN_FAILED : REALTIME_EVENTS.RUN_COMPLETED,
          title: r.status === 'failed' ? `${r.workflowName ?? 'Workflow'} failed` : `${r.workflowName ?? 'Workflow'} completed`,
          timestamp: r.finishedAt ?? r.startedAt ?? new Date().toISOString(),
          status: r.status,
          runId: r.id,
          workflowId: r.workflowId,
          workflowName: r.workflowName,
          failedNodeId: r.failedNodeId,
          failedNode: r.failedNode,
        })));
      } catch { setEvents([]); }
    } finally { setLoading(false); }
  }

  useEffect(() => {
    const ws = wsStore.get();
    const unsubscribe = ws ? rtSubscribe('workspace', { workspaceId: ws }) : undefined;
    void refresh();
    return () => unsubscribe?.();
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, [tab]);

  useEffect(() => {
    const runId = searchParams.get('runId');
    if (runId) openRunModal({ runId, source: 'history-query' });
  }, [searchParams]);

  useRealtime([
    REALTIME_EVENTS.RUN_COMPLETED,
    REALTIME_EVENTS.RUN_FAILED,
    REALTIME_EVENTS.AGENT_TASK_COMPLETED,
  ], () => { void refresh(); });

  const filtered = useMemo(() => {
    if (!search.trim()) return events;
    const q = search.toLowerCase();
    return events.filter((e) =>
      e.title.toLowerCase().includes(q)
      || (e.subtitle ?? '').toLowerCase().includes(q)
      || (e.workflowName ?? '').toLowerCase().includes(q)
      || (e.agentName ?? '').toLowerCase().includes(q),
    );
  }, [events, search]);

  const grouped = useMemo(() => {
    const map = new Map<string, HistoryEvent[]>();
    for (const e of filtered) {
      const k = dateBucket(e.timestamp);
      if (!map.has(k)) map.set(k, []);
      map.get(k)!.push(e);
    }
    return map;
  }, [filtered]);

  async function handleRetry(runId: string) {
    try { await api(`/v1/runs/${runId}/retry`, { method: 'POST' }); toast.success('Retry started'); void refresh(); }
    catch (e) { toast.error('Retry failed', apiErrorMessage(e)); }
  }

  function inspectRun(event: HistoryEvent) {
    if (!event.runId) return;
    openRunModal({
      runId: event.runId,
      workflowId: event.workflowId ?? (typeof event.context?.workflowId === 'string' ? event.context.workflowId : undefined),
      focusNodeId: event.failedNodeId,
      source: 'history',
    });
  }

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-line px-6 py-4">
        <h1 className="text-display text-text-primary">History</h1>
        <div className="mt-0.5 text-[12px] text-text-muted">Workflow runs, agent activity, and audit events</div>
      </div>

      <Tabs
        value={tab}
        onChange={(v) => setTab(v as EventType)}
        tabs={[
          { value: 'all',      label: 'All' },
          { value: 'runs',     label: 'Workflow runs' },
          { value: 'activity', label: 'Agent activity' },
          { value: 'audit',    label: 'Audit' },
        ]}
        className="px-6"
      />

      <div className="flex flex-wrap items-center gap-3 border-b border-line px-6 py-3">
        <div className="ml-auto w-full sm:w-72">
          <SearchInput value={search} onChange={setSearch} placeholder="Search history…" bindSlashShortcut />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-5">
        {loading && filtered.length === 0 ? (
          <div className="space-y-2">
            <Skeleton height={48} /><Skeleton height={48} /><Skeleton height={48} />
          </div>
        ) : filtered.length === 0 ? (
          events.length === 0 ? (
            <EmptyState
              icon={<Clock size={48} />}
              title="No history yet"
              body="Workflows you run will appear here with full details."
              primaryAction={<Button variant="primary" size="md" onClick={() => nav('/workflows')}>View workflows</Button>}
              variant="page"
            />
          ) : (
            <EmptyState
              icon={<SearchX size={48} />}
              title="No matching events"
              body="Try adjusting your search."
              primaryAction={<Button variant="secondary" size="sm" onClick={() => setSearch('')}>Clear search</Button>}
              variant="page"
            />
          )
        ) : (
          Array.from(grouped.entries()).map(([bucket, list]) => (
            <div key={bucket} className="mb-6 last:mb-0">
              <div className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-text-muted">
                {bucket} · {list.length}
              </div>
              <div className="space-y-1">
                {list.map((e) => (
                  <button
                    key={e.id}
                    type="button"
                    onClick={() => setSelected(e)}
                    className="flex w-full items-center gap-3 rounded-md border border-line bg-surface px-4 py-3 text-left transition-colors hover:bg-surface-2"
                  >
                    <span className="text-[12px] tabular-nums text-text-muted">
                      {new Date(e.timestamp).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}
                    </span>
                    <StatusBadge status={e.status ?? 'info'} size="sm" />
                    <span className="flex-1 truncate text-[13px] text-text-primary">{e.title}</span>
                    {e.type === REALTIME_EVENTS.RUN_FAILED && e.runId && (
                      <Button variant="secondary" size="sm" iconLeft={<RotateCcw size={11} />} onClick={(ev) => { ev.stopPropagation(); void handleRetry(e.runId!); }}>Retry</Button>
                    )}
                    {(e.type === REALTIME_EVENTS.RUN_COMPLETED || e.type === REALTIME_EVENTS.RUN_FAILED) && e.runId && (
                      <Button variant="ghost" size="sm" iconRight={<ArrowRight size={11} />} onClick={(ev) => { ev.stopPropagation(); inspectRun(e); }}>Inspect</Button>
                    )}
                  </button>
                ))}
              </div>
            </div>
          ))
        )}
      </div>

      <DetailPanel
        open={!!selected}
        onClose={() => setSelected(null)}
        title={selected?.title ?? 'Event'}
        subtitle={selected ? `${new Date(selected.timestamp).toLocaleString()} · ${selected.type}` : undefined}
        width="md"
      >
        {selected && (
          <div className="space-y-4">
            {selected.workflowName && (
              <KV k="Workflow" v={selected.workflowName} />
            )}
            {selected.agentName && (
              <KV k="Agent" v={selected.agentName} />
            )}
            {selected.runId && (
              <KV k="Run" v={
                <button onClick={() => inspectRun(selected)} className="text-accent hover:underline">
                  run_{selected.runId.slice(-8)}
                </button>
              } />
            )}
            {selected.failedNode && (
              <KV k="Failed at" v={<span className="text-danger">{selected.failedNode}</span>} />
            )}
            {selected.context && (
              <div>
                <div className="mb-1.5 text-[11px] font-medium uppercase tracking-wider text-text-muted">Context</div>
                <pre className="overflow-x-auto rounded-card border border-line bg-surface-2 p-3 font-mono text-[12px] text-text-primary">
                  {JSON.stringify(selected.context, null, 2)}
                </pre>
              </div>
            )}
            <div className="flex gap-1.5">
              {selected.runId && (
                <Button variant="primary" size="sm" iconLeft={<Eye size={11} />} onClick={() => inspectRun(selected)}>Inspect run</Button>
              )}
              {selected.type === REALTIME_EVENTS.RUN_FAILED && selected.runId && (
                <Button variant="secondary" size="sm" iconLeft={<RotateCcw size={11} />} onClick={() => void handleRetry(selected.runId!)}>Retry</Button>
              )}
            </div>
          </div>
        )}
      </DetailPanel>
    </div>
  );
}

function KV({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="flex items-baseline gap-3">
      <div className="w-24 shrink-0 text-[11px] font-medium uppercase tracking-wider text-text-muted">{k}</div>
      <div className="min-w-0 flex-1 text-[13px] text-text-primary">{v}</div>
    </div>
  );
}



