import { useEffect, useMemo, useState } from 'react';
import { BookOpen, Filter } from 'lucide-react';
import { api, apiErrorMessage } from '../../lib/api';
import { useToast } from '../shared/Toast';
import { Skeleton } from '../shared/Skeleton';
import { Button } from '../shared/Button';
import { WorkspaceDocDropZone } from '../knowledge/WorkspaceDocDropZone';
import { DocumentList } from '../knowledge/DocumentList';
import { KnowledgeBaseList } from '../knowledge/KnowledgeBaseList';
import type { KnowledgeBaseRow, KnowledgeDocumentRow } from '../knowledge/types';

export interface AppKnowledgePanelCounts {
  baseCount: number;
  documentCount: number;
}

export function AppKnowledgePanel({
  appId,
  appName,
  onCounts,
}: {
  appId: string;
  appName: string;
  onCounts?: (counts: AppKnowledgePanelCounts) => void;
}) {
  const toast = useToast();
  const [bases, setBases] = useState<KnowledgeBaseRow[]>([]);
  const [documents, setDocuments] = useState<KnowledgeDocumentRow[]>([]);
  const [selectedBaseId, setSelectedBaseId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  async function refresh() {
    setLoading(true);
    try {
      const baseData = await api<{ knowledgeBases: KnowledgeBaseRow[] }>(`/v1/apps/${appId}/knowledge-bases`);
      const nextBases = baseData.knowledgeBases ?? [];
      setBases(nextBases);
      setSelectedBaseId((current) => {
        if (current && nextBases.some((base) => base.id === current)) return current;
        return nextBases[0]?.id ?? null;
      });
      const docLists = await Promise.all(nextBases.map(async (base) => {
        const data = await api<{ documents: KnowledgeDocumentRow[] }>(`/v1/knowledge-bases/${base.id}/documents`);
        return (data.documents ?? []).map((document) => ({ ...document, knowledgeBaseName: base.name }));
      }));
      setDocuments(docLists.flat());
    } catch (err) {
      toast.error('Failed to load app knowledge', apiErrorMessage(err));
      setBases([]);
      setDocuments([]);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void refresh(); }, [appId]);

  useEffect(() => {
    onCounts?.({ baseCount: bases.length, documentCount: documents.length });
  }, [bases.length, documents.length, onCounts]);

  const documentCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const document of documents) counts.set(document.knowledgeBaseId, (counts.get(document.knowledgeBaseId) ?? 0) + 1);
    return counts;
  }, [documents]);

  const selectedBase = bases.find((base) => base.id === selectedBaseId) ?? null;
  const visibleDocuments = selectedBaseId
    ? documents.filter((document) => document.knowledgeBaseId === selectedBaseId)
    : documents;

  async function createBase(input: { name: string; description?: string }) {
    await api(`/v1/apps/${appId}/knowledge-bases`, { method: 'POST', body: JSON.stringify(input) });
    toast.success('Knowledge base created', input.name);
    await refresh();
  }

  async function deleteBase(base: KnowledgeBaseRow) {
    await api(`/v1/apps/${appId}/knowledge-bases/${base.id}`, { method: 'DELETE' });
    toast.success('Knowledge base deleted', base.name);
    await refresh();
  }

  async function deleteDocument(document: KnowledgeDocumentRow) {
    await api(`/v1/knowledge-bases/${document.knowledgeBaseId}/documents/${document.id}`, { method: 'DELETE' });
    toast.success('Document removed', document.name);
    await refresh();
  }

  if (loading) return <Skeleton height={420} />;

  return (
    <div className="space-y-4">
      <div className="rounded-card border border-line bg-surface-2 px-4 py-3 text-[12px] text-text-muted">
        Documents uploaded here stay scoped to <span className="font-medium text-text-primary">{appName}</span>.
        Use the workspace Brain when the same knowledge should be shared across multiple apps.
      </div>

      <WorkspaceDocDropZone
        bases={bases}
        selectedBaseId={selectedBaseId}
        onBaseChange={setSelectedBaseId}
        onUploaded={refresh}
        createBasePath={`/v1/apps/${appId}/knowledge-bases`}
        title="Add app knowledge"
        description={`Upload PDFs, notes, and reference files that only ${appName} should retrieve from.`}
        defaultBaseName={`${appName} knowledge`}
        defaultBaseDescription={`Documents only available to ${appName}.`}
        emptySelectionLabel={`${appName} knowledge (new)`}
        newBasePlaceholder="New app collection name"
      />

      <KnowledgeBaseList
        bases={bases}
        documentCounts={documentCounts}
        onCreate={createBase}
        onOpen={(base) => setSelectedBaseId(base.id)}
        onDelete={(base) => void deleteBase(base)}
      />

      <section className="rounded-card border border-line bg-surface p-4">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <span className="flex h-8 w-8 items-center justify-center rounded-card border border-line bg-surface-2 text-accent">
            <BookOpen size={15} />
          </span>
          <div>
            <h3 className="text-subheading text-text-primary">{selectedBase ? `${selectedBase.name} documents` : 'Documents'}</h3>
            <p className="text-[12px] text-text-muted">
              {selectedBase ? 'Focused on one collection.' : 'All documents available to this app.'}
            </p>
          </div>
          {selectedBaseId && (
            <Button variant="ghost" size="sm" className="ml-auto" iconLeft={<Filter size={12} />} onClick={() => setSelectedBaseId(null)}>
              Show all
            </Button>
          )}
        </div>
        <DocumentList
          documents={visibleDocuments}
          onDelete={(document) => void deleteDocument(document)}
          emptyBody={`Upload files to give ${appName} its own reference material.`}
        />
      </section>
    </div>
  );
}