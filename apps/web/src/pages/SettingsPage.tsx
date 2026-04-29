/**
 * Settings — credentials vault + version info.
 */

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { useConfirm } from '../components/shared/ConfirmDialog';
import { useToast } from '../components/shared/Toast';

interface Credential {
  id: string;
  name: string;
  credentialType: string;
  createdAt: string;
}

export function SettingsPage() {
  const [creds, setCreds] = useState<Credential[]>([]);
  const [tick, setTick] = useState(0);
  const [adding, setAdding] = useState(false);
  const confirm = useConfirm();
  const toast = useToast();

  useEffect(() => {
    void api<{ credentials: Credential[] }>('/v1/credentials').then((r) => setCreds(r.credentials));
  }, [tick]);

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-6">
      <h1 className="text-lg font-medium">Settings</h1>

      <section className="rounded-2xl border border-line bg-surface p-4">
        <div className="mb-3 flex items-center">
          <h2 className="text-sm font-medium">Credentials vault</h2>
          <button
            onClick={() => setAdding(true)}
            className="ml-auto rounded-md border border-line px-3 py-1 text-xs hover:text-accent"
          >
            + Add
          </button>
        </div>
        <div className="divide-y divide-line">
          {creds.length === 0 && (
            <div className="py-4 text-xs text-text-muted">No credentials stored.</div>
          )}
          {creds.map((c) => (
            <div key={c.id} className="flex items-center justify-between py-2 text-sm">
              <div>
                <div>{c.name}</div>
                <div className="font-mono text-xs text-text-muted">{c.credentialType}</div>
              </div>
              <button
                onClick={async () => {
                  const ok = await confirm({
                    title: `Delete credential “${c.name}”?`,
                    body: 'This is irreversible. Anything that depends on this credential will fail until replaced.',
                    confirmLabel: 'Delete',
                    tone: 'danger',
                  });
                  if (!ok) return;
                  try {
                    await api(`/v1/credentials/${c.id}`, { method: 'DELETE' });
                    toast.success('Credential deleted');
                    setTick((t) => t + 1);
                  } catch (err) {
                    toast.error('Could not delete credential', (err as Error).message);
                  }
                }}
                className="rounded-md border border-line px-2 py-0.5 text-xs hover:text-danger"
              >
                Delete
              </button>
            </div>
          ))}
        </div>
      </section>

      <section className="rounded-2xl border border-line bg-surface p-4">
        <div className="flex items-center">
          <h2 className="text-sm font-medium">Channel bridge</h2>
          <Link
            to="/settings/channels"
            className="ml-auto rounded-md border border-line px-3 py-1 text-xs hover:text-accent"
          >
            Open →
          </Link>
        </div>
        <p className="mt-2 text-xs text-text-muted">
          Connect Telegram or Discord so external chats land in an agent's conversation thread.
        </p>
      </section>

      <section className="rounded-2xl border border-line bg-surface p-4">
        <h2 className="mb-2 text-sm font-medium">About</h2>
        <div className="text-xs text-text-muted">
          Agentis V1 — proactive ambient dashboard for OpenClaw. Self-hosted, no commercial limits.
        </div>
      </section>

      {adding && <AddCredential onClose={() => { setAdding(false); setTick((t) => t + 1); }} />}
    </div>
  );
}

function AddCredential({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState('');
  const [type, setType] = useState('http_adapter_secret');
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  return (
    <div className="fixed inset-0 z-30 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div
        className="w-full max-w-md rounded-2xl border border-line bg-surface p-5 shadow-card"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="mb-3 text-base font-medium">New credential</h2>
        <div className="space-y-3">
          <label className="block">
            <span className="mb-1 block text-xs uppercase tracking-wide text-text-muted">Name</span>
            <input className={inp} value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs uppercase tracking-wide text-text-muted">Type</span>
            <input className={inp} value={type} onChange={(e) => setType(e.target.value)} />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs uppercase tracking-wide text-text-muted">Secret value</span>
            <input
              type="password"
              className={inp}
              value={value}
              onChange={(e) => setValue(e.target.value)}
            />
          </label>
          {err && <div className="text-xs text-danger">{err}</div>}
          <div className="flex justify-end gap-2 pt-1">
            <button onClick={onClose} className="rounded-md border border-line px-3 py-1 text-xs">
              Cancel
            </button>
            <button
              disabled={busy || !name || !value}
              onClick={async () => {
                setBusy(true);
                setErr(null);
                try {
                  await api('/v1/credentials', {
                    method: 'POST',
                    body: JSON.stringify({ name, credentialType: type, value }),
                  });
                  onClose();
                } catch (e) {
                  setErr((e as { message?: string })?.message ?? 'Failed');
                } finally {
                  setBusy(false);
                }
              }}
              className="rounded-md bg-accent px-3 py-1 text-xs font-medium text-canvas disabled:opacity-50"
            >
              {busy ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

const inp =
  'w-full rounded-md border border-line bg-canvas px-2 py-1 text-sm text-text-primary outline-none focus:border-accent';
