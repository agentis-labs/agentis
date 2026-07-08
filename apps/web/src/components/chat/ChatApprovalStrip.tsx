import { useState } from 'react';
import { api } from '../../lib/api';
import {
  refreshWorkspaceSnapshot,
  useWorkspaceData,
  type WorkspaceApproval,
} from '../../lib/workspaceData';
import { ApprovalPreviewCard, ApprovalReviewModal } from '../shared/ApprovalReviewModal';


export function ChatApprovalStrip() {
  const { approvals } = useWorkspaceData();
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [selected, setSelected] = useState<WorkspaceApproval | null>(null);

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
        <ApprovalPreviewCard
          key={approval.id}
          approval={approval}
          busy={Boolean(busy[approval.id])}
          compact
          onReview={setSelected}
          onApprove={(item) => resolve(item, 'approve')}
          onReject={(item) => resolve(item, 'reject')}
        />
      ))}
      <ApprovalReviewModal
        approval={selected}
        open={Boolean(selected)}
        onClose={() => setSelected(null)}
      />
    </div>
  );
}


