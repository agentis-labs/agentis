import { Activity, Brain, GitBranch, RefreshCw, ShieldAlert, Wrench } from 'lucide-react';
import clsx from 'clsx';

export interface BrainActivityItem {
  id: string;
  eventType: string;
  atomId: string | null;
  abilityId: string | null;
  delta: number | null;
  createdAt: string;
  metadata: unknown;
}

export function BrainActivityFeed({ activity, dense = false }: { activity: BrainActivityItem[]; dense?: boolean }) {
  if (activity.length === 0) {
    return (
      <div className="rounded-card border border-line bg-surface px-4 py-6 text-center text-[13px] text-text-muted">
        No Brain activity has been recorded yet.
      </div>
    );
  }

  return (
    <div className="rounded-card border border-line bg-surface">
      <div className="border-b border-line px-4 py-3">
        <div className="text-[12px] font-semibold uppercase tracking-wide text-text-muted">Ambient Brain Feed</div>
      </div>
      <div className={clsx('divide-y divide-line', dense ? 'max-h-[360px] overflow-y-auto' : undefined)}>
        {activity.map((item) => (
          <div key={item.id} className="flex gap-3 px-4 py-3">
            <span className={clsx('mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-btn', toneClass(item.eventType))}>
              {iconFor(item.eventType)}
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[13px] font-medium text-text-primary">{labelFor(item.eventType)}</span>
                {item.delta != null && (
                  <span className={clsx('rounded-full px-1.5 py-0.5 text-[10px] font-semibold', item.delta >= 0 ? 'bg-emerald-500/12 text-emerald-300' : 'bg-rose-500/12 text-rose-300')}>
                    {item.delta >= 0 ? '+' : ''}{item.delta.toFixed(3)}
                  </span>
                )}
              </div>
              <div className="mt-0.5 truncate text-[12px] text-text-muted">
                {activityDetail(item)}
              </div>
            </div>
            <time className="shrink-0 text-[11px] text-text-muted" dateTime={item.createdAt}>
              {formatTime(item.createdAt)}
            </time>
          </div>
        ))}
      </div>
    </div>
  );
}

function iconFor(eventType: string) {
  if (eventType.includes('maintenance')) return <Wrench size={14} />;
  if (eventType.includes('dispute')) return <ShieldAlert size={14} />;
  if (eventType.includes('Discourse')) return <GitBranch size={14} />;
  if (eventType.includes('refresh') || eventType.includes('context')) return <RefreshCw size={14} />;
  if (eventType.includes('ability')) return <Activity size={14} />;
  return <Brain size={14} />;
}

function toneClass(eventType: string): string {
  if (eventType.includes('dispute')) return 'bg-amber-500/12 text-amber-300';
  if (eventType.includes('maintenance')) return 'bg-cyan-500/12 text-cyan-300';
  if (eventType.includes('ability')) return 'bg-emerald-500/12 text-emerald-300';
  return 'bg-accent-soft text-accent';
}

function labelFor(eventType: string): string {
  return eventType
    .replace(/^brain_/, '')
    .replaceAll('_', ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function activityDetail(item: BrainActivityItem): string {
  const meta = record(item.metadata);
  const parts = [
    item.atomId ? `atom ${shortId(item.atomId)}` : null,
    item.abilityId ? `ability ${shortId(item.abilityId)}` : null,
    typeof meta.action === 'string' ? meta.action : null,
    typeof meta.reason === 'string' ? meta.reason : null,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(' - ') : 'Workspace Brain signal';
}

function record(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
}

function shortId(id: string): string {
  return id.length <= 10 ? id : id.slice(0, 8);
}

function formatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(date);
}
