import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import clsx from 'clsx';
import { BookOpen, ExternalLink, Info, Plus, Save, Trash2, Workflow as WorkflowIcon } from 'lucide-react';
import { api, apiErrorMessage } from '../../lib/api';
import { useToast } from '../shared/Toast';
import { useConfirm } from '../shared/ConfirmDialog';
import { Button } from '../shared/Button';
import { Skeleton } from '../shared/Skeleton';
import { Drawer } from '../shared/Drawer';
import { WorkspaceDocDropZone } from './WorkspaceDocDropZone';
import { DocumentList } from './DocumentList';
import type { KnowledgeBaseRow, KnowledgeDocumentRow } from './types';

type ScopeKind = 'workspace' | 'workflow';
type OwnerWorkflow = { id: string; title: string };

type KnowledgeBaseView = KnowledgeBaseRow & {
  scopeId?: string | null;
  scopeKind?: ScopeKind;
  ownerWorkflow?: OwnerWorkflow | null;
  documentCount?: number;
};

type KnowledgeDocumentView = KnowledgeDocumentRow & {
  knowledgeBaseScopeKind?: ScopeKind;
  ownerWorkflow?: OwnerWorkflow | null;
};

interface KnowledgeChunkPreview {
  id: string;
  chunkIndex: number;
  content: string;
  metadata?: Record<string, unknown>;
  tokenCount?: number;
  createdAt?: string;
}

const GENERIC_WORKFLOW_KNOWLEDGE = 'workflow knowledge';

