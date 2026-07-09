import { useMemo, useState } from 'react';
import { FileText } from 'lucide-react';
import { EmptyState } from '../shared/EmptyState';
import { DocumentRow } from './DocumentRow';
import type { KnowledgeDocumentRow } from './types';

type KnowledgeDocumentView = KnowledgeDocumentRow & {
  knowledgeBaseScopeKind?: 'workspace' | 'app' | 'agent' | 'workflow';
  ownerScope?: { id: string; kind: 'app' | 'agent' | 'workflow'; title: string } | null;
  ownerWorkflow?: { id: string; title: string } | null;
};

export function DocumentList({
  documents,
  onDelete,
  onInspect,
  emptyBody = 'Upload files or paste text to give agents shared workspace context.',
}: {
  documents: KnowledgeDocumentView[];
  onDelete?: (document: KnowledgeDocumentView) => void;
  onInspect?: (document: KnowledgeDocumentView) => void;
  emptyBody?: string;
}) {
  const [query, setQuery] = useState('');
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return documents;
    return documents.filter((document) => `${document.name} ${document.knowledgeBaseName ?? ''} ${document.ownerScope?.title ?? document.ownerWorkflow?.title ?? ''} ${document.mimeType}`.toLowerCase().includes(q));
  }, [documents, query]);

  if (documents.length === 0) {
    return <EmptyState icon={<FileText size={48} />} title="No documents yet" body={emptyBody} />;
  }

  return (
    <div className="overflow-hidden rounded-card border border-line bg-surface">
      <div className="border-b border-line bg-surface-2 px-4 py-3">
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search documents"
          className="h-9 w-full rounded-input border border-line bg-canvas px-3 text-[13px] text-text-primary placeholder:text-text-muted focus:border-accent focus:outline-none"
        />
      </div>
      {filtered.length === 0 ? (
        <div className="px-4 py-8 text-center text-[13px] text-text-muted">No documents match that search.</div>
      ) : (
        filtered.map((document) => <DocumentRow key={document.id} document={document} onDelete={onDelete} onInspect={onInspect} />)
      )}
    </div>
  );
}



