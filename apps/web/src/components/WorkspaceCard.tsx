import clsx from 'clsx';
import { ArrowRight, Check, Lock } from 'lucide-react';
import type { AmbientContext, WorkspaceFull, WorkspaceLiveStats } from '../store/agentisStore';
import { WorkspaceAvatar } from './WorkspaceSwitcherDropdown';

export function WorkspaceCard({
  workspace,
  stats,
  ambients = [],
  active = false,
  featured = false,
  onEnter,
}: {
  workspace: WorkspaceFull;
  stats?: WorkspaceLiveStats;
  ambients?: AmbientContext[];
  active?: boolean;
  featured?: boolean;
  onEnter?: () => void;
}) {
  const attention = (stats?.pendingApprovals ?? 0) + (stats?.failedRuns ?? 0);
  return (
    <article
      className={clsx(
        'relative overflow-hidden rounded-lg border border-line bg-surface shadow-card',
        featured ? 'p-5' : 'p-4',
      )}
    >
      <span className="absolute inset-y-0 left-0 w-1" style={{ backgroundColor: workspace.brandColor ?? '#7dd3fc' }} />
      <div className="flex items-start gap-3 pl-1">
        <WorkspaceAvatar workspace={workspace} size={featured ? 'lg' : 'md'} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className={clsx('truncate font-medium text-text-primary', featured ? 'text-base' : 'text-sm')}>
              {workspace.name}
            </h2>
            {active && (
              <span className="inline-flex shrink-0 items-center gap-1 rounded border border-accent/30 bg-accent/10 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-accent">
                <Check size={10} />
                You are here
              </span>
            )}
          </div>
          <p className="truncate font-mono text-xs text-text-muted">{workspace.slug}</p>
          {workspace.description && <p className="mt-2 line-clamp-2 text-xs leading-5 text-text-muted">{workspace.description}</p>}
        </div>
      </div>

      <div className={clsx('grid gap-2 pl-1 text-xs', featured ? 'mt-5 grid-cols-3' : 'mt-4 grid-cols-3')}>
        <Stat label="Agents" value={stats?.agentsOnline} tone="accent" />
        <Stat label="Runs" value={stats?.activeRuns} tone="sky" />
        <Stat label="Attention" value={attention} tone={attention > 0 ? 'warn' : 'muted'} />
      </div>

      {ambients.length > 0 && (
        <div className="mt-4 flex flex-wrap gap-1.5 pl-1">
          {ambients.slice(0, featured ? 8 : 4).map((ambient) => (
            <AmbientChip key={ambient.id} ambient={ambient} />
          ))}
          {ambients.length > (featured ? 8 : 4) && (
            <span className="rounded border border-line px-1.5 py-1 text-[10px] text-text-muted">
              +{ambients.length - (featured ? 8 : 4)} more
            </span>
          )}
        </div>
      )}

      <div className="mt-4 flex items-center justify-between gap-3 pl-1 text-xs text-text-muted">
        <span>{stats?.lastActivityAt ? `Active ${relativeTime(stats.lastActivityAt)}` : 'No activity yet'}</span>
        {!active && onEnter && (
          <button
            type="button"
            onClick={onEnter}
            className="inline-flex items-center gap-1 rounded-md border border-line px-2 py-1 text-xs text-text-primary hover:border-accent/40 hover:text-accent"
          >
            Enter
            <ArrowRight size={12} />
          </button>
        )}
      </div>
    </article>
  );
}

function Stat({ label, value, tone }: { label: string; value?: number; tone: 'accent' | 'sky' | 'warn' | 'muted' }) {
  return (
    <div className="rounded-md border border-line bg-canvas px-2 py-2">
      <div className={clsx('text-sm font-medium', toneClass(tone))}>{value ?? '-'}</div>
      <div className="mt-0.5 truncate text-[10px] uppercase tracking-wide text-text-muted">{label}</div>
    </div>
  );
}

function AmbientChip({ ambient }: { ambient: AmbientContext }) {
  const normalized = ambient.kind.toLowerCase();
  const prod = normalized === 'prod' || normalized === 'production';
  return (
    <span className={clsx('inline-flex max-w-36 items-center gap-1 rounded border px-1.5 py-1 text-[10px]', ambientBadgeClass(ambient.kind))}>
      {prod && <Lock size={10} />}
      <span className="truncate">{ambient.name}</span>
      <span className="uppercase text-current/70">{ambient.kind}</span>
    </span>
  );
}

function toneClass(tone: 'accent' | 'sky' | 'warn' | 'muted') {
  if (tone === 'accent') return 'text-accent';
  if (tone === 'sky') return 'text-sky-300';
  if (tone === 'warn') return 'text-warn';
  return 'text-text-muted';
}

function ambientBadgeClass(kind: string) {
  const normalized = kind.toLowerCase();
  if (normalized === 'prod' || normalized === 'production') return 'border-accent/30 bg-accent/10 text-accent';
  if (normalized === 'staging') return 'border-warn/30 bg-warn/10 text-warn';
  if (normalized === 'dev' || normalized === 'development') return 'border-sky-400/30 bg-sky-400/10 text-sky-300';
  return 'border-line bg-canvas text-text-muted';
}

function relativeTime(value: string) {
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) return 'recently';
  const delta = Date.now() - timestamp;
  const minutes = Math.max(1, Math.floor(delta / 60_000));
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}