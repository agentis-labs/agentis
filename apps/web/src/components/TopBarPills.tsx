/**
 * Top-bar pill cluster: ambient selector + gateway health.
 *
 * Design-spec §13.2: the operator must always see, at a glance, which
 * ambient is active and whether their gateways are healthy.
 * synced. These three pills are always visible in the top bar of the
 * dashboard shell, on every page.
 *
 * Each pill is silent when its underlying state is healthy and loudly
 * coloured when something needs attention. No noise unless there is a
 * reason for noise.
 */

import { useEffect, useState } from 'react';
import clsx from 'clsx';
import { REALTIME_EVENTS } from '@agentis/core';
import { api, ambient as ambientStore, workspace } from '../lib/api';
import { useRealtime, rtSubscribe } from '../lib/realtime';

interface Ambient {
  id: string;
  name: string;
  kind: string;
}

interface WorkspaceDetail {
  workspace: { id: string; name: string; defaultAmbientId: string | null };
  ambients: Ambient[];
}

interface GatewayRow {
  id: string;
  name: string;
  status: 'connected' | 'degraded' | 'disconnected' | 'error';
}

export function AmbientSelector({ workspaceId }: { workspaceId: string }) {
  const [ambients, setAmbients] = useState<Ambient[]>([]);
  const [activeId, setActiveId] = useState<string | null>(ambientStore.get());
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void api<WorkspaceDetail>(`/v1/workspaces/${workspaceId}`)
      .then((d) => {
        if (cancelled) return;
        setAmbients(d.ambients);
        if (!ambientStore.get() && d.workspace.defaultAmbientId) {
          ambientStore.set(d.workspace.defaultAmbientId);
          setActiveId(d.workspace.defaultAmbientId);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  const active = ambients.find((a) => a.id === activeId) ?? null;

  async function pick(a: Ambient) {
    ambientStore.set(a.id);
    setActiveId(a.id);
    setOpen(false);
    await api(`/v1/workspaces/${workspaceId}/ambients/${a.id}/select`, { method: 'POST' }).catch(() => {});
  }

  if (ambients.length === 0) return null;

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1 rounded-md border border-line bg-surface-2 px-2 py-1 text-xs text-text-muted hover:text-text-primary"
      >
        <span className="inline-block h-1.5 w-1.5 rounded-full bg-accent" />
        {active?.name ?? 'No ambient'}
        <span className="ml-1 text-[10px] uppercase tracking-wide text-text-muted">{active?.kind ?? ''}</span>
      </button>
      {open && (
        <div className="absolute left-0 top-full z-40 mt-1 w-56 overflow-hidden rounded-lg border border-line bg-surface shadow-card">
          {ambients.map((a) => (
            <button
              key={a.id}
              onClick={() => pick(a)}
              className={clsx(
                'flex w-full items-center justify-between px-3 py-2 text-left text-xs hover:bg-surface-2',
                a.id === activeId ? 'text-accent' : 'text-text-primary',
              )}
            >
              <span>{a.name}</span>
              <span className="text-[10px] uppercase tracking-wide text-text-muted">{a.kind}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function GatewayHealthPill() {
  const [gateways, setGateways] = useState<GatewayRow[]>([]);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const ws = workspace.get();
    const unsubscribe = ws ? rtSubscribe('workspace', { workspaceId: ws }) : undefined;
    void api<{ gateways: GatewayRow[] }>('/v1/gateways')
      .then((d) => setGateways(d.gateways))
      .catch(() => {});
    return () => unsubscribe?.();
  }, [tick]);
  useRealtime([
    REALTIME_EVENTS.GATEWAY_CONNECTED,
    REALTIME_EVENTS.GATEWAY_DEGRADED,
    REALTIME_EVENTS.GATEWAY_DISCONNECTED,
  ], () =>
    setTick((t) => t + 1),
  );

  if (gateways.length === 0) return null;
  const connected = gateways.filter((g) => g.status === 'connected').length;
  const degraded = gateways.filter((g) => g.status === 'degraded').length;
  const failed = gateways.filter((g) => g.status === 'disconnected' || g.status === 'error').length;
  const dotClass =
    failed > 0
      ? 'bg-red-400'
      : degraded > 0
        ? 'bg-amber-400'
        : 'bg-accent';
  const tone = failed > 0 ? 'text-red-300' : degraded > 0 ? 'text-amber-300' : 'text-text-muted';
  return (
    <div
      className="flex items-center gap-1.5 rounded-md border border-line bg-surface-2 px-2 py-1 text-xs"
      title={`${connected}/${gateways.length} gateways connected`}
    >
      <span className={clsx('inline-block h-1.5 w-1.5 rounded-full', dotClass)} />
      <span className={tone}>
        {connected}/{gateways.length} gateways
      </span>
    </div>
  );
}
