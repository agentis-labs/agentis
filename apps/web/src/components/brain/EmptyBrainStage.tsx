import { Brain, ArrowRight } from 'lucide-react';
import { Button } from '../shared/Button';

export function EmptyBrainStage({
  scope = 'app',
  actionLabel = 'Add knowledge',
  onAction,
}: {
  scope?: 'app' | 'workspace';
  actionLabel?: string;
  onAction: () => void;
}) {
  const title = scope === 'workspace' ? 'The workspace brain is empty.' : "This app's intelligence is empty.";
  const body = scope === 'workspace'
    ? 'Import documents, add knowledge bases, or run workflows to start accumulating shared intelligence.'
    : 'Upload reference documents, save memory entries, and provide evaluator examples to give this app usable context.';
  return (
    <div className="absolute inset-0 flex items-center justify-center bg-canvas/70 p-6">
      <div className="max-w-md rounded-card border border-dashed border-line bg-surface px-8 py-10 text-center">
        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-card border border-line bg-surface-2 text-text-muted">
          <Brain size={28} />
        </div>
        <h3 className="mt-5 text-heading text-text-primary">{title}</h3>
        <p className="mt-2 text-[13px] leading-relaxed text-text-muted">{body}</p>
        <div className="mt-5 flex justify-center">
          <Button variant="primary" size="md" iconRight={<ArrowRight size={12} />} onClick={onAction}>{actionLabel}</Button>
        </div>
      </div>
    </div>
  );
}