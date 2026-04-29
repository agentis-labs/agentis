import { useEffect, useState } from 'react';
import { api } from '../lib/api';

interface Approval {
  id: string;
  source: string;
  title: string;
  summary: string;
  status: string;
  createdAt: string;
}

export function ApprovalsPage() {
  const [items, setItems] = useState<Approval[]>([]);
  useEffect(() => {
    void load();
  }, []);
  async function load() {
    const d = await api<{ approvals: Approval[] }>('/v1/approvals?status=pending');
    setItems(d.approvals);
  }
  async function decide(id: string, decision: 'approve' | 'reject') {
    await api(`/v1/approvals/${id}/resolve`, {
      method: 'POST',
      body: JSON.stringify({ decision }),
    });
    void load();
  }
  return (
    <div className="p-6">
      <h1 className="mb-4 text-lg font-medium">Approvals</h1>
      {items.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-line p-10 text-center text-sm text-text-muted">
          No pending approvals. The inbox stays quiet until a checkpoint or risky proposal needs review.
        </div>
      ) : (
        <ul className="space-y-3">
          {items.map((a) => (
            <li key={a.id} className="rounded-2xl border border-line bg-surface p-4">
              <div className="mb-2 flex items-center gap-2">
                <span className="rounded-full bg-surface-2 px-2 py-0.5 text-[10px] uppercase tracking-wide text-text-muted">
                  {a.source}
                </span>
                <span className="text-sm font-medium">{a.title}</span>
              </div>
              <p className="mb-3 text-sm text-text-muted">{a.summary}</p>
              <div className="flex gap-2">
                <button
                  onClick={() => decide(a.id, 'approve')}
                  className="rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-canvas"
                >
                  Approve
                </button>
                <button
                  onClick={() => decide(a.id, 'reject')}
                  className="rounded-lg border border-line px-3 py-1.5 text-xs text-text-muted hover:text-danger"
                >
                  Reject
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
