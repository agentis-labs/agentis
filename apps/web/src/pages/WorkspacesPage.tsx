/**
 * Workspaces — list + create + select.
 */

import { useEffect, useState } from 'react';
import { api, workspace as wsStore } from '../lib/api';

interface Workspace {
  id: string;
  name: string;
  slug: string;
}

export function WorkspacesPage() {
  const [items, setItems] = useState<Workspace[]>([]);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [tick, setTick] = useState(0);
  const current = wsStore.get();

  useEffect(() => {
    void api<{ workspaces: Workspace[] }>('/v1/workspaces').then((r) => setItems(r.workspaces));
  }, [tick]);

  async function create() {
    if (!name.trim()) return;
    setBusy(true);
    try {
      await api('/v1/workspaces', { method: 'POST', body: JSON.stringify({ name }) });
      setName('');
      setTick((t) => t + 1);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-2xl space-y-4 p-6">
      <h1 className="text-lg font-medium">Workspaces</h1>
      <div className="flex gap-2">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="New workspace name"
          className="flex-1 rounded-md border border-line bg-canvas px-3 py-2 text-sm outline-none focus:border-accent"
        />
        <button
          disabled={busy || !name.trim()}
          onClick={create}
          className="rounded-md bg-accent px-3 py-2 text-xs font-medium text-canvas disabled:opacity-50"
        >
          Create
        </button>
      </div>
      <div className="divide-y divide-line rounded-2xl border border-line bg-surface">
        {items.map((w) => (
          <div key={w.id} className="flex items-center justify-between px-4 py-3 text-sm">
            <div>
              <div className="font-medium">{w.name}</div>
              <div className="font-mono text-xs text-text-muted">{w.slug}</div>
            </div>
            {w.id === current ? (
              <span className="text-xs text-accent">active</span>
            ) : (
              <button
                onClick={() => {
                  wsStore.set(w.id);
                  window.location.reload();
                }}
                className="rounded-md border border-line px-3 py-1 text-xs hover:text-accent"
              >
                Activate
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
