import { AlertTriangle } from 'lucide-react';

export function CanvasApprovalNodeBadge({ title = 'Approval needed' }: { title?: string }) {
  return (
    <span className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-warn/30 bg-warn-soft text-warn" title={title}>
      <AlertTriangle size={14} />
    </span>
  );
}