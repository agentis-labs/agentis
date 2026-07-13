import { useEffect, useState } from 'react';
import { Pencil, Save, Trash2, X, ChevronRight, Check } from 'lucide-react';
import { api } from '../../lib/api';
import { useToast } from '../shared/Toast';
import type { MemoryRecordRowData } from './types';

export function MemoryRecordRow({
  entry,
  scopeId,
  selected,
  onToggleSelect,
  onUpdated,
  onDeleted,
}: {
  entry: MemoryRecordRowData;
  /** The scope this memory was saved under — required so the PATCH/DELETE
   * scope check on the API matches (a scoped entry 404s without it). */
  scopeId?: string;
  selected?: boolean;
  onToggleSelect?: (id: string) => void;
  onUpdated?: (next: MemoryRecordRowData) => void;
  onDeleted?: (id: string) => void;
}) {
  const kind = entry.kind ?? entry.type ?? 'memory';
  const trust = entry.trust ?? entry.confidence ?? 1;
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draftTitle, setDraftTitle] = useState(entry.title ?? '');
  const [draftContent, setDraftContent] = useState(entry.content);
  const [saving, setSaving] = useState(false);
  const toast = useToast();
  const query = scopeId ? `?scopeId=${encodeURIComponent(scopeId)}` : '';

  async function saveEdit() {
    const content = draftContent.trim();
    if (!content) return;
    setSaving(true);
    try {
      await api(`/v1/memory/${entry.id}${query}`, {
        method: 'PATCH',
        body: JSON.stringify({
          title: draftTitle.trim() || undefined,
          content,
        }),
      });
      onUpdated?.({ ...entry, title: draftTitle.trim() || entry.title, content });
      setEditing(false);
      toast.success('Memory updated');
    } catch (err) {
      toast.error('Failed to update memory', String(err));
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    try {
      await api(`/v1/memory/${entry.id}${query}`, { method: 'DELETE' });
      onDeleted?.(entry.id);
    } catch (err) {
      toast.error('Failed to archive memory', String(err));
    }
  }

  return (
    <article className={`rounded-card border bg-surface ${selected ? 'border-accent/50 ring-1 ring-accent/30' : 'border-line'}`}>
      <div className="flex items-start gap-2.5 p-3">
        {onToggleSelect && (
          <input
            type="checkbox"
            checked={selected ?? false}
            onChange={() => onToggleSelect(entry.id)}
            className="mt-0.5 h-3.5 w-3.5 shrink-0 rounded border-line bg-surface text-accent"
            aria-label="Select memory"
          />
        )}
        <button type="button" onClick={() => setExpanded((v) => !v)} aria-expanded={expanded} className="min-w-0 flex-1 text-left">
          <div className="flex flex-wrap items-center gap-2 text-[11px] text-text-muted">
            <KindBadge kind={kind} />
            <SourceBadge source={entry.sourceType ?? entry.source ?? 'operator'} />
            {entry.createdAt && <span className="ml-auto">{relativeTime(entry.createdAt)}</span>}
          </div>
          <h3 className="mt-1.5 text-[13px] font-semibold text-text-primary">{entry.title ?? entry.content}</h3>
          {!expanded && <p className="mt-0.5 truncate text-[12px] text-text-secondary">{entry.content}</p>}
        </button>
        <ChevronRight size={15} className={`mt-0.5 shrink-0 text-text-muted transition-transform ${expanded ? 'rotate-90' : ''}`} />
      </div>

      {expanded && (
        <div className="border-t border-line/70 px-3 py-3">
          {editing ? (
            <div className="space-y-2">
              <input
                value={draftTitle}
                onChange={(e) => setDraftTitle(e.target.value)}
                placeholder="Title"
                className="w-full rounded-md border border-line bg-canvas px-2.5 py-1.5 text-[13px] font-medium text-text-primary outline-none focus:border-accent"
              />
              <textarea
                value={draftContent}
                onChange={(e) => setDraftContent(e.target.value)}
                rows={4}
                className="w-full resize-y rounded-md border border-line bg-canvas px-2.5 py-1.5 text-[13px] leading-relaxed text-text-primary outline-none focus:border-accent"
              />
              <div className="flex items-center gap-2">
                <button type="button" onClick={() => void saveEdit()} disabled={saving} className="inline-flex items-center gap-1 rounded-btn bg-accent px-2 py-1 text-[11px] font-medium text-on-accent hover:bg-accent-hover disabled:opacity-50"><Check size={12} /> Save</button>
                <button type="button" onClick={() => { setEditing(false); setDraftTitle(entry.title ?? ''); setDraftContent(entry.content); }} className="inline-flex items-center gap-1 rounded-btn px-2 py-1 text-[11px] text-text-muted hover:bg-surface-2"><X size={12} /> Cancel</button>
              </div>
            </div>
          ) : (
            <>
              <p className="whitespace-pre-wrap break-words text-[13px] leading-relaxed text-text-secondary">{entry.content}</p>
              <div className="mt-3 flex flex-wrap items-center gap-3">
                <TrustBar value={trust} />
                {entry.importance != null && <span className="text-[10px] uppercase tracking-wider text-text-muted">importance {entry.importance}</span>}
                <div className="ml-auto flex items-center gap-1">
                  <button type="button" onClick={() => setEditing(true)} className="inline-flex items-center gap-1 rounded-btn px-2 py-1 text-[11px] text-text-muted hover:bg-surface-2 hover:text-text-primary"><Pencil size={12} /> Edit</button>
                  <button type="button" onClick={() => void remove()} className="inline-flex items-center gap-1 rounded-btn px-2 py-1 text-[11px] text-text-muted hover:bg-danger/10 hover:text-danger"><Trash2 size={12} /> Delete</button>
                </div>
              </div>
            </>
          )}
        </div>
      )}
    </article>
  );
}

export function KindBadge({ kind }: { kind: string }) {
  return (
    <span className="inline-flex items-center rounded-full border border-line bg-surface-2 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-text-secondary">
      {kind.replace(/_/g, ' ')}
    </span>
  );
}

export function SourceBadge({ source }: { source: string }) {
  const label = source === 'operator' ? 'manual' : source === 'promotion' ? 'auto-learned' : source;
  return (
    <span className="inline-flex items-center rounded-full border border-line bg-canvas px-2 py-0.5 text-[10px] text-text-muted">
      {label.replace(/_/g, ' ')}
    </span>
  );
}

export function TrustBar({ value }: { value: number }) {
  const pct = Math.round(Math.max(0, Math.min(1, value)) * 100);
  return (
    <div className="flex items-center gap-1.5">
      <div className="h-1 w-16 overflow-hidden rounded-full bg-surface-2">
        <div className="h-full rounded-full bg-accent" style={{ width: `${pct}%` }} />
      </div>
      <span className="text-[10px] text-text-muted">{pct}% trust</span>
    </div>
  );
}

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(diff)) return '';
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}



