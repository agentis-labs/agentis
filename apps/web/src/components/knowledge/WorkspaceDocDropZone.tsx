import { useEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import { Check, FileText, Scissors, Sparkles, Network, BookOpenCheck, Loader2, UploadCloud, X } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { api, apiErrorMessage } from '../../lib/api';
import { useToast } from '../shared/Toast';
import { Button } from '../shared/Button';
import type { KnowledgeBaseRow } from './types';

const NEW_BASE = '__new__';

/**
 * The real ingestion pipeline a dropped file flows through, narrated so a long
 * embed (the on-device multilingual model is the slow step, especially on its
 * first cold load) reads as honest progress rather than a frozen skeleton.
 */
const INGEST_STEPS: Array<{ icon: LucideIcon; label: string; detail: string }> = [
  { icon: FileText, label: 'Reading the document', detail: 'Extracting clean text from the file.' },
  { icon: Scissors, label: 'Splitting into passages', detail: 'Chunking into semantically coherent pieces.' },
  { icon: Sparkles, label: 'Generating embeddings', detail: 'Encoding each passage with the on-device multilingual model — the first upload also warms the model, which can take a moment.' },
  { icon: Network, label: 'Grounding & linking', detail: 'Summarizing passages and wiring them into the Brain graph.' },
  { icon: BookOpenCheck, label: 'Indexing', detail: 'Making the knowledge retrievable for this Brain.' },
];

function IngestProgress() {
  const [step, setStep] = useState(0);
  useEffect(() => {
    // Advance through the pipeline, then dwell on the embedding step (the slow
    // one) so the narration tracks where the time actually goes.
    const id = setInterval(() => setStep((s) => (s >= INGEST_STEPS.length - 1 ? 2 : s + 1)), 2600);
    return () => clearInterval(id);
  }, []);
  const Active = INGEST_STEPS[step]!.icon;
  return (
    <div className="mt-4 rounded-card border border-accent/30 bg-accent-soft/40 px-4 py-3 text-left">
      <div className="flex items-center gap-2">
        <Loader2 size={14} className="animate-spin text-accent" />
        <span className="text-[13px] font-semibold text-text-primary">Indexing into the Brain</span>
        <span className="ml-auto text-[11px] text-text-muted">step {step + 1} of {INGEST_STEPS.length}</span>
      </div>
      <div className="mt-2 flex items-start gap-2">
        <Active size={15} className="mt-0.5 shrink-0 text-accent" />
        <div>
          <p className="text-[13px] font-medium text-text-primary">{INGEST_STEPS[step]!.label}</p>
          <p className="mt-0.5 text-[12px] leading-5 text-text-secondary">{INGEST_STEPS[step]!.detail}</p>
        </div>
      </div>
      <div className="mt-3 flex gap-1">
        {INGEST_STEPS.map((_, i) => (
          <span key={i} className={clsx('h-1 flex-1 rounded-full transition-colors', i <= step ? 'bg-accent' : 'bg-line')} />
        ))}
      </div>
      <p className="mt-2 text-[11px] text-text-muted">You can keep working — this finishes in the background.</p>
    </div>
  );
}

export function WorkspaceDocDropZone({
  bases,
  selectedBaseId,
  onBaseChange,
  onUploaded,
  createBasePath = '/v1/knowledge-bases',
  uploadPathForBase = (baseId) => `/v1/knowledge-bases/${baseId}/documents`,
  defaultBaseName = 'Workspace knowledge',
  defaultBaseDescription = 'Shared documents available to workflows and agents.',
  title = 'Add workspace knowledge',
  description = 'Shared across workflows and agents. Documents are accepted; images and spreadsheets require configured extractors.',
  emptySelectionLabel = 'Workspace knowledge (new)',
  newBasePlaceholder = 'New collection name',
  compact = false,
  accept = '.pdf,.docx,.html,.htm,.md,.markdown,.txt,.csv,.json,.xlsx,.png,.jpg,.jpeg,.webp,.mp3,.m4a,.wav,.ogg,text/*,image/*,audio/*,application/json,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  showDescribeImages = true,
  hideBaseSelector = false,
  labelForBase = (base) => base.name,
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
  compact?: boolean;
  accept?: string;
  showDescribeImages?: boolean;
  hideBaseSelector?: boolean;
  labelForBase?: (base: KnowledgeBaseRow) => string;
}) {
  const toast = useToast();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [savingBase, setSavingBase] = useState(false);
  const [describeImages, setDescribeImages] = useState(false);
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
      if (describeImages) form.set('describeImage', 'true');
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
        'rounded-card border border-dashed bg-surface transition-colors',
        compact ? 'flex flex-wrap items-center gap-3 px-4 py-3' : 'px-5 py-8 text-center',
        dragging ? 'border-accent bg-accent-soft' : 'border-line',
      )}
    >
      <div className={clsx('flex items-center justify-center rounded-card border border-line bg-surface-2 text-accent', compact ? 'h-9 w-9 shrink-0' : 'mx-auto h-12 w-12')}>
        <UploadCloud size={compact ? 18 : 22} />
      </div>
      <div className={compact ? 'min-w-[220px] flex-1' : ''}>
        <h3 className={clsx('text-heading text-text-primary', !compact && 'mt-4')}>{title}</h3>
        <p className="mt-1 text-[13px] text-text-muted">{description}</p>
        <label className="mt-2 inline-flex items-center gap-2 text-[12px] text-text-muted" style={showDescribeImages ? undefined : { display: 'none' }}>
          <input
            type="checkbox"
            checked={describeImages}
            onChange={(event) => setDescribeImages(event.target.checked)}
            className="accent-accent"
          />
          Add compact AI descriptions for uploaded images
        </label>
        {uploading && !compact && <IngestProgress />}
      </div>

      <div className={clsx('flex flex-wrap items-center gap-2', compact ? 'ml-auto justify-end' : 'mt-4 justify-center')}>
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
        ) : hideBaseSelector ? (
          <Button variant="primary" size="md" loading={uploading} onClick={() => inputRef.current?.click()}>
            Browse files
          </Button>
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
              {bases.map((base) => <option key={base.id} value={base.id}>{labelForBase(base)}</option>)}
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
        accept={accept}
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
  if (lower.endsWith('.xlsx')) return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  if (lower.endsWith('.xls')) return 'application/vnd.ms-excel';
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.mp3')) return 'audio/mpeg';
  if (lower.endsWith('.m4a')) return 'audio/mp4';
  if (lower.endsWith('.wav')) return 'audio/wav';
  if (lower.endsWith('.ogg')) return 'audio/ogg';
  if (lower.endsWith('.html') || lower.endsWith('.htm')) return 'text/html';
  return 'text/plain';
}
