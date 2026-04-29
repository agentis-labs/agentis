/**
 * PendingApprovalsDock — V1-SPEC §3.3, §11.1 pending approvals dock card.
 */

import { Link } from 'react-router-dom';

export interface PendingApprovalsDockProps {
  pending: number;
}

export function PendingApprovalsDock({ pending }: PendingApprovalsDockProps) {
  return (
    <Link
      to="/approvals"
      className="flex items-center justify-between rounded-2xl border border-line bg-surface px-4 py-3 hover:border-accent"
    >
      <div>
        <div className="text-xs uppercase tracking-wide text-text-muted">Approvals</div>
        <div className="text-sm">
          {pending === 0 ? 'No pending approvals' : `${pending} pending`}
        </div>
      </div>
      {pending > 0 && (
        <span className="rounded-full bg-accent px-2 py-0.5 text-xs font-medium text-canvas">
          {pending}
        </span>
      )}
    </Link>
  );
}
