import { useState } from 'react';
import { ChevronRight, Pencil, Trash2, Check, X } from 'lucide-react';
import { api, apiErrorMessage } from '../../lib/api';
import { useToast } from '../shared/Toast';
import { SourceBadge, TrustBar } from './MemoryRecordRow';
import type { EpisodeRowData } from './types';

/**
 * Expandable, editable, selectable episode row — the shared "list item that opens
 * to rich detail + bulk-selects" pattern used across the Brain and agent panels.
 */
export function EpisodeRow({
  episode,
  selected,
  onToggleSelect,
  onUpdated,
  onDeleted,
}: {
  episode: EpisodeRowData;
  selected?: boolean;
  onToggleSelect?: (id: string) => void;
  onUpdated?: (next: EpisodeRowData) => void;
  onDeleted?: (id: string) => void;
}) {
  const toast = useToast();
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [titleDraft, setTitleDraft] = useState(episode.title ?? '');
  const [summaryDraft, setSummaryDraft] = useState(episode.summary);

  async function save() {
    const content = summaryDraft.trim();
    if (!content) return;
    setSaving(true);
    try {
      await api(`/v1/brain/atoms/episode/${episode.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ title: titleDraft.trim() || undefined, content }),
      });
      onUpdated?.({ ...episode, title: titleDraft.trim() || episode.title, summary: content });
      setEditing(false);
      toast.success('Episode updated');
    } catch (err) {
      toast.error('Failed to update episode', apiErrorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    try {
      await api(`/v1/brain/atoms/episode/${episode.id}`, { method: 'DELETE' });
      onDeleted?.(episode.id);
    } catch (err) {
      toast.error('Failed to delete episode', apiErrorMessage(err));
    }
  }

  return (
    <article className={`rounded-card border bg-surface ${selected ? 'border-accent/50 ring-1 ring-accent/30' : 'border-line'}`}>
      <div className="flex items-start gap-2.5 p-3">
        {onToggleSelect && (
          <input
            type="checkbox"
            checked={selected ?? false}
            onChange={() => onToggleSelect(episode.id)}
            className="mt-0.5 h-3.5 w-3.5 shrink-0 rounded border-line bg-surface text-accent"
            aria-label="Select episode"
          />
        )}
        <button type="button" onClick={() => setExpanded((v) => !v)} aria-expanded={expanded} className="min-w-0 flex-1 text-left">
          <div className="flex flex-wrap items-center gap-2 text-[11px] text-text-muted">
            <span className="inline-flex items-center rounded-full border border-line bg-surface-2 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-text-secondary">
              {episode.type.replace(/_/g, ' ')}
            </span>
            {episode.source && <SourceBadge source={episode.source} />}
            {episode.createdAt && <span className="ml-auto">{new Date(episode.createdAt).toLocaleDateString()}</span>}
          </div>
          <h3 className="mt-1.5 text-[13px] font-semibold text-text-primary">{episode.title ?? episode.summary}</h3>
          {!expanded && <p className="mt-0.5 truncate text-[12px] text-text-secondary">{episode.summary}</p>}
        </button>
        <ChevronRight size={15} className={`mt-0.5 shrink-0 text-text-muted transition-transform ${expanded ? 'rotate-90' : ''}`} />
      </div>

      {expanded && (
        <div className="border-t border-line/70 px-3 py-3">
          {editing ? (
            <div className="space-y-2">
              <input
                value={titleDraft}
                onChange={(e) => setTitleDraft(e.target.value)}
                placeholder="Title"
                className="w-full rounded-md border border-line bg-canvas px-2.5 py-1.5 text-[13px] font-medium text-text-primary outline-none focus:border-accent"
              />
              <textarea
                value={summaryDraft}
                onChange={(e) => setSummaryDraft(e.target.value)}
                rows={4}
                className="w-full resize-y rounded-md border border-line bg-canvas px-2.5 py-1.5 text-[13px] leading-relaxed text-text-primary outline-none focus:border-accent"
              />
              <div className="flex items-center gap-2">
                <button type="button" onClick={() => void save()} disabled={saving} className="inline-flex items-center gap-1 rounded-btn bg-accent px-2 py-1 text-[11px] font-medium text-on-accent hover:bg-accent-hover disabled:opacity-50"><Check size={12} /> Save</button>
                <button type="button" onClick={() => { setEditing(false); setTitleDraft(episode.title ?? ''); setSummaryDraft(episode.summary); }} className="inline-flex items-center gap-1 rounded-btn px-2 py-1 text-[11px] text-text-muted hover:bg-surface-2"><X size={12} /> Cancel</button>
              </div>
            </div>
          ) : (
            <>
              <p className="whitespace-pre-wrap break-words text-[13px] leading-relaxed text-text-secondary">{episode.summary}</p>
              {episode.details && <p className="mt-2 whitespace-pre-wrap break-words text-[12px] leading-relaxed text-text-muted">{episode.details}</p>}
              <div className="mt-3 flex flex-wrap items-center gap-3">
                <TrustBar value={episode.trust ?? episode.confidence ?? 1} />
                {episode.runId && <span className="font-mono text-[10px] text-text-muted">run_{episode.runId.slice(-6)}</span>}
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
