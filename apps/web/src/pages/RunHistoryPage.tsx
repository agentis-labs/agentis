/**
 * Global run history browser.
 *
 * V1-SPEC §0.3 item 18: every run across every workflow, filterable, with
 * replay buttons, duration, and a jump link to the run inspector.
 */

import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, workspace } from '../lib/api';
import { rtSubscribe, useRealtime } from '../lib/realtime';

interface RunRow {
  id: string;
  workflowId: string;
  status: string;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  triggerId: string | null;
}

const STATUSES = ['ALL', 'RUNNING', 'WAITING', 'COMPLETED', 'FAILED', 'CANCELLED'] as const;

export function RunHistoryPage() {
  const [runs, setRuns] = useState<RunRow[]>([]);
  const [filter, setFilter] = useState<(typeof STATUSES)[number]>('ALL');
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const ws = workspace.get();
    if (ws) rtSubscribe('workspace', { workspaceId: ws });
    void api<{ runs: RunRow[] }>('/v1/runs?limit=200').then((r) => setRuns(r.runs)).catch(() => {});
  }, [tick]);

  useRealtime(['run.created', 'run.completed', 'run.failed'], () => setTick((t) => t + 1));

  const filtered = useMemo(
    () => (filter === 'ALL' ? runs : runs.filter((r) => r.status === filter)),
    [runs, filter],
  );

  return (
    <div className="flex h-full flex-col p-4">
      <div className="mb-3 flex items-center gap-2">
        <h1 className="text-lg font-medium">Run history</h1>
        <span className="text-xs text-text-muted">{filtered.length} runs</span>
        <div className="ml-auto flex gap-1">
          {STATUSES.map((s) => (
            <button
              key={s}
              onClick={() => setFilter(s)}
              className={`rounded-md border border-line px-2 py-1 text-xs ${
                filter === s ? 'bg-accent-soft text-accent' : 'text-text-muted hover:text-text-primary'
              }`}
            >
              {s}
            </button>
          ))}
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto rounded-2xl border border-line bg-surface">
        <table className="w-full text-sm">
          <thead className="sticky top-0 bg-surface text-xs uppercase tracking-wide text-text-muted">
            <tr>
              <th className="px-3 py-2 text-left">Run</th>
              <th className="px-3 py-2 text-left">Workflow</th>
              <th className="px-3 py-2 text-left">Status</th>
              <th className="px-3 py-2 text-left">Trigger</th>
              <th className="px-3 py-2 text-left">Duration</th>
              <th className="px-3 py-2 text-left">Created</th>
              <th className="px-3 py-2"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {filtered.length === 0 && (
              <tr>
                <td colSpan={7} className="px-3 py-6 text-center text-text-muted">
                  No runs match the current filter.
                </td>
              </tr>
            )}
            {filtered.map((r) => (
              <tr key={r.id} className="hover:bg-surface-2">
                <td className="px-3 py-2 font-mono text-xs">
                  <Link to={`/runs/${r.id}`} className="hover:text-accent">
                    {r.id.slice(0, 8)}
                  </Link>
                </td>
                <td className="px-3 py-2">
                  <Link to={`/workflows/${r.workflowId}`} className="font-mono text-xs text-text-muted hover:text-accent">
                    {r.workflowId.slice(0, 8)}
                  </Link>
                </td>
                <td className="px-3 py-2">
                  <StatusBadge status={r.status} />
                </td>
                <td className="px-3 py-2 text-xs text-text-muted">
                  {r.triggerId ? r.triggerId.slice(0, 8) : 'manual'}
                </td>
                <td className="px-3 py-2 text-xs text-text-muted">{duration(r.startedAt, r.completedAt)}</td>
                <td className="px-3 py-2 text-xs text-text-muted">{new Date(r.createdAt).toLocaleString()}</td>
                <td className="px-3 py-2 text-right">
                  <ReplayButton runId={r.id} onDone={() => setTick((t) => t + 1)} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const cls =
    status === 'COMPLETED'
      ? 'text-accent'
      : status === 'FAILED'
        ? 'text-danger'
        : status === 'RUNNING' || status === 'WAITING'
          ? 'text-warn'
          : 'text-text-muted';
  return <span className={`text-xs ${cls}`}>{status}</span>;
}

function duration(start: string | null, end: string | null): string {
  if (!start) return '—';
  const a = new Date(start).getTime();
  const b = end ? new Date(end).getTime() : Date.now();
  const ms = Math.max(0, b - a);
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.floor((ms % 60_000) / 1000)}s`;
}

function ReplayButton({ runId, onDone }: { runId: string; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          await api(`/v1/runs/${runId}/replay`, {
            method: 'POST',
            body: JSON.stringify({ mode: 'replay-failed-branch' }),
          });
          onDone();
        } catch {
          // surface in console; toast layer ships separately
        } finally {
          setBusy(false);
        }
      }}
      className="rounded-md border border-line px-2 py-1 text-xs text-text-muted hover:text-accent disabled:opacity-50"
    >
      {busy ? '…' : 'Replay'}
    </button>
  );
}
