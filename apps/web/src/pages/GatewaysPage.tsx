/**
 * Gateways — list, pair, sync, delete OpenClaw gateway connections.
 */

import { useEffect, useState } from 'react';
import { api, workspace } from '../lib/api';
import { rtSubscribe, useRealtime } from '../lib/realtime';
import { GatewayDetailPanel } from '../components/GatewayDetailPanel';

interface Gateway {
  id: string;
  name: string;
  gatewayUrl: string;
  status: string;
  lastHeartbeatAt: string | null;
  lastSyncAt: string | null;
}

export function GatewaysPage() {
  const [gateways, setGateways] = useState<Gateway[]>([]);
  const [tick, setTick] = useState(0);
  const [pairing, setPairing] = useState(false);
  const [opened, setOpened] = useState<Gateway | null>(null);

  useEffect(() => {
    const ws = workspace.get();
    if (ws) rtSubscribe('workspace', { workspaceId: ws });
    void api<{ gateways: Gateway[] }>('/v1/gateways').then((r) => setGateways(r.gateways)).catch(() => {});
  }, [tick]);

  useRealtime(['gateway.connected', 'gateway.disconnected', 'gateway.degraded'], () => setTick((t) => t + 1));

  return (
    <div className="flex h-full flex-col p-4">
      <div className="mb-3 flex items-center gap-2">
        <h1 className="text-lg font-medium">Gateways</h1>
        <span className="text-xs text-text-muted">{gateways.length} connected</span>
        <button
          onClick={() => setPairing(true)}
          className="ml-auto rounded-md border border-line bg-surface-2 px-3 py-1 text-xs hover:text-accent"
        >
          + Pair
        </button>
      </div>
      <div className="grid min-h-0 flex-1 gap-3 overflow-auto sm:grid-cols-2 lg:grid-cols-3">
        {gateways.length === 0 && (
          <div className="col-span-full rounded-2xl border border-dashed border-line p-8 text-center text-text-muted">
            No gateways paired. Pair an OpenClaw gateway to register agents.
          </div>
        )}
        {gateways.map((g) => (
          <div
            key={g.id}
            className="cursor-pointer rounded-2xl border border-line bg-surface p-4 shadow-card hover:border-accent/40"
            onClick={() => setOpened(g)}
          >
            <div className="flex items-center justify-between">
              <div className="font-medium">{g.name}</div>
              <span
                className={`rounded-full px-2 py-0.5 text-xs ${
                  g.status === 'connected'
                    ? 'bg-accent-soft text-accent'
                    : g.status === 'degraded'
                      ? 'text-warn'
                      : 'text-danger'
                }`}
              >
                {g.status}
              </span>
            </div>
            <div className="mt-2 truncate font-mono text-xs text-text-muted">{g.gatewayUrl}</div>
            <div className="mt-3 flex items-center justify-between text-xs text-text-muted">
              <span>Last sync: {g.lastSyncAt ? new Date(g.lastSyncAt).toLocaleTimeString() : '—'}</span>
              <div className="flex gap-2">
                <button
                  onClick={async (e) => {
                    e.stopPropagation();
                    await api(`/v1/gateways/${g.id}/sync`, { method: 'POST' });
                    setTick((t) => t + 1);
                  }}
                  className="rounded border border-line px-2 py-0.5 hover:text-accent"
                >
                  Sync
                </button>
                <button
                  onClick={async (e) => {
                    e.stopPropagation();
                    if (!confirm(`Delete gateway "${g.name}"?`)) return;
                    await api(`/v1/gateways/${g.id}`, { method: 'DELETE' });
                    setTick((t) => t + 1);
                  }}
                  className="rounded border border-line px-2 py-0.5 hover:text-danger"
                >
                  Delete
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>
      {pairing && <PairDrawer onClose={() => { setPairing(false); setTick((t) => t + 1); }} />}
      {opened && <GatewayDetailPanel gateway={opened} onClose={() => setOpened(null)} />}
    </div>
  );
}

function PairDrawer({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [token, setToken] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  return (
    <div className="fixed inset-0 z-30 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div
        className="w-full max-w-lg rounded-2xl border border-line bg-surface p-5 shadow-card"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="mb-3 text-base font-medium">Pair OpenClaw gateway</h2>
        <div className="space-y-3">
          <Field label="Name">
            <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Gateway URL">
            <input
              className={inputCls}
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="wss://gateway.example.com"
            />
          </Field>
          <Field label="Device token">
            <input
              type="password"
              className={inputCls}
              value={token}
              onChange={(e) => setToken(e.target.value)}
            />
          </Field>
          {err && <div className="text-xs text-danger">{err}</div>}
          <div className="flex justify-end gap-2 pt-2">
            <button onClick={onClose} className="rounded-md border border-line px-3 py-1 text-xs">
              Cancel
            </button>
            <button
              disabled={busy || !name || !url || !token}
              className="rounded-md bg-accent px-3 py-1 text-xs font-medium text-canvas disabled:opacity-50"
              onClick={async () => {
                setBusy(true);
                setErr(null);
                try {
                  await api('/v1/gateways/pair', {
                    method: 'POST',
                    body: JSON.stringify({ name, gatewayUrl: url, deviceToken: token }),
                  });
                  onClose();
                } catch (e) {
                  setErr((e as { message?: string })?.message ?? 'Pairing failed');
                } finally {
                  setBusy(false);
                }
              }}
            >
              {busy ? 'Pairing…' : 'Pair'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

const inputCls =
  'w-full rounded-md border border-line bg-canvas px-2 py-1 text-sm text-text-primary outline-none focus:border-accent';

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs uppercase tracking-wide text-text-muted">{label}</span>
      {children}
    </label>
  );
}
