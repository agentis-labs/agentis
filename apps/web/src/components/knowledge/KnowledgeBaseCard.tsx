import { BookOpen, Trash2 } from 'lucide-react';
import { Button } from '../shared/Button';
import type { KnowledgeBaseRow } from './types';

export function KnowledgeBaseCard({
  base,
  documentCount,
  onOpen,
  onDelete,
}: {
  base: KnowledgeBaseRow;
  documentCount?: number;
  onOpen: (base: KnowledgeBaseRow) => void;
  onDelete?: (base: KnowledgeBaseRow) => void;
}) {
  return (
    <article className="rounded-card border border-line bg-surface p-4">
      <div className="flex items-start gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-card border border-line bg-surface-2 text-accent">
          <BookOpen size={16} />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-subheading text-text-primary">{base.name}</h3>
          {base.description && <p className="mt-1 line-clamp-2 text-[12px] leading-relaxed text-text-muted">{base.description}</p>}
          <div className="mt-2 text-[11px] text-text-muted">{documentCount ?? 0} document{documentCount === 1 ? '' : 's'}</div>
        </div>
      </div>
      <div className="mt-4 flex justify-end gap-2">
        {onDelete && <Button variant="ghost" size="sm" iconLeft={<Trash2 size={12} />} onClick={() => onDelete(base)}>Delete</Button>}
        <Button variant="secondary" size="sm" onClick={() => onOpen(base)}>Open</Button>
      </div>
    </article>
  );
}