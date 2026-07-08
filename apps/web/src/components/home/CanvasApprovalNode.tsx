import { AlertTriangle, Wrench } from 'lucide-react';

export function CanvasApprovalNodeBadge({ source, title }: { source?: string; title?: string }) {
  const selfHeal = source === 'self_heal';
  return (
    <span
      className={selfHeal
        ? 'inline-flex h-7 w-7 items-center justify-center rounded-md border border-accent/30 bg-accent/10 text-accent'
        : 'inline-flex h-7 w-7 items-center justify-center rounded-md border border-warn/30 bg-warn-soft text-warn'}
      title={title ?? (selfHeal ? 'Self-healing approval' : 'Approval needed')}
    >
      {selfHeal ? <Wrench size={14} /> : <AlertTriangle size={14} />}
    </span>
  );
}



