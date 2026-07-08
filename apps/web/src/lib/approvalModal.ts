import { useSyncExternalStore } from 'react';
import type { ApprovalReview } from '../components/shared/ApprovalReviewModal';

/**
 * Global approval-review modal store — mirrors {@link ./runModal} so any surface
 * (notification panel, workflow monitor card, workspace attention cards) can open
 * the approval review modal WITHOUT a dedicated `/approvals` page/route. Callers
 * pass the full approval when they already have it, or just an `approvalId` and
 * the provider fetches it.
 */

export interface OpenApprovalModalDetail {
  approvalId?: string | null;
  approval?: ApprovalReview | null;
}

export interface ApprovalModalSnapshot extends OpenApprovalModalDetail {
  open: boolean;
  openedAt?: number;
}

const CLOSED: ApprovalModalSnapshot = { open: false };

let snapshot: ApprovalModalSnapshot = CLOSED;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

export function getApprovalModalSnapshot(): ApprovalModalSnapshot {
  return snapshot;
}

export function subscribeApprovalModal(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function openApprovalModal(detail: OpenApprovalModalDetail): void {
  const approvalId = detail.approval?.id ?? detail.approvalId ?? null;
  if (!approvalId && !detail.approval) return;
  snapshot = {
    approvalId,
    approval: detail.approval ?? null,
    open: true,
    openedAt: Date.now(),
  };
  emit();
}

export function closeApprovalModal(): void {
  snapshot = CLOSED;
  emit();
}

export function useApprovalModalSnapshot(): ApprovalModalSnapshot {
  return useSyncExternalStore(subscribeApprovalModal, getApprovalModalSnapshot, getApprovalModalSnapshot);
}
