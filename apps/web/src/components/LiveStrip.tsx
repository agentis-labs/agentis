/**
 * Bottom live strip - sticky operator situational awareness.
 *
 * Active runs, pending approvals, gateway health, latest activity.
 */

import { Link } from 'react-router-dom';
import clsx from 'clsx';
import { useWorkspaceData } from '../lib/workspaceData';

export function LiveStrip() {
  const { approvals, counts, fleet: snap, latestActivity: latest, loading } = useWorkspaceData();

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
        <Link to="/history?tab=runs" className="flex items-center gap-1 hover:text-text-primary">
          <span className="inline-block h-1.5 w-1.5 rounded-full bg-accent" />
          {counts.activeRuns} active {counts.activeRuns === 1 ? 'run' : 'runs'}
        </Link>
        <Link
          to="/home"
          className={clsx(
            'flex items-center gap-1 hover:text-text-primary',
            approvals.length > 0 && 'text-warn',
          )}
        >
          <span
            className={clsx(
              'inline-block h-1.5 w-1.5 rounded-full',
              approvals.length > 0 ? 'bg-warn' : 'bg-text-muted/40',
            )}
          />
          {approvals.length} pending {approvals.length === 1 ? 'approval' : 'approvals'}
        </Link>
        <Link to="/settings?tab=connections" className="flex items-center gap-1 hover:text-text-primary">
          <span className="inline-block h-1.5 w-1.5 rounded-full bg-text-muted/40" />
          Connections 0/0
        </Link>
        <span className="ml-auto opacity-60">Idle</span>
      </div>
    );
  }

  const gwOk = snap.gateways.connected === snap.gateways.total;
  const gwDot = gwOk ? 'bg-accent' : 'bg-amber-400';

  return (
    <div className="flex h-7 shrink-0 items-center gap-4 border-t border-line bg-surface px-3 text-[11px] text-text-muted">
      <Link to="/history?tab=runs" className="flex items-center gap-1 hover:text-text-primary">
        <span className="inline-block h-1.5 w-1.5 rounded-full bg-accent" />
        {snap.runs.active} active {snap.runs.active === 1 ? 'run' : 'runs'}
      </Link>
      <Link
        to="/home"
        className={clsx(
          'flex items-center gap-1 hover:text-text-primary',
          snap.approvals.pending > 0 && 'text-warn',
        )}
      >
        <span
          className={clsx(
            'inline-block h-1.5 w-1.5 rounded-full',
            snap.approvals.pending > 0 ? 'bg-warn' : 'bg-text-muted/40',
          )}
        />
        {snap.approvals.pending} pending {snap.approvals.pending === 1 ? 'approval' : 'approvals'}
      </Link>
      <Link to="/settings?tab=connections" className="flex items-center gap-1 hover:text-text-primary">
        <span className={clsx('inline-block h-1.5 w-1.5 rounded-full', gwDot)} />
        Connections {snap.gateways.connected}/{snap.gateways.total}
      </Link>
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
