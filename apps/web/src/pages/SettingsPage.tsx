/**
 * SettingsPage — 4 tabs: Profile / Workspace / Connections / Security.
 *
 * Connections tab consolidates Gateways + Channels (replaces /gateways
 * and /settings/channels). Theme toggle lives here too (and in avatar menu).
 */

import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Save, Plug, Hash, Key, Trash2, Plus, Upload, Copy, X, MessageSquare, Webhook as WebhookIcon } from 'lucide-react';
import clsx from 'clsx';
import { api, apiErrorMessage } from '../lib/api';
import { useToast } from '../components/shared/Toast';
import { useConfirm } from '../components/shared/ConfirmDialog';
import { Tabs } from '../components/shared/Tabs';
import { Button } from '../components/shared/Button';
import { Skeleton } from '../components/shared/Skeleton';
import { ThemeToggle } from '../components/shared/ThemeToggle';
import { StatusBadge } from '../components/shared/StatusBadge';
import { GovernancePanel } from '../components/settings/GovernancePanel';
import { McpConnectionsPanel } from '../components/settings/McpConnectionsPanel';
import { ChannelIdentitiesPanel } from '../components/settings/ChannelIdentitiesPanel';
import { OrchestratorModelsPanel } from '../components/settings/OrchestratorModelsPanel';

type Tab = 'profile' | 'workspace' | 'connections' | 'security' | 'budget' | 'runtimes' | 'governance';

export function SettingsPage() {
  const [searchParams] = useSearchParams();
  const initialTab = (searchParams.get('tab') as Tab) || 'profile';
  const [tab, setTab] = useState<Tab>(initialTab);

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-line px-6 py-4">
        <h1 className="text-display text-text-primary">Settings</h1>
      </div>
      <Tabs
        value={tab}
        onChange={(v) => setTab(v as Tab)}
        tabs={[
          { value: 'profile',     label: 'Profile' },
          { value: 'workspace',   label: 'Workspace' },
          { value: 'connections', label: 'Connections' },
          { value: 'governance',  label: 'Governance' },
          { value: 'security',    label: 'Security' },
          { value: 'budget',      label: 'Budget' },
          { value: 'runtimes',    label: 'Runtimes' },
        ]}
        className="px-6"
      />
      <div className="flex-1 overflow-y-auto px-6 py-5">
        {tab === 'profile' && <ProfileTab />}
        {tab === 'workspace' && <WorkspaceTab />}
        {tab === 'connections' && (
          <div className="space-y-8">
            <ConnectionsTab />
            <ChannelIdentitiesPanel />
            <McpConnectionsPanel />
          </div>
        )}
        {tab === 'governance' && <GovernancePanel />}
        {tab === 'security' && <SecurityTab />}
        {tab === 'budget' && <BudgetTab />}
        {tab === 'runtimes' && (
          <div className="space-y-8">
            <OrchestratorModelsPanel />
            <RuntimesTab />
          </div>
        )}
      </div>
    </div>
  );
}

// Runtimes tab — tool-availability matrix per adapter type. Mirrors the
// capabilities each adapter declares server-side (apps/api/src/adapters/*),
// so operators can see at a glance which runtimes can drive platform tools
// from chat and which run in relay mode. (CHAT-10X-VISION §4.4.3)
type ToolSupport = 'native' | 'marker' | 'relay' | 'none';

interface RuntimeRow {
  type: string;
  label: string;
  interactiveChat: boolean;
  support: ToolSupport;
  note: string;
}

const RUNTIME_MATRIX: RuntimeRow[] = [
  { type: 'http', label: 'HTTP', interactiveChat: true, support: 'native', note: 'Generic HTTP endpoint. Native tool calls work when the endpoint implements the Agentis chat contract.' },
  { type: 'codex', label: 'Codex CLI', interactiveChat: true, support: 'marker', note: 'Marker protocol. Slower (re-spawns per tool round). Use the orchestrator fast path for native speed.' },
  { type: 'claude_code', label: 'Claude Code CLI', interactiveChat: true, support: 'marker', note: 'Marker protocol. Same fast-path recommendation as Codex.' },
  { type: 'openclaw', label: 'OpenClaw', interactiveChat: true, support: 'relay', note: 'Chats through the gateway session: Agentis relays your message and streams the reply. Platform tool calls run on the gateway agent, not the local chat loop.' },
  { type: 'hermes_agent', label: 'Hermes Agent', interactiveChat: true, support: 'marker', note: 'Marker protocol. Interactive chat and Agentis tool forwarding via the spawn-level JSON stream.' },
  { type: 'cursor', label: 'Cursor', interactiveChat: true, support: 'marker', note: 'Marker protocol. Chat and tool forwarding via spawn-level JSON stream.' },
];

