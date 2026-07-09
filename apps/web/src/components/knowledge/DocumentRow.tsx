import { Bot, BookOpen, Info, Trash2, Workflow as WorkflowIcon } from 'lucide-react';
import { Button } from '../shared/Button';
import type { KnowledgeDocumentRow } from './types';

type KnowledgeDocumentView = KnowledgeDocumentRow & {
  knowledgeBaseScopeKind?: 'workspace' | 'app' | 'agent' | 'workflow';
  ownerScope?: { id: string; kind: 'app' | 'agent' | 'workflow'; title: string } | null;
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
  const scoped = Boolean(document.knowledgeBaseScopeKind && document.knowledgeBaseScopeKind !== 'workspace');
  const ownerTitle = document.ownerScope?.title ?? document.ownerWorkflow?.title;
  return (
    <div className="flex items-center gap-3 border-b border-line/60 px-4 py-3 transition-colors last:border-b-0 hover:bg-surface-2/40">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="truncate text-[13px] font-medium text-text-primary">{document.name}</span>
          <span className="rounded-full border border-line bg-surface-2 px-2 py-0.5 text-[10px] text-text-muted">{document.status}</span>
          {scoped && (
            <span title={`${scopeKindLabel(document.knowledgeBaseScopeKind)}-scoped knowledge`} className="inline-flex h-5 w-5 items-center justify-center rounded-full border border-accent/30 bg-accent-soft text-accent">
              <ScopeIcon kind={document.knowledgeBaseScopeKind} />
            </span>
          )}
        </div>
        <div className="mt-1 flex flex-wrap gap-2 text-[11px] text-text-muted">
          {document.knowledgeBaseName && <span>{document.knowledgeBaseName}</span>}
          {scoped && ownerTitle && <span>from {ownerTitle}</span>}
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

function ScopeIcon({ kind }: { kind: KnowledgeDocumentView['knowledgeBaseScopeKind'] }) {
  if (kind === 'agent') return <Bot size={11} />;
  if (kind === 'workflow') return <WorkflowIcon size={11} />;
  return <BookOpen size={11} />;
}

function scopeKindLabel(kind: KnowledgeDocumentView['knowledgeBaseScopeKind']): string {
  if (kind === 'agent') return 'Agent';
  if (kind === 'app') return 'App';
  if (kind === 'workflow') return 'Workflow';
  return 'Workspace';
}
