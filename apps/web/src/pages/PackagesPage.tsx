/**
 * PackagesPage — card-based package library.
 *
 * Default tab: "My Library" (owned packages, not templates).
 * Fixed import/export icons. Delete with confirmation + undo toast.
 */

import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  Package as PackageIcon, Plus, ArrowDownToLine, ArrowUpFromLine,
  MoreHorizontal, Trash2, Copy, Edit3, Sparkles, Bot,
  AppWindow, Workflow as WorkflowIcon, SearchX,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { api, workspace as wsStore } from '../lib/api';
import { useToast } from '../components/shared/Toast';
import { useConfirm } from '../components/shared/ConfirmDialog';
import { Tabs } from '../components/shared/Tabs';
import { Button } from '../components/shared/Button';
import { SearchInput } from '../components/shared/SearchInput';
import { Skeleton } from '../components/shared/Skeleton';
import { EmptyState } from '../components/shared/EmptyState';

interface Package {
  id: string;
  name: string;
  slug: string;
  kind: 'app' | 'skill' | 'workflow' | 'agent';
  version?: string;
  description?: string;
  isTemplate?: boolean;
  metadata?: Record<string, unknown>;
}

const TYPE_ICONS: Record<Package['kind'], LucideIcon> = {
  app:      AppWindow,
  skill:    Sparkles,
  workflow: WorkflowIcon,
  agent:    Bot,
};

