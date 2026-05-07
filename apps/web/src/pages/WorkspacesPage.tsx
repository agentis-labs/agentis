/**
 * WorkspacesPage — workspace list with image upload + clean creation modal.
 */

import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, Building2, Upload, X, ArrowRight, Settings as SettingsIcon } from 'lucide-react';
import { api, workspace as wsStore } from '../lib/api';
import { useToast } from '../components/shared/Toast';
import { Button } from '../components/shared/Button';
import { Skeleton } from '../components/shared/Skeleton';
import { StatusBadge } from '../components/shared/StatusBadge';
import { EmptyState } from '../components/shared/EmptyState';

interface Workspace {
  id: string;
  name: string;
  slug: string;
  imageUrl?: string | null;
  description?: string;
  agentCount?: number;
  workflowCount?: number;
  appCount?: number;
  createdAt?: string;
}

function relativeTime(iso?: string): string {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    return d.toLocaleString(undefined, { month: 'short', year: 'numeric' });
  } catch { return ''; }
}

export function WorkspacesPage() {
  const nav = useNavigate();
  const toast = useToast();
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const activeId = wsStore.get();

  async function refresh() {
    try {
      const data = await api<{ workspaces: Workspace[] }>('/v1/workspaces');
      setWorkspaces(data.workspaces ?? []);
    } catch { setWorkspaces([]); }
    finally { setLoading(false); }
  }

  useEffect(() => { void refresh(); }, []);

  function handleSwitch(w: Workspace) {
    wsStore.set(w.id);
    toast.success('Switched workspace', w.name);
    nav('/home');
    setTimeout(() => window.location.reload(), 100);
  }

  async function handleImageUpload(w: Workspace, file: File) {
    const reader = new FileReader();
    reader.onload = async (ev) => {
      const dataUrl = ev.target?.result as string;
      try {
        await api(`/v1/workspaces/${w.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ imageDataUrl: dataUrl }),
        });
        toast.success('Image updated', w.name);
        void refresh();
      } catch (e) { toast.error('Failed to upload image', String(e)); }
    };
    reader.readAsDataURL(file);
  }

  if (loading && workspaces.length === 0) {
    return (
      <div className="space-y-4 p-6">
        <Skeleton width={150} height={28} />
        <Skeleton height={120} /><Skeleton height={120} />
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-center gap-3 border-b border-line px-6 py-4">
        <h1 className="text-display text-text-primary">Workspaces</h1>
        <div className="ml-auto">
          <Button variant="primary" size="md" iconLeft={<Plus size={14} />} onClick={() => setCreating(true)}>
            New workspace
          </Button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-5">
        {workspaces.length === 0 ? (
          <EmptyState
            icon={<Building2 size={48} />}
            title="No workspaces yet"
            body="Create a workspace to organize your agents, workflows, and apps."
            primaryAction={<Button variant="primary" size="md" iconLeft={<Plus size={14} />} onClick={() => setCreating(true)}>New workspace</Button>}
            variant="page"
          />
        ) : (
          <div className="space-y-2">
            {workspaces.map((w) => (
              <WorkspaceRow
                key={w.id}
                w={w}
                isActive={w.id === activeId}
                onSwitch={() => handleSwitch(w)}
                onImageUpload={(file) => void handleImageUpload(w, file)}
              />
            ))}
          </div>
        )}
      </div>

      <CreateWorkspaceDialog
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={() => { setCreating(false); void refresh(); }}
      />
    </div>
  );
}

function WorkspaceRow({
  w, isActive, onSwitch, onImageUpload,
}: {
  w: Workspace;
  isActive: boolean;
  onSwitch: () => void;
  onImageUpload: (file: File) => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);

  return (
    <div
      className={`rounded-card border bg-surface p-4 transition-colors ${
        isActive ? 'border-accent-muted bg-accent-soft/30' : 'border-line hover:bg-surface-2'
      } ${dragOver ? '!border-accent' : ''}`}
      onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        const file = e.dataTransfer.files?.[0];
        if (file && file.type.startsWith('image/')) onImageUpload(file);
      }}
    >
      <div className="flex items-center gap-4">
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          className="group relative h-14 w-14 shrink-0 overflow-hidden rounded-card border border-line bg-surface-2"
          aria-label="Change workspace image"
        >
          {w.imageUrl ? (
            <img src={w.imageUrl} alt={w.name} className="h-full w-full object-cover" />
          ) : (
            <span className="flex h-full w-full items-center justify-center text-[20px] font-bold text-text-primary">
              {w.name.charAt(0).toUpperCase()}
            </span>
          )}
          <span className="absolute inset-0 hidden items-center justify-center bg-black/60 group-hover:flex">
            <Upload size={16} className="text-white" />
          </span>
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) onImageUpload(f);
            e.target.value = '';
          }}
          className="hidden"
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-subheading text-text-primary">{w.name}</span>
            {isActive && <StatusBadge status="active" size="sm" />}
          </div>
          <div className="mt-1 flex flex-wrap gap-3 text-[12px] text-text-muted">
            {w.agentCount != null && <span>{w.agentCount} agent{w.agentCount === 1 ? '' : 's'}</span>}
            {w.workflowCount != null && <span>{w.workflowCount} workflow{w.workflowCount === 1 ? '' : 's'}</span>}
            {w.appCount != null && <span>{w.appCount} app{w.appCount === 1 ? '' : 's'}</span>}
            {w.createdAt && <span>Created {relativeTime(w.createdAt)}</span>}
          </div>
        </div>
        <div className="flex shrink-0 gap-1.5">
          <Button variant="ghost" size="sm" iconLeft={<SettingsIcon size={11} />}>Manage</Button>
          {!isActive && (
            <Button variant="primary" size="sm" iconRight={<ArrowRight size={11} />} onClick={onSwitch}>Switch to</Button>
          )}
        </div>
      </div>
    </div>
  );
}

function CreateWorkspaceDialog({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: () => void }) {
  const toast = useToast();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [imageDataUrl, setImageDataUrl] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) { setName(''); setDescription(''); setImageDataUrl(null); }
  }, [open]);

  if (!open) return null;

  function handleImageChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => setImageDataUrl(ev.target?.result as string);
    reader.readAsDataURL(file);
  }

  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'workspace';

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setCreating(true);
    try {
      await api('/v1/workspaces', {
        method: 'POST',
        body: JSON.stringify({
          name: name.trim(),
          slug,
          description: description.trim() || undefined,
          imageDataUrl: imageDataUrl || undefined,
        }),
      });
      toast.success('Workspace created', name.trim());
      onCreated();
    } catch (err) { toast.error('Failed to create workspace', String(err)); }
    finally { setCreating(false); }
  }

  return (
    <div className="animate-fade-in fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4" role="dialog" aria-modal="true">
      <form onSubmit={handleCreate} className="animate-scale-in w-full max-w-md rounded-modal border border-line bg-surface shadow-modal">
        <header className="flex items-center justify-between border-b border-line px-5 py-4">
          <h3 className="text-heading text-text-primary">Create workspace</h3>
          <button type="button" onClick={onClose} aria-label="Close" className="-m-1 rounded-md p-1 text-text-muted hover:bg-surface-2 hover:text-text-primary">
            <X size={16} />
          </button>
        </header>
        <div className="space-y-4 px-5 py-5">
          <div className="flex items-center gap-4">
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              className="group relative h-16 w-16 shrink-0 overflow-hidden rounded-card border-2 border-dashed border-line bg-surface-2 transition-colors hover:border-accent-muted"
              aria-label="Upload image"
            >
              {imageDataUrl ? (
                <img src={imageDataUrl} alt="" className="h-full w-full object-cover" />
              ) : name.trim() ? (
                <span className="flex h-full w-full items-center justify-center text-[20px] font-bold text-text-secondary group-hover:text-text-primary">
                  {name.charAt(0).toUpperCase()}
                </span>
              ) : (
                <span className="flex h-full w-full items-center justify-center text-text-muted group-hover:text-text-primary">
                  <Upload size={16} />
                </span>
              )}
            </button>
            <input
              ref={fileRef}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              onChange={handleImageChange}
              className="hidden"
            />
            <div className="text-[12px] text-text-muted">
              {imageDataUrl ? (
                <button type="button" onClick={() => setImageDataUrl(null)} className="text-text-secondary hover:text-text-primary">Remove image</button>
              ) : 'Upload a logo (optional)'}
            </div>
          </div>

          <div className="space-y-1.5">
            <label className="text-[12px] font-medium text-text-secondary">Name</label>
            <input
              autoFocus
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g., Acme Inc."
              className="h-10 w-full rounded-input border border-line bg-surface-2 px-3 text-[14px] text-text-primary placeholder:text-text-muted focus:border-accent focus:outline-none"
            />
            {name && <div className="text-[11px] text-text-muted">URL slug: <span className="font-mono">{slug}</span></div>}
          </div>

          <div className="space-y-1.5">
            <label className="text-[12px] font-medium text-text-secondary">Description (optional)</label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
              className="w-full resize-none rounded-input border border-line bg-surface-2 px-3 py-2 text-[14px] text-text-primary placeholder:text-text-muted focus:border-accent focus:outline-none"
            />
          </div>
        </div>
        <footer className="flex items-center justify-end gap-2 border-t border-line bg-surface-2 px-5 py-3">
          <button type="button" onClick={onClose} className="inline-flex h-9 items-center rounded-btn border border-line bg-transparent px-3 text-[13px] font-medium text-text-secondary hover:bg-surface-3 hover:text-text-primary">Cancel</button>
          <button
            type="submit"
            disabled={!name.trim() || creating}
            className="inline-flex h-9 items-center rounded-btn bg-accent px-3 text-[13px] font-semibold text-canvas hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
          >
            {creating ? 'Creating…' : 'Create'}
          </button>
        </footer>
      </form>
    </div>
  );
}
