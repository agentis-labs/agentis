import { useEffect, useState } from 'react';
import { Pencil, Save, Trash2, X } from 'lucide-react';
import { Button } from '../shared/Button';
import type { MemoryRecordRowData } from './types';

export function MemoryRecordRow({
  entry,
  onArchive,
  onSave,
}: {
  entry: MemoryRecordRowData;
  onArchive?: (id: string) => void;
  onSave?: (id: string, patch: { title?: string; content?: string }) => Promise<void> | void;
}) {
  const kind = entry.kind ?? entry.type ?? 'memory';
  const trust = entry.trust ?? entry.confidence ?? 1;
  const [editing, setEditing] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [draftTitle, setDraftTitle] = useState(entry.title ?? '');
  const [draftContent, setDraftContent] = useState(entry.content);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setDraftTitle(entry.title ?? '');
    setDraftContent(entry.content);
    setEditing(false);
  }, [entry.id, entry.title, entry.content]);

  async function saveEdit() {
    if (!onSave || !draftContent.trim()) return;
    setSaving(true);
    try {
      await onSave(entry.id, {
        title: draftTitle.trim() || undefined,
        content: draftContent.trim(),
      });
      setEditing(false);
    } finally {
      setSaving(false);
    }
  }

  return (
    <article className="rounded-card border border-line bg-surface p-4">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2 text-[11px] text-text-muted">
            <KindBadge kind={kind} />
            <SourceBadge source={entry.sourceType ?? entry.source ?? 'operator'} />
            {entry.createdAt && <span className="ml-auto">{relativeTime(entry.createdAt)}</span>}
          </div>
          {editing ? (
            <div className="mt-3 space-y-2">
              <input
                value={draftTitle}
                onChange={(event) => setDraftTitle(event.target.value)}
                placeholder="Memory title"
                className="h-9 w-full rounded-input border border-line bg-canvas px-3 text-[12px] text-text-primary placeholder:text-text-muted focus:border-accent focus:outline-none"
              />
              <textarea
                value={draftContent}
                onChange={(event) => setDraftContent(event.target.value)}
                rows={4}
                className="w-full resize-y rounded-input border border-line bg-canvas px-3 py-2 text-[12px] text-text-primary placeholder:text-text-muted focus:border-accent focus:outline-none"
              />
            </div>
          ) : (
            <>
              {entry.title && <h3 className="mt-2 text-subheading text-text-primary">{entry.title}</h3>}
              <p className={`mt-1.5 whitespace-pre-wrap text-[13px] leading-relaxed text-text-secondary ${!expanded && entry.content.length > 180 ? 'line-clamp-3' : ''}`}>{entry.content}</p>
              {entry.content.length > 180 && (
                <button
                  type="button"
                  onClick={() => setExpanded(!expanded)}
                  className="mt-1.5 text-[11px] font-semibold text-accent hover:underline block"
                >
                  {expanded ? 'Read less' : 'Read more'}
                </button>
              )}
            </>
          )}
          <div className="mt-3 flex items-center gap-3">
            <TrustBar value={trust} />
            {entry.importance != null && <span className="text-[10px] uppercase tracking-wider text-text-muted">importance {entry.importance}</span>}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {onSave && editing ? (
            <>
              <Button variant="ghost" size="sm" iconLeft={<X size={12} />} onClick={() => setEditing(false)}>Cancel</Button>
              <Button variant="secondary" size="sm" iconLeft={<Save size={12} />} loading={saving} onClick={() => void saveEdit()}>Save</Button>
            </>
          ) : onSave ? (
            <Button variant="ghost" size="sm" iconLeft={<Pencil size={12} />} onClick={() => setEditing(true)}>Edit</Button>
          ) : null}
          {onArchive && !editing && (
            <Button variant="ghost" size="sm" iconLeft={<Trash2 size={12} />} onClick={() => onArchive(entry.id)}>
              Archive
            </Button>
          )}
        </div>
      </div>
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



