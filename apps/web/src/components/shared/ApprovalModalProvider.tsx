import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Loader2, RefreshCw, X } from 'lucide-react';
import { api, apiErrorMessage } from '../../lib/api';
import { refreshWorkspaceChromeSnapshot } from '../../lib/workspaceChromeData';
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
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    if (!snapshot.open) {
      setApproval(null);
      setLoading(false);
      setError(null);
      return;
    }
    // Prefer the approval we were handed; otherwise fetch it by id.
    if (snapshot.approval) {
      setApproval(snapshot.approval);
      setLoading(false);
      setError(null);
      return;
    }
    if (!snapshot.approvalId) return;
    let cancelled = false;
    setApproval(null);
    setLoading(true);
    setError(null);
    void api<{ approval: ApprovalReview }>(`/v1/approvals/${encodeURIComponent(snapshot.approvalId)}`)
      .then((res) => { if (!cancelled) setApproval(res.approval); })
      .catch((fetchError) => {
        if (cancelled) return;
        setError(apiErrorMessage(fetchError));
        void refreshWorkspaceChromeSnapshot();
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [snapshot.open, snapshot.approvalId, snapshot.approval, snapshot.openedAt, retry]);

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
        : snapshot.open ? createPortal(
            <div className="pointer-events-auto fixed inset-0 z-[10100] flex items-center justify-center bg-canvas/80 p-4 backdrop-blur-sm" role="dialog" aria-modal="true" aria-label="Approval review">
              <div className="w-full max-w-md rounded-xl border border-line bg-surface p-4 shadow-dropdown">
                <div className="flex items-center justify-between gap-3">
                  <div className="text-[14px] font-semibold text-text-primary">Approval review</div>
                  <button type="button" onClick={closeApprovalModal} aria-label="Close" className="flex h-7 w-7 items-center justify-center rounded-md text-text-muted hover:bg-surface-2 hover:text-text-primary"><X size={14} /></button>
                </div>
                {loading ? (
                  <div className="flex items-center gap-2 py-8 text-[12px] text-text-secondary"><Loader2 size={15} className="animate-spin text-accent" /> Loading the decision document…</div>
                ) : (
                  <div className="py-5">
                    <div className="text-[12px] font-medium text-danger">Could not open this approval</div>
                    <p className="mt-1 text-[12px] leading-relaxed text-text-secondary">{error ?? 'The approval is unavailable or no longer actionable.'}</p>
                    <button type="button" onClick={() => setRetry((value) => value + 1)} className="mt-4 inline-flex h-8 items-center gap-1.5 rounded-md bg-accent px-3 text-[12px] font-medium text-canvas hover:bg-accent-hover"><RefreshCw size={12} /> Retry</button>
                  </div>
                )}
              </div>
            </div>,
            document.body,
          ) : null}
    </>
  );
}