export function PackagesPage() {
  const nav = useNavigate();
  const toast = useToast();
  const confirm = useConfirm();
  const [searchParams] = useSearchParams();
  const initialTab = (searchParams.get('tab') as 'library' | 'apps' | 'skills' | 'workflows' | 'agents' | 'templates') ?? 'library';
  const [tab, setTab] = useState(initialTab);
  const [packages, setPackages] = useState<Package[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');

  async function refresh() {
    setLoading(true);
    try {
      const data = await api<{ packages: Package[] }>('/v1/packages');
      setPackages(data.packages ?? []);
    } catch { setPackages([]); }
    finally { setLoading(false); }
  }

  useEffect(() => { void refresh(); }, []);

  const filtered = useMemo(() => {
    let list = packages;
    if (tab === 'library') list = list.filter((p) => !p.isTemplate);
    else if (tab === 'templates') list = list.filter((p) => p.isTemplate);
    else if (tab === 'apps') list = list.filter((p) => !p.isTemplate && p.kind === 'app');
    else if (tab === 'skills') list = list.filter((p) => !p.isTemplate && p.kind === 'skill');
    else if (tab === 'workflows') list = list.filter((p) => !p.isTemplate && p.kind === 'workflow');
    else if (tab === 'agents') list = list.filter((p) => !p.isTemplate && p.kind === 'agent');
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter((p) => p.name.toLowerCase().includes(q) || (p.description ?? '').toLowerCase().includes(q));
    }
    return list;
  }, [packages, tab, search]);

  async function handleImport() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,.zip,application/json,application/zip';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      const fd = new FormData();
      fd.append('file', file);
      try {
        await fetch('/v1/packages/import', {
          method: 'POST',
          body: fd,
          headers: {
            authorization: `Bearer ${localStorage.getItem('agentis.access') ?? ''}`,
            'x-agentis-workspace': wsStore.get() ?? '',
          },
        });
        toast.success('Imported', file.name);
        void refresh();
      } catch (e) { toast.error('Import failed', String(e)); }
    };
    input.click();
  }

  async function handleExport(p: Package) {
    try {
      const res = await fetch(`/v1/packages/${p.id}/export`, {
        headers: {
          authorization: `Bearer ${localStorage.getItem('agentis.access') ?? ''}`,
          'x-agentis-workspace': wsStore.get() ?? '',
        },
      });
      if (!res.ok) throw new Error('Export failed');
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${p.slug || p.name}.json`;
      a.click();
      URL.revokeObjectURL(url);
      toast.success('Exported', p.name);
    } catch (e) { toast.error('Export failed', String(e)); }
  }

  async function handleDelete(p: Package) {
    const ok = await confirm({
      title: `Delete ${p.kind} "${p.name}"?`,
      body: 'This action cannot be undone immediately, but you can restore from the toast for 5 seconds.',
      confirmLabel: 'Delete',
      tone: 'danger',
    });
    if (!ok) return;
    try {
      await api(`/v1/packages/${p.id}`, { method: 'DELETE' });
      toast.undo(`Deleted ${p.name}`, async () => {
        try { await api(`/v1/packages/${p.id}/restore`, { method: 'POST' }); toast.success(`Restored ${p.name}`); void refresh(); }
        catch { toast.error('Failed to restore'); }
      });
      void refresh();
    } catch (e) { toast.error('Failed to delete', String(e)); }
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-center gap-3 border-b border-line px-6 py-4">
        <div>
          <h1 className="text-display text-text-primary">Packages</h1>
          <div className="mt-0.5 text-[12px] text-text-muted">Reusable bundles of agents, workflows, and skills</div>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <Button variant="secondary" size="md" iconLeft={<ArrowDownToLine size={14} />} onClick={() => void handleImport()}>
            Import
          </Button>
          <Button variant="primary" size="md" iconLeft={<Plus size={14} />} onClick={() => toast.info('Create new package', 'Coming soon')}>
            New package
          </Button>
        </div>
      </div>

      <Tabs
        value={tab}
        onChange={(v) => setTab(v as typeof tab)}
        tabs={[
          { value: 'library',   label: 'My Library' },
          { value: 'apps',      label: 'Apps' },
          { value: 'skills',    label: 'Skills' },
          { value: 'workflows', label: 'Workflows' },
          { value: 'agents',    label: 'Agents' },
          { value: 'templates', label: 'Templates' },
        ]}
        className="px-6"
      />

      <div className="flex flex-wrap items-center gap-3 border-b border-line px-6 py-3">
        <div className="ml-auto w-full sm:w-72">
          <SearchInput value={search} onChange={setSearch} placeholder="Search packages…" bindSlashShortcut />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-5">
        {loading && filtered.length === 0 ? (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <Skeleton height={140} /><Skeleton height={140} /><Skeleton height={140} />
          </div>
        ) : filtered.length === 0 ? (
          packages.length === 0 ? (
            <EmptyState
              icon={<PackageIcon size={48} />}
              title="Your library is empty"
              body="Save agents, workflows, or skills as reusable packages to share or deploy."
              primaryAction={<Button variant="secondary" size="md" iconLeft={<ArrowDownToLine size={14} />} onClick={() => void handleImport()}>Import</Button>}
              variant="page"
            />
          ) : (
            <EmptyState
              icon={<SearchX size={48} />}
              title="No matching packages"
              body="Try adjusting your search or category."
              primaryAction={<Button variant="secondary" size="sm" onClick={() => setSearch('')}>Clear search</Button>}
              variant="page"
            />
          )
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {filtered.map((p) => (
              <PackageCard
                key={p.id}
                p={p}
                onExport={() => void handleExport(p)}
                onDelete={() => void handleDelete(p)}
                onOpen={() => toast.info('Open package', p.name)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function PackageCard({ p, onExport, onDelete, onOpen }: {
  p: Package;
  onExport: () => void;
  onDelete: () => void;
  onOpen: () => void;
}) {
  const Icon = TYPE_ICONS[p.kind];
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <div className="group rounded-card border border-line bg-surface p-4 transition-colors hover:border-line-strong hover:bg-surface-2">
      <div className="flex items-start gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-card bg-surface-2 text-text-secondary">
          <Icon size={16} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-subheading text-text-primary">{p.name}</div>
          <div className="mt-0.5 text-[11px] capitalize text-text-muted">
            {p.kind}{p.version ? ` · v${p.version}` : ''}{p.isTemplate ? ' · template' : ''}
          </div>
          {p.description && <div className="mt-2 line-clamp-2 text-[12px] text-text-secondary">{p.description}</div>}
        </div>
        <div className="relative">
          <button
            type="button"
            onClick={() => setMenuOpen((v) => !v)}
            aria-label="Actions"
            className="-m-1 rounded-md p-1 text-text-muted hover:bg-surface-3 hover:text-text-primary"
          >
            <MoreHorizontal size={14} />
          </button>
          {menuOpen && (
            <div
              onMouseLeave={() => setMenuOpen(false)}
              className="absolute right-0 z-10 mt-1 w-44 rounded-card border border-line bg-surface shadow-dropdown"
            >
              <MenuItem icon={<Edit3 size={12} />} onClick={() => { setMenuOpen(false); onOpen(); }}>Open</MenuItem>
              <MenuItem icon={<Copy size={12} />} onClick={() => setMenuOpen(false)}>Duplicate</MenuItem>
              <MenuItem icon={<ArrowUpFromLine size={12} />} onClick={() => { setMenuOpen(false); onExport(); }}>Export</MenuItem>
              <div className="my-1 border-t border-line" />
              <MenuItem icon={<Trash2 size={12} />} danger onClick={() => { setMenuOpen(false); onDelete(); }}>Delete</MenuItem>
            </div>
          )}
        </div>
      </div>
      <div className="mt-3 flex gap-1.5">
        <Button variant="secondary" size="sm" onClick={onOpen}>Open</Button>
        <Button variant="ghost" size="sm" iconLeft={<ArrowUpFromLine size={11} />} onClick={onExport}>Export</Button>
      </div>
    </div>
  );
}

function MenuItem({ icon, danger, onClick, children }: {
  icon?: React.ReactNode; danger?: boolean; onClick: () => void; children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex w-full items-center gap-2 px-3 py-2 text-left text-[13px] transition-colors hover:bg-surface-2 ${
        danger ? 'text-danger hover:text-danger' : 'text-text-secondary hover:text-text-primary'
      }`}
    >
      {icon}
      {children}
    </button>
  );
}
