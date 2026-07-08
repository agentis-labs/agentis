import { Info, Trash2, Workflow as WorkflowIcon } from 'lucide-react';
import { Button } from '../shared/Button';
import type { KnowledgeDocumentRow } from './types';

type KnowledgeDocumentView = KnowledgeDocumentRow & {
  knowledgeBaseScopeKind?: 'workspace' | 'workflow';
  ownerWorkflow?: { id: string; title: string } | null;
};

export function DocumentRow({
  document,
  onDelete,
  onInspect,
}: {
  document: KnowledgeDocumentView;
  onDelete?: (document: KnowledgeDocumentView) => void;
  onInspect?: (document: KnowledgeDocumentView) => void;
}) {
  const workflowScoped = document.knowledgeBaseScopeKind === 'workflow';
  return (
    <div className="flex items-center gap-3 border-b border-line/60 px-4 py-3 transition-colors last:border-b-0 hover:bg-surface-2/40">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="truncate text-[13px] font-medium text-text-primary">{document.name}</span>
          <span className="rounded-full border border-line bg-surface-2 px-2 py-0.5 text-[10px] text-text-muted">{document.status}</span>
          {workflowScoped && (
            <span title="Workflow-scoped knowledge" className="inline-flex h-5 w-5 items-center justify-center rounded-full border border-accent/30 bg-accent-soft text-accent">
              <WorkflowIcon size={11} />
            </span>
          )}
        </div>
        <div className="mt-1 flex flex-wrap gap-2 text-[11px] text-text-muted">
          {document.knowledgeBaseName && <span>{document.knowledgeBaseName}</span>}
          {workflowScoped && document.ownerWorkflow?.title && <span>from {document.ownerWorkflow.title}</span>}
          <span>{document.mimeType}</span>
          {document.tokenCount != null && <span>{document.tokenCount} tokens</span>}
          {document.chunks != null && <span>{document.chunks} chunks</span>}
        </div>
      </div>
      {onInspect && (
        <Button variant="ghost" size="sm" iconLeft={<Info size={12} />} onClick={() => onInspect(document)}>
          Inspect
        </Button>
      )}
      {onDelete && (
        <Button variant="ghost" size="sm" iconLeft={<Trash2 size={12} />} onClick={() => onDelete(document)}>
          Delete
        </Button>
      )}
    </div>
  );
}



