import { useEffect, useMemo, useState } from 'react';
import clsx from 'clsx';
import { BookOpen, MoreHorizontal, Plus, Trash2 } from 'lucide-react';
import { api, apiErrorMessage } from '../../lib/api';
import { useToast } from '../shared/Toast';
import { Button } from '../shared/Button';
import { Skeleton } from '../shared/Skeleton';
import { WorkspaceDocDropZone } from './WorkspaceDocDropZone';
import { DocumentList } from './DocumentList';
import type { KnowledgeBaseRow, KnowledgeDocumentRow } from './types';

export function KnowledgeTab() {
  const toast = useToast();
  const [bases, setBases] = useState<KnowledgeBaseRow[]>([]);
  const [documents, setDocuments] = useState<KnowledgeDocumentRow[]>([]);
  const [selectedBaseId, setSelectedBaseId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);

  async function refresh(preferredBaseId?: string | null) {
    setLoading(true);
    try {
      const baseData = await api<{ knowledgeBases: KnowledgeBaseRow[] }>('/v1/knowledge-bases');
      const nextBases = baseData.knowledgeBases ?? [];
      const nextSelected = preferredBaseId && nextBases.some((base) => base.id === preferredBaseId)
        ? preferredBaseId
        : selectedBaseId && nextBases.some((base) => base.id === selectedBaseId)
          ? selectedBaseId
          : nextBases[0]?.id ?? null;
      const documentLists = await Promise.all(nextBases.map(async (base) => {
        const data = await api<{ documents: KnowledgeDocumentRow[] }>(`/v1/knowledge-bases/${base.id}/documents`);
        return (data.documents ?? []).map((document) => ({ ...document, knowledgeBaseName: base.name }));
      }));
      setBases(nextBases);
      setSelectedBaseId(nextSelected);
      setDocuments(documentLists.flat());
    } catch (error) {
      toast.error('Failed to load knowledge', apiErrorMessage(error));
      setBases([]);
      setDocuments([]);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void refresh(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  const documentCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const document of documents) counts.set(document.knowledgeBaseId, (counts.get(document.knowledgeBaseId) ?? 0) + 1);
    return counts;
  }, [documents]);

  const visibleDocuments = selectedBaseId
    ? documents.filter((document) => document.knowledgeBaseId === selectedBaseId)
    : documents;
  const selectedBase = bases.find((base) => base.id === selectedBaseId);

  async function createBase(event: React.FormEvent) {
    event.preventDefault();
    const name = newName.trim();
    if (!name || saving) return;
    setSaving(true);
    try {
      const result = await api<{ knowledgeBase: KnowledgeBaseRow }>('/v1/knowledge-bases', {
        method: 'POST',
        body: JSON.stringify({ name }),
      });
      setCreating(false);
      setNewName('');
      toast.success('Knowledge base created', name);
      await refresh(result.knowledgeBase.id);
    } catch (error) {
      toast.error('Could not create knowledge base', apiErrorMessage(error));
    } finally {
      setSaving(false);
    }
  }

  async function deleteBase(base: KnowledgeBaseRow) {
    try {
      await api(`/v1/knowledge-bases/${base.id}`, { method: 'DELETE' });
      toast.success('Knowledge base deleted', base.name);
      await refresh(base.id === selectedBaseId ? null : selectedBaseId);
    } catch (error) {
      toast.error('Could not delete knowledge base', apiErrorMessage(error));
    }
  }

  async function deleteDocument(document: KnowledgeDocumentRow) {
    await api(`/v1/knowledge-bases/${document.knowledgeBaseId}/documents/${document.id}`, { method: 'DELETE' });
    toast.success('Document removed', document.name);
    await refresh(selectedBaseId);
  }

  if (loading && bases.length === 0) {
    return <div className="p-6"><Skeleton height={92} /><div className="mt-4"><Skeleton height={360} /></div></div>;
  }

  return (
    <main className="h-full overflow-y-auto px-6 py-5">
      <div className="mx-auto flex max-w-7xl flex-col gap-4">
        <WorkspaceDocDropZone
          bases={bases}
          selectedBaseId={selectedBaseId}
          onBaseChange={setSelectedBaseId}
          onUploaded={() => refresh(selectedBaseId)}
          title="Drop knowledge here"
          description="PDF, DOCX, Markdown, CSV, HTML, and JSON documents."
          accept=".pdf,.docx,.html,.htm,.md,.markdown,.txt,.csv,.json,.xlsx,.xls,text/*,application/json,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          showDescribeImages={false}
          compact
        />
        <div className="grid min-h-[420px] gap-4 lg:grid-cols-[240px_minmax(0,1fr)]">
          <aside className="rounded-card border border-line bg-surface p-2">
            <div className="flex items-center justify-between px-2 py-2">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-text-muted">Knowledge Bases</span>
              <button type="button" aria-label="New knowledge base" onClick={() => setCreating(true)} className="rounded-btn p-1 text-text-muted hover:bg-surface-2 hover:text-text-primary">
                <Plus size={14} />
              </button>
            </div>
            {creating && (
              <form className="mb-2 space-y-2 rounded-btn border border-line bg-surface-2 p-2" onSubmit={(event) => void createBase(event)}>
                <input autoFocus value={newName} onChange={(event) => setNewName(event.target.value)} placeholder="New base name" className="h-8 w-full rounded-input border border-line bg-canvas px-2 text-[12px] text-text-primary focus:border-accent focus:outline-none" />
                <div className="flex gap-1.5">
                  <Button type="submit" size="sm" variant="primary" loading={saving}>Create</Button>
                  <Button size="sm" variant="ghost" onClick={() => { setCreating(false); setNewName(''); }}>Cancel</Button>
                </div>
              </form>
            )}
            {bases.length === 0 ? (
              <p className="px-2 py-5 text-[12px] leading-relaxed text-text-muted">Your first upload will create workspace knowledge automatically.</p>
            ) : bases.map((base) => (
              <div key={base.id} className="group relative">
                <button
                  type="button"
                  onClick={() => setSelectedBaseId(base.id)}
                  className={clsx(
                    'mb-1 flex w-full items-center gap-2 rounded-btn px-2.5 py-2.5 pr-8 text-left transition-colors',
                    selectedBaseId === base.id ? 'bg-accent-soft text-text-primary' : 'text-text-secondary hover:bg-surface-2',
                  )}
                >
                  <BookOpen size={13} className={selectedBaseId === base.id ? 'text-accent' : 'text-text-muted'} />
                  <span className="min-w-0 flex-1 truncate text-[12px] font-medium">{base.name}</span>
                  <span className="text-[11px] text-text-muted">{documentCounts.get(base.id) ?? 0}</span>
                </button>
                <button
                  type="button"
                  title={`Delete ${base.name}`}
                  aria-label={`Delete ${base.name}`}
                  onClick={() => void deleteBase(base)}
                  className="absolute right-1.5 top-2 hidden rounded p-1 text-text-muted hover:bg-danger-soft hover:text-danger group-hover:block"
                >
                  <Trash2 size={12} />
                </button>
              </div>
            ))}
            <button type="button" onClick={() => setCreating(true)} className="mt-2 inline-flex w-full items-center gap-2 rounded-btn px-2.5 py-2 text-[12px] text-text-muted hover:bg-surface-2 hover:text-text-primary">
              <Plus size={13} /> New base
            </button>
          </aside>
          <section className="min-w-0">
            <div className="mb-3 flex items-center gap-2">
              <h2 className="text-heading text-text-primary">{selectedBase?.name ?? 'All documents'}</h2>
              <span className="rounded-pill bg-surface-2 px-2 py-0.5 text-[11px] text-text-muted">{visibleDocuments.length} documents</span>
              {selectedBase && <MoreHorizontal size={14} className="ml-auto text-text-muted" />}
            </div>
            <DocumentList documents={visibleDocuments} onDelete={(document) => void deleteDocument(document)} emptyBody="Drop files above to begin building this knowledge base." />
          </section>
        </div>
      </div>
    </main>
  );
}
