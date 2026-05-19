import { useRef, useState } from 'react';
import clsx from 'clsx';
import { Check, UploadCloud, X } from 'lucide-react';
import { api, apiErrorMessage } from '../../lib/api';
import { useToast } from '../shared/Toast';
import { Button } from '../shared/Button';
import type { KnowledgeBaseRow } from './types';

const NEW_BASE = '__new__';

export function WorkspaceDocDropZone({
  bases,
  selectedBaseId,
  onBaseChange,
  onUploaded,
  createBasePath = '/v1/knowledge-bases',
  uploadPathForBase = (baseId) => `/v1/knowledge-bases/${baseId}/documents`,
  defaultBaseName = 'Workspace knowledge',
  defaultBaseDescription = 'Shared documents available to apps and agents.',
  title = 'Add workspace knowledge',
  description = 'Shared across every app and agent. PDF, DOCX, HTML, Markdown, plain text, CSV, and JSON are accepted.',
  emptySelectionLabel = 'Workspace knowledge (new)',
  newBasePlaceholder = 'New collection name',
}: {
  bases: KnowledgeBaseRow[];
  selectedBaseId?: string | null;
  onBaseChange?: (id: string) => void;
  onUploaded: () => Promise<void>;
  createBasePath?: string;
  uploadPathForBase?: (baseId: string) => string;
  defaultBaseName?: string;
  defaultBaseDescription?: string;
  title?: string;
  description?: string;
  emptySelectionLabel?: string;
  newBasePlaceholder?: string;
}) {
  const toast = useToast();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [savingBase, setSavingBase] = useState(false);
  const activeBaseId = selectedBaseId ?? bases[0]?.id ?? null;

  async function ensureBase(): Promise<string> {
    if (activeBaseId) return activeBaseId;
    const created = await api<{ knowledgeBase: KnowledgeBaseRow }>(createBasePath, {
      method: 'POST',
      body: JSON.stringify({ name: defaultBaseName, description: defaultBaseDescription }),
    });
    return created.knowledgeBase.id;
  }

  async function createBase() {
    const name = newName.trim();
    if (!name || savingBase) return;
    setSavingBase(true);
    try {
      const created = await api<{ knowledgeBase: KnowledgeBaseRow }>(createBasePath, {
        method: 'POST',
        body: JSON.stringify({ name, description: defaultBaseDescription }),
      });
      onBaseChange?.(created.knowledgeBase.id);
      setCreating(false);
      setNewName('');
      await onUploaded();
      toast.success('Knowledge base created', name);
    } catch (err) {
      toast.error('Could not create knowledge base', apiErrorMessage(err));
    } finally {
      setSavingBase(false);
    }
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
      await api(uploadPathForBase(baseId), {
        method: 'POST',
        body: form,
      });
      toast.success('Document indexed', file.name);
      await onUploaded();
    } catch (err) {
      toast.error('Upload failed', apiErrorMessage(err));
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
      <h3 className="mt-4 text-heading text-text-primary">{title}</h3>
      <p className="mt-1 text-[13px] text-text-muted">{description}</p>

      <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
        {creating ? (
          <div className="flex items-center gap-1.5">
            <input
              autoFocus
              value={newName}
              onChange={(event) => setNewName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void createBase();
                if (event.key === 'Escape') { setCreating(false); setNewName(''); }
              }}
              placeholder={newBasePlaceholder}
              aria-label="New knowledge base name"
              className="h-9 w-60 rounded-input border border-accent bg-surface-2 px-3 text-[13px] text-text-primary focus:outline-none"
            />
            <Button variant="primary" size="md" iconLeft={<Check size={13} />} loading={savingBase} disabled={!newName.trim()} onClick={() => void createBase()}>
              Create
            </Button>
            <Button variant="ghost" size="md" iconLeft={<X size={13} />} onClick={() => { setCreating(false); setNewName(''); }}>
              Cancel
            </Button>
          </div>
        ) : (
          <>
            <span className="text-[12px] text-text-muted">Add to</span>
            <select
              value={activeBaseId ?? ''}
              onChange={(event) => {
                if (event.target.value === NEW_BASE) { setCreating(true); return; }
                onBaseChange?.(event.target.value);
              }}
              className="h-9 max-w-64 rounded-input border border-line bg-surface-2 px-3 text-[13px] text-text-primary focus:border-accent focus:outline-none"
            >
              {bases.length === 0 && <option value="">{emptySelectionLabel}</option>}
              {bases.map((base) => <option key={base.id} value={base.id}>{base.name}</option>)}
              <option value={NEW_BASE}>+ New collection…</option>
            </select>
            <Button variant="primary" size="md" loading={uploading} onClick={() => inputRef.current?.click()}>
              Browse files
            </Button>
          </>
        )}
      </div>
      <input
        ref={inputRef}
        type="file"
        accept=".pdf,.docx,.html,.htm,.md,.markdown,.txt,.csv,.json,text/*,application/json,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        className="hidden"
        onChange={(event) => void upload(event.target.files?.[0] ?? null)}
      />
    </section>
  );
}

function mimeFromName(name: string): string {
  const lower = name.toLowerCase();
  if (lower.endsWith('.md')) return 'text/markdown';
  if (lower.endsWith('.csv')) return 'text/csv';
  if (lower.endsWith('.json')) return 'application/json';
  if (lower.endsWith('.pdf')) return 'application/pdf';
  if (lower.endsWith('.docx')) return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  if (lower.endsWith('.html') || lower.endsWith('.htm')) return 'text/html';
  return 'text/plain';
}
