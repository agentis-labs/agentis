/**
 * WorkspaceKnowledgePanels — body of the workspace-knowledge tabs.
 *
 * The parent owns the active tab key, so this component is purely a
 * controlled view that fetches its own data.
 */

import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, apiErrorMessage } from '../../lib/api';
import { useToast } from '../shared/Toast';
import { Skeleton } from '../shared/Skeleton';
import { WorkspaceDocDropZone } from './WorkspaceDocDropZone';
import { DocumentList } from './DocumentList';
import { KnowledgeBaseList } from './KnowledgeBaseList';
import type { KnowledgeBaseRow, KnowledgeDocumentRow } from './types';

export type WorkspaceKnowledgeTab = 'documents' | 'bases';

export interface WorkspaceKnowledgePanelsHandles {
  documentCount: number;
  baseCount: number;
}

export interface WorkspaceKnowledgePanelsProps {
  tab: WorkspaceKnowledgeTab;
  onCounts?: (counts: WorkspaceKnowledgePanelsHandles) => void;
}

export function WorkspaceKnowledgePanels({ tab, onCounts }: WorkspaceKnowledgePanelsProps) {
  const nav = useNavigate();
  const toast = useToast();
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
      toast.error('Failed to load knowledge', apiErrorMessage(err));
      setBases([]);
      setDocuments([]);
    } finally {
      setLoading(false);
    }
  }

  // Initial load (parent may re-mount the component to force a refresh).
  useEffect(() => { void refresh(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  useEffect(() => {
    onCounts?.({ documentCount: documents.length, baseCount: bases.length });
  }, [documents.length, bases.length, onCounts]);

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

  async function packageBase(base: KnowledgeBaseRow) {
    await api(`/v1/packages/pack/knowledge/${base.id}`, {
      method: 'POST',
      body: JSON.stringify({
        name: base.name,
        description: base.description ?? undefined,
        tags: ['knowledge'],
      }),
    });
    toast.success('Knowledge package created', base.name);
  }

  async function deleteDocument(document: KnowledgeDocumentRow) {
    await api(`/v1/knowledge-bases/${document.knowledgeBaseId}/documents/${document.id}`, { method: 'DELETE' });
    toast.success('Document removed', document.name);
    await refresh();
  }

  if (loading) {
    return <Skeleton height={340} />;
  }

  return (
    <div className="space-y-5">
      {tab === 'documents' && (
        <>
          <div className="rounded-card border border-cyan-400/20 bg-cyan-500/[0.06] px-4 py-2.5 text-[12px] text-text-secondary">
            <span className="font-semibold text-cyan-200">Workspace knowledge.</span>{' '}
            Documents added here are shared across the whole workspace — every app and agent can draw on them.
            To scope knowledge to a single app, upload it from that app&apos;s Brain tab.
          </div>
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
          onPackage={(base) => void packageBase(base)}
        />
      )}
    </div>
  );
}
