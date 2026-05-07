/**
 * SettingsPage — 4 tabs: Profile / Workspace / Connections / Security.
 *
 * Connections tab consolidates Gateways + Channels (replaces /gateways
 * and /settings/channels). Theme toggle lives here too (and in avatar menu).
 */

import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Save, Plug, Hash, Key, Trash2, Plus, Upload } from 'lucide-react';
import { api } from '../lib/api';
import { useToast } from '../components/shared/Toast';
import { useConfirm } from '../components/shared/ConfirmDialog';
import { Tabs } from '../components/shared/Tabs';
import { Button } from '../components/shared/Button';
import { Skeleton } from '../components/shared/Skeleton';
import { ThemeToggle } from '../components/shared/ThemeToggle';
import { StatusBadge } from '../components/shared/StatusBadge';

type Tab = 'profile' | 'workspace' | 'connections' | 'security';

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
          { value: 'security',    label: 'Security' },
        ]}
        className="px-6"
      />
      <div className="flex-1 overflow-y-auto px-6 py-5">
        {tab === 'profile' && <ProfileTab />}
        {tab === 'workspace' && <WorkspaceTab />}
        {tab === 'connections' && <ConnectionsTab />}
        {tab === 'security' && <SecurityTab />}
      </div>
    </div>
  );
}

function ProfileTab() {
  const toast = useToast();
  const [me, setMe] = useState<{ id: string; email: string; name: string; avatarUrl?: string } | null>(null);
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    void api<{ user: { id: string; email: string; name: string; avatarUrl?: string } }>('/v1/auth/me')
      .then((d) => { setMe(d.user); setName(d.user.name); })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  async function save() {
    if (!me) return;
    setSaving(true);
    try {
      await api('/v1/auth/me', { method: 'PATCH', body: JSON.stringify({ name }) });
      toast.success('Profile updated');
    } catch (e) { toast.error('Failed to update', String(e)); }
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
              value={me?.email ?? ''}
              disabled
              className="h-10 w-full rounded-input border border-line bg-surface-2/50 px-3 text-[14px] text-text-disabled"
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
        body: JSON.stringify({ name, description, ...(imageDataUrl ? { imageDataUrl } : {}) }),
      });
      toast.success('Workspace updated');
      setImageDataUrl(null);
    } catch (e) { toast.error('Failed to update', String(e)); }
    finally { setSaving(false); }
  }

  async function deleteWorkspace() {
    if (!ws) return;
    const ok = await confirm({
      title: `Delete workspace "${ws.name}"?`,
      body: 'This will permanently delete the workspace and all its agents, workflows, apps, and data. This action cannot be undone.',
      confirmLabel: 'Delete workspace',
      tone: 'danger',
      typeToConfirm: ws.name,
    });
    if (!ok) return;
    try {
      await api(`/v1/workspaces/${ws.id}`, { method: 'DELETE' });
      toast.success('Workspace deleted');
      window.location.reload();
    } catch (e) { toast.error('Failed to delete', String(e)); }
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
              <span className="absolute inset-0 hidden items-center justify-center bg-black/60 group-hover:flex">
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
              value={ws.slug}
              disabled
              className="h-10 w-full rounded-input border border-line bg-surface-2/50 px-3 font-mono text-[14px] text-text-disabled"
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
            All agents, workflows, apps, and data inside it will be permanently deleted.
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
    } catch (e) { toast.error('Failed to disconnect', String(e)); }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-[11px] font-semibold uppercase tracking-wider text-text-muted">Connections</h2>
        <Button variant="primary" size="md" iconLeft={<Plus size={14} />}>Add connection</Button>
      </div>

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

  async function refresh() {
    try {
      const data = await api<{ keys: typeof keys }>('/v1/auth/api-keys');
      setKeys(data.keys ?? []);
    } catch { setKeys([]); }
    finally { setLoading(false); }
  }

  useEffect(() => { void refresh(); }, []);

  async function createKey() {
    const name = window.prompt('Name for this API key:');
    if (!name) return;
    try {
      const data = await api<{ key: { id: string; secret: string } }>('/v1/auth/api-keys', {
        method: 'POST',
        body: JSON.stringify({ name }),
      });
      window.alert(`Save this key — it won't be shown again:\n\n${data.key.secret}`);
      void refresh();
    } catch (e) { toast.error('Failed to create key', String(e)); }
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
    } catch (e) { toast.error('Failed to revoke', String(e)); }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-[11px] font-semibold uppercase tracking-wider text-text-muted">API Keys</h2>
        <Button variant="primary" size="md" iconLeft={<Plus size={14} />} onClick={() => void createKey()}>
          New key
        </Button>
      </div>

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
