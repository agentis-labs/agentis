import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../../lib/api';
import {
  closeApprovalModal,
  useApprovalModalSnapshot,
} from '../../lib/approvalModal';
import { ApprovalReviewModal, type ApprovalReview } from './ApprovalReviewModal';

/**
 * Mounts a single global {@link ApprovalReviewModal} driven by the approval-modal
 * store. Replaces the deleted `/approvals` page: opening an approval anywhere in
 * the app now surfaces this modal in place. When opened with just an id, the
 * full approval (with structured payload) is fetched here.
 */
export function ApprovalModalProvider({ children }: { children: React.ReactNode }) {
  const snapshot = useApprovalModalSnapshot();
  const [approval, setApproval] = useState<ApprovalReview | null>(null);

  useEffect(() => {
    if (!snapshot.open) {
      setApproval(null);
      return;
    }
    // Prefer the approval we were handed; otherwise fetch it by id.
    if (snapshot.approval) {
      setApproval(snapshot.approval);
      return;
    }
    if (!snapshot.approvalId) return;
    let cancelled = false;
    setApproval(null);
    void api<{ approval: ApprovalReview }>(`/v1/approvals/${encodeURIComponent(snapshot.approvalId)}`)
      .then((res) => { if (!cancelled) setApproval(res.approval); })
      .catch(() => { if (!cancelled) closeApprovalModal(); });
    return () => { cancelled = true; };
  }, [snapshot.open, snapshot.approvalId, snapshot.approval, snapshot.openedAt]);

  return (
    <>
      {children}
      {snapshot.open && approval
        ? createPortal(
            <ApprovalReviewModal
              approval={approval}
              open
              onClose={closeApprovalModal}
            />,
            document.body,
          )
        : null}
    </>
  );
}
