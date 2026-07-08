/**
 * ListenerHealthPanel — EXTENSIONS-AND-LISTENER-10X §4.3.
 *
 * The live diagnostic surface for an active listener: connection state, event /
 * fire / skip counters, last-fired, and a "Fire now" test button. Polls
 * /v1/listeners/:id/health while mounted.
 */

import { useEffect, useState } from 'react';
import { api, apiErrorMessage } from '../../lib/api';

interface ListenerHealth {
  connected: boolean;
  status: string;
  sourceKind: string;
  lastEventAt?: string;
  lastFireAt?: string;
  eventCount: number;
  fireCount: number;
  skipCount: number;
  errorCount: number;
  lastError?: string;
}

export function ListenerHealthPanel({ triggerId }: { triggerId: string }) {
  const [health, setHealth] = useState<ListenerHealth | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    const poll = () => {
      api<{ health: ListenerHealth }>(`/v1/listeners/${triggerId}/health`)
        .then((r) => { if (live) { setHealth(r.health); setError(null); } })
        .catch((e) => { if (live) setError(apiErrorMessage(e)); });
    };
    poll();
    const t = setInterval(poll, 4000);
    return () => { live = false; clearInterval(t); };
  }, [triggerId]);

  const fireNow = async () => {
    setBusy(true);
    try {
      await api(`/v1/listeners/${triggerId}/fire-now`, { method: 'POST', body: JSON.stringify({}) });
    } catch (e) {
      setError(apiErrorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  if (error && !health) {
    return <div className="mb-3 rounded-md border border-line bg-surface-2 px-2 py-2 text-[11px] text-text-muted">Listener not active — register and activate the trigger to see live health.</div>;
  }
  if (!health) return null;

  const dot = health.connected ? 'bg-ok' : health.status === 'error' ? 'bg-danger' : 'bg-warn';

  return (
    <div className="mb-3 rounded-md border border-line bg-surface-2 p-2 text-[11px]">
      <div className="mb-2 flex items-center justify-between">
        <span className="font-medium uppercase tracking-wider text-text-secondary">Listener health</span>
        <span className="flex items-center gap-1 text-text-primary">
          <span className={`inline-block h-2 w-2 rounded-full ${dot}`} />
          {health.connected ? 'Connected' : health.status}
        </span>
      </div>
      <dl className="grid grid-cols-2 gap-x-2 gap-y-1 text-text-secondary">
        <Stat label="Source" value={health.sourceKind} />
        <Stat label="Events" value={String(health.eventCount)} />
        <Stat label="Fires" value={String(health.fireCount)} />
        <Stat label="Skipped" value={String(health.skipCount)} />
        <Stat label="Errors" value={String(health.errorCount)} />
        <Stat label="Last fire" value={rel(health.lastFireAt)} />
      </dl>
      {health.lastError && <p className="mt-1 text-[10px] text-danger">{health.lastError}</p>}
      <div className="mt-2 flex gap-1">
        <button
          type="button"
          onClick={fireNow}
          disabled={busy}
          className="rounded-pill border border-line bg-canvas px-2 py-0.5 text-[10px] text-text-secondary hover:border-accent/50 hover:text-text-primary disabled:opacity-50"
        >
          {busy ? 'Firing…' : 'Fire now'}
        </button>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between">
      <dt className="text-text-muted">{label}</dt>
      <dd className="text-text-primary">{value}</dd>
    </div>
  );
}

function rel(iso?: string): string {
  if (!iso) return '—';
  const diff = Date.now() - Date.parse(iso);
  if (diff < 60_000) return `${Math.round(diff / 1000)}s ago`;
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`;
  return `${Math.round(diff / 3_600_000)}h ago`;
}



