/**
 * WorkflowRunsTab — scoped run history for one workflow.
 *
 * Tab 2 of the workflow page (WORKFLOW-PAGE-REDESIGN.md §Tab 2). Answers
 * "what has this workflow run?". Lists the last N runs newest-first with
 * realtime prepend on RUN_* events, and links each row to RunDetailPage.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { REALTIME_EVENTS } from '@agentis/core';
import clsx from 'clsx';
import { RotateCcw } from 'lucide-react';
import { api, apiErrorMessage, workspace as workspaceStore } from '../../lib/api';
import { rtSubscribe, useRealtime, type RealtimeEnvelope } from '../../lib/realtime';
import { useToast } from '../shared/Toast';
import { formatDuration, relativeTime, type WorkflowRunSummary } from './runFormat';

const PAGE_SIZE = 30;

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

const STATUS_LABEL: Record<WorkflowRunSummary['status'], string> = {
  running: 'running',
  completed: 'completed',
  completed_with_violation: 'contract violation',
  failed: 'failed',
  pending: 'pending',
  paused: 'paused',
  waiting: 'waiting',
  cancelled: 'cancelled',
};

export function WorkflowRunsTab({
  workflowId,
  onRun,
}: {
  workflowId: string;
  onRun: () => void;
}) {
  const nav = useNavigate();
  const toast = useToast();
  const [runs, setRuns] = useState<WorkflowRunSummary[]>([]);
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState<string | null>(null);

  const load = useCallback(
    async (nextLimit: number) => {
      try {
        const d = await api<{ runs: WorkflowRunSummary[] }>(
          `/v1/workflows/${workflowId}/runs?limit=${nextLimit}`,
        );
        setRuns(d.runs);
        setError(null);
      } catch (e) {
        setError(apiErrorMessage(e));
      } finally {
        setLoading(false);
      }
    },
    [workflowId],
  );

  useEffect(() => {
    setLoading(true);
    void load(limit);
  }, [load, limit]);

  // Realtime: subscribe to the workspace room so run lifecycle events for
  // this workflow refresh the list (prepend new, update existing).
  useEffect(() => {
    const ws = workspaceStore.get();
    if (!ws) return;
    return rtSubscribe('workspace', { workspaceId: ws });
  }, []);

  const refetchRef = useRef<number | null>(null);
  const events = useMemo(
    () => [
      REALTIME_EVENTS.RUN_CREATED,
      REALTIME_EVENTS.RUN_RUNNING,
      REALTIME_EVENTS.RUN_COMPLETED,
      REALTIME_EVENTS.RUN_FAILED,
    ],
    [],
  );
  useRealtime(events, (env: RealtimeEnvelope) => {
    const payload = (env.payload ?? {}) as { workflowId?: string };
    if (payload.workflowId && payload.workflowId !== workflowId) return;
    // Debounce bursts of node/run events into a single refetch.
    if (refetchRef.current) window.clearTimeout(refetchRef.current);
    refetchRef.current = window.setTimeout(() => void load(limit), 400);
  });

  async function retry(runId: string) {
    setRetrying(runId);
    try {
      const res = await api<{ runId: string }>(`/v1/workflows/${workflowId}/run`, {
        method: 'POST',
        body: JSON.stringify({ inputs: {} }),
      });
      toast.success('Retry started');
      nav(`/runs/${res.runId}`);
    } catch (e) {
      toast.error('Retry failed', apiErrorMessage(e));
    } finally {
      setRetrying(null);
    }
  }

  return (
    <div className="mx-auto w-full max-w-4xl px-6 py-6">
      <div className="mb-4 flex items-end justify-between">
        <div>
          <h2 className="text-heading text-text-primary">Runs</h2>
          <p className="mt-0.5 text-[12px] text-text-muted">Recent executions of this workflow</p>
        </div>
        <button
          type="button"
          onClick={onRun}
          className="inline-flex h-9 items-center gap-1.5 rounded-btn bg-accent px-3 text-[13px] font-semibold text-canvas hover:bg-accent-hover"
        >
          Run now
        </button>
      </div>

      {error && (
        <div className="rounded-card border border-danger/40 bg-danger-soft px-4 py-3 text-[12px] text-danger">
          Failed to load runs: {error}
        </div>
      )}

      {!error && loading && runs.length === 0 && (
        <p className="py-12 text-center text-[13px] text-text-muted">Loading runs…</p>
      )}

      {!error && !loading && runs.length === 0 && (
        <div className="rounded-card border border-line bg-surface px-6 py-12 text-center">
          <p className="text-[13px] text-text-secondary">This workflow hasn't run yet.</p>
          <button
            type="button"
            onClick={onRun}
            className="mt-3 inline-flex h-9 items-center gap-1.5 rounded-btn bg-accent px-3 text-[13px] font-semibold text-canvas hover:bg-accent-hover"
          >
            Run now
          </button>
        </div>
      )}

      {runs.length > 0 && (
        <div className="overflow-hidden rounded-card border border-line bg-surface">
          {runs.map((run) => (
            <div
              key={run.id}
              className="flex items-center gap-3 border-b border-line/60 px-4 py-3 last:border-b-0 hover:bg-surface-2"
            >
              <span
                className={clsx('h-2 w-2 shrink-0 rounded-full', STATUS_DOT[run.status])}
                role="img"
                aria-label={`${STATUS_LABEL[run.status]} — ${relativeTime(run.startedAt)}`}
              />
              <span className="w-24 shrink-0 text-[13px] font-medium capitalize text-text-primary">
                {STATUS_LABEL[run.status]}
              </span>
              <span className="flex-1 text-[12px] text-text-muted">{relativeTime(run.startedAt)}</span>
              <span className="w-20 shrink-0 text-right font-mono text-[12px] text-text-secondary">
                {formatDuration(run.durationMs)}
              </span>
              <span className="w-20 shrink-0 text-right text-[11px] uppercase tracking-wide text-text-muted">
                {run.triggeredBy}
              </span>
              <div className="flex w-24 shrink-0 items-center justify-end gap-1">
                {run.status === 'failed' && (
                  <button
                    type="button"
                    onClick={() => void retry(run.id)}
                    disabled={retrying === run.id}
                    className="inline-flex h-7 items-center gap-1 rounded-btn border border-line bg-surface-2 px-2 text-[11px] font-medium text-text-secondary hover:bg-surface-3 hover:text-text-primary disabled:opacity-50"
                  >
                    <RotateCcw size={11} /> Retry
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => nav(`/runs/${run.id}`)}
                  className="text-[12px] font-medium text-accent hover:text-accent-hover"
                >
                  View →
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {runs.length >= limit && (
        <div className="mt-3 text-center">
          <button
            type="button"
            onClick={() => setLimit((l) => l + PAGE_SIZE)}
            className="inline-flex h-8 items-center rounded-btn border border-line bg-surface-2 px-3 text-[12px] font-medium text-text-secondary hover:bg-surface-3 hover:text-text-primary"
          >
            Load more
          </button>
        </div>
      )}
    </div>
  );
}
