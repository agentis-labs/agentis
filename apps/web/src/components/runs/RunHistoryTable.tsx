/**
 * RunHistoryTable — V1-SPEC §3.3, §11.3 run history table.
 */

import { Link } from 'react-router-dom';

export interface RunHistoryRow {
  id: string;
  status: string;
  workflowId: string;
  startedAt?: string | null;
  completedAt?: string | null;
}

export function RunHistoryTable({ runs }: { runs: RunHistoryRow[] }) {
  return (
    <table className="w-full text-sm">
      <thead className="text-xs uppercase tracking-wide text-text-muted">
        <tr>
          <th className="px-3 py-2 text-left">Run</th>
          <th className="px-3 py-2 text-left">Workflow</th>
          <th className="px-3 py-2 text-left">Status</th>
          <th className="px-3 py-2 text-left">Started</th>
          <th className="px-3 py-2 text-left">Completed</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-line">
        {runs.length === 0 && (
          <tr>
            <td colSpan={5} className="px-3 py-8 text-center text-text-muted">
              No runs yet.
            </td>
          </tr>
        )}
        {runs.map((r) => (
          <tr key={r.id} className="hover:bg-surface-2">
            <td className="px-3 py-2 font-mono text-xs">
              <Link to={`/runs/${r.id}`} className="hover:text-accent">
                {r.id.slice(0, 8)}
              </Link>
            </td>
            <td className="px-3 py-2">{r.workflowId}</td>
            <td className="px-3 py-2 text-xs uppercase tracking-wide">{r.status}</td>
            <td className="px-3 py-2 text-xs text-text-muted">
              {r.startedAt ? new Date(r.startedAt).toLocaleString() : '—'}
            </td>
            <td className="px-3 py-2 text-xs text-text-muted">
              {r.completedAt ? new Date(r.completedAt).toLocaleString() : '—'}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
