import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, ArrowUpFromLine, Search, Trash2 } from 'lucide-react';
import { api } from '../lib/api';
import { useToast } from '../components/shared/Toast';
import { useConfirm } from '../components/shared/ConfirmDialog';
import { Button } from '../components/shared/Button';
import { Skeleton } from '../components/shared/Skeleton';
import { WorkspaceDocDropZone } from '../components/knowledge/WorkspaceDocDropZone';
import { DocumentList } from '../components/knowledge/DocumentList';
import type { KnowledgeBaseRow, KnowledgeDocumentRow } from '../components/knowledge/types';

interface SearchHit {
  id: string;
  documentId: string;
  chunkIndex: number;
  content: string;
  score: number;
}

export function KnowledgeBasePage() {
  const { knowledgeBaseId } = useParams<{ knowledgeBaseId: string }>();
  const nav = useNavigate();
  const toast = useToast();
  const confirm = useConfirm();
  const [base, setBase] = useState<KnowledgeBaseRow | null>(null);
  const [documents, setDocuments] = useState<KnowledgeDocumentRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [packaging, setPackaging] = useState(false);

  async function refresh() {
    if (!knowledgeBaseId) return;
    setLoading(true);
    try {
      const [baseData, docData] = await Promise.all([
        api<{ knowledgeBase: KnowledgeBaseRow }>(`/v1/knowledge-bases/${knowledgeBaseId}`),
        api<{ documents: KnowledgeDocumentRow[] }>(`/v1/knowledge-bases/${knowledgeBaseId}/documents`),
      ]);
      setBase(baseData.knowledgeBase);
      setName(baseData.knowledgeBase.name);
      setDescription(baseData.knowledgeBase.description ?? '');
      setDocuments((docData.documents ?? []).map((document) => ({ ...document, knowledgeBaseName: baseData.knowledgeBase.name })));
    } catch (err) {
      toast.error('Failed to load knowledge base', String(err));
      setBase(null);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void refresh(); }, [knowledgeBaseId]);

  async function saveDetails() {
    if (!base) return;
    await api(`/v1/knowledge-bases/${base.id}`, { method: 'PATCH', body: JSON.stringify({ name, description: description || null }) });
    toast.success('Knowledge base updated');
    await refresh();
  }

  async function deleteBase() {
    if (!base) return;
    const ok = await confirm({ title: `Delete "${base.name}"?`, body: 'All documents in this knowledge base will be removed.', confirmLabel: 'Delete base', tone: 'danger' });
    if (!ok) return;
    await api(`/v1/knowledge-bases/${base.id}`, { method: 'DELETE' });
    toast.success('Knowledge base deleted');
    nav('/brain?tab=knowledge');
  }

  async function deleteDocument(document: KnowledgeDocumentRow) {
    await api(`/v1/knowledge-bases/${document.knowledgeBaseId}/documents/${document.id}`, { method: 'DELETE' });
    toast.success('Document removed', document.name);
    await refresh();
  }

  async function packageBase() {
    if (!base || packaging) return;
    setPackaging(true);
    try {
      await api(`/v1/packages/pack/knowledge/${base.id}`, {
        method: 'POST',
        body: JSON.stringify({
          name: base.name,
          description: base.description ?? undefined,
          tags: ['knowledge'],
        }),
      });
      toast.success('Knowledge package created', base.name);
    } catch (err) {
      toast.error('Package failed', String(err));
    } finally {
      setPackaging(false);
    }
  }

  async function search() {
    if (!base || !query.trim()) return;
    setSearching(true);
    try {
      const data = await api<{ results: SearchHit[] }>(`/v1/knowledge-bases/${base.id}/search`, {
        method: 'POST',
        body: JSON.stringify({ query: query.trim(), topK: 8 }),
      });
      setResults(data.results ?? []);
    } catch (err) {
      toast.error('Search failed', String(err));
      setResults([]);
    } finally {
      setSearching(false);
    }
  }

  if (loading) return <div className="p-6"><Skeleton height={420} /></div>;
  if (!base) return <div className="p-8 text-[14px] text-text-muted">Knowledge base not found.</div>;

  return (
    <div className="flex h-full flex-col">
      <header className="border-b border-line px-6 py-4">
        <button onClick={() => nav('/brain?tab=knowledge')} className="mb-3 inline-flex items-center gap-1 text-[12px] text-text-muted hover:text-text-primary">
          <ArrowLeft size={12} /> Knowledge
        </button>
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-0 flex-1">
            <input value={name} onChange={(event) => setName(event.target.value)} className="w-full bg-transparent text-display text-text-primary focus:outline-none" />
            <input value={description} onChange={(event) => setDescription(event.target.value)} placeholder="Description" className="mt-1 w-full bg-transparent text-[13px] text-text-muted placeholder:text-text-muted focus:outline-none" />
          </div>
          <Button variant="secondary" size="sm" onClick={() => void saveDetails()}>Save details</Button>
          <Button variant="secondary" size="sm" loading={packaging} iconLeft={<ArrowUpFromLine size={12} />} onClick={() => void packageBase()}>Package</Button>
          <Button variant="danger" size="sm" iconLeft={<Trash2 size={12} />} onClick={() => void deleteBase()}>Delete</Button>
        </div>
      </header>
      <main className="flex-1 overflow-y-auto px-6 py-5">
        <div className="mx-auto max-w-6xl space-y-5">
          <WorkspaceDocDropZone bases={[base]} selectedBaseId={base.id} onUploaded={refresh} />
          <section className="rounded-card border border-line bg-surface p-4">
            <div className="flex gap-2">
              <input value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void search(); }} placeholder="Search this base" className="h-9 flex-1 rounded-input border border-line bg-surface-2 px-3 text-[13px] text-text-primary placeholder:text-text-muted focus:border-accent focus:outline-none" />
              <Button variant="primary" size="md" loading={searching} iconLeft={<Search size={12} />} onClick={() => void search()}>Search</Button>
            </div>
            {results.length > 0 && (
              <div className="mt-4 space-y-2">
                {results.map((result) => (
                  <div key={result.id} className="rounded-card border border-line bg-surface-2 p-3">
                    <div className="mb-1 text-[11px] text-text-muted">score {Math.round(result.score * 100)}% · chunk {result.chunkIndex + 1}</div>
                    <p className="text-[12px] leading-relaxed text-text-secondary">{result.content}</p>
                  </div>
                ))}
              </div>
            )}
          </section>
          <DocumentList documents={documents} onDelete={(document) => void deleteDocument(document)} />
        </div>
      </main>
    </div>
  );
}



