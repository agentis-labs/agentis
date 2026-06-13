/**
 * WorkflowOutputTab - immutable output history for one workflow.
 *
 * Every completed run remains selectable. The primary viewer renders the exact
 * delivered artifact first, followed by any declared terminal summaries.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ExternalLink, History, RotateCcw } from 'lucide-react';
import { REALTIME_EVENTS } from '@agentis/core';
import clsx from 'clsx';
import { api, apiErrorMessage, workspace as workspaceStore } from '../../lib/api';
import { rtSubscribe, useRealtime, type RealtimeEnvelope } from '../../lib/realtime';
import { formatDuration, relativeTime, type WorkflowRunSummary } from './runFormat';
import { RunOutputCard, type FinalNodeOutput } from './RunOutputCard';
import { WorkflowRecordBrowser, type RecordTable } from './WorkflowRecordBrowser';
import { WorkflowArtifactGrid, type RunArtifact } from './WorkflowArtifactGrid';

const STATUS_DOT: Record<WorkflowRunSummary['status'], string> = {
  running: 'bg-accent animate-pulse-dot',
  completed: 'bg-accent',
  completed_with_violation: 'bg-warn',
  failed: 'bg-danger',
  pending: 'bg-warn',
  paused: 'bg-warn',
  waiting: 'bg-warn',
  cancelled: 'bg-text-muted',
};

interface OutputRunEntry {
  run: WorkflowRunSummary;
  outputs: FinalNodeOutput[];
}

interface OutputResponse {
  lastRun: WorkflowRunSummary | null;
  outputs: FinalNodeOutput[];
  runs?: OutputRunEntry[];
  hasMore?: boolean;
}

function runStatusLabel(status: WorkflowRunSummary['status']): string {
  if (status === 'completed_with_violation') return 'Completed with violation';
  return status.charAt(0).toUpperCase() + status.slice(1);
}

function absoluteTime(value: string | null | undefined): string {
  if (!value) return 'Unknown time';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}

export function WorkflowOutputTab({
  workflowId,
  onRun,
}: {
  workflowId: string;
  onRun: () => void;
}) {
  const nav = useNavigate();
  const [data, setData] = useState<OutputResponse | null>(null);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [tables, setTables] = useState<RecordTable[]>([]);
  const [artifacts, setArtifacts] = useState<RunArtifact[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const ctaRef = useRef<HTMLButtonElement | null>(null);

  const load = useCallback(async () => {
    try {
      const output = await api<OutputResponse>(`/v1/workflows/${workflowId}/output?limit=20`);
      setData(output);
      setSelectedRunId((current) => {
        const runs = output.runs ?? [];
        return current && runs.some((entry) => entry.run.id === current)
          ? current
          : runs[0]?.run.id ?? output.lastRun?.id ?? null;
      });
      setError(null);
      try {
        const records = await api<{ tables: RecordTable[] }>(`/v1/workflows/${workflowId}/records`);
        setTables(records.tables ?? []);
      } catch {
        setTables([]);
      }
    } catch (e) {
      setError(apiErrorMessage(e));
    } finally {
      setLoading(false);
    }
  }, [workflowId]);

  useEffect(() => {
    setLoading(true);
    void load();
  }, [load]);

  const history = useMemo<OutputRunEntry[]>(() => {
    if (data?.runs?.length) return data.runs;
    return data?.lastRun ? [{ run: data.lastRun, outputs: data.outputs }] : [];
  }, [data]);

  const selected = useMemo(
    () => history.find((entry) => entry.run.id === selectedRunId) ?? history[0] ?? null,
    [history, selectedRunId],
  );

  useEffect(() => {
    if (!selected?.run.id) {
      setArtifacts([]);
      return;
    }
    let active = true;
    void api<{ artifacts: RunArtifact[] }>(`/v1/artifacts?runId=${selected.run.id}`)
      .then((response) => {
        if (active) setArtifacts(response.artifacts ?? []);
      })
      .catch(() => {
        if (active) setArtifacts([]);
      });
    return () => {
      active = false;
    };
  }, [selected?.run.id]);

  useEffect(() => {
    const ws = workspaceStore.get();
    if (!ws) return;
    return rtSubscribe('workspace', { workspaceId: ws });
  }, []);

  const events = useMemo(
    () => [REALTIME_EVENTS.RUN_COMPLETED, REALTIME_EVENTS.RUN_FAILED],
    [],
  );
  useRealtime(events, (env: RealtimeEnvelope) => {
    const payload = (env.payload ?? {}) as { workflowId?: string };
    if (payload.workflowId && payload.workflowId !== workflowId) return;
    void load();
  });

  useEffect(() => {
    if (!loading && !error && history.length === 0) ctaRef.current?.focus();
  }, [loading, error, history.length]);

  return (
    <div className="mx-auto w-full max-w-6xl px-5 py-6 lg:px-7">
      <div className="mb-5 flex items-end justify-between gap-4">
        <div>
          <div className="mb-1 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.16em] text-text-muted">
            <History size={13} />
            Output history
          </div>
          <p className="max-w-2xl text-[13px] leading-relaxed text-text-secondary">
            Exact delivered artifacts and declared results, preserved for every completed run.
          </p>
        </div>
        {history.length > 0 && (
          <span className="font-mono text-[11px] text-text-muted">
            {history.length}{data?.hasMore ? '+' : ''} run{history.length === 1 ? '' : 's'}
          </span>
        )}
      </div>

      {error && (
        <div className="rounded-card border border-danger/40 bg-danger-soft px-4 py-3 text-[12px] text-danger">
          Failed to load output: {error}
        </div>
      )}

      {!error && loading && (
        <div className="grid gap-5 lg:grid-cols-[260px_minmax(0,1fr)]">
          <div className="space-y-2 border-r border-line/70 pr-5">
            {[0, 1, 2].map((index) => (
              <div key={index} className="h-16 animate-pulse rounded-lg bg-surface-2" />
            ))}
          </div>
          <div className="h-80 animate-pulse rounded-card border border-line bg-surface" />
        </div>
      )}

      {!error && !loading && history.length === 0 && (
        <div className="rounded-card border border-line bg-surface px-6 py-14 text-center">
          <p className="text-[13px] text-text-secondary">
            No output yet. Run this workflow to create its first immutable result.
          </p>
          <button
            ref={ctaRef}
            type="button"
            onClick={onRun}
            className="mt-4 inline-flex h-9 items-center gap-1.5 rounded-btn bg-accent px-3 text-[13px] font-semibold text-canvas transition-transform hover:bg-accent-hover active:scale-[0.98]"
          >
            Run now
          </button>
        </div>
      )}

      {!error && !loading && selected && (
        <div className="grid items-start gap-5 lg:grid-cols-[260px_minmax(0,1fr)]">
          <aside aria-label="Output runs" className="lg:sticky lg:top-4">
            <div className="mb-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-text-muted">
              Runs
            </div>
            <div className="flex gap-2 overflow-x-auto pb-2 lg:block lg:space-y-1.5 lg:overflow-visible lg:border-r lg:border-line/70 lg:pb-0 lg:pr-5">
              {history.map((entry, index) => {
                const active = entry.run.id === selected.run.id;
                return (
                  <button
                    key={entry.run.id}
                    type="button"
                    aria-pressed={active}
                    onClick={() => setSelectedRunId(entry.run.id)}
                    className={clsx(
                      'min-w-[220px] rounded-lg border px-3 py-2.5 text-left transition-colors active:scale-[0.99] lg:min-w-0 lg:w-full',
                      active
                        ? 'border-accent/35 bg-accent/8'
                        : 'border-transparent bg-transparent hover:border-line hover:bg-surface-2',
                    )}
                  >
                    <div className="flex items-center gap-2">
                      <span className={clsx('h-1.5 w-1.5 rounded-full', STATUS_DOT[entry.run.status])} />
                      <span className="truncate text-[12px] font-medium text-text-primary">
                        {absoluteTime(entry.run.finishedAt ?? entry.run.startedAt)}
                      </span>
                      {index === 0 && (
                        <span className="ml-auto rounded-full bg-surface-3 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-text-muted">
                          Latest
                        </span>
                      )}
                    </div>
                    <div className="mt-1 flex items-center gap-2 pl-3.5 text-[10px] text-text-muted">
                      <span>{runStatusLabel(entry.run.status)}</span>
                      <span>{formatDuration(entry.run.durationMs)}</span>
                      <span>{entry.outputs.length} output{entry.outputs.length === 1 ? '' : 's'}</span>
                    </div>
                  </button>
                );
              })}
            </div>
            {data?.hasMore && (
              <p className="mt-2 text-[10px] leading-relaxed text-text-muted">
                Showing the 20 most recent completed runs.
              </p>
            )}
          </aside>

          <main className="min-w-0">
            <section role="region" aria-label="Selected run output" className="overflow-hidden rounded-card border border-line bg-surface">
              <header className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-3">
                <span className={clsx('h-2 w-2 shrink-0 rounded-full', STATUS_DOT[selected.run.status])} />
                <span className="text-[13px] font-medium text-text-primary">
                  {runStatusLabel(selected.run.status)}
                </span>
                <span className="text-[12px] text-text-muted">{relativeTime(selected.run.startedAt)}</span>
                <span className="font-mono text-[11px] text-text-secondary">
                  {formatDuration(selected.run.durationMs)}
                </span>
                <div className="ml-auto flex items-center gap-1">
                  <button
                    type="button"
                    onClick={onRun}
                    className="inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-[11px] font-medium text-text-secondary hover:bg-surface-2 hover:text-text-primary active:scale-[0.98]"
                    title="Run this workflow again"
                  >
                    <RotateCcw size={12} />
                    Re-run
                  </button>
                  <button
                    type="button"
                    onClick={() => nav(`/runs/${selected.run.id}`)}
                    className="inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-[11px] font-medium text-accent hover:bg-accent/8 active:scale-[0.98]"
                  >
                    View run
                    <ExternalLink size={12} />
                  </button>
                </div>
              </header>

              {selected.run.contractViolations && selected.run.contractViolations.length > 0 && (
                <div className="border-b border-warn/30 bg-warn-soft px-4 py-3">
                  <div className="mb-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-warn">
                    Output contract violations
                  </div>
                  <ul className="space-y-1 text-[12px] text-text-secondary">
                    {selected.run.contractViolations.map((violation, index) => (
                      <li key={index}>{violation}</li>
                    ))}
                  </ul>
                </div>
              )}

              <div className="p-4 sm:p-5">
                {selected.outputs.length > 0 ? (
                  <div className="space-y-7">
                    {selected.outputs.map((output) => (
                      <RunOutputCard key={`${output.nodeId}-${output.role ?? 'output'}`} output={output} />
                    ))}
                  </div>
                ) : (
                  <p className="py-8 text-center text-[12px] text-text-muted">
                    This run completed but produced no captured output.
                  </p>
                )}
              </div>
            </section>

            <WorkflowArtifactGrid artifacts={artifacts} />
          </main>
        </div>
      )}

      {tables.length > 0 && (
        <section role="region" aria-label="Accumulated records" className="mt-8 border-t border-line pt-6">
          <h2 className="mb-1 text-[11px] font-semibold uppercase tracking-[0.14em] text-text-muted">
            Accumulated records
          </h2>
          <p className="mb-3 text-[12px] text-text-muted">
            Persistent records written across all workflow runs.
          </p>
          <div className="space-y-4">
            {tables.map((table) => (
              <WorkflowRecordBrowser
                key={table.table}
                workflowId={workflowId}
                initial={table}
                onCleared={() => void load()}
              />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
