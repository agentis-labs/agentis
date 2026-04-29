/**
 * Gateway detail panel — V1-SPEC §13.7.
 *
 * Slide-over right dock with three tabs:
 *   - Connections   — persistent links & device tokens summary
 *   - Event stream  — live socket feed of `gateway.*` events for this gateway
 *   - Agent map     — every agent currently published through this gateway
 *
 * Subscribes to the gateway-scoped realtime room so the event stream is
 * truly live.
 */

import { useEffect, useState } from 'react';
import clsx from 'clsx';
import { api } from '../lib/api';
import { rtSubscribe, useRealtime } from '../lib/realtime';

export interface GatewayDetailGateway {
  id: string;
  name: string;
  gatewayUrl: string;
  status: string;
  lastHeartbeatAt: string | null;
  lastSyncAt: string | null;
}

interface AgentRow {
  id: string;
  name: string;
  status: string;
  colorHex: string;
  gatewayId: string | null;
}

interface EventLine {
  at: string;
  event: string;
  payload: unknown;
}

type Tab = 'connections' | 'events' | 'agents';

export function GatewayDetailPanel({
  gateway,
  onClose,
}: {
  gateway: GatewayDetailGateway;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<Tab>('connections');
  const [agents, setAgents] = useState<AgentRow[]>([]);
  const [events, setEvents] = useState<EventLine[]>([]);

  useEffect(() => {
    rtSubscribe('gateway', { gatewayId: gateway.id });
    void api<{ agents: AgentRow[] }>('/v1/agents')
      .then((d) => setAgents(d.agents.filter((a) => a.gatewayId === gateway.id)))
      .catch(() => {});
  }, [gateway.id]);

  useRealtime(
    [
      'gateway.connected',
      'gateway.disconnected',
      'gateway.degraded',
      'gateway.event',
      'agent.created',
      'agent.status.changed',
    ],
    (env) => {
      const p = env.payload as { gatewayId?: string };
      if (p?.gatewayId && p.gatewayId !== gateway.id) return;
      setEvents((prev) => [
        { at: env.emittedAt, event: env.event, payload: env.payload },
        ...prev,
      ].slice(0, 200));
    },
  );

  return (
    <div className="fixed inset-0 z-30 flex justify-end bg-black/40" onClick={onClose}>
      <div
        className="flex h-full w-[28rem] max-w-full flex-col border-l border-line bg-surface shadow-card"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between border-b border-line px-3 py-2">
          <div>
            <div className="text-sm font-medium">{gateway.name}</div>
            <div className="font-mono text-[10px] text-text-muted">{gateway.gatewayUrl}</div>
          </div>
          <button onClick={onClose} className="text-text-muted hover:text-accent">
            ×
          </button>
        </header>
        <nav className="flex border-b border-line text-[11px]">
          {(['connections', 'events', 'agents'] as Tab[]).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={clsx(
                'flex-1 px-3 py-2 uppercase tracking-wider',
                t === tab ? 'border-b-2 border-accent text-accent' : 'text-text-muted hover:text-text-primary',
              )}
            >
              {t === 'events' ? 'Event stream' : t === 'agents' ? 'Agent map' : 'Connections'}
            </button>
          ))}
        </nav>
        <div className="min-h-0 flex-1 overflow-auto p-3 text-xs">
          {tab === 'connections' && (
            <dl className="space-y-2">
              <Row label="Status" value={gateway.status} />
              <Row label="Last heartbeat" value={fmt(gateway.lastHeartbeatAt)} />
              <Row label="Last sync" value={fmt(gateway.lastSyncAt)} />
            </dl>
          )}
          {tab === 'events' && (
            <ul className="space-y-1.5">
              {events.length === 0 && <li className="text-text-muted">No events received yet on this gateway.</li>}
              {events.map((e, i) => (
                <li key={i} className="rounded border border-line bg-surface-2 p-2">
                  <div className="flex items-baseline justify-between">
                    <span className="font-mono text-[11px] text-accent">{e.event}</span>
                    <span className="text-[10px] text-text-muted">{new Date(e.at).toLocaleTimeString()}</span>
                  </div>
                  <pre className="mt-1 max-h-24 overflow-auto whitespace-pre-wrap break-all text-[10px] text-text-muted">
                    {JSON.stringify(e.payload, null, 2)}
                  </pre>
                </li>
              ))}
            </ul>
          )}
          {tab === 'agents' && (
            <ul className="space-y-1.5">
              {agents.length === 0 && <li className="text-text-muted">No agents on this gateway.</li>}
              {agents.map((a) => (
                <li key={a.id} className="flex items-center gap-2 rounded border border-line bg-surface-2 px-2 py-1.5">
                  <span className="h-2.5 w-2.5 rounded-full" style={{ background: a.colorHex }} />
                  <span className="flex-1 truncate">{a.name}</span>
                  <span className="text-[10px] uppercase tracking-wider text-text-muted">{a.status}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between">
      <dt className="text-[10px] uppercase tracking-wider text-text-muted">{label}</dt>
      <dd className="font-mono">{value}</dd>
    </div>
  );
}

function fmt(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString();
}
