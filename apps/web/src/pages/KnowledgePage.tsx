import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { BookOpen, Database, FileText, History } from 'lucide-react';
import { api } from '../lib/api';
import { useToast } from '../components/shared/Toast';
import { Tabs } from '../components/shared/Tabs';
import { Skeleton } from '../components/shared/Skeleton';
import { WorkspaceDocDropZone } from '../components/knowledge/WorkspaceDocDropZone';
import { DocumentList } from '../components/knowledge/DocumentList';
import { KnowledgeBaseList } from '../components/knowledge/KnowledgeBaseList';
import { WorkspaceMemoryTab } from '../components/knowledge/WorkspaceMemoryTab';
import { EpisodesTab } from '../components/knowledge/EpisodesTab';
import type { KnowledgeBaseRow, KnowledgeDocumentRow } from '../components/knowledge/types';

type Tab = 'documents' | 'bases' | 'memory' | 'episodes';

export function KnowledgePage() {
  const nav = useNavigate();
  const toast = useToast();
  const [tab, setTab] = useState<Tab>(() => {
    const value = new URLSearchParams(window.location.search).get('tab');
    return value === 'bases' || value === 'memory' || value === 'episodes' ? value : 'documents';
  });
  const [bases, setBases] = useState<KnowledgeBaseRow[]>([]);
  const [documents, setDocuments] = useState<KnowledgeDocumentRow[]>([]);
  const [selectedBaseId, setSelectedBaseId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  async function refresh() {
    setLoading(true);
    try {
      const baseData = await api<{ knowledgeBases: KnowledgeBaseRow[] }>('/v1/knowledge-bases');
      const nextBases = baseData.knowledgeBases ?? [];
      setBases(nextBases);
      if (!selectedBaseId && nextBases[0]) setSelectedBaseId(nextBases[0].id);
      const docLists = await Promise.all(nextBases.map(async (base) => {
        const data = await api<{ documents: KnowledgeDocumentRow[] }>(`/v1/knowledge-bases/${base.id}/documents`);
        return (data.documents ?? []).map((document) => ({ ...document, knowledgeBaseName: base.name }));
      }));
      setDocuments(docLists.flat());
    } catch (err) {
      toast.error('Failed to load knowledge', String(err));
      setBases([]);
      setDocuments([]);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void refresh(); }, []);

  const documentCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const document of documents) counts.set(document.knowledgeBaseId, (counts.get(document.knowledgeBaseId) ?? 0) + 1);
    return counts;
  }, [documents]);

  async function createBase(input: { name: string; description?: string }) {
    await api('/v1/knowledge-bases', { method: 'POST', body: JSON.stringify(input) });
    toast.success('Knowledge base created', input.name);
    await refresh();
  }

  async function deleteBase(base: KnowledgeBaseRow) {
    await api(`/v1/knowledge-bases/${base.id}`, { method: 'DELETE' });
    toast.success('Knowledge base deleted', base.name);
    await refresh();
  }

  async function deleteDocument(document: KnowledgeDocumentRow) {
    await api(`/v1/knowledge-bases/${document.knowledgeBaseId}/documents/${document.id}`, { method: 'DELETE' });
    toast.success('Document removed', document.name);
    await refresh();
  }

  return (
    <div className="flex h-full flex-col">
      <header className="border-b border-line px-6 py-5">
        <div className="flex items-start gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-card border border-line bg-surface-2 text-accent"><BookOpen size={18} /></span>
          <div>
            <h1 className="text-display text-text-primary">Workspace Knowledge</h1>
            <p className="mt-1 text-[13px] text-text-muted">Shared intelligence available to all apps and agents.</p>
          </div>
        </div>
      </header>
      <Tabs
        param="tab"
        value={tab}
        onChange={setTab}
        defaultValue="documents"
        className="px-6"
        tabs={[
          { value: 'documents', label: 'Documents', count: documents.length, icon: <FileText size={13} /> },
          { value: 'bases', label: 'Knowledge Bases', count: bases.length, icon: <BookOpen size={13} /> },
          { value: 'memory', label: 'Memory', icon: <Database size={13} /> },
          { value: 'episodes', label: 'Episodes', icon: <History size={13} /> },
        ]}
      />
      <main className="flex-1 overflow-y-auto px-6 py-5">
        {loading && tab !== 'memory' && tab !== 'episodes' ? <Skeleton height={340} /> : (
          <div className="mx-auto max-w-6xl space-y-5">
            {tab === 'documents' && (
              <>
                <WorkspaceDocDropZone bases={bases} selectedBaseId={selectedBaseId} onBaseChange={setSelectedBaseId} onUploaded={refresh} />
                <DocumentList documents={documents} onDelete={(document) => void deleteDocument(document)} />
              </>
            )}
            {tab === 'bases' && (
              <KnowledgeBaseList
                bases={bases}
                documentCounts={documentCounts}
                onCreate={createBase}
                onOpen={(base) => nav(`/knowledge/bases/${base.id}`)}
                onDelete={(base) => void deleteBase(base)}
              />
            )}
            {tab === 'memory' && <WorkspaceMemoryTab />}
            {tab === 'episodes' && <EpisodesTab />}
          </div>
        )}
      </main>
    </div>
  );
}