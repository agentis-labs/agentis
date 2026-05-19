/**
 * AppActionInbox — pending human decisions, promoted to the top of the
 * Surface (SURFACE-PAGE-REDESIGN.md §3).
 *
 * Renders only when there are pending approvals. Approve is a high-affordance
 * green fill; Reject is a conservative danger outline so it is harder to
 * misclick. Approvals never auto-dismiss — they persist until resolved.
 */

import { useState } from 'react';
import { AlertTriangle, Check, X } from 'lucide-react';
import { relativeTime, type SurfaceApproval } from './appSurfaceShared';

export function AppActionInbox({
  approvals,
  onResolve,
}: {
  approvals: SurfaceApproval[];
  onResolve: (id: string, decision: 'approve' | 'reject') => Promise<void>;
}) {
  if (approvals.length === 0) return null;

  return (
    <section
      role="region"
      aria-label="Action required"
      className="overflow-hidden rounded-[22px] border border-warn/30 bg-warn-soft"
    >
      <div className="flex items-center gap-2 px-4 py-3 text-[11px] font-semibold uppercase tracking-[0.16em] text-warn">
        <AlertTriangle size={13} />
        Needs your input · {approvals.length} item{approvals.length === 1 ? '' : 's'}
      </div>
      <div className="space-y-2 px-3 pb-3">
        {approvals.map((approval) => (
          <ApprovalCard key={approval.id} approval={approval} onResolve={onResolve} />
        ))}
      </div>
    </section>
  );
}

function ApprovalCard({
  approval,
  onResolve,
}: {
  approval: SurfaceApproval;
  onResolve: (id: string, decision: 'approve' | 'reject') => Promise<void>;
}) {
  const [pending, setPending] = useState<'approve' | 'reject' | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function resolve(decision: 'approve' | 'reject') {
    if (pending) return;
    setPending(decision);
    setError(null);
    try {
      await onResolve(approval.id, decision);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not record decision');
      setPending(null);
    }
  }

  return (
    <div className="rounded-[16px] border border-warn/20 bg-surface px-4 py-3">
      <div className="flex flex-wrap items-center gap-2 text-[11px] text-text-muted">
        {approval.workflowName && <span>{approval.workflowName}</span>}
        <span>· {relativeTime(approval.createdAt)}</span>
      </div>
      <div className="mt-1 text-[14px] font-semibold text-text-primary">{approval.title}</div>
      {approval.summary && (
        <p className="mt-1 text-[12px] leading-relaxed text-text-secondary">{approval.summary}</p>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          aria-label={`Approve: ${approval.title}`}
          onClick={() => void resolve('approve')}
          disabled={pending !== null}
          className="inline-flex h-11 min-w-[44px] items-center gap-1.5 rounded-btn bg-accent px-4 text-[13px] font-medium text-white transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-canvas disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Check size={14} />
          {pending === 'approve' ? 'Approving…' : 'Approve'}
        </button>
        <button
          type="button"
          aria-label={`Reject: ${approval.title}`}
          onClick={() => void resolve('reject')}
          disabled={pending !== null}
          className="inline-flex h-11 min-w-[44px] items-center gap-1.5 rounded-btn border border-danger px-4 text-[13px] font-medium text-danger transition-colors hover:bg-danger-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-canvas disabled:cursor-not-allowed disabled:opacity-50"
        >
          <X size={14} />
          {pending === 'reject' ? 'Rejecting…' : 'Reject'}
        </button>
      </div>
      {error && <div className="mt-2 text-[12px] text-danger">{error}</div>}
    </div>
  );
}
