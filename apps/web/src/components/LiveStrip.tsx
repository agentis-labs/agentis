

import { Link } from 'react-router-dom';
import clsx from 'clsx';
import { useWorkspaceChromeData } from '../lib/workspaceChromeData';
import { useAgentisStore } from '../store/agentisStore';

export function LiveStrip() {
  const { approvals, counts, fleet: snap, latestActivity: latest, loading } = useWorkspaceChromeData();
  const { setSettingsOpen } = useAgentisStore();

  if (!snap) {
    if (loading) {
      return (
        <div className="flex h-7 shrink-0 items-center border-t border-line bg-surface px-3 text-[11px] text-text-muted">
          <span className="opacity-60">Connecting...</span>
        </div>
      );
    }

    return (
      <div className="flex h-7 shrink-0 items-center gap-4 border-t border-line bg-surface px-3 text-[11px] text-text-muted">
        <Link to="/agents" className="flex items-center gap-1 hover:text-text-primary">
          <span className={clsx('inline-block h-1.5 w-1.5 rounded-full', counts.liveAgents > 0 ? 'bg-emerald-500' : 'bg-white')} />
          {counts.liveAgents} active {counts.liveAgents === 1 ? 'agent' : 'agents'}
        </Link>
        <Link to="/history?tab=runs" className="flex items-center gap-1 hover:text-text-primary">
          <span className={clsx('inline-block h-1.5 w-1.5 rounded-full', counts.activeRuns > 0 ? 'bg-emerald-500' : 'bg-white')} />
          {counts.activeRuns} active {counts.activeRuns === 1 ? 'run' : 'runs'}
        </Link>
        {approvals.length > 0 && (
          <Link to="/home" className="flex items-center gap-1 text-warn hover:text-text-primary">
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-warn" />
            {approvals.length} pending {approvals.length === 1 ? 'approval' : 'approvals'}
          </Link>
        )}
        <button onClick={() => setSettingsOpen(true, 'channels')} className="flex items-center gap-1 hover:text-text-primary">
          <span className="inline-block h-1.5 w-1.5 rounded-full bg-white" />
          Connections 0/0
        </button>
        <span className="ml-auto opacity-60">Idle</span>
      </div>
    );
  }

  // Green only once something is actually connected; amber flags a partial
  // outage (some but not all gateways up); zero connections is neutral, not
  // an error — most workspaces simply haven't wired one up yet.
  const gwActive = snap.gateways.connected > 0;
  const gwDegraded = gwActive && snap.gateways.connected < snap.gateways.total;
  const gwDot = gwDegraded ? 'bg-warn' : gwActive ? 'bg-emerald-500' : 'bg-white';

  return (
    <div className="flex h-7 shrink-0 items-center gap-4 border-t border-line bg-surface px-3 text-[11px] text-text-muted">
      <Link to="/agents" className="flex items-center gap-1 hover:text-text-primary">
        <span className={clsx('inline-block h-1.5 w-1.5 rounded-full', counts.liveAgents > 0 ? 'bg-emerald-500' : 'bg-white')} />
        {counts.liveAgents} active {counts.liveAgents === 1 ? 'agent' : 'agents'}
      </Link>
      <Link to="/history?tab=runs" className="flex items-center gap-1 hover:text-text-primary">
        <span className={clsx('inline-block h-1.5 w-1.5 rounded-full', snap.runs.active > 0 ? 'bg-emerald-500' : 'bg-white')} />
        {snap.runs.active} active {snap.runs.active === 1 ? 'run' : 'runs'}
      </Link>
      {snap.approvals.pending > 0 && (
        <Link to="/home" className="flex items-center gap-1 text-warn hover:text-text-primary">
          <span className="inline-block h-1.5 w-1.5 rounded-full bg-warn" />
          {snap.approvals.pending} pending {snap.approvals.pending === 1 ? 'approval' : 'approvals'}
        </Link>
      )}
      <button onClick={() => setSettingsOpen(true, 'channels')} className="flex items-center gap-1 hover:text-text-primary">
        <span className={clsx('inline-block h-1.5 w-1.5 rounded-full', gwDot)} />
        Connections {snap.gateways.connected}/{snap.gateways.total}
      </button>
      <span className="ml-auto truncate" title={latest?.summary ?? ''}>
        {latest ? (
          <Link to="/history" className="hover:text-text-primary">
            ~ {latest.summary}
          </Link>
        ) : (
          <span className="opacity-60">Idle</span>
        )}
      </span>
    </div>
  );
}


