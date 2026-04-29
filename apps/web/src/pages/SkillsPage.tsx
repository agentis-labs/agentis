import { useEffect, useState } from 'react';
import { api } from '../lib/api';

interface Skill {
  id: string;
  name: string;
  slug: string;
  runtime: string;
  version: string;
}

interface RegistryEntry {
  entryId: string;
  slug: string;
  entryType: 'workflow' | 'skill' | 'agent_package' | 'workflow_template';
  title: string;
  summary: string;
  version: string;
  author: { displayName: string };
  artifacts: Array<{ sha256: string }>;
}

interface RegistryStatus {
  configured: boolean;
  breaker: { state: string };
}

const RUNTIME_TONE: Record<string, string> = {
  builtin: 'border-accent/40 bg-accent/10 text-accent',
  node_worker: 'border-warn/40 bg-warn/10 text-warn',
  docker_sandbox: 'border-line bg-surface-2 text-text-muted',
};

export function SkillsPage() {
  const [items, setItems] = useState<Skill[]>([]);
  const [registryOpen, setRegistryOpen] = useState(false);
  const [status, setStatus] = useState<RegistryStatus | null>(null);

  useEffect(() => {
    void api<{ skills: Skill[] }>('/v1/skills').then((d) => setItems(d.skills));
  }, []);

  useEffect(() => {
    if (!registryOpen) return;
    void api<RegistryStatus>('/v1/skills/registry/status')
      .then(setStatus)
      .catch(() => setStatus({ configured: false, breaker: { state: 'closed' } }));
  }, [registryOpen]);

  return (
    <div className="p-6">
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-lg font-medium">Skills</h1>
        <button
          onClick={() => setRegistryOpen(true)}
          className="rounded-md border border-line bg-surface px-3 py-1.5 text-xs hover:border-accent"
        >
          Install from registry
        </button>
      </div>
      <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {items.map((s) => (
          <li key={s.id} className="rounded-2xl border border-line bg-surface p-4">
            <div className="flex items-center justify-between">
              <div className="text-sm font-medium">{s.name}</div>
              <span className={`rounded-full border px-2 py-0.5 text-[10px] uppercase ${RUNTIME_TONE[s.runtime] ?? ''}`}>
                {s.runtime}
              </span>
            </div>
            <div className="mt-1 text-xs text-text-muted">{s.slug} · v{s.version}</div>
          </li>
        ))}
      </ul>
      {registryOpen && (
        <RegistryDrawer
          status={status}
          onClose={() => {
            setRegistryOpen(false);
            // refresh after install
            void api<{ skills: Skill[] }>('/v1/skills').then((d) => setItems(d.skills));
          }}
        />
      )}
    </div>
  );
}

function RegistryDrawer({
  status,
  onClose,
}: {
  status: RegistryStatus | null;
  onClose: () => void;
}) {
  const [q, setQ] = useState('');
  const [entries, setEntries] = useState<RegistryEntry[]>([]);
  const [focus, setFocus] = useState<RegistryEntry | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function search() {
    setErr(null);
    try {
      const r = await api<{ entries: RegistryEntry[] }>(
        `/v1/skills/registry?q=${encodeURIComponent(q)}`,
      );
      setEntries(r.entries);
    } catch (e) {
      setErr((e as { message?: string })?.message ?? 'Registry unreachable');
      setEntries([]);
    }
  }

  return (
    <div className="fixed inset-0 z-30 flex items-stretch justify-end bg-black/60" onClick={onClose}>
      <div
        className="flex h-full w-full max-w-xl flex-col border-l border-line bg-surface p-5 shadow-card"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-base font-medium">Install skill from registry</h2>
          <button onClick={onClose} className="text-xs text-text-muted">
            Close
          </button>
        </div>
        {status && (
          <div className="mb-3 text-xs text-text-muted">
            {status.configured
              ? `Source: ClawdHub · breaker ${status.breaker.state}`
              : 'Registry not configured. Set AGENTIS_SKILL_REGISTRY_URL to enable installs.'}
          </div>
        )}
        <div className="mb-3 flex gap-2">
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void search()}
            placeholder="Search registry…"
            className="flex-1 rounded-md border border-line bg-canvas px-3 py-2 text-sm outline-none focus:border-accent"
          />
          <button
            onClick={() => void search()}
            className="rounded-md bg-accent px-4 py-2 text-xs font-medium text-canvas"
          >
            Search
          </button>
        </div>
        {err && (
          <div className="mb-2 rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger">
            {err}
          </div>
        )}
        <div className="grid min-h-0 flex-1 gap-2 overflow-auto">
          {entries.map((e) => (
            <button
              key={e.entryId}
              onClick={() => setFocus(e)}
              className="rounded-2xl border border-line bg-canvas p-3 text-left hover:border-accent"
            >
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">{e.title}</span>
                <span className="text-xs text-text-muted">v{e.version}</span>
              </div>
              <div className="mt-1 line-clamp-2 text-xs text-text-muted">{e.summary}</div>
              <div className="mt-2 text-[10px] text-text-muted">by {e.author.displayName}</div>
            </button>
          ))}
          {entries.length === 0 && !err && (
            <div className="rounded-2xl border border-dashed border-line p-6 text-center text-xs text-text-muted">
              Search the registry to find a skill to install.
            </div>
          )}
        </div>
        {focus && <InstallConfirm entry={focus} onClose={() => setFocus(null)} onInstalled={onClose} />}
      </div>
    </div>
  );
}

function InstallConfirm({
  entry,
  onClose,
  onInstalled,
}: {
  entry: RegistryEntry;
  onClose: () => void;
  onInstalled: () => void;
}) {
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const sha256 = entry.artifacts[0]?.sha256 ?? '';

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/70 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg rounded-2xl border border-line bg-surface p-5 shadow-card"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="text-xs uppercase tracking-wide text-accent">{entry.entryType}</div>
        <h2 className="mb-2 text-base font-medium">
          {entry.title} <span className="text-xs text-text-muted">v{entry.version}</span>
        </h2>
        <p className="mb-3 text-sm text-text-muted">{entry.summary}</p>
        <div className="mb-3 font-mono text-[10px] text-text-muted">sha256: {sha256}</div>
        <label className="mb-3 flex items-start gap-2 text-xs">
          <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} className="mt-0.5" />
          <span>
            I reviewed the permission summary and accept that this artifact may execute on my Agentis instance.
          </span>
        </label>
        {err && <div className="mb-2 text-xs text-danger">{err}</div>}
        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="rounded-md border border-line px-3 py-1 text-xs">
            Cancel
          </button>
          <button
            disabled={!ack || busy}
            className="rounded-md bg-accent px-3 py-1 text-xs font-medium text-canvas disabled:opacity-50"
            onClick={async () => {
              setBusy(true);
              setErr(null);
              try {
                await api(
                  `/v1/skills/registry/install/${encodeURIComponent(entry.slug)}`,
                  {
                    method: 'POST',
                    body: JSON.stringify({ permissionsAcknowledged: true }),
                  },
                );
                onInstalled();
              } catch (e) {
                setErr((e as { message?: string })?.message ?? 'Install failed');
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? 'Installing…' : 'Install'}
          </button>
        </div>
      </div>
    </div>
  );
}
