/**
 * ApprovalRequestRow — V1-SPEC §3.3, §11.10 single approval row.
 */

export interface ApprovalRequest {
  id: string;
  source: string;
  title: string;
  summary: string;
  status: string;
  confidence: number | null;
  createdAt: string;
}

export function ApprovalRequestRow({
  approval,
  onResolve,
}: {
  approval: ApprovalRequest;
  onResolve?: (decision: 'approve' | 'reject', reason?: string) => void;
}) {
  const isPending = approval.status === 'pending';
  return (
    <div className="rounded-2xl border border-line bg-surface p-3">
      <div className="flex items-center gap-2">
        <span className="rounded-md bg-surface-2 px-2 py-0.5 text-[10px] uppercase tracking-wide text-text-muted">
          {approval.source}
        </span>
        <span className="text-sm font-medium">{approval.title}</span>
        {approval.confidence !== null && (
          <span className="ml-auto text-xs text-text-muted">
            {Math.round(approval.confidence * 100)}% confidence
          </span>
        )}
      </div>
      <div className="mt-1 text-xs text-text-muted">{approval.summary}</div>
      <div className="mt-2 flex items-center justify-between text-[11px] text-text-muted">
        <span>{new Date(approval.createdAt).toLocaleString()}</span>
        {isPending ? (
          onResolve && (
            <span className="flex gap-2">
              <button
                onClick={() => onResolve('reject')}
                className="rounded-md border border-danger/40 px-2 py-0.5 text-xs text-danger"
              >
                Reject
              </button>
              <button
                onClick={() => onResolve('approve')}
                className="rounded-md bg-accent px-2 py-0.5 text-xs font-medium text-canvas"
              >
                Approve
              </button>
            </span>
          )
        ) : (
          <span>{approval.status}</span>
        )}
      </div>
    </div>
  );
}
