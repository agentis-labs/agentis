/**
 * Bottom live strip — sticky operator situational awareness.
 *
 * V1-SPEC §13.2 calls for a permanent "what is happening right now" bar at
 * the bottom of the shell so the operator never has to leave their current
 * page to know:
 *
 *   - Active runs count (with quick link to /runs?status=active)
 *   - Pending approvals (with badge + link to /approvals)
 *   - Gateway reconnect indicator (loud only when at least one is degraded)
 *   - Recent activity tail (last summary, click to /activity)
 *
 * Refreshed on every relevant realtime event; no polling.
 */

import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import clsx from 'clsx';
import { api, workspace as wsStore } from '../lib/api';
import { useRealtime, rtSubscribe } from '../lib/realtime';

interface FleetOverview {
  runs: { active: number };
  gateways: { total: number; connected: number };
  approvals: { pending: number };
}

interface ActivityRow {
  id: string;
  summary: string;
  createdAt: string;
}

const REFRESH_EVENTS = [
  'run.created',
  'run.running',
  'run.completed',
  'run.failed',
  'approval.requested',
  'approval.resolved',
  'gateway.connected',
  'gateway.disconnected',
  'gateway.degraded',
];

export function LiveStrip() {
  const [snap, setSnap] = useState<FleetOverview | null>(null);
  const [latest, setLatest] = useState<ActivityRow | null>(null);

  const refresh = useCallback(() => {
    void api<FleetOverview>('/v1/dashboard/fleet-overview')
      .then(setSnap)
      .catch(() => {});
    void api<{ events: ActivityRow[] }>('/v1/activity?limit=1')
      .then((d) => setLatest(d.events[0] ?? null))
      .catch(() => {});
  }, []);

  useEffect(() => {
    const ws = wsStore.get();
    if (ws) rtSubscribe('workspace', { workspaceId: ws });
    refresh();
  }, [refresh]);

  useRealtime(REFRESH_EVENTS, refresh);
  useRealtime(['activity.created'], (env) => {
    const p = env.payload as { id: string; summary: string; createdAt: string };
    if (p?.id) setLatest({ id: p.id, summary: p.summary, createdAt: p.createdAt });
  });

  if (!snap) {
    return (
      <div className="flex h-7 shrink-0 items-center border-t border-line bg-surface px-3 text-[11px] text-text-muted">
        <span className="opacity-60">Connecting…</span>
      </div>
    );
  }

  const gwOk = snap.gateways.connected === snap.gateways.total;
  const gwDot = gwOk ? 'bg-accent' : 'bg-amber-400';

  return (
    <div className="flex h-7 shrink-0 items-center gap-4 border-t border-line bg-surface px-3 text-[11px] text-text-muted">
      <Link to="/runs" className="flex items-center gap-1 hover:text-text-primary">
        <span className="inline-block h-1.5 w-1.5 rounded-full bg-accent" />
        {snap.runs.active} active runs
      </Link>
      <Link
        to="/approvals"
        className={clsx(
          'flex items-center gap-1 hover:text-text-primary',
          snap.approvals.pending > 0 && 'text-amber-300',
        )}
      >
        <span
          className={clsx(
            'inline-block h-1.5 w-1.5 rounded-full',
            snap.approvals.pending > 0 ? 'bg-amber-400' : 'bg-text-muted/40',
          )}
        />
        {snap.approvals.pending} pending approvals
      </Link>
      <Link to="/gateways" className="flex items-center gap-1 hover:text-text-primary">
        <span className={clsx('inline-block h-1.5 w-1.5 rounded-full', gwDot)} />
        Gateways {snap.gateways.connected}/{snap.gateways.total}
      </Link>
      <span className="ml-auto truncate" title={latest?.summary ?? ''}>
        {latest ? (
          <Link to="/activity" className="hover:text-text-primary">
            ≈ {latest.summary}
          </Link>
        ) : (
          <span className="opacity-60">Idle</span>
        )}
      </span>
    </div>
  );
}
