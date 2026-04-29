/**
 * Fleet Overview cockpit — V1-SPEC §13.4.
 *
 * Six-region grid the operator sees the moment they sign in:
 *   1) Agent constellation (top-left)
 *   2) Active runs strip   (top-right)
 *   3) Gateway health rail (mid-left)
 *   4) Pending approvals   (mid-right)
 *   5) Recent activity     (bottom-left, wide)
 *   6) Quick launch tiles  (bottom-right)
 *
 * All six regions live-update via realtime events; the page never polls.
 * Constellation is the only region that animates.
 */

import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import clsx from 'clsx';
import { api, workspace } from '../lib/api';
import { useRealtime, rtSubscribe } from '../lib/realtime';
import { AgentConstellation, type ConstellationAgent } from '../components/agents/AgentConstellation';

interface FleetSnapshot {
  agents: { total: number; online: number };
  gateways: { total: number; connected: number };
  workflows: { total: number };
  runs: {
    active: number;
    total: number;
    recent: Array<{ id: string; workflowId: string; status: string; createdAt: string }>;
  };
  approvals: { pending: number };
  operator: { displayName: string };
}

type AgentRow = ConstellationAgent;
interface GatewayRow {
  id: string;
  name: string;
  status: 'connected' | 'degraded' | 'disconnected' | 'error';
}
interface ApprovalRow {
  id: string;
  summary: string;
  workflowId: string;
  runId: string;
  createdAt: string;
}
interface ActivityRow {
  id: string;
  summary: string;
  eventType: string;
  createdAt: string;
}

export function FleetOverviewPage() {
  const [snap, setSnap] = useState<FleetSnapshot | null>(null);
  const [agents, setAgents] = useState<AgentRow[]>([]);
  const [gateways, setGateways] = useState<GatewayRow[]>([]);
  const [approvals, setApprovals] = useState<ApprovalRow[]>([]);
  const [activity, setActivity] = useState<ActivityRow[]>([]);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const ws = workspace.get();
    if (ws) rtSubscribe('workspace', { workspaceId: ws });
    void Promise.all([
      api<FleetSnapshot>('/v1/dashboard/fleet-overview'),
      api<{ agents: AgentRow[] }>('/v1/agents').catch(() => ({ agents: [] as AgentRow[] })),
      api<{ gateways: GatewayRow[] }>('/v1/gateways').catch(() => ({ gateways: [] as GatewayRow[] })),
      api<{ approvals: ApprovalRow[] }>('/v1/approvals').catch(() => ({ approvals: [] as ApprovalRow[] })),
      api<{ events: ActivityRow[] }>('/v1/activity?limit=12').catch(() => ({ events: [] as ActivityRow[] })),
    ])
      .then(([s, a, g, ap, ac]) => {
        setSnap(s);
        setAgents(a.agents);
        setGateways(g.gateways);
        setApprovals(ap.approvals);
        setActivity(ac.events);
      })
      .catch(() => {});
  }, [tick]);

  useRealtime(
    [
      'agent.status.changed',
      'gateway.connected',
      'gateway.disconnected',
      'gateway.degraded',
      'approval.requested',
      'approval.resolved',
      'run.created',
      'run.running',
      'run.completed',
      'run.failed',
      'activity.created',
    ],
    () => setTick((t) => t + 1),
  );

  if (!snap) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-text-muted">Loading fleet…</div>
    );
  }

  return (
    <div className="grid h-full grid-cols-12 grid-rows-[minmax(280px,1fr)_minmax(200px,auto)_minmax(180px,auto)] gap-3 p-3">
      <Region className="col-span-7" title="Constellation" badge={`${snap.agents.online}/${snap.agents.total} online`}>
        {agents.length === 0 ? (
          <Empty>No agents yet — install a package or open an OpenClaw cell.</Empty>
        ) : (
          <AgentConstellation agents={agents} height={260} />
        )}
      </Region>

      <Region className="col-span-5" title="Active runs" badge={`${snap.runs.active} running`}>
        <div className="flex flex-col divide-y divide-line">
          {snap.runs.recent.length === 0 && <Empty>No runs yet.</Empty>}
          {snap.runs.recent.slice(0, 6).map((r) => (
            <Link
              key={r.id}
              to={`/runs/${r.id}`}
              className="flex items-center justify-between py-1.5 text-xs hover:text-accent"
            >
              <span className="font-mono text-text-muted">{r.id.slice(0, 8)}</span>
              <span className={clsx('rounded px-1.5 text-[10px] uppercase tracking-wide', statusTone(r.status))}>
                {r.status}
              </span>
              <span className="text-text-muted">{relTime(r.createdAt)}</span>
            </Link>
          ))}
        </div>
      </Region>

      <Region className="col-span-7" title="Gateways" badge={`${snap.gateways.connected}/${snap.gateways.total} healthy`}>
        <div className="grid grid-cols-2 gap-2 lg:grid-cols-3">
          {gateways.length === 0 && <Empty>No gateways yet.</Empty>}
          {gateways.map((g) => (
            <Link
              key={g.id}
              to="/gateways"
              className="flex items-center justify-between rounded-md border border-line bg-surface-2 px-2 py-1.5 text-xs hover:border-accent/40"
            >
              <span className="truncate" title={g.name}>{g.name}</span>
              <span className={clsx('h-2 w-2 rounded-full', gatewayDot(g.status))} title={g.status} />
            </Link>
          ))}
        </div>
      </Region>

      <Region
        className="col-span-5"
        title="Pending approvals"
        badge={snap.approvals.pending > 0 ? `${snap.approvals.pending}` : 'clear'}
        accent={snap.approvals.pending > 0}
      >
        <div className="flex flex-col divide-y divide-line">
          {approvals.length === 0 && <Empty>Nothing waiting on you.</Empty>}
          {approvals.slice(0, 5).map((a) => (
            <Link key={a.id} to="/approvals" className="py-1.5 text-xs hover:text-accent" title={a.summary}>
              <div className="truncate">{a.summary}</div>
              <div className="font-mono text-[10px] text-text-muted">
                run {a.runId.slice(0, 8)} · {relTime(a.createdAt)}
              </div>
            </Link>
          ))}
        </div>
      </Region>

      <Region className="col-span-8" title="Recent activity" badge={`${activity.length}`}>
        <div className="max-h-48 overflow-auto">
          {activity.length === 0 && <Empty>No activity yet.</Empty>}
          <ul className="space-y-1.5">
            {activity.map((e) => (
              <li key={e.id} className="flex items-baseline gap-2 text-xs">
                <span className="font-mono text-[10px] uppercase tracking-wide text-text-muted">{e.eventType}</span>
                <span className="flex-1 truncate">{e.summary}</span>
                <span className="text-[10px] text-text-muted">{relTime(e.createdAt)}</span>
              </li>
            ))}
          </ul>
        </div>
      </Region>

      <Region className="col-span-4" title="Quick launch">
        <QuickLaunch />
      </Region>
    </div>
  );
}

