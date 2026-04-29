/**
 * ApprovalInbox — V1-SPEC §3.3, §11.10 approval inbox list.
 */

import { ApprovalRequestRow, type ApprovalRequest } from './ApprovalRequestRow';

export function ApprovalInbox({
  approvals,
  onResolve,
}: {
  approvals: ApprovalRequest[];
  onResolve?: (id: string, decision: 'approve' | 'reject', reason?: string) => void;
}) {
  if (approvals.length === 0) {
    return (
      <div className="rounded-2xl border border-line bg-surface p-4 text-sm text-text-muted">
        Inbox zero. Nothing waiting on you.
      </div>
    );
  }
  return (
    <div className="space-y-2">
      {approvals.map((a) => (
        <ApprovalRequestRow
          key={a.id}
          approval={a}
          onResolve={
            onResolve ? (decision, reason) => onResolve(a.id, decision, reason) : undefined
          }
        />
      ))}
    </div>
  );
}
