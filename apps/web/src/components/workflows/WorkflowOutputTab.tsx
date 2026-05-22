/**
 * WorkflowOutputTab — what the workflow produced.
 *
 * Tab 3 of the workflow page (WORKFLOW-PAGE-REDESIGN.md §Tab 3):
 *   Section A — Last Run Result   (always shown)
 *   Section B — Accumulated Records (only when the graph has data_write nodes)
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { REALTIME_EVENTS } from '@agentis/core';
import clsx from 'clsx';
import { api, workspace as workspaceStore } from '../../lib/api';
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
  cancelled: 'bg-text-muted',
};

interface OutputResponse {
  lastRun: WorkflowRunSummary | null;
  outputs: FinalNodeOutput[];
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
  const [tables, setTables] = useState<RecordTable[]>([]);
  const [artifacts, setArtifacts] = useState<RunArtifact[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const ctaRef = useRef<HTMLButtonElement | null>(null);

  const load = useCallback(async () => {
    try {
      const output = await api<OutputResponse>(`/v1/workflows/${workflowId}/output`);
      setData(output);
      setError(null);
      // Artifacts the run produced (artifact_save / artifact_collect). Optional
      // surface — never let it fail the whole output view.
      if (output.lastRun?.id) {
        try {
          const res = await api<{ artifacts: RunArtifact[] }>(`/v1/artifacts?runId=${output.lastRun.id}`);
          setArtifacts(res.artifacts ?? []);
        } catch {
          setArtifacts([]);
        }
      } else {
        setArtifacts([]);
      }
      // Record tables are an optional, secondary surface — their endpoint may
      // not exist for every workflow. Never let it fail the whole output view.
      try {
        const records = await api<{ tables: RecordTable[] }>(`/v1/workflows/${workflowId}/records`);
        setTables(records.tables ?? []);
      } catch {
        setTables([]);
      }
    } catch (e) {
      setError((e as { message?: string })?.message ?? String(e));
    } finally {
      setLoading(false);
    }
  }, [workflowId]);

  useEffect(() => {
    setLoading(true);
    void load();
  }, [load]);

  // Realtime: when a run of this workflow finishes, refresh the output.
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

  // A11y: focus the empty-state CTA when there is no output to show.
  useEffect(() => {
    if (!loading && !error && !data?.lastRun) ctaRef.current?.focus();
  }, [loading, error, data]);

  return (
    <div className="mx-auto w-full max-w-4xl px-6 py-6">
      <section role="region" aria-label="Last run output" className="mb-8">
        <h2 className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-text-muted">
          Last run
        </h2>

        {error && (
          <div className="rounded-card border border-danger/40 bg-danger-soft px-4 py-3 text-[12px] text-danger">
            Failed to load output: {error}
          </div>
        )}

        {!error && loading && (
          <p className="py-12 text-center text-[13px] text-text-muted">Loading output…</p>
        )}

        {!error && !loading && !data?.lastRun && (
          <div className="rounded-card border border-line bg-surface px-6 py-12 text-center">
            <p className="text-[13px] text-text-secondary">
              No output yet. Run this workflow to see what it produces.
            </p>
            <button
              ref={ctaRef}
              type="button"
              onClick={onRun}
              className="mt-3 inline-flex h-9 items-center gap-1.5 rounded-btn bg-accent px-3 text-[13px] font-semibold text-canvas hover:bg-accent-hover"
            >
              Run now
            </button>
          </div>
        )}

        {!error && !loading && data?.lastRun && (
          <div className="rounded-card border border-line bg-surface">
            <div className="flex items-center gap-2 border-b border-line px-4 py-2.5">
              <span
                className={clsx('h-2 w-2 shrink-0 rounded-full', STATUS_DOT[data.lastRun.status])}
              />
              <span className="text-[13px] font-medium text-text-primary">
                {data.lastRun.status === 'completed_with_violation' ? 'Completed (contract violation)' : <span className="capitalize">{data.lastRun.status}</span>}
              </span>
              <span className="text-[12px] text-text-muted">{relativeTime(data.lastRun.startedAt)}</span>
              <span className="font-mono text-[12px] text-text-secondary">
                {formatDuration(data.lastRun.durationMs)}
              </span>
              <button
                type="button"
                onClick={() => nav(`/runs/${data.lastRun!.id}`)}
                className="ml-auto text-[12px] font-medium text-accent hover:text-accent-hover"
              >
                View run →
              </button>
            </div>
            {data.lastRun.contractViolations && data.lastRun.contractViolations.length > 0 && (
              <div className="border-b border-warn/30 bg-warn-soft px-4 py-2.5">
                <div className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-warn">
                  Output contract violations
                </div>
                <ul className="space-y-0.5 text-[12px] text-text-secondary">
                  {data.lastRun.contractViolations.map((v, i) => (
                    <li key={i} className="flex items-start gap-1.5">
                      <span className="mt-0.5 text-warn">•</span>
                      <span>{v}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <div className="p-4">
              {data.outputs.length > 0 ? (
                <div className="space-y-4">
                  {data.outputs.map((output) => (
                    <RunOutputCard key={output.nodeId} output={output} />
                  ))}
                </div>
              ) : (
                <p className="py-6 text-center text-[12px] text-text-muted">
                  This run completed but produced no node output.
                </p>
              )}
            </div>
          </div>
        )}
      </section>

      {!error && !loading && <WorkflowArtifactGrid artifacts={artifacts} />}

      {tables.length > 0 && (
        <section role="region" aria-label="Accumulated records">
          <h2 className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-text-muted">
            Accumulated records
          </h2>
          <p className="mb-3 text-[12px] text-text-muted">
            Written by data_write nodes across all runs of this workflow.
          </p>
          <div className="space-y-4">
            {tables.map((table) => (
              <WorkflowRecordBrowser
                key={`${table.appId ?? ''}:${table.table}`}
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
