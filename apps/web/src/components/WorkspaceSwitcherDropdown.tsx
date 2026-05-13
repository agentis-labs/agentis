import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import clsx from 'clsx';
import { ArrowRight, Check, Search } from 'lucide-react';
import { useAgentisStore, type WorkspaceFull, type WorkspaceLiveStats } from '../store/agentisStore';

interface WorkspaceSwitcherDropdownProps {
  open: boolean;
  onClose: () => void;
  positionClassName?: string;
}

export function WorkspaceSwitcherDropdown({
  open,
  onClose,
  positionClassName = 'left-0 top-full mt-2',
}: WorkspaceSwitcherDropdownProps) {
  const nav = useNavigate();
  const [query, setQuery] = useState('');
  const [loadingStats, setLoadingStats] = useState(false);
  const workspaces = useAgentisStore((s) => s.availableWorkspaces);
  const currentWorkspaceId = useAgentisStore((s) => s.workspaceId);
  const workspaceStats = useAgentisStore((s) => s.workspaceStats);
  const loadWorkspaces = useAgentisStore((s) => s.loadWorkspaces);
  const loadWorkspaceStats = useAgentisStore((s) => s.loadWorkspaceStats);
  const switchWorkspace = useAgentisStore((s) => s.switchWorkspace);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void (async () => {
      const rows = workspaces.length > 0 ? workspaces : await loadWorkspaces().catch(() => []);
      if (cancelled || rows.length === 0) return;
      setLoadingStats(true);
      await loadWorkspaceStats(rows.map((workspace) => workspace.id)).catch(() => {});
      if (!cancelled) setLoadingStats(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [loadWorkspaceStats, loadWorkspaces, open, workspaces]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return workspaces;
    return workspaces.filter(
      (workspace) =>
        workspace.name.toLowerCase().includes(needle) ||
        workspace.slug.toLowerCase().includes(needle),
    );
  }, [query, workspaces]);

  async function pick(workspace: WorkspaceFull) {
    onClose();
    if (workspace.id === currentWorkspaceId) return;
    await switchWorkspace(workspace, { navigate: nav });
  }

  if (!open) return null;

  return (
    <div
      className={clsx(
        'absolute z-50 w-80 overflow-hidden rounded-lg border border-line bg-surface text-sm shadow-card',
        positionClassName,
      )}
    >
      {workspaces.length > 4 && (
        <label className="flex items-center gap-2 border-b border-line bg-canvas px-3 py-2 text-xs text-text-muted">
          <Search size={13} />
          <input
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search workspaces"
            className="min-w-0 flex-1 bg-transparent text-text-primary outline-none placeholder:text-text-muted"
          />
        </label>
      )}
      <div className="max-h-80 overflow-y-auto py-1">
        {filtered.map((workspace) => {
          const stats = workspaceStats[workspace.id];
          const isActive = workspace.id === currentWorkspaceId;
          return (
            <button
              key={workspace.id}
              onClick={() => void pick(workspace)}
              className={clsx(
                'flex w-full items-start gap-2 px-3 py-2.5 text-left transition hover:bg-surface-2',
                isActive && 'bg-surface-2/70',
              )}
            >
              <WorkspaceAvatar workspace={workspace} size="sm" />
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2">
                  <span className="truncate font-medium text-text-primary">{workspace.name}</span>
                  {isActive && (
                    <span className="rounded border border-accent/30 px-1.5 py-0.5 text-[9px] uppercase tracking-wide text-accent">
                      Active
                    </span>
                  )}
                </span>
                <span className="block truncate font-mono text-[10px] text-text-muted">{workspace.slug}</span>
                {!isActive && <WorkspaceStatsLine stats={stats} loading={loadingStats} />}
              </span>
              {isActive ? (
                <Check size={14} className="mt-1 shrink-0 text-accent" />
              ) : (
                <ArrowRight size={13} className="mt-1 shrink-0 text-text-muted" />
              )}
            </button>
          );
        })}
        {filtered.length === 0 && (
          <div className="px-3 py-6 text-center text-xs text-text-muted">No workspaces found.</div>
        )}
      </div>
      <button
        onClick={() => {
          onClose();
          nav('/workspaces');
        }}
        className="flex w-full items-center justify-between border-t border-line px-3 py-2 text-left text-xs text-accent hover:bg-surface-2"
      >
        Manage workspaces
        <ArrowRight size={12} />
      </button>
    </div>
  );
}

export function WorkspaceAvatar({ workspace, size = 'md' }: { workspace: WorkspaceFull; size?: 'sm' | 'md' | 'lg' }) {
  const dimensions = size === 'lg' ? 'h-12 w-12 text-sm' : size === 'md' ? 'h-8 w-8 text-xs' : 'h-7 w-7 text-[10px]';
  return (
    <span
      className={clsx('grid shrink-0 place-items-center rounded-md border border-line font-semibold text-canvas', dimensions)}
      style={{ backgroundColor: workspace.brandColor ?? '#7dd3fc' }}
    >
      {workspace.name.slice(0, 2).toUpperCase()}
    </span>
  );
}

function WorkspaceStatsLine({ stats, loading }: { stats?: WorkspaceLiveStats; loading: boolean }) {
  if (!stats) {
    return loading ? <span className="mt-1 block text-[10px] text-text-muted">Loading live state...</span> : null;
  }
  const attention = stats.pendingApprovals + stats.failedRuns;
  if (stats.agentsOnline === 0 && stats.activeRuns === 0 && attention === 0) {
    return <span className="mt-1 block text-[10px] text-text-muted">Quiet workspace</span>;
  }
  return (
    <span className="mt-1 flex flex-wrap gap-x-2 gap-y-1 text-[10px] text-text-muted">
      <span className="text-accent">{stats.agentsOnline} agents</span>
      <span className="text-sky-300">{stats.activeRuns} runs</span>
      <span className={attention > 0 ? 'text-warn' : 'text-text-muted'}>{attention} attention</span>
    </span>
  );
}