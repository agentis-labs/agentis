/**
 * ActiveRunsStrip — V1-SPEC §3.3, §11.1 active runs row.
 */

import { Link } from 'react-router-dom';

export interface ActiveRunsStripRun {
  id: string;
  status: string;
  workflowId: string;
  startedAt?: string | null;
}

export function ActiveRunsStrip({ runs }: { runs: ActiveRunsStripRun[] }) {
  if (runs.length === 0) {
    return (
      <div className="rounded-2xl border border-line bg-surface p-4 text-sm text-text-muted">
        No active runs.
      </div>
    );
  }
  return (
    <div className="flex gap-2 overflow-x-auto rounded-2xl border border-line bg-surface p-3">
      {runs.map((r) => (
        <Link
          key={r.id}
          to={`/runs/${r.id}`}
          className="flex min-w-[140px] flex-col rounded-md border border-line bg-surface-2 px-3 py-2 hover:border-accent"
        >
          <span className="text-xs uppercase tracking-wide text-accent">{r.status}</span>
          <span className="truncate text-sm">{r.workflowId}</span>
          {r.startedAt && (
            <span className="text-[10px] text-text-muted">
              {new Date(r.startedAt).toLocaleTimeString()}
            </span>
          )}
        </Link>
      ))}
    </div>
  );
}
