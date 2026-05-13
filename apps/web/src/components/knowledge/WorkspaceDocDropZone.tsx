import { useRef, useState } from 'react';
import clsx from 'clsx';
import { UploadCloud } from 'lucide-react';
import { api } from '../../lib/api';
import { useToast } from '../shared/Toast';
import { Button } from '../shared/Button';
import type { KnowledgeBaseRow } from './types';

export function WorkspaceDocDropZone({
  bases,
  selectedBaseId,
  onBaseChange,
  onUploaded,
}: {
  bases: KnowledgeBaseRow[];
  selectedBaseId?: string | null;
  onBaseChange?: (id: string) => void;
  onUploaded: () => Promise<void>;
}) {
  const toast = useToast();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const activeBaseId = selectedBaseId ?? bases[0]?.id ?? null;

  async function ensureBase(): Promise<string> {
    if (activeBaseId) return activeBaseId;
    const created = await api<{ knowledgeBase: KnowledgeBaseRow }>('/v1/knowledge-bases', {
      method: 'POST',
      body: JSON.stringify({ name: 'Workspace knowledge', description: 'Shared documents available to apps and agents.' }),
    });
    return created.knowledgeBase.id;
  }

  async function upload(file: File | null) {
    if (!file || uploading) return;
    setUploading(true);
    try {
      const baseId = await ensureBase();
      const form = new FormData();
      form.set('file', file);
      form.set('name', file.name);
      form.set('mimeType', file.type || mimeFromName(file.name));
      await api(`/v1/knowledge-bases/${baseId}/documents`, {
        method: 'POST',
        body: form,
      });
      toast.success('Document indexed', file.name);
      await onUploaded();
    } catch (err) {
      toast.error('Upload failed', String(err));
    } finally {
      setUploading(false);
      setDragging(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  }

  return (
    <section
      onDragOver={(event) => { event.preventDefault(); setDragging(true); }}
      onDragLeave={() => setDragging(false)}
      onDrop={(event) => { event.preventDefault(); void upload(event.dataTransfer.files?.[0] ?? null); }}
      className={clsx(
        'rounded-card border border-dashed bg-surface px-5 py-8 text-center transition-colors',
        dragging ? 'border-accent bg-accent-soft' : 'border-line',
      )}
    >
      <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-card border border-line bg-surface-2 text-accent">
        <UploadCloud size={22} />
      </div>
      <h3 className="mt-4 text-heading text-text-primary">Drop files here</h3>
      <p className="mt-1 text-[13px] text-text-muted">PDF, Markdown, plain text, CSV, JSON, and DOCX text exports are accepted.</p>
      <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
        {bases.length > 0 && (
          <select
            value={activeBaseId ?? ''}
            onChange={(event) => onBaseChange?.(event.target.value)}
            className="h-9 max-w-64 rounded-input border border-line bg-surface-2 px-3 text-[13px] text-text-primary focus:border-accent focus:outline-none"
          >
            {bases.map((base) => <option key={base.id} value={base.id}>{base.name}</option>)}
          </select>
        )}
        <Button variant="primary" size="md" loading={uploading} onClick={() => inputRef.current?.click()}>
          Browse files
        </Button>
      </div>
      <input ref={inputRef} type="file" className="hidden" onChange={(event) => void upload(event.target.files?.[0] ?? null)} />
    </section>
  );
}

function mimeFromName(name: string): string {
  const lower = name.toLowerCase();
  if (lower.endsWith('.md')) return 'text/markdown';
  if (lower.endsWith('.csv')) return 'text/csv';
  if (lower.endsWith('.json')) return 'application/json';
  if (lower.endsWith('.pdf')) return 'application/pdf';
  return 'text/plain';
}