function QuickLaunch() {
  const nav = useNavigate();
  const tiles = [
    { label: 'New workflow', to: '/workflows', glyph: '⌘' },
    { label: 'Browse skills', to: '/skills', glyph: '✦' },
    { label: 'Add agent', to: '/agents', glyph: '◈' },
    { label: 'Conversations', to: '/conversations', glyph: '✉' },
  ];
  return (
    <div className="grid grid-cols-2 gap-2">
      {tiles.map((t) => (
        <button
          key={t.to}
          onClick={() => nav(t.to)}
          className="flex flex-col items-start gap-1 rounded-lg border border-line bg-surface-2 p-3 text-left text-xs hover:border-accent/40"
        >
          <span className="text-base">{t.glyph}</span>
          <span>{t.label}</span>
        </button>
      ))}
    </div>
  );
}

function Region({
  title,
  badge,
  accent,
  className,
  children,
}: {
  title: string;
  badge?: string;
  accent?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <section
      className={clsx(
        'flex min-h-0 flex-col rounded-2xl border bg-surface p-3 shadow-card',
        accent ? 'border-amber-400/50' : 'border-line',
        className,
      )}
    >
      <header className="mb-2 flex items-center justify-between">
        <h2 className="text-xs font-medium uppercase tracking-wider text-text-muted">{title}</h2>
        {badge && (
          <span className={clsx('text-[10px]', accent ? 'text-amber-300' : 'text-text-muted')}>{badge}</span>
        )}
      </header>
      <div className="min-h-0 flex-1">{children}</div>
    </section>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div className="flex h-full items-center justify-center text-xs text-text-muted">{children}</div>;
}

function statusTone(s: string): string {
  if (s === 'COMPLETED') return 'bg-accent/15 text-accent';
  if (s === 'FAILED' || s === 'CANCELED') return 'bg-red-400/15 text-red-300';
  if (s === 'RUNNING') return 'bg-blue-400/15 text-blue-200';
  if (s === 'WAITING') return 'bg-amber-400/15 text-amber-200';
  return 'bg-surface-2 text-text-muted';
}

function gatewayDot(s: string): string {
  if (s === 'connected') return 'bg-accent';
  if (s === 'degraded') return 'bg-amber-400';
  return 'bg-red-400';
}

function relTime(iso: string): string {
  const t = new Date(iso).getTime();
  const diffSec = Math.max(1, Math.floor((Date.now() - t) / 1000));
  if (diffSec < 60) return `${diffSec}s`;
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h`;
  return `${Math.floor(diffSec / 86400)}d`;
}
