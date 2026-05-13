import { Trash2 } from 'lucide-react';
import { Button } from '../shared/Button';
import type { KnowledgeDocumentRow } from './types';

export function DocumentRow({ document, onDelete }: { document: KnowledgeDocumentRow; onDelete?: (document: KnowledgeDocumentRow) => void }) {
  return (
    <div className="flex items-center gap-3 border-b border-line/60 px-4 py-3 last:border-b-0">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="truncate text-[13px] font-medium text-text-primary">{document.name}</span>
          <span className="rounded-full border border-line bg-surface-2 px-2 py-0.5 text-[10px] text-text-muted">{document.status}</span>
        </div>
        <div className="mt-1 flex flex-wrap gap-2 text-[11px] text-text-muted">
          {document.knowledgeBaseName && <span>{document.knowledgeBaseName}</span>}
          <span>{document.mimeType}</span>
          {document.tokenCount != null && <span>{document.tokenCount} tokens</span>}
          {document.chunks != null && <span>{document.chunks} chunks</span>}
        </div>
      </div>
      {onDelete && (
        <Button variant="ghost" size="sm" iconLeft={<Trash2 size={12} />} onClick={() => onDelete(document)}>
          Delete
        </Button>
      )}
    </div>
  );
}