export function KnowledgeTab({ scopeId, scopeName }: { scopeId?: string; scopeName?: string }) {
  const toast = useToast();
  const nav = useNavigate();
  const confirm = useConfirm();
  const [bases, setBases] = useState<KnowledgeBaseView[]>([]);
  const [documents, setDocuments] = useState<KnowledgeDocumentView[]>([]);
  const [selectedBaseId, setSelectedBaseId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  const [inspectedBase, setInspectedBase] = useState<KnowledgeBaseView | null>(null);
  const [baseDraftName, setBaseDraftName] = useState('');
  const [baseDraftDescription, setBaseDraftDescription] = useState('');
  const [savingBaseDetails, setSavingBaseDetails] = useState(false);
  const [inspectedDocument, setInspectedDocument] = useState<KnowledgeDocumentView | null>(null);
  const [documentDraftName, setDocumentDraftName] = useState('');
  const [documentChunks, setDocumentChunks] = useState<KnowledgeChunkPreview[]>([]);
  const [chunkDrafts, setChunkDrafts] = useState<Record<string, string>>({});
  const [documentLoading, setDocumentLoading] = useState(false);
  const [savingDocument, setSavingDocument] = useState(false);
  const isScoped = Boolean(scopeId);
  const basePath = scopeId ? `/v1/knowledge-bases?scopeId=${encodeURIComponent(scopeId)}` : '/v1/knowledge-bases';
  const fallbackWorkflowName = scopeName?.trim() || 'Workflow knowledge';

  async function refresh(preferredBaseId?: string | null) {
    setLoading(true);
    try {
      const baseData = await api<{ knowledgeBases: KnowledgeBaseView[] }>(basePath);
      const nextBases = baseData.knowledgeBases ?? [];
      const nextSelected = preferredBaseId && nextBases.some((base) => base.id === preferredBaseId)
        ? preferredBaseId
        : selectedBaseId && nextBases.some((base) => base.id === selectedBaseId)
          ? selectedBaseId
          : nextBases[0]?.id ?? null;
      const documentLists = await Promise.all(nextBases.map(async (base) => {
        const data = await api<{ documents: KnowledgeDocumentRow[] }>(`/v1/knowledge-bases/${base.id}/documents`);
        return (data.documents ?? []).map((document) => decorateDocument(document, base, isScoped, fallbackWorkflowName));
      }));
      setBases(nextBases);
      setSelectedBaseId(nextSelected);
      setDocuments(documentLists.flat());
      setInspectedBase((current) => current ? nextBases.find((base) => base.id === current.id) ?? null : null);
    } catch (error) {
      toast.error('Failed to load knowledge', apiErrorMessage(error));
      setBases([]);
      setDocuments([]);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void refresh(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [scopeId, scopeName]);

  // A freshly uploaded document indexes in the background (embedding + grounding)
  // and reports `indexing` until ready. Poll quietly while that's true so it
  // flips to `ready` on its own — no manual refresh, no frozen screen.
  const anyIndexing = useMemo(() => documents.some((document) => document.status === 'indexing'), [documents]);
  useEffect(() => {
    if (!anyIndexing) return;
    const id = setInterval(() => { void refresh(selectedBaseId); }, 3000);
    return () => clearInterval(id);
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, [anyIndexing, selectedBaseId]);

  const documentCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const document of documents) counts.set(document.knowledgeBaseId, (counts.get(document.knowledgeBaseId) ?? 0) + 1);
    for (const base of bases) {
      if (typeof base.documentCount === 'number') counts.set(base.id, base.documentCount);
    }
    return counts;
  }, [bases, documents]);

  const baseById = useMemo(() => new Map(bases.map((base) => [base.id, base])), [bases]);
  const visibleDocuments = selectedBaseId
    ? documents.filter((document) => document.knowledgeBaseId === selectedBaseId)
    : documents;
  const selectedBase = bases.find((base) => base.id === selectedBaseId);
  const selectedBaseTitle = selectedBase ? baseTitle(selectedBase, isScoped, fallbackWorkflowName) : 'All documents';
  const selectedBaseSubtitle = selectedBase ? baseSubtitle(selectedBase, isScoped, fallbackWorkflowName) : 'Every knowledge source in this Brain';
  const defaultBaseName = isScoped ? fallbackWorkflowName : 'Workspace knowledge';

  async function createBase(event: React.FormEvent) {
    event.preventDefault();
    const name = newName.trim();
    if (!name || saving) return;
    setSaving(true);
    try {
      const result = await api<{ knowledgeBase: KnowledgeBaseView }>(basePath, {
        method: 'POST',
        body: JSON.stringify({ name, ...(scopeId ? { scopeId } : {}) }),
      });
      setCreating(false);
      setNewName('');
      toast.success('Collection created', name);
      await refresh(result.knowledgeBase.id);
    } catch (error) {
      toast.error('Could not create collection', apiErrorMessage(error));
    } finally {
      setSaving(false);
    }
  }

  async function deleteBase(base: KnowledgeBaseView) {
    const title = baseTitle(base, isScoped, fallbackWorkflowName);
    const ok = await confirm({
      title: `Delete collection "${title}"?`,
      body: 'All documents in this collection will be permanently removed. This action cannot be undone.',
      tone: 'danger',
      confirmLabel: 'Delete',
    });
    if (!ok) return;
    try {
      await api(`/v1/knowledge-bases/${base.id}`, { method: 'DELETE' });
      toast.success('Collection deleted', title);
      if (inspectedBase?.id === base.id) setInspectedBase(null);
      await refresh(base.id === selectedBaseId ? null : selectedBaseId);
    } catch (error) {
      toast.error('Could not delete collection', apiErrorMessage(error));
    }
  }

  async function saveBaseDetails() {
    if (!inspectedBase || savingBaseDetails) return;
    const name = baseDraftName.trim();
    if (!name) return;
    setSavingBaseDetails(true);
    try {
      const result = await api<{ knowledgeBase: KnowledgeBaseView }>(`/v1/knowledge-bases/${inspectedBase.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          name,
          description: baseDraftDescription.trim() || null,
        }),
      });
      toast.success('Collection updated', baseTitle(result.knowledgeBase, isScoped, fallbackWorkflowName));
      setInspectedBase(result.knowledgeBase);
      await refresh(result.knowledgeBase.id);
    } catch (error) {
      toast.error('Could not update collection', apiErrorMessage(error));
    } finally {
      setSavingBaseDetails(false);
    }
  }

  async function deleteDocument(document: KnowledgeDocumentView) {
    const ok = await confirm({
      title: `Delete "${document.name}"?`,
      body: 'This document and all its indexed chunks will be permanently removed.',
      tone: 'danger',
      confirmLabel: 'Delete',
    });
    if (!ok) return;
    await api(`/v1/knowledge-bases/${document.knowledgeBaseId}/documents/${document.id}`, { method: 'DELETE' });
    toast.success('Document removed', document.name);
    if (inspectedDocument?.id === document.id) setInspectedDocument(null);
    await refresh(selectedBaseId);
  }

  async function inspectDocument(document: KnowledgeDocumentView) {
    setInspectedDocument(document);
    setDocumentDraftName(document.name);
    setDocumentChunks([]);
    setDocumentLoading(true);
    try {
      const data = await api<{ document: KnowledgeDocumentRow; chunks: KnowledgeChunkPreview[] }>(
        `/v1/knowledge-bases/${document.knowledgeBaseId}/documents/${document.id}`,
      );
      const base = baseById.get(document.knowledgeBaseId);
      const decorated = base
        ? decorateDocument(data.document, base, isScoped, fallbackWorkflowName)
        : { ...document, ...data.document };
      setInspectedDocument(decorated);
      setDocumentDraftName(data.document.name);
      setDocumentChunks(data.chunks ?? []);
      setChunkDrafts(Object.fromEntries((data.chunks ?? []).map((chunk) => [chunk.id, chunk.content])));
    } catch (error) {
      toast.error('Could not load document details', apiErrorMessage(error));
    } finally {
      setDocumentLoading(false);
    }
  }

  async function saveDocumentDetails() {
    if (!inspectedDocument || savingDocument) return;
    const name = documentDraftName.trim();
    if (!name) return;
    setSavingDocument(true);
    try {
      const data = await api<{ document: KnowledgeDocumentRow; chunks: KnowledgeChunkPreview[] }>(
        `/v1/knowledge-bases/${inspectedDocument.knowledgeBaseId}/documents/${inspectedDocument.id}`,
        {
          method: 'PATCH',
          body: JSON.stringify({
            name,
            chunks: documentChunks.map((chunk) => ({
              id: chunk.id,
              content: chunkDrafts[chunk.id] ?? chunk.content,
            })),
          }),
        },
      );
      const base = baseById.get(inspectedDocument.knowledgeBaseId);
      const decorated = base
        ? decorateDocument(data.document, base, isScoped, fallbackWorkflowName)
        : { ...inspectedDocument, ...data.document };
      setInspectedDocument(decorated);
      setDocumentDraftName(data.document.name);
      setDocumentChunks(data.chunks ?? []);
      setChunkDrafts(Object.fromEntries((data.chunks ?? []).map((chunk) => [chunk.id, chunk.content])));
      toast.success('Document updated', data.document.name);
      await refresh(selectedBaseId);
    } catch (error) {
      toast.error('Could not update document', apiErrorMessage(error));
    } finally {
      setSavingDocument(false);
    }
  }

  function openBaseInspector(base: KnowledgeBaseView) {
    setInspectedBase(base);
    setBaseDraftName(base.name);
    setBaseDraftDescription(base.description ?? '');
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
          createBasePath={basePath}
          title={isScoped ? `Drop knowledge for ${fallbackWorkflowName}` : 'Drop knowledge here'}
          description={isScoped
            ? 'Attached to this workflow Brain, visible from Workspace Brain with workflow provenance.'
            : 'Workspace knowledge plus workflow-scoped collections, all with visible ownership.'}
          defaultBaseName={defaultBaseName}
          defaultBaseDescription={isScoped
            ? `Knowledge attached to ${fallbackWorkflowName}.`
            : 'Shared documents available to workflows and agents.'}
          emptySelectionLabel={isScoped ? `${fallbackWorkflowName} (new)` : 'Workspace knowledge (new)'}
          newBasePlaceholder={isScoped ? 'Workflow collection name' : 'New collection name'}
          labelForBase={(base) => pickerLabel(base, isScoped, fallbackWorkflowName)}
          accept=".pdf,.docx,.html,.htm,.md,.markdown,.txt,.csv,.json,.xlsx,.xls,text/*,application/json,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          showDescribeImages={false}
          compact
        />
        <div className="grid min-h-[420px] gap-4 lg:grid-cols-[264px_minmax(0,1fr)]">
          <aside className="rounded-card border border-line bg-surface p-2">
            <div className="flex items-center justify-between px-2 py-2">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-text-muted">Collections</span>
              <button type="button" aria-label="New collection" onClick={() => setCreating(true)} className="rounded-btn p-1 text-text-muted hover:bg-surface-2 hover:text-text-primary">
                <Plus size={14} />
              </button>
            </div>
            {creating && (
              <form className="mb-2 space-y-2 rounded-btn border border-line bg-surface-2 p-2" onSubmit={(event) => void createBase(event)}>
                <input autoFocus value={newName} onChange={(event) => setNewName(event.target.value)} placeholder={isScoped ? `${fallbackWorkflowName} notes` : 'New collection name'} className="h-8 w-full rounded-input border border-line bg-canvas px-2 text-[12px] text-text-primary focus:border-accent focus:outline-none" />
                <div className="flex gap-1.5">
                  <Button type="submit" size="sm" variant="primary" loading={saving}>Create</Button>
                  <Button size="sm" variant="ghost" onClick={() => { setCreating(false); setNewName(''); }}>Cancel</Button>
                </div>
              </form>
            )}
            {bases.length === 0 ? (
              <p className="px-2 py-5 text-[12px] leading-relaxed text-text-muted">
                Your first upload will create {isScoped ? 'workflow' : 'workspace'} knowledge automatically.
              </p>
            ) : bases.map((base) => {
              const active = selectedBaseId === base.id;
              const workflowScoped = base.scopeKind === 'workflow' || Boolean(base.scopeId);
              return (
                <div key={base.id} className="group relative">
                  <button
                    type="button"
                    onClick={() => setSelectedBaseId(base.id)}
                    className={clsx(
                      'mb-1 flex w-full items-start gap-2 rounded-btn px-2.5 py-2.5 pr-16 text-left transition-colors',
                      active ? 'bg-accent-soft text-text-primary' : 'text-text-secondary hover:bg-surface-2',
                    )}
                  >
                    <BookOpen size={13} className={clsx('mt-0.5 shrink-0', active ? 'text-accent' : 'text-text-muted')} />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1.5">
                        <span className="truncate text-[12px] font-medium">{baseTitle(base, isScoped, fallbackWorkflowName)}</span>
                        {workflowScoped && <ScopeBadge compact />}
                      </span>
                      <span className="mt-0.5 block truncate text-[10.5px] text-text-muted">{baseSubtitle(base, isScoped, fallbackWorkflowName)}</span>
                    </span>
                    <span className="text-[11px] text-text-muted">{documentCounts.get(base.id) ?? 0}</span>
                  </button>
                  <button
                    type="button"
                    title={`Inspect ${baseTitle(base, isScoped, fallbackWorkflowName)}`}
                    aria-label={`Inspect ${baseTitle(base, isScoped, fallbackWorkflowName)}`}
                    onClick={() => openBaseInspector(base)}
                    className="absolute right-7 top-2 rounded p-1 text-text-muted opacity-0 transition-opacity hover:bg-surface-3 hover:text-text-primary group-hover:opacity-100"
                  >
                    <Info size={12} />
                  </button>
                  <button
                    type="button"
                    title={`Delete ${baseTitle(base, isScoped, fallbackWorkflowName)}`}
                    aria-label={`Delete ${baseTitle(base, isScoped, fallbackWorkflowName)}`}
                    onClick={() => void deleteBase(base)}
                    className="absolute right-1.5 top-2 rounded p-1 text-text-muted opacity-0 transition-opacity hover:bg-danger-soft hover:text-danger group-hover:opacity-100"
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              );
            })}
            <button type="button" onClick={() => setCreating(true)} className="mt-2 inline-flex w-full items-center gap-2 rounded-btn px-2.5 py-2 text-[12px] text-text-muted hover:bg-surface-2 hover:text-text-primary">
              <Plus size={13} /> New collection
            </button>
          </aside>
          <section className="min-w-0">
            <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <h2 className="truncate text-heading text-text-primary">{selectedBaseTitle}</h2>
                  <span className="rounded-pill bg-surface-2 px-2 py-0.5 text-[11px] text-text-muted">{visibleDocuments.length} documents</span>
                  {selectedBase?.scopeKind === 'workflow' && <ScopeBadge />}
                </div>
                <p className="mt-1 text-[12px] text-text-muted">{selectedBaseSubtitle}</p>
              </div>
              {selectedBase && (
                <Button variant="ghost" size="sm" iconLeft={<Info size={12} />} onClick={() => openBaseInspector(selectedBase)}>
                  Inspect base
                </Button>
              )}
            </div>
            <DocumentList
              documents={visibleDocuments}
              onInspect={(document) => void inspectDocument(document)}
              onDelete={(document) => void deleteDocument(document)}
              emptyBody={isScoped ? 'Drop files above to add knowledge to this workflow.' : 'Drop files above to begin building this collection.'}
            />
          </section>
        </div>
      </div>

      <Drawer
        open={Boolean(inspectedBase)}
        onClose={() => setInspectedBase(null)}
        width="md"
        title={inspectedBase ? baseTitle(inspectedBase, isScoped, fallbackWorkflowName) : 'Collection'}
        subtitle={inspectedBase ? baseSubtitle(inspectedBase, isScoped, fallbackWorkflowName) : undefined}
        footer={(
          <>
            {inspectedBase?.ownerWorkflow?.id && !isScoped && (
              <Button variant="ghost" size="md" iconLeft={<ExternalLink size={13} />} onClick={() => nav(`/apps/workflows/${inspectedBase.ownerWorkflow!.id}?tab=brain`)}>
                Open logic Brain
              </Button>
            )}
            <Button variant="primary" size="md" iconLeft={<Save size={13} />} loading={savingBaseDetails} disabled={!baseDraftName.trim()} onClick={() => void saveBaseDetails()}>
              Save
            </Button>
          </>
        )}
      >
        {inspectedBase && (
          <div className="space-y-5">
            <div className="rounded-card border border-line bg-surface-2 p-3">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="text-[11px] font-semibold uppercase tracking-wide text-text-muted">Scope</div>
                  <div className="mt-1 flex items-center gap-2 text-[13px] text-text-primary">
                    {inspectedBase.scopeKind === 'workflow' ? <WorkflowIcon size={13} className="text-text-muted" /> : <BookOpen size={13} className="text-text-muted" />}
                    {inspectedBase.scopeKind === 'workflow' ? inspectedBase.ownerWorkflow?.title ?? 'Workflow' : 'Workspace shared knowledge'}
                  </div>
                </div>
                {inspectedBase.scopeKind === 'workflow' && <ScopeBadge />}
              </div>
            </div>
            <label className="block">
              <span className="text-[12px] font-medium text-text-secondary">Collection name</span>
              <input
                value={baseDraftName}
                onChange={(event) => setBaseDraftName(event.target.value)}
                className="mt-1 h-10 w-full rounded-input border border-line bg-canvas px-3 text-[13px] text-text-primary focus:border-accent focus:outline-none"
              />
              {isGenericWorkflowBaseName(inspectedBase.name) && inspectedBase.ownerWorkflow?.title && (
                <span className="mt-1 block text-[11px] text-text-muted">
                  Displayed as “{inspectedBase.ownerWorkflow.title}” in Workspace Brain until renamed.
                </span>
              )}
            </label>
            <label className="block">
              <span className="text-[12px] font-medium text-text-secondary">Description</span>
              <textarea
                value={baseDraftDescription}
                onChange={(event) => setBaseDraftDescription(event.target.value)}
                rows={4}
                className="mt-1 w-full rounded-input border border-line bg-canvas px-3 py-2 text-[13px] text-text-primary focus:border-accent focus:outline-none"
                placeholder="What should agents understand from this collection?"
              />
            </label>
            <div className="grid grid-cols-2 gap-2 text-[12px]">
              <Fact label="Documents" value={String(documentCounts.get(inspectedBase.id) ?? 0)} />
              <Fact label="Created" value={formatDate(inspectedBase.createdAt)} />
              <Fact label="Updated" value={formatDate(inspectedBase.updatedAt)} />
              <Fact label="Stored name" value={inspectedBase.name} />
            </div>
          </div>
        )}
      </Drawer>

      <Drawer
        open={Boolean(inspectedDocument)}
        onClose={() => setInspectedDocument(null)}
        width="lg"
        title={inspectedDocument?.name ?? 'Document'}
        subtitle={inspectedDocument?.knowledgeBaseName}
        footer={(
          <>
            {inspectedDocument && (
              <Button variant="ghost" size="md" iconLeft={<Trash2 size={13} />} onClick={() => void deleteDocument(inspectedDocument)}>
                Delete
              </Button>
            )}
            <Button variant="primary" size="md" iconLeft={<Save size={13} />} loading={savingDocument} disabled={!documentDraftName.trim()} onClick={() => void saveDocumentDetails()}>
              Save
            </Button>
          </>
        )}
      >
        {inspectedDocument && (
          <div className="space-y-5">
            <div className="rounded-card border border-line bg-surface-2 p-3">
              <div className="flex flex-wrap items-center gap-2">
                {inspectedDocument.knowledgeBaseScopeKind === 'workflow' ? <ScopeBadge /> : <span className="rounded-pill border border-line px-2 py-0.5 text-[10px] font-semibold text-text-muted">Workspace</span>}
                <span className="text-[12px] text-text-muted">
                  {inspectedDocument.knowledgeBaseScopeKind === 'workflow'
                    ? `From ${inspectedDocument.ownerWorkflow?.title ?? 'workflow Brain'}`
                    : 'Shared workspace knowledge'}
                </span>
              </div>
            </div>
            <label className="block">
              <span className="text-[12px] font-medium text-text-secondary">Document name</span>
              <input
                value={documentDraftName}
                onChange={(event) => setDocumentDraftName(event.target.value)}
                className="mt-1 h-10 w-full rounded-input border border-line bg-canvas px-3 text-[13px] text-text-primary focus:border-accent focus:outline-none"
              />
            </label>
            <div className="grid grid-cols-2 gap-2 text-[12px]">
              <Fact label="Collection" value={inspectedDocument.knowledgeBaseName ?? 'Collection'} />
              <Fact label="Status" value={inspectedDocument.status} />
              <Fact label="Type" value={inspectedDocument.mimeType} />
              <Fact label="Tokens" value={inspectedDocument.tokenCount != null ? String(inspectedDocument.tokenCount) : '—'} />
              <Fact label="Chunks" value={inspectedDocument.chunks != null ? String(inspectedDocument.chunks) : String(documentChunks.length || '—')} />
              <Fact label="Created" value={formatDate(inspectedDocument.createdAt)} />
            </div>
            <section>
              <div className="mb-2 flex items-center justify-between">
                <h3 className="text-[12px] font-semibold uppercase tracking-wide text-text-muted">Chunks</h3>
                {documentLoading && <span className="text-[11px] text-text-muted">Loading…</span>}
              </div>
              <div className="space-y-2">
                {documentChunks.length === 0 && !documentLoading ? (
                  <div className="rounded-card border border-line bg-surface-2 px-3 py-4 text-[12px] text-text-muted">No indexed chunks available yet.</div>
                ) : documentChunks.slice(0, 5).map((chunk) => (
                  <div key={chunk.id} className="rounded-card border border-line bg-bg-base p-3">
                    <div className="mb-2 flex items-center justify-between text-[11px] text-text-muted">
                      <span>Chunk {chunk.chunkIndex + 1}</span>
                      {chunk.tokenCount != null && <span>{chunk.tokenCount} tokens</span>}
                    </div>
                    <textarea
                      value={chunkDrafts[chunk.id] ?? chunk.content}
                      onChange={(event) => setChunkDrafts((drafts) => ({ ...drafts, [chunk.id]: event.target.value }))}
                      rows={5}
                      className="w-full resize-y rounded-input border border-line bg-canvas px-3 py-2 text-[12px] leading-relaxed text-text-primary focus:border-accent focus:outline-none"
                    />
                  </div>
                ))}
              </div>
            </section>
          </div>
        )}
      </Drawer>
    </main>
  );
}

function ScopeBadge({ compact = false }: { compact?: boolean }) {
  return (
    <span className={clsx(
      'inline-flex items-center justify-center rounded-full border border-accent/30 bg-accent-soft text-accent',
      compact ? 'h-4 w-4' : 'h-5 w-5',
    )} title="Workflow-scoped knowledge">
      <WorkflowIcon size={compact ? 10 : 11} />
    </span>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-card border border-line bg-surface-2 px-3 py-2">
      <div className="text-[10px] font-semibold uppercase tracking-wide text-text-muted">{label}</div>
      <div className="mt-1 truncate text-text-primary" title={value}>{value}</div>
    </div>
  );
}

function decorateDocument(
  document: KnowledgeDocumentRow,
  base: KnowledgeBaseView,
  viewingScoped: boolean,
  fallbackWorkflowName: string,
): KnowledgeDocumentView {
  return {
    ...document,
    knowledgeBaseName: baseTitle(base, viewingScoped, fallbackWorkflowName),
    knowledgeBaseScopeKind: base.scopeKind ?? (base.scopeId ? 'workflow' : 'workspace'),
    ownerWorkflow: base.ownerWorkflow ?? null,
  };
}

function pickerLabel(base: KnowledgeBaseView, viewingScoped: boolean, fallbackWorkflowName: string): string {
  const primary = baseTitle(base, viewingScoped, fallbackWorkflowName);
  const secondary = baseSubtitle(base, viewingScoped, fallbackWorkflowName);
  if (!secondary || secondary === 'Shared workspace knowledge') return primary;
  return `${primary} · ${secondary}`;
}

function baseTitle(base: KnowledgeBaseView, viewingScoped: boolean, fallbackWorkflowName: string): string {
  const workflowTitle = base.ownerWorkflow?.title ?? (base.scopeId ? fallbackWorkflowName : null);
  if (base.scopeKind === 'workflow' || base.scopeId) {
    if (!viewingScoped) return workflowTitle ?? cleanBaseName(base.name);
    if (isGenericWorkflowBaseName(base.name)) return workflowTitle ?? fallbackWorkflowName;
  }
  return cleanBaseName(base.name);
}

function baseSubtitle(base: KnowledgeBaseView, viewingScoped: boolean, fallbackWorkflowName: string): string {
  if (base.scopeKind === 'workflow' || base.scopeId) {
    const workflowTitle = base.ownerWorkflow?.title ?? fallbackWorkflowName;
    const collectionName = cleanBaseName(base.name);
    if (!viewingScoped) {
      if (!isGenericWorkflowBaseName(base.name) && collectionName !== workflowTitle) return collectionName;
      return 'Scoped workflow knowledge';
    }
    return `Scoped to ${workflowTitle}`;
  }
  return 'Shared workspace knowledge';
}

function cleanBaseName(name: string): string {
  return name.trim() || 'Collection';
}

function isGenericWorkflowBaseName(name: string): boolean {
  return name.trim().toLowerCase() === GENERIC_WORKFLOW_KNOWLEDGE;
}

function formatDate(value?: string): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}