const SUPPORT_META: Record<ToolSupport, { label: string; cls: string }> = {
  native: { label: 'Native', cls: 'bg-accent-soft text-accent' },
  marker: { label: 'Marker', cls: 'bg-warn-soft text-warn' },
  relay: { label: 'Relay', cls: 'bg-surface-3 text-text-muted' },
  none: { label: 'None', cls: 'bg-surface-3 text-text-muted' },
};

function RuntimesTab() {
  return (
    <div className="max-w-3xl space-y-4">
      <div>
        <h2 className="text-subheading text-text-primary">Runtime tool support</h2>
        <p className="mt-1 text-[13px] text-text-muted">
          Which agent runtimes can drive Agentis platform tools (build workflows, run, dispatch, etc.) directly from chat.
          Runtimes marked <span className="font-medium text-warn">Marker</span> work but re-spawn a process per tool round —
          configure the orchestrator fast path (<code className="rounded bg-canvas/70 px-1 font-mono text-[11px]">AGENTIS_ORCHESTRATOR_BASE_URL</code>)
          to answer their chats through a native runtime instead.
        </p>
      </div>
      <div className="overflow-hidden rounded-card border border-line">
        <table className="w-full text-left text-[13px]">
          <thead className="bg-surface-2 text-[11px] uppercase tracking-wide text-text-muted">
            <tr>
              <th className="px-3 py-2 font-medium">Runtime</th>
              <th className="px-3 py-2 font-medium">Chat</th>
              <th className="px-3 py-2 font-medium">Tools</th>
              <th className="px-3 py-2 font-medium">Notes</th>
            </tr>
          </thead>
          <tbody>
            {RUNTIME_MATRIX.map((row) => {
              const meta = SUPPORT_META[row.support];
              return (
                <tr key={row.type} className="border-t border-line align-top">
                  <td className="px-3 py-2.5">
                    <div className="font-medium text-text-primary">{row.label}</div>
                    <div className="font-mono text-[10px] text-text-muted">{row.type}</div>
                  </td>
                  <td className="px-3 py-2.5">
                    <span className={clsx('inline-flex items-center rounded-full px-2 py-0.5 text-[11px]', row.interactiveChat ? 'bg-accent-soft text-accent' : 'bg-surface-3 text-text-muted')}>
                      {row.interactiveChat ? 'Interactive' : 'Relay only'}
                    </span>
                  </td>
                  <td className="px-3 py-2.5">
                    <span className={clsx('inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium', meta.cls)}>
                      {meta.label}
                    </span>
                  </td>
                  <td className="px-3 py-2.5 text-[12px] text-text-muted">{row.note}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ProfileTab() {
  const toast = useToast();
  const [me, setMe] = useState<{ id: string; email: string; name: string; avatarUrl?: string } | null>(null);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    void api<{ user: { id: string; email: string | null; displayName: string; avatarUrl?: string } }>('/v1/auth/me')
      .then((d) => {
        const mapped = {
          id: d.user.id,
          email: d.user.email ?? '',
          name: d.user.displayName ?? '',
          avatarUrl: d.user.avatarUrl,
        };
        setMe(mapped);
        setName(mapped.name);
        setEmail(mapped.email);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  async function save() {
    if (!me) return;
    setSaving(true);
    try {
      await api('/v1/auth/me', { method: 'PATCH', body: JSON.stringify({ name, email }) });
      toast.success('Profile updated');
      setMe((prev) => prev ? { ...prev, name, email } : null);
      setTimeout(() => window.location.reload(), 800);
    } catch (e) { toast.error('Failed to update', apiErrorMessage(e)); }
    finally { setSaving(false); }
  }

  if (loading) return <Skeleton height={200} />;

  return (
    <div className="max-w-xl space-y-5">
      <div>
        <h2 className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-text-muted">Profile</h2>
        <div className="space-y-4 rounded-card border border-line bg-surface p-5">
          <div className="space-y-1.5">
            <label className="text-[12px] font-medium text-text-secondary">Display name</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="h-10 w-full rounded-input border border-line bg-surface-2 px-3 text-[14px] text-text-primary focus:border-accent focus:outline-none"
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-[12px] font-medium text-text-secondary">Email</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="h-10 w-full rounded-input border border-line bg-surface-2 px-3 text-[14px] text-text-primary focus:border-accent focus:outline-none"
            />
          </div>
          <Button variant="primary" size="md" iconLeft={<Save size={12} />} disabled={saving} onClick={() => void save()}>
            Save changes
          </Button>
        </div>
      </div>

      <div>
        <h2 className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-text-muted">Theme</h2>
        <div className="rounded-card border border-line bg-surface p-5">
          <ThemeToggle variant="full" />
          <p className="mt-3 text-[12px] text-text-muted">
            Match the system theme, or pick light/dark explicitly.
          </p>
        </div>
      </div>
    </div>
  );
}


function WorkspaceTab() {
  const toast = useToast();
  const confirm = useConfirm();
  const [ws, setWs] = useState<{ id: string; name: string; slug: string; description?: string; imageUrl?: string | null } | null>(null);
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [description, setDescription] = useState('');
  const [imageDataUrl, setImageDataUrl] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void api<{ workspaces: typeof ws[] }>('/v1/workspaces')
      .then((d) => {
        const wsId = localStorage.getItem('agentis.workspace');
        const current = d.workspaces.find((x: any) => x?.id === wsId) ?? d.workspaces[0];
        if (current) {
          setWs(current);
          setName(current.name);
          setSlug(current.slug);
          setDescription(current.description ?? '');
        }
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  async function save() {
    if (!ws) return;
    setSaving(true);
    try {
      await api(`/v1/workspaces/${ws.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ name, slug, description, ...(imageDataUrl ? { imageDataUrl } : {}) }),
      });
      toast.success('Workspace updated');
      setImageDataUrl(null);
      setWs((prev) => prev ? { ...prev, name, slug, description } : null);
      setTimeout(() => window.location.reload(), 800);
    } catch (e) { toast.error('Failed to update', apiErrorMessage(e)); }
    finally { setSaving(false); }
  }

  async function deleteWorkspace() {
    if (!ws) return;
    const ok = await confirm({
      title: `Delete workspace "${ws.name}"?`,
      body: 'This will permanently delete the workspace and all its agents, workflows, knowledge, and data. This action cannot be undone.',
      confirmLabel: 'Delete workspace',
      tone: 'danger',
      typeToConfirm: ws.name,
    });
    if (!ok) return;
    try {
      await api(`/v1/workspaces/${ws.id}`, { method: 'DELETE' });
      toast.success('Workspace deleted');
      window.location.reload();
    } catch (e) { toast.error('Failed to delete', apiErrorMessage(e)); }
  }

  function handleImageChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => setImageDataUrl(ev.target?.result as string);
    reader.readAsDataURL(file);
  }

  if (loading) return <Skeleton height={300} />;
  if (!ws) return <div className="text-[13px] text-text-muted">No workspace.</div>;

  const previewImage = imageDataUrl ?? ws.imageUrl;

  return (
    <div className="max-w-xl space-y-5">
      <div>
        <h2 className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-text-muted">Workspace</h2>
        <div className="space-y-4 rounded-card border border-line bg-surface p-5">
          <div className="flex items-center gap-4">
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              className="group relative h-16 w-16 shrink-0 overflow-hidden rounded-card border border-line bg-surface-2"
              aria-label="Change workspace image"
            >
              {previewImage ? (
                <img src={previewImage} alt="" className="h-full w-full object-cover" />
              ) : (
                <span className="flex h-full w-full items-center justify-center text-[24px] font-bold text-text-primary">
                  {name.charAt(0).toUpperCase() || '?'}
                </span>
              )}
              <span className="absolute inset-0 hidden items-center justify-center bg-overlay group-hover:flex">
                <Upload size={16} className="text-white" />
              </span>
            </button>
            <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp" onChange={handleImageChange} className="hidden" />
            <div className="text-[12px] text-text-muted">Click to change workspace image</div>
          </div>

          <div className="space-y-1.5">
            <label className="text-[12px] font-medium text-text-secondary">Name</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="h-10 w-full rounded-input border border-line bg-surface-2 px-3 text-[14px] text-text-primary focus:border-accent focus:outline-none"
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-[12px] font-medium text-text-secondary">Slug</label>
            <input
              type="text"
              value={slug}
              onChange={(e) => setSlug(e.target.value)}
              className="h-10 w-full rounded-input border border-line bg-surface-2 px-3 font-mono text-[14px] text-text-primary focus:border-accent focus:outline-none"
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-[12px] font-medium text-text-secondary">Description</label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
              className="w-full resize-none rounded-input border border-line bg-surface-2 px-3 py-2 text-[14px] text-text-primary focus:border-accent focus:outline-none"
            />
          </div>
          <Button variant="primary" size="md" iconLeft={<Save size={12} />} disabled={saving} onClick={() => void save()}>
            Save changes
          </Button>
        </div>
      </div>

      <div>
        <h2 className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-danger">Danger zone</h2>
        <div className="space-y-3 rounded-card border border-danger/20 bg-danger-soft/30 p-5">
          <div className="text-[13px] text-text-primary">Delete this workspace permanently.</div>
          <div className="text-[12px] text-text-muted">
            All agents, workflows, knowledge, and data inside it will be permanently deleted.
          </div>
          <Button variant="danger" size="md" iconLeft={<Trash2 size={12} />} onClick={() => void deleteWorkspace()}>
            Delete workspace
          </Button>
        </div>
      </div>
    </div>
  );
}

interface Connection {
  id: string;
  kind: 'gateway' | 'telegram' | 'discord' | 'slack' | 'webhook';
  name: string;
  status?: string;
  agentCount?: number;
}

function ConnectionsTab() {
  const toast = useToast();
  const confirm = useConfirm();
  const [items, setItems] = useState<Connection[]>([]);
  const [loading, setLoading] = useState(true);
  const [addOpen, setAddOpen] = useState(false);

  async function refresh() {
    setLoading(true);
    try {
      const [g, c] = await Promise.allSettled([
        api<{ gateways: Array<{ id: string; name: string; status: string; agentCount?: number }> }>('/v1/gateways'),
        api<{ channels: Array<{ id: string; kind: string; name: string; status?: string }> }>('/v1/channels'),
      ]);
      const merged: Connection[] = [];
      if (g.status === 'fulfilled') {
        for (const x of g.value.gateways ?? []) merged.push({ ...x, kind: 'gateway' });
      }
      if (c.status === 'fulfilled') {
        for (const x of c.value.channels ?? []) {
          if (x.kind === 'telegram' || x.kind === 'discord' || x.kind === 'slack' || x.kind === 'webhook') {
            merged.push({ id: x.id, kind: x.kind, name: x.name, status: x.status });
          }
        }
      }
      setItems(merged);
    } finally { setLoading(false); }
  }

  useEffect(() => { void refresh(); }, []);

  async function handleDelete(c: Connection) {
    const ok = await confirm({
      title: `Disconnect "${c.name}"?`,
      body: 'This will remove the connection. Agents using it will lose access.',
      confirmLabel: 'Disconnect',
      tone: 'danger',
    });
    if (!ok) return;
    try {
      const path = c.kind === 'gateway' ? `/v1/gateways/${c.id}` : `/v1/channels/${c.id}`;
      await api(path, { method: 'DELETE' });
      toast.success('Disconnected', c.name);
      void refresh();
    } catch (e) { toast.error('Failed to disconnect', apiErrorMessage(e)); }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-[11px] font-semibold uppercase tracking-wider text-text-muted">Connections</h2>
        <Button variant="primary" size="md" iconLeft={<Plus size={14} />} onClick={() => setAddOpen(true)}>Add connection</Button>
      </div>
      <AddConnectionDialog
        open={addOpen}
        onClose={() => setAddOpen(false)}
        onCreated={() => { setAddOpen(false); void refresh(); }}
      />

      {loading ? (
        <Skeleton height={200} />
      ) : items.length === 0 ? (
        <div className="rounded-card border border-dashed border-line bg-surface/40 p-8 text-center">
          <Plug size={32} className="mx-auto text-text-muted opacity-60" />
          <h3 className="mt-3 text-subheading text-text-primary">No connections configured</h3>
          <p className="mt-1 text-[13px] text-text-secondary">
            Connect an OpenClaw gateway or messaging integration to bring agents online.
          </p>
        </div>
      ) : (
        <div className="space-y-1.5">
          {items.map((c) => (
            <div key={c.id} className="flex items-center gap-3 rounded-card border border-line bg-surface px-4 py-3">
              <span className={`flex h-8 w-8 items-center justify-center rounded-card ${
                c.kind === 'gateway' ? 'bg-info-soft text-info'
                  : c.kind === 'telegram' ? 'bg-info-soft text-info'
                  : c.kind === 'discord' ? 'bg-accent-soft text-accent'
                  : c.kind === 'slack' ? 'bg-warn-soft text-warn'
                  : 'bg-surface-2 text-text-secondary'
              }`}>
                {c.kind === 'gateway' ? <Plug size={14} /> : <Hash size={14} />}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-[13px] font-medium text-text-primary">{c.name}</span>
                  <StatusBadge status={c.status ?? 'unknown'} size="sm" />
                </div>
                <div className="mt-0.5 text-[11px] capitalize text-text-muted">
                  {c.kind}{c.agentCount != null ? ` · ${c.agentCount} agent${c.agentCount === 1 ? '' : 's'}` : ''}
                </div>
              </div>
              <Button variant="ghost" size="sm" aria-label="Disconnect" onClick={() => void handleDelete(c)}>
                <Trash2 size={12} />
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function SecurityTab() {
  const toast = useToast();
  const [keys, setKeys] = useState<Array<{ id: string; name: string; preview: string; createdAt: string }>>([]);
  const [loading, setLoading] = useState(true);
  const confirm = useConfirm();
  const [creatingOpen, setCreatingOpen] = useState(false);
  const [revealedKey, setRevealedKey] = useState<{ name: string; secret: string } | null>(null);

  async function refresh() {
    try {
      const data = await api<{ keys: typeof keys }>('/v1/auth/api-keys');
      setKeys(data.keys ?? []);
    } catch { setKeys([]); }
    finally { setLoading(false); }
  }

  useEffect(() => { void refresh(); }, []);

  async function createKey(name: string) {
    if (!name.trim()) return;
    try {
      const data = await api<{ key: { id: string; secret: string } }>('/v1/auth/api-keys', {
        method: 'POST',
        body: JSON.stringify({ name: name.trim() }),
      });
      setCreatingOpen(false);
      setRevealedKey({ name: name.trim(), secret: data.key.secret });
      void refresh();
    } catch (e) { toast.error('Failed to create key', apiErrorMessage(e)); }
  }

  async function revoke(id: string) {
    const ok = await confirm({
      title: 'Revoke this API key?',
      body: 'Anything using this key will stop working immediately.',
      confirmLabel: 'Revoke',
      tone: 'danger',
    });
    if (!ok) return;
    try {
      await api(`/v1/auth/api-keys/${id}`, { method: 'DELETE' });
      toast.success('Key revoked');
      void refresh();
    } catch (e) { toast.error('Failed to revoke', apiErrorMessage(e)); }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-[11px] font-semibold uppercase tracking-wider text-text-muted">API Keys</h2>
        <Button variant="primary" size="md" iconLeft={<Plus size={14} />} onClick={() => setCreatingOpen(true)}>
          New key
        </Button>
      </div>
      <ApiKeyCreateDialog
        open={creatingOpen}
        onClose={() => setCreatingOpen(false)}
        onCreate={createKey}
      />
      <ApiKeyRevealDialog
        keyValue={revealedKey}
        onClose={() => setRevealedKey(null)}
      />

      {loading ? (
        <Skeleton height={150} />
      ) : keys.length === 0 ? (
        <div className="rounded-card border border-dashed border-line bg-surface/40 p-8 text-center">
          <Key size={32} className="mx-auto text-text-muted opacity-60" />
          <h3 className="mt-3 text-subheading text-text-primary">No API keys yet</h3>
          <p className="mt-1 text-[13px] text-text-secondary">
            Create an API key to authenticate programmatic access.
          </p>
        </div>
      ) : (
        <div className="space-y-1.5">
          {keys.map((k) => (
            <div key={k.id} className="flex items-center gap-3 rounded-card border border-line bg-surface px-4 py-3">
              <Key size={14} className="text-text-muted" />
              <div className="min-w-0 flex-1">
                <div className="text-[13px] font-medium text-text-primary">{k.name}</div>
                <div className="mt-0.5 font-mono text-[11px] text-text-muted">{k.preview}</div>
              </div>
              <Button variant="danger" size="sm" iconLeft={<Trash2 size={11} />} onClick={() => void revoke(k.id)}>
                Revoke
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ApiKeyCreateDialog({
  open, onClose, onCreate,
}: {
  open: boolean;
  onClose: () => void;
  onCreate: (name: string) => Promise<void> | void;
}) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => { if (open) setName(''); }, [open]);
  if (!open) return null;

  return (
    <div className="animate-fade-in fixed inset-0 z-[60] flex items-center justify-center bg-overlay p-4" role="dialog" aria-modal="true">
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          if (!name.trim() || busy) return;
          setBusy(true);
          try { await onCreate(name); }
          finally { setBusy(false); }
        }}
        className="animate-scale-in w-full max-w-sm rounded-modal border border-line bg-surface shadow-modal"
      >
        <header className="flex items-center justify-between border-b border-line px-5 py-4">
          <h3 className="text-heading text-text-primary">New API key</h3>
          <button type="button" onClick={onClose} aria-label="Close" className="-m-1 rounded-md p-1 text-text-muted hover:bg-surface-2 hover:text-text-primary">
            <X size={16} />
          </button>
        </header>
        <div className="space-y-3 px-5 py-5">
          <label className="block">
            <span className="mb-1.5 block text-[12px] font-medium text-text-secondary">Name</span>
            <input
              autoFocus
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g., CI deploy script"
              className="h-10 w-full rounded-input border border-line bg-surface-2 px-3 text-[14px] text-text-primary placeholder:text-text-muted focus:border-accent focus:outline-none"
            />
          </label>
          <p className="text-[11px] text-text-muted">
            The full key will only be shown once after creation. Save it somewhere safe.
          </p>
        </div>
        <footer className="flex items-center justify-end gap-2 border-t border-line bg-surface-2 px-5 py-3">
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-9 items-center rounded-btn border border-line bg-transparent px-3 text-[13px] font-medium text-text-secondary hover:bg-surface-3 hover:text-text-primary"
          >Cancel</button>
          <button
            type="submit"
            disabled={!name.trim() || busy}
            className="inline-flex h-9 items-center rounded-btn bg-accent px-3 text-[13px] font-semibold text-canvas hover:bg-accent-hover disabled:opacity-60"
          >{busy ? 'Creating…' : 'Create key'}</button>
        </footer>
      </form>
    </div>
  );
}

function ApiKeyRevealDialog({
  keyValue, onClose,
}: {
  keyValue: { name: string; secret: string } | null;
  onClose: () => void;
}) {
  const toast = useToast();
  const [copied, setCopied] = useState(false);
  if (!keyValue) return null;
  return (
    <div className="animate-fade-in fixed inset-0 z-[60] flex items-center justify-center bg-overlay p-4" role="dialog" aria-modal="true">
      <div className="animate-scale-in w-full max-w-md rounded-modal border border-line bg-surface shadow-modal">
        <header className="flex items-center justify-between border-b border-line px-5 py-4">
          <h3 className="text-heading text-text-primary">Save your API key</h3>
          <button type="button" onClick={onClose} aria-label="Close" className="-m-1 rounded-md p-1 text-text-muted hover:bg-surface-2 hover:text-text-primary">
            <X size={16} />
          </button>
        </header>
        <div className="space-y-3 px-5 py-5">
          <div className="rounded-card border border-warn/30 bg-warn-soft px-3 py-2 text-[12px] text-text-primary">
            This is the only time this key will be shown. Copy and store it somewhere safe.
          </div>
          <div className="space-y-1.5">
            <span className="text-[12px] text-text-muted">Key name</span>
            <div className="text-[13px] text-text-primary">{keyValue.name}</div>
          </div>
          <div className="space-y-1.5">
            <span className="text-[12px] text-text-muted">Secret</span>
            <div className="flex items-center gap-2">
              <code className="flex-1 break-all rounded-input border border-line bg-surface-2 px-3 py-2 font-mono text-[12px] text-text-primary">{keyValue.secret}</code>
              <Button
                variant="secondary"
                size="md"
                iconLeft={<Copy size={12} />}
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(keyValue.secret);
                    setCopied(true);
                    toast.success('Copied');
                    setTimeout(() => setCopied(false), 2000);
                  } catch { /* ignore */ }
                }}
              >
                {copied ? 'Copied' : 'Copy'}
              </Button>
            </div>
          </div>
        </div>
        <footer className="flex items-center justify-end gap-2 border-t border-line bg-surface-2 px-5 py-3">
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-9 items-center rounded-btn bg-accent px-3 text-[13px] font-semibold text-canvas hover:bg-accent-hover"
          >Done</button>
        </footer>
      </div>
    </div>
  );
}

interface AddConnectionDialogProps {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
}

const CONNECTION_KINDS = [
  { kind: 'gateway',  label: 'OpenClaw Gateway', desc: 'Self-hosted compute', icon: Plug },
  { kind: 'telegram', label: 'Telegram',         desc: 'Bot adapter',          icon: MessageSquare },
  { kind: 'discord',  label: 'Discord',          desc: 'Bot adapter',          icon: Hash },
  { kind: 'slack',    label: 'Slack',            desc: 'Bot adapter',          icon: Hash },
  { kind: 'webhook',  label: 'Webhook',          desc: 'Inbound HTTP',         icon: WebhookIcon },
] as const;

function AddConnectionDialog({ open, onClose, onCreated }: AddConnectionDialogProps) {
  const toast = useToast();
  const [pickedKind, setPickedKind] = useState<typeof CONNECTION_KINDS[number]['kind'] | null>(null);
  const [name, setName] = useState('');
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) { setPickedKind(null); setName(''); setToken(''); }
  }, [open]);

  if (!open) return null;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!pickedKind || !name.trim() || busy) return;
    setBusy(true);
    try {
      if (pickedKind === 'gateway') {
        await api('/v1/gateways', {
          method: 'POST',
          body: JSON.stringify({ name: name.trim() }),
        });
      } else {
        await api('/v1/channels', {
          method: 'POST',
          body: JSON.stringify({
            kind: pickedKind,
            name: name.trim(),
            credentials: token.trim() ? { token: token.trim() } : {},
          }),
        });
      }
      toast.success('Connected', name.trim());
      onCreated();
    } catch (e) {
      toast.error('Failed to connect', apiErrorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="animate-fade-in fixed inset-0 z-[60] flex items-center justify-center bg-overlay p-4" role="dialog" aria-modal="true">
      <form onSubmit={submit} className="animate-scale-in w-full max-w-md rounded-modal border border-line bg-surface shadow-modal">
        <header className="flex items-center justify-between border-b border-line px-5 py-4">
          <h3 className="text-heading text-text-primary">Add connection</h3>
          <button type="button" onClick={onClose} aria-label="Close" className="-m-1 rounded-md p-1 text-text-muted hover:bg-surface-2 hover:text-text-primary">
            <X size={16} />
          </button>
        </header>
        <div className="space-y-4 px-5 py-5">
          {!pickedKind ? (
            <div className="grid grid-cols-2 gap-2">
              {CONNECTION_KINDS.map((c) => {
                const Icon = c.icon;
                return (
                  <button
                    key={c.kind}
                    type="button"
                    onClick={() => setPickedKind(c.kind)}
                    className="flex flex-col items-start gap-1.5 rounded-card border border-line bg-surface-2 p-3 text-left transition-colors hover:border-line-strong hover:bg-surface-3"
                  >
                    <Icon size={16} className="text-text-secondary" />
                    <span className="text-subheading text-text-primary">{c.label}</span>
                    <span className="text-[11px] text-text-muted">{c.desc}</span>
                  </button>
                );
              })}
            </div>
          ) : (
            <>
              <div>
                <button type="button" onClick={() => setPickedKind(null)} className="text-[12px] text-text-muted hover:text-text-primary">
                  ← Back
                </button>
              </div>
              <label className="block">
                <span className="mb-1.5 block text-[12px] font-medium text-text-secondary">Name</span>
                <input
                  autoFocus
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder={`My ${pickedKind}`}
                  className="h-10 w-full rounded-input border border-line bg-surface-2 px-3 text-[14px] text-text-primary placeholder:text-text-muted focus:border-accent focus:outline-none"
                />
              </label>
              {pickedKind !== 'gateway' && pickedKind !== 'webhook' && (
                <label className="block">
                  <span className="mb-1.5 block text-[12px] font-medium text-text-secondary">Bot token</span>
                  <input
                    type="password"
                    value={token}
                    onChange={(e) => setToken(e.target.value)}
                    placeholder="Paste token"
                    className="h-10 w-full rounded-input border border-line bg-surface-2 px-3 font-mono text-[13px] text-text-primary placeholder:text-text-muted focus:border-accent focus:outline-none"
                  />
                </label>
              )}
            </>
          )}
        </div>
        <footer className="flex items-center justify-end gap-2 border-t border-line bg-surface-2 px-5 py-3">
          <button type="button" onClick={onClose} className="inline-flex h-9 items-center rounded-btn border border-line bg-transparent px-3 text-[13px] font-medium text-text-secondary hover:bg-surface-3 hover:text-text-primary">Cancel</button>
          <button
            type="submit"
            disabled={!pickedKind || !name.trim() || busy}
            className="inline-flex h-9 items-center rounded-btn bg-accent px-3 text-[13px] font-semibold text-canvas hover:bg-accent-hover disabled:opacity-60"
          >{busy ? 'Connecting…' : 'Connect'}</button>
        </footer>
      </form>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Budget tab
// ---------------------------------------------------------------------------

interface BudgetAgentRow {
  id: string;
  name: string;
  monthlyBudgetCents?: number | null;
  currentMonthSpendCents?: number | null;
}

interface BudgetEventRow {
  id: string;
  agentId: string;
  runId?: string | null;
  eventType: string;
  amountCents: number;
  createdAt: string;
}

interface BudgetData {
  agents: BudgetAgentRow[];
  events: BudgetEventRow[];
}

function budgetMoney(cents: number) {
  return `$${(cents / 100).toFixed(2)}`;
}

function BudgetTab() {
  const toast = useToast();
  const [data, setData] = useState<BudgetData | null>(null);
  const [loading, setLoading] = useState(true);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');
  const [saving, setSaving] = useState(false);

  async function refresh() {
    setLoading(true);
    try {
      const res = await api<BudgetData>('/v1/budgets');
      setData({ agents: res.agents ?? [], events: res.events ?? [] });
    } catch {
      setData(null);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void refresh(); }, []);

  function startEdit(agent: BudgetAgentRow) {
    setEditingId(agent.id);
    setEditValue(agent.monthlyBudgetCents != null ? String(agent.monthlyBudgetCents / 100) : '');
  }

  async function saveEdit(agentId: string) {
    setSaving(true);
    const dollars = parseFloat(editValue);
    const monthlyBudgetCents = isNaN(dollars) || editValue.trim() === '' ? null : Math.round(dollars * 100);
    try {
      await api(`/v1/budgets/agents/${agentId}`, {
        method: 'PATCH',
        body: JSON.stringify({ monthlyBudgetCents }),
      });
      toast.success('Budget updated');
      setEditingId(null);
      void refresh();
    } catch (e) {
      toast.error('Failed to update', apiErrorMessage(e));
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <Skeleton height={300} />;

  if (!data) {
    return (
      <div className="rounded-card border border-dashed border-line bg-surface/40 p-8 text-center text-[13px] text-text-muted">
        Could not load budget data.
      </div>
    );
  }

  const totalSpend = data.agents.reduce((s, a) => s + Math.max(0, a.currentMonthSpendCents ?? 0), 0);
  const allCapped = data.agents.length > 0 && data.agents.every((a) => a.monthlyBudgetCents != null);
  const totalCap = allCapped ? data.agents.reduce((s, a) => s + (a.monthlyBudgetCents ?? 0), 0) : null;
  const recentEvents = [...data.events]
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
    .slice(0, 20);

  function agentName(id: string) {
    return data!.agents.find((a) => a.id === id)?.name ?? id.slice(0, 8);
  }

  return (
    <div className="max-w-2xl space-y-6">
      {/* Summary strip */}
      <div className="grid grid-cols-3 gap-3">
        <div className="rounded-card border border-line bg-surface p-4">
          <div className="text-[11px] text-text-muted">This month's spend</div>
          <div className="mt-1 text-[20px] font-semibold text-text-primary">{budgetMoney(totalSpend)}</div>
        </div>
        <div className="rounded-card border border-line bg-surface p-4">
          <div className="text-[11px] text-text-muted">Monthly cap</div>
          <div className="mt-1 text-[20px] font-semibold text-text-primary">
            {totalCap != null ? budgetMoney(totalCap) : <span className="text-[14px] text-text-muted">None set</span>}
          </div>
        </div>
        <div className="rounded-card border border-line bg-surface p-4">
          <div className="text-[11px] text-text-muted">Spend events</div>
          <div className="mt-1 text-[20px] font-semibold text-text-primary">{data.events.length}</div>
        </div>
      </div>

      {/* Per-agent limits */}
      <div>
        <h2 className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-text-muted">Per-agent limits</h2>
        {data.agents.length === 0 ? (
          <div className="rounded-card border border-dashed border-line bg-surface/40 p-6 text-center text-[13px] text-text-muted">
            No agents in this workspace.
          </div>
        ) : (
          <div className="space-y-1.5">
            {data.agents.map((agent) => {
              const spend = agent.currentMonthSpendCents ?? 0;
              const cap = agent.monthlyBudgetCents;
              const pct = cap != null && cap > 0 ? Math.min(100, (spend / cap) * 100) : 0;
              const isEditing = editingId === agent.id;
              return (
                <div key={agent.id} className="rounded-card border border-line bg-surface px-4 py-3">
                  <div className="flex items-center gap-3">
                    <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-text-primary">{agent.name}</span>
                    <span className="text-[12px] text-text-secondary">{budgetMoney(spend)} this month</span>
                    {isEditing ? (
                      <div className="flex items-center gap-1.5">
                        <span className="text-[12px] text-text-muted">$</span>
                        <input
                          type="number"
                          min="0"
                          step="0.01"
                          placeholder="No cap"
                          value={editValue}
                          onChange={(e) => setEditValue(e.target.value)}
                          className="w-24 rounded-input border border-line bg-canvas px-2 py-1 text-[12px] text-text-primary outline-none focus:border-accent"
                          autoFocus
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') void saveEdit(agent.id);
                            if (e.key === 'Escape') setEditingId(null);
                          }}
                        />
                        <Button variant="primary" size="sm" disabled={saving} onClick={() => void saveEdit(agent.id)}>
                          Save
                        </Button>
                        <Button variant="ghost" size="sm" onClick={() => setEditingId(null)}>
                          Cancel
                        </Button>
                      </div>
                    ) : (
                      <div className="flex items-center gap-2">
                        <span className="text-[12px] text-text-muted">
                          Cap: {cap != null ? budgetMoney(cap) : 'None'}
                        </span>
                        <Button variant="ghost" size="sm" onClick={() => startEdit(agent)}>
                          Edit
                        </Button>
                      </div>
                    )}
                  </div>
                  {cap != null && cap > 0 && (
                    <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-surface-2">
                      <div
                        className={clsx(
                          'h-full rounded-full transition-all',
                          pct >= 90 ? 'bg-danger' : pct >= 70 ? 'bg-amber-400' : 'bg-accent',
                        )}
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Recent spend events */}
      <div>
        <h2 className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-text-muted">Recent spend events</h2>
        {recentEvents.length === 0 ? (
          <div className="rounded-card border border-dashed border-line bg-surface/40 p-6 text-center text-[13px] text-text-muted">
            No spend events yet.
          </div>
        ) : (
          <div className="space-y-1">
            {recentEvents.map((event) => (
              <div
                key={event.id}
                className="flex items-center gap-3 rounded-card border border-line/70 bg-surface px-3 py-2"
              >
                <span className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-info" />
                <span className="min-w-0 flex-1 truncate text-[12px] text-text-secondary">
                  {agentName(event.agentId)}
                </span>
                <span className="text-[12px] font-medium text-text-primary">{budgetMoney(event.amountCents)}</span>
                <span className="text-[11px] text-text-muted">
                  {new Date(event.createdAt).toLocaleDateString()}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
