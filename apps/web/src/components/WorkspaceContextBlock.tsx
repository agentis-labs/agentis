import { useState } from 'react';
import clsx from 'clsx';
import { ChevronDown } from 'lucide-react';
import { useAgentisStore } from '../store/agentisStore';
import { WorkspaceAvatar, WorkspaceSwitcherDropdown } from './WorkspaceSwitcherDropdown';

export function WorkspaceContextBlock({ collapsed }: { collapsed: boolean }) {
  const [open, setOpen] = useState(false);
  const workspace = useAgentisStore((s) => s.currentWorkspace);
  const currentAmbient = useAgentisStore((s) => s.currentAmbient);
  const stats = useAgentisStore((s) => (workspace ? s.workspaceStats[workspace.id] : undefined));
  const attention = (stats?.pendingApprovals ?? 0) + (stats?.failedRuns ?? 0);

  if (!workspace) {
    return (
      <div className={clsx('relative border-b border-line p-2', collapsed && 'flex justify-center')}>
        <div className="h-8 w-8 rounded-md border border-line bg-surface-2" />
      </div>
    );
  }

  return (
    <div className="relative border-b border-line p-2">
      <button
        type="button"
        title={workspace.name}
        onClick={() => setOpen((value) => !value)}
        className={clsx(
          'flex w-full items-center gap-2 rounded-md text-left transition hover:bg-surface-2',
          collapsed ? 'justify-center px-0 py-1.5' : 'px-2 py-2',
        )}
      >
        <span className="relative shrink-0">
          <WorkspaceAvatar workspace={workspace} size="md" />
          {attention > 0 && (
            <span className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full border border-surface bg-warn shadow-glow" />
          )}
        </span>
        {!collapsed && (
          <span className="min-w-0 flex-1">
            <span className="flex min-w-0 items-center gap-1.5">
              <span className="truncate text-[13px] font-medium text-text-primary">{workspace.name}</span>
              {currentAmbient && (
                <span className={clsx('shrink-0 rounded border px-1 py-0.5 text-[9px] uppercase tracking-wide', ambientBadgeClass(currentAmbient.kind))}>
                  {currentAmbient.kind}
                </span>
              )}
            </span>
            <span className="mt-0.5 block truncate text-[10px] text-text-muted">
              {stats ? `${stats.agentsOnline} agents - ${stats.activeRuns} runs` : workspace.slug}
            </span>
          </span>
        )}
        {!collapsed && <ChevronDown size={12} className="shrink-0 text-text-muted" />}
      </button>
      <WorkspaceSwitcherDropdown
        open={open}
        onClose={() => setOpen(false)}
        positionClassName={collapsed ? 'left-full top-1 ml-2' : 'left-2 top-full mt-2'}
      />
    </div>
  );
}

function ambientBadgeClass(kind: string) {
  const normalized = kind.toLowerCase();
  if (normalized === 'prod' || normalized === 'production') return 'border-accent/30 bg-accent/10 text-accent';
  if (normalized === 'staging') return 'border-warn/30 bg-warn/10 text-warn';
  if (normalized === 'dev' || normalized === 'development') return 'border-sky-400/30 bg-sky-400/10 text-sky-300';
  return 'border-line bg-canvas text-text-muted';
}