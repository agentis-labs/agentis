import { Trash2 } from 'lucide-react';
import { Button } from '../shared/Button';
import type { MemoryEntryRowData } from './types';

export function MemoryEntryRow({ entry, onArchive }: { entry: MemoryEntryRowData; onArchive?: (id: string) => void }) {
  const kind = entry.kind ?? entry.type ?? 'memory';
  const trust = entry.trust ?? entry.confidence ?? 1;
  return (
    <article className="rounded-card border border-line bg-surface p-4">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2 text-[11px] text-text-muted">
            <KindBadge kind={kind} />
            <SourceBadge source={entry.sourceType ?? entry.source ?? 'operator'} />
            {entry.createdAt && <span className="ml-auto">{relativeTime(entry.createdAt)}</span>}
          </div>
          {entry.title && <h3 className="mt-2 text-subheading text-text-primary">{entry.title}</h3>}
          <p className="mt-1.5 whitespace-pre-wrap text-[13px] leading-relaxed text-text-secondary">{entry.content}</p>
          <div className="mt-3 flex items-center gap-3">
            <TrustBar value={trust} />
            {entry.importance != null && <span className="text-[10px] uppercase tracking-wider text-text-muted">importance {entry.importance}</span>}
          </div>
        </div>
        {onArchive && (
          <Button variant="ghost" size="sm" iconLeft={<Trash2 size={12} />} onClick={() => onArchive(entry.id)}>
            Archive
          </Button>
        )}
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