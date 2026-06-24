import { useState } from 'react';
import { Check, ShieldCheck, Wrench, X } from 'lucide-react';
import { api } from '../../lib/api';
import {
  refreshWorkspaceSnapshot,
  useWorkspaceData,
  type WorkspaceApproval,
} from '../../lib/workspaceData';

/**
 * ChatApprovalStrip — approval-as-conversation.
 *
 * When a run pauses at a checkpoint, the operator shouldn't have to hunt for a
 * separate inbox. Pending approvals surface right above the composer, as rich,
 * one-click cards. The `summary` is the engine's connector-agnostic action
 * preview (checkpointApprovalCopy) — "Approve running Send Email (agentmail).
 * to: …" — so the operator sees exactly what they're authorizing. Approving
 * resumes the run; the live store updates the moment the decision lands.
 */
export function ChatApprovalStrip() {
  const { approvals } = useWorkspaceData();
  const [busy, setBusy] = useState<Record<string, boolean>>({});

  if (approvals.length === 0) return null;

  async function resolve(approval: WorkspaceApproval, decision: 'approve' | 'reject') {
    setBusy((b) => ({ ...b, [approval.id]: true }));
    try {
      await api(`/v1/approvals/${approval.id}/resolve`, {
        method: 'POST',
        body: JSON.stringify({ decision }),
      });
      await refreshWorkspaceSnapshot();
    } finally {
      setBusy((b) => ({ ...b, [approval.id]: false }));
    }
  }

  return (
    <div className="space-y-2 px-3 pb-2">
      {approvals.slice(0, 4).map((approval) => (
        <ApprovalCard key={approval.id} approval={approval} busy={Boolean(busy[approval.id])} onResolve={resolve} />
      ))}
    </div>
  );
}

function ApprovalCard({
  approval,
  busy,
  onResolve,
}: {
  approval: WorkspaceApproval;
  busy: boolean;
  onResolve: (approval: WorkspaceApproval, decision: 'approve' | 'reject') => Promise<void>;
}) {
  const selfHeal = approval.source === 'self_heal';
  const title = selfHeal
    ? 'Self-healing fix ready'
    : approval.title ?? approval.workflowName ?? 'Approval needed';
  return (
    <div
      className={selfHeal
        ? 'rounded-card border border-accent/35 bg-accent/[0.07] p-3'
        : 'rounded-card border border-amber-400/30 bg-amber-400/[0.06] p-3'}
    >
      <div className="flex items-center gap-2">
        {selfHeal ? (
          <Wrench size={14} className="shrink-0 text-accent" />
        ) : (
          <ShieldCheck size={14} className="shrink-0 text-amber-400" />
        )}
        <span className="truncate text-[12px] font-medium text-text-primary">
          {title}
        </span>
        <span className={selfHeal
          ? 'ml-auto shrink-0 text-[10px] uppercase tracking-wide text-accent/80'
          : 'ml-auto shrink-0 text-[10px] uppercase tracking-wide text-amber-400/80'}
        >
          awaiting you
        </span>
      </div>
      <p className="mt-1 whitespace-pre-line text-[11px] leading-relaxed text-text-secondary">
        {approval.summary ?? 'This run is paused for your approval before it continues.'}
      </p>
      <div className="mt-2 flex gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={() => void onResolve(approval, 'approve')}
          className="inline-flex items-center gap-1 rounded-md bg-accent px-2.5 py-1 text-[11px] font-medium text-white transition-colors hover:bg-accent/90 disabled:opacity-50"
        >
          <Check size={12} /> {selfHeal ? 'Approve fix' : 'Approve & run'}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => void onResolve(approval, 'reject')}
          className="inline-flex items-center gap-1 rounded-md border border-line px-2.5 py-1 text-[11px] text-text-secondary transition-colors hover:text-text-primary disabled:opacity-50"
        >
          <X size={12} /> Reject
        </button>
      </div>
    </div>
  );
}
