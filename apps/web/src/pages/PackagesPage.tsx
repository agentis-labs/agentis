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
  AppWindow, Workflow as WorkflowIcon, SearchX, X, Check, ChevronRight, ArrowLeft, FolderTree,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { api } from '../lib/api';
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
  kind: 'app' | 'skill' | 'workflow' | 'agent' | 'integration';
  version?: string;
  description?: string;
  isTemplate?: boolean;
  metadata?: Record<string, unknown>;
}

interface WorkflowItem { id: string; title: string; status?: string; }
interface AgentItem { id: string; name: string; status: string; adapterType: string; }
interface SkillItem { id: string; name: string; slug: string; version: string; runtime: string; }
interface WorkflowCollection { name: string; count: number; }

type PackageTab = 'all' | 'apps' | 'workflows' | 'agents' | 'skills' | 'collections';

interface PackageDetail {
  package: {
    id: string;
    name: string;
    version: string;
    slug: string;
    kind: Package['kind'];
    description: string;
    installedAt: string;
    manifest: unknown;
  };
  workflows: { id: string; title: string }[];
  agents: { id: string; name: string; status: string; adapterType: string }[];
  skills: { id: string; name: string; slug: string; version: string; runtime: string }[];
}

const TYPE_ICONS: Record<Package['kind'], LucideIcon> = {
  app:      AppWindow,
  skill:    Sparkles,
  workflow: WorkflowIcon,
  agent:    Bot,
  integration: PackageIcon,
};

export function PackagesPage() {
  const nav = useNavigate();
  const toast = useToast();
  const confirm = useConfirm();
  const [searchParams] = useSearchParams();
  const initialTab = (searchParams.get('tab') as PackageTab) ?? 'all';
  const [tab, setTab] = useState(initialTab);
  const [packages, setPackages] = useState<Package[]>([]);
  const [collections, setCollections] = useState<WorkflowCollection[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [creating, setCreating] = useState(false);
  const [openPkg, setOpenPkg] = useState<Package | null>(null);

  async function refresh() {
    setLoading(true);
    try {
      const [packageRes, collectionRes] = await Promise.allSettled([
        api<{ packages: Package[] }>('/v1/packages'),
        api<{ collections: WorkflowCollection[] }>('/v1/workflows/collections'),
      ]);
      setPackages(packageRes.status === 'fulfilled' ? packageRes.value.packages ?? [] : []);
      setCollections(collectionRes.status === 'fulfilled' ? collectionRes.value.collections ?? [] : []);
    } catch { setPackages([]); setCollections([]); }
    finally { setLoading(false); }
  }

  useEffect(() => { void refresh(); }, []);

  const filtered = useMemo(() => {
    // 10.12: "Yours" library is the single source of truth — always exclude
    // templates. Type tabs filter by package kind.
    let list = packages.filter((p) => !p.isTemplate);
    if (tab === 'apps') list = list.filter((p) => p.kind === 'app');
    else if (tab === 'skills') list = list.filter((p) => p.kind === 'skill');
    else if (tab === 'workflows') list = list.filter((p) => p.kind === 'workflow');
    else if (tab === 'agents') list = list.filter((p) => p.kind === 'agent');
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter((p) => p.name.toLowerCase().includes(q) || (p.description ?? '').toLowerCase().includes(q));
    }
    return list;
  }, [packages, tab, search]);

  const filteredCollections = useMemo(() => {
    if (tab !== 'collections') return [];
    const q = search.trim().toLowerCase();
    return q ? collections.filter((collection) => collection.name.toLowerCase().includes(q)) : collections;
  }, [collections, search, tab]);

  async function handleImport() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.agentis,.json,application/json';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        const text = await file.text();
        const json = JSON.parse(text) as Record<string, unknown>;
        if ('contents' in json && 'checksum' in json) {
          // PackageManifest format (exported from libraryPackages via our export)
          await api('/v1/packages/import', {
            method: 'POST',
            body: JSON.stringify({ manifest: json }),
          });
        } else if (json['manifestVersion'] === 1) {
          await api('/v1/packages/install-local', {
            method: 'POST',
            body: JSON.stringify({ manifest: json, permissionsAcknowledged: true }),
          });
        } else if (typeof json['name'] === 'string') {
          const src = (json['sourceIds'] as { workflowIds?: string[]; agentIds?: string[]; skillIds?: string[] } | undefined) ?? {};
          await api('/v1/packages', {
            method: 'POST',
            body: JSON.stringify({
              name: json['name'],
              version: (json['version'] as string | undefined) ?? '1.0.0',
              kind: (json['kind'] as string | undefined) ?? 'workflow',
              description: (json['description'] as string | undefined) ?? '',
              workflowIds: src.workflowIds ?? [],
              agentIds: src.agentIds ?? [],
              skillIds: src.skillIds ?? [],
            }),
          });
        } else {
          toast.error('Import failed', 'Unrecognized file format');
          return;
        }
        toast.success('Imported', file.name);
        void refresh();
      } catch (err: unknown) {
        const e = err as { message?: string };
        toast.error('Import failed', e.message ?? String(err));
      }
    };
    input.click();
  }

  async function handleExport(p: Package) {
    try {
      const detail = await api<PackageDetail>(`/v1/packages/${p.id}`);
      const blob = new Blob(
        [JSON.stringify(detail.package.manifest, null, 2)],
        { type: 'application/json' },
      );
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${p.slug || p.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.agentis`;
      a.click();
      URL.revokeObjectURL(url);
      toast.success('Exported', p.name);
    } catch (err: unknown) {
      const e = err as { message?: string };
      toast.error('Export failed', e.message ?? 'Unknown error');
    }
  }

  async function handleDelete(p: Package) {
    const ok = await confirm({
      title: `Delete "${p.name}"?`,
      body: 'You can undo this for 5 seconds.',
      confirmLabel: 'Delete',
      tone: 'danger',
    });
    if (!ok) return;
    // Snapshot before deleting so undo can re-create.
    let snapshot: { name: string; version: string; kind: Package['kind']; description: string; workflowIds: string[]; agentIds: string[]; skillIds: string[] } | null = null;
    let manifestSnapshot: unknown = null;
    let isLibraryPkg = false;
    try {
      const detail = await api<PackageDetail>(`/v1/packages/${p.id}`);
      const mfst = detail.package.manifest as Record<string, unknown>;
      isLibraryPkg = 'contents' in mfst && 'checksum' in mfst;
      if (isLibraryPkg) {
        manifestSnapshot = mfst;
      } else {
        const src = (mfst['sourceIds'] as { workflowIds?: string[]; agentIds?: string[]; skillIds?: string[] } | undefined) ?? {};
        snapshot = { name: p.name, version: p.version ?? '1.0.0', kind: p.kind, description: p.description ?? '', workflowIds: src.workflowIds ?? [], agentIds: src.agentIds ?? [], skillIds: src.skillIds ?? [] };
      }
    } catch { /* proceed without snapshot */ }
    try {
      await api(`/v1/packages/${p.id}`, { method: 'DELETE' });
      toast.undo(`Deleted "${p.name}"`, async () => {
        if (!snapshot && !manifestSnapshot) return;
        try {
          if (isLibraryPkg && manifestSnapshot) {
            await api('/v1/packages/import', { method: 'POST', body: JSON.stringify({ manifest: manifestSnapshot }) });
          } else if (snapshot) {
            await api('/v1/packages', { method: 'POST', body: JSON.stringify(snapshot) });
          }
          toast.success('Restored', p.name);
          void refresh();
        } catch { toast.error('Could not restore', p.name); }
      });
      void refresh();
    } catch (err: unknown) {
      const e = err as { message?: string };
      toast.error('Failed to delete', e.message ?? 'Unknown error');
    }
  }

  async function handleDuplicate(p: Package) {
    try {
      await api(`/v1/packages/${p.id}/duplicate`, { method: 'POST' });
      toast.success('Duplicated', `Copy of ${p.name}`);
      void refresh();
    } catch (err: unknown) {
      const e = err as { message?: string };
      toast.error('Duplicate failed', e.message ?? 'Unknown error');
    }
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-center gap-3 border-b border-line px-6 py-4">
        <div>
          <h1 className="text-display text-text-primary">Packages</h1>
          <div className="mt-0.5 text-[12px] text-text-muted">Everything you've built - apps, workflows, agents, and skills</div>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <Button variant="secondary" size="md" iconLeft={<ArrowDownToLine size={14} />} onClick={() => void handleImport()}>
            Import
          </Button>
          <Button variant="primary" size="md" iconLeft={<Plus size={14} />} onClick={() => setCreating(true)}>
            New package
          </Button>
        </div>
      </div>

      <Tabs
        value={tab}
        onChange={(v) => setTab(v as typeof tab)}
        tabs={[
          { value: 'all',       label: 'All' },
          { value: 'apps',      label: 'Apps' },
          { value: 'workflows', label: 'Workflows' },
          { value: 'agents',    label: 'Agents' },
          { value: 'skills',    label: 'Skills' },
          { value: 'collections', label: 'Collections' },
        ]}
        className="px-6"
      />

      <div className="flex flex-wrap items-center gap-3 border-b border-line px-6 py-3">
        <div className="ml-auto w-full sm:w-72">
          <SearchInput value={search} onChange={setSearch} placeholder="Search packages…" bindSlashShortcut />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-5">
        {loading && filtered.length === 0 && filteredCollections.length === 0 ? (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <Skeleton height={140} /><Skeleton height={140} /><Skeleton height={140} />
          </div>
        ) : tab === 'collections' ? (
          filteredCollections.length === 0 ? (
            collections.length === 0 ? (
              <EmptyState
                icon={<FolderTree size={48} />}
                title="No collections yet"
                body="Assign workflows to collections from the Workflows page."
                primaryAction={<Button variant="secondary" size="md" iconLeft={<WorkflowIcon size={14} />} onClick={() => nav('/workflows')}>Open workflows</Button>}
                variant="page"
              />
            ) : (
              <EmptyState
                icon={<SearchX size={48} />}
                title="No matching collections"
                body="Try adjusting your search."
                primaryAction={<Button variant="secondary" size="sm" onClick={() => setSearch('')}>Clear search</Button>}
                variant="page"
              />
            )
          ) : (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {filteredCollections.map((collection) => (
                <CollectionCard
                  key={collection.name}
                  collection={collection}
                  onOpen={() => nav(`/workflows?collection=${encodeURIComponent(collection.name)}`)}
                />
              ))}
            </div>
          )
        ) : filtered.length === 0 ? (
          packages.length === 0 ? (
            <EmptyState
              icon={<PackageIcon size={48} />}
              title="Your library is empty"
              body="Save apps, workflows, agents, or skills as reusable packages."
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
                onOpen={() => setOpenPkg(p)}
                onDuplicate={() => void handleDuplicate(p)}
              />
            ))}
          </div>
        )}
      </div>

      <NewPackageDialog
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={() => { setCreating(false); void refresh(); }}
      />
      {openPkg && (
        <PackageDetailDrawer
          pkg={openPkg}
          onClose={() => setOpenPkg(null)}
          onDeleted={() => { void refresh(); }}
          onDuplicated={() => { void refresh(); }}
        />
      )}
    </div>
  );
}

// ── helpers ──────────────────────────────────────────────────────────────────

function toggle<T>(set: Set<T>, id: T): Set<T> {
  const next = new Set(set);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

function ResourceSection({
  title, items, selected, onToggle, search, onSearch, loading, icon,
}: {
  title: string;
  items: { id: string; primary: string; secondary: string }[];
  selected: Set<string>;
  onToggle: (id: string) => void;
  search: string;
  onSearch: (v: string) => void;
  loading: boolean;
  icon: React.ReactNode;
}) {
  return (
    <div>
      <div className="mb-2 flex items-center gap-1.5 text-[12px] font-medium text-text-secondary">
        {icon}
        {title}
        {selected.size > 0 && (
          <span className="ml-1 rounded-full bg-accent-soft px-1.5 text-[10px] font-semibold text-accent">
            {selected.size}
          </span>
        )}
      </div>
      <input
        type="text"
        value={search}
        onChange={(e) => onSearch(e.target.value)}
        placeholder={`Search ${title.toLowerCase()}…`}
        className="mb-2 h-8 w-full rounded-input border border-line bg-surface-2 px-3 text-[13px] text-text-primary placeholder:text-text-muted focus:border-accent focus:outline-none"
      />
      <div className="overflow-y-auto rounded-card border border-line" style={{ maxHeight: '176px' }}>
        {loading ? (
          <div className="px-3 py-5 text-center text-[12px] text-text-muted">Loading…</div>
        ) : items.length === 0 ? (
          <div className="px-3 py-5 text-center text-[12px] text-text-muted">
            {search ? 'No matches' : `No ${title.toLowerCase()} yet`}
          </div>
        ) : (
          items.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => onToggle(item.id)}
              className={`flex w-full items-center gap-3 border-b border-line px-3 py-2.5 text-left last:border-b-0 transition-colors hover:bg-surface-3 ${
                selected.has(item.id) ? 'bg-surface-2' : 'bg-surface'
              }`}
            >
              <span
                className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border transition-colors ${
                  selected.has(item.id)
                    ? 'border-accent bg-accent text-canvas'
                    : 'border-line bg-surface'
                }`}
              >
                {selected.has(item.id) && <Check size={10} />}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] text-text-primary">{item.primary}</span>
                <span className="block text-[11px] capitalize text-text-muted">{item.secondary}</span>
              </span>
            </button>
          ))
        )}
      </div>
    </div>
  );
}

// ── dialog ───────────────────────────────────────────────────────────────────

const KIND_CONFIG = [
  { value: 'workflow' as const, label: 'Workflow', icon: WorkflowIcon },
  { value: 'agent'    as const, label: 'Agent',    icon: Bot },
  { value: 'skill'    as const, label: 'Skill',    icon: Sparkles },
  { value: 'app'      as const, label: 'App',      icon: AppWindow },
];

function NewPackageDialog({
  open, onClose, onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
}) {
  const toast = useToast();
  const [step, setStep] = useState<'pick' | 'details'>('pick');
  const [kind, setKind] = useState<Package['kind']>('workflow');

  const [workflows, setWorkflows] = useState<WorkflowItem[]>([]);
  const [agents, setAgents] = useState<AgentItem[]>([]);
  const [skills, setSkills] = useState<SkillItem[]>([]);
  const [loadingRes, setLoadingRes] = useState(false);

  const [selWorkflows, setSelWorkflows] = useState<Set<string>>(new Set());
  const [selAgents, setSelAgents] = useState<Set<string>>(new Set());
  const [selSkills, setSelSkills] = useState<Set<string>>(new Set());

  const [wSearch, setWSearch] = useState('');
  const [aSearch, setASearch] = useState('');
  const [sSearch, setSSearch] = useState('');

  const [name, setName] = useState('');
  const [version, setVersion] = useState('1.0.0');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setStep('pick');
    setKind('workflow');
    setSelWorkflows(new Set()); setSelAgents(new Set()); setSelSkills(new Set());
    setWSearch(''); setASearch(''); setSSearch('');
    setName(''); setVersion('1.0.0'); setDescription('');
    setLoadingRes(true);
    void Promise.all([
      api<{ workflows: WorkflowItem[] }>('/v1/workflows').then((d) => d.workflows ?? []).catch((): WorkflowItem[] => []),
      api<{ agents: AgentItem[] }>('/v1/agents').then((d) => d.agents ?? []).catch((): AgentItem[] => []),
      api<{ skills: SkillItem[] }>('/v1/skills').then((d) => d.skills ?? []).catch((): SkillItem[] => []),
    ]).then(([wf, ag, sk]) => {
      setWorkflows(wf);
      setAgents(ag);
      setSkills(sk);
    }).finally(() => setLoadingRes(false));
  }, [open]);

  const showWorkflows = kind === 'workflow' || kind === 'app';
  const showAgents    = kind === 'agent'    || kind === 'app';
  const showSkills    = kind === 'skill'    || kind === 'app';

  const canAdvance =
    (kind === 'workflow' && selWorkflows.size > 0) ||
    (kind === 'agent'    && selAgents.size > 0)    ||
    (kind === 'skill'    && selSkills.size > 0)    ||
    (kind === 'app' && (selWorkflows.size > 0 || selAgents.size > 0 || selSkills.size > 0));

  const totalSelected = selWorkflows.size + selAgents.size + selSkills.size;

  function goToDetails() {
    let suggestion = '';
    if (kind === 'workflow' && selWorkflows.size > 0) {
      const titles = workflows.filter((w) => selWorkflows.has(w.id)).map((w) => w.title);
      suggestion = titles.length === 1 ? (titles[0] ?? '') : `${titles[0] ?? ''} + ${titles.length - 1} more`;
    } else if (kind === 'agent' && selAgents.size > 0) {
      const names = agents.filter((a) => selAgents.has(a.id)).map((a) => a.name);
      suggestion = names.length === 1 ? (names[0] ?? '') : `${names[0] ?? ''} + ${names.length - 1} more`;
    } else if (kind === 'skill' && selSkills.size > 0) {
      const names = skills.filter((s) => selSkills.has(s.id)).map((s) => s.name);
      suggestion = names.length === 1 ? (names[0] ?? '') : `${names[0] ?? ''} + ${names.length - 1} more`;
    }
    setName(suggestion);
    setStep('details');
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || busy) return;
    setBusy(true);
    try {
      await api('/v1/packages', {
        method: 'POST',
        body: JSON.stringify({
          name: name.trim(),
          version: version.trim() || '1.0.0',
          kind,
          description: description.trim() || undefined,
          workflowIds: [...selWorkflows],
          agentIds: [...selAgents],
          skillIds: [...selSkills],
        }),
      });
      toast.success('Package created', name.trim());
      onCreated();
    } catch (err: unknown) {
      const e = err as { message?: string };
      toast.error('Failed to create package', e.message ?? 'Unknown error');
    } finally {
      setBusy(false);
    }
  }

  if (!open) return null;

  const filteredWorkflows = workflows.filter((w) => w.title.toLowerCase().includes(wSearch.toLowerCase()));
  const filteredAgents    = agents.filter((a) => a.name.toLowerCase().includes(aSearch.toLowerCase()));
  const filteredSkills    = skills.filter((s) => s.name.toLowerCase().includes(sSearch.toLowerCase()));

  return (
    <div
      className="animate-fade-in fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4"
      role="dialog"
      aria-modal="true"
    >
      {step === 'pick' ? (
        /* ── Step 1: pick type + resources ─────────────────────── */
        <div className="animate-scale-in flex w-full max-w-lg flex-col rounded-modal border border-line bg-surface shadow-modal">
          <header className="flex items-center justify-between border-b border-line px-5 py-4">
            <h3 className="text-heading text-text-primary">New package</h3>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="-m-1 rounded-md p-1 text-text-muted hover:bg-surface-2 hover:text-text-primary"
            >
              <X size={16} />
            </button>
          </header>

          <div
            className="space-y-5 overflow-y-auto px-5 py-5"
            style={{ maxHeight: 'calc(100dvh - 180px)' }}
          >
            {/* Type selector */}
            <div>
              <div className="mb-2 text-[12px] font-medium text-text-secondary">Package type</div>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                {KIND_CONFIG.map(({ value, label, icon: Icon }) => (
                  <button
                    key={value}
                    type="button"
                    onClick={() => {
                      setKind(value);
                      setSelWorkflows(new Set());
                      setSelAgents(new Set());
                      setSelSkills(new Set());
                    }}
                    className={`flex flex-col items-center gap-1.5 rounded-card border px-2 py-3 text-[12px] font-medium transition-colors ${
                      kind === value
                        ? 'border-accent bg-accent-soft text-accent'
                        : 'border-line bg-surface-2 text-text-secondary hover:border-line-strong hover:text-text-primary'
                    }`}
                  >
                    <Icon size={16} />
                    {label}
                  </button>
                ))}
              </div>
            </div>

            {showWorkflows && (
              <ResourceSection
                title="Workflows"
                items={filteredWorkflows.map((w) => ({ id: w.id, primary: w.title, secondary: w.status ?? 'draft' }))}
                selected={selWorkflows}
                onToggle={(id) => setSelWorkflows((s) => toggle(s, id))}
                search={wSearch}
                onSearch={setWSearch}
                loading={loadingRes}
                icon={<WorkflowIcon size={12} />}
              />
            )}
            {showAgents && (
              <ResourceSection
                title="Agents"
                items={filteredAgents.map((a) => ({ id: a.id, primary: a.name, secondary: a.adapterType }))}
                selected={selAgents}
                onToggle={(id) => setSelAgents((s) => toggle(s, id))}
                search={aSearch}
                onSearch={setASearch}
                loading={loadingRes}
                icon={<Bot size={12} />}
              />
            )}
            {showSkills && (
              <ResourceSection
                title="Skills"
                items={filteredSkills.map((s) => ({ id: s.id, primary: s.name, secondary: `${s.runtime} · v${s.version}` }))}
                selected={selSkills}
                onToggle={(id) => setSelSkills((s) => toggle(s, id))}
                search={sSearch}
                onSearch={setSSearch}
                loading={loadingRes}
                icon={<Sparkles size={12} />}
              />
            )}
          </div>

          <footer className="flex items-center justify-between border-t border-line bg-surface-2 px-5 py-3">
            <button
              type="button"
              onClick={onClose}
              className="inline-flex h-9 items-center rounded-btn border border-line bg-transparent px-3 text-[13px] font-medium text-text-secondary hover:bg-surface-3 hover:text-text-primary"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={!canAdvance}
              onClick={goToDetails}
              className="inline-flex h-9 items-center gap-1.5 rounded-btn bg-accent px-3 text-[13px] font-semibold text-canvas hover:bg-accent-hover disabled:opacity-50"
            >
              Next
              <ChevronRight size={13} />
            </button>
          </footer>
        </div>
      ) : (
        /* ── Step 2: name + details ─────────────────────────────── */
        <form
          onSubmit={submit}
          className="animate-scale-in w-full max-w-md rounded-modal border border-line bg-surface shadow-modal"
        >
          <header className="flex items-center gap-2 border-b border-line px-5 py-4">
            <button
              type="button"
              onClick={() => setStep('pick')}
              aria-label="Back"
              className="-ml-1 rounded-md p-1 text-text-muted hover:bg-surface-2 hover:text-text-primary"
            >
              <ArrowLeft size={15} />
            </button>
            <h3 className="text-heading text-text-primary">Name your package</h3>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="-m-1 ml-auto rounded-md p-1 text-text-muted hover:bg-surface-2 hover:text-text-primary"
            >
              <X size={16} />
            </button>
          </header>

          <div className="space-y-4 px-5 py-5">
            <label className="block">
              <span className="mb-1.5 block text-[12px] font-medium text-text-secondary">Name</span>
              <input
                autoFocus
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g., Lead enrichment kit"
                className="h-10 w-full rounded-input border border-line bg-surface-2 px-3 text-[14px] text-text-primary placeholder:text-text-muted focus:border-accent focus:outline-none"
              />
            </label>

            <label className="block">
              <span className="mb-1.5 block text-[12px] font-medium text-text-secondary">Version</span>
              <input
                type="text"
                value={version}
                onChange={(e) => setVersion(e.target.value)}
                placeholder="1.0.0"
                className="h-10 w-48 rounded-input border border-line bg-surface-2 px-3 font-mono text-[13px] text-text-primary placeholder:text-text-muted focus:border-accent focus:outline-none"
              />
            </label>

            <label className="block">
              <span className="mb-1.5 block text-[12px] font-medium text-text-secondary">Description (optional)</span>
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={2}
                placeholder="What does this package do?"
                className="w-full resize-none rounded-input border border-line bg-surface-2 px-3 py-2.5 text-[14px] text-text-primary placeholder:text-text-muted focus:border-accent focus:outline-none"
              />
            </label>

            {totalSelected > 0 && (
              <div className="rounded-card border border-line bg-surface-2 px-4 py-3">
                <div className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-text-muted">Includes</div>
                <div className="space-y-1.5">
                  {selWorkflows.size > 0 && (
                    <div className="flex items-center gap-2 text-[12px] text-text-secondary">
                      <WorkflowIcon size={11} className="text-text-muted" />
                      {selWorkflows.size} workflow{selWorkflows.size > 1 ? 's' : ''}
                    </div>
                  )}
                  {selAgents.size > 0 && (
                    <div className="flex items-center gap-2 text-[12px] text-text-secondary">
                      <Bot size={11} className="text-text-muted" />
                      {selAgents.size} agent{selAgents.size > 1 ? 's' : ''}
                    </div>
                  )}
                  {selSkills.size > 0 && (
                    <div className="flex items-center gap-2 text-[12px] text-text-secondary">
                      <Sparkles size={11} className="text-text-muted" />
                      {selSkills.size} skill{selSkills.size > 1 ? 's' : ''}
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>

          <footer className="flex items-center justify-end gap-2 border-t border-line bg-surface-2 px-5 py-3">
            <button
              type="button"
              onClick={onClose}
              className="inline-flex h-9 items-center rounded-btn border border-line bg-transparent px-3 text-[13px] font-medium text-text-secondary hover:bg-surface-3 hover:text-text-primary"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!name.trim() || busy}
              className="inline-flex h-9 items-center rounded-btn bg-accent px-3 text-[13px] font-semibold text-canvas hover:bg-accent-hover disabled:opacity-60"
            >
              {busy ? 'Creating…' : 'Create package'}
            </button>
          </footer>
        </form>
      )}
    </div>
  );
}

function PackageCard({ p, onExport, onDelete, onOpen, onDuplicate }: {
  p: Package;
  onExport: () => void;
  onDelete: () => void;
  onOpen: () => void;
  onDuplicate: () => void;
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
              <MenuItem icon={<Copy size={12} />} onClick={() => { setMenuOpen(false); onDuplicate(); }}>Duplicate</MenuItem>
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

function CollectionCard({ collection, onOpen }: { collection: WorkflowCollection; onOpen: () => void }) {
  return (
    <div className="group rounded-card border border-line bg-surface p-4 transition-colors hover:border-line-strong hover:bg-surface-2">
      <div className="flex items-start gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-card bg-surface-2 text-text-secondary">
          <FolderTree size={16} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-subheading text-text-primary">{collection.name}</div>
          <div className="mt-0.5 text-[11px] text-text-muted">
            {collection.count} workflow{collection.count === 1 ? '' : 's'}
          </div>
          <div className="mt-2 line-clamp-2 text-[12px] text-text-secondary">
            Drop this collection onto an app canvas to connect its workflows as a group.
          </div>
        </div>
      </div>
      <div className="mt-3 flex gap-1.5">
        <Button variant="secondary" size="sm" onClick={onOpen}>Open workflows</Button>
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

// ── PackageDetailDrawer ───────────────────────────────────────────────────────

function PackageDetailDrawer({
  pkg, onClose, onDeleted, onDuplicated,
}: {
  pkg: Package;
  onClose: () => void;
  onDeleted: () => void;
  onDuplicated: () => void;
}) {
  const nav = useNavigate();
  const toast = useToast();
  const confirm = useConfirm();
  const [detail, setDetail] = useState<PackageDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [duplicating, setDuplicating] = useState(false);
  const [launching, setLaunching] = useState(false);

  useEffect(() => {
    setLoading(true);
    setDetail(null);
    void api<PackageDetail>(`/v1/packages/${pkg.id}`)
      .then(setDetail)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [pkg.id]);

  async function drawerExport() {
    if (!detail) return;
    const blob = new Blob([JSON.stringify(detail.package.manifest, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${detail.package.slug}.agentis`;
    a.click();
    URL.revokeObjectURL(url);
    toast.success('Exported', detail.package.name);
  }

  async function drawerDuplicate() {
    if (!detail || duplicating) return;
    setDuplicating(true);
    try {
      await api(`/v1/packages/${pkg.id}/duplicate`, { method: 'POST' });
      toast.success('Duplicated', `Copy of ${detail.package.name}`);
      onDuplicated();
      onClose();
    } catch (err: unknown) {
      const e = err as { message?: string };
      toast.error('Duplicate failed', e.message ?? 'Unknown error');
    } finally {
      setDuplicating(false);
    }
  }

  async function drawerLaunch() {
    if (!detail || launching) return;
    setLaunching(true);
    try {
      await api(`/v1/apps/activate/${pkg.id}`, { method: 'POST' });
      toast.success('App launched!', detail.package.name);
      onClose();
      nav('/apps');
    } catch (err: unknown) {
      const e = err as { message?: string };
      toast.error('Launch failed', e.message ?? 'Unknown error');
    } finally {
      setLaunching(false);
    }
  }

  async function drawerDelete() {
    const ok = await confirm({
      title: `Delete "${pkg.name}"?`,
      body: 'You can undo this for 5 seconds.',
      confirmLabel: 'Delete',
      tone: 'danger',
    });
    if (!ok) return;
    const mfst = detail ? (detail.package.manifest as Record<string, unknown>) : null;
    const isLibraryPkg = mfst && 'contents' in mfst && 'checksum' in mfst;
    const src = mfst && !isLibraryPkg
      ? (mfst['sourceIds'] as { workflowIds?: string[]; agentIds?: string[]; skillIds?: string[] } | undefined) ?? {}
      : {};
    const snapshot = detail && !isLibraryPkg
      ? { name: detail.package.name, version: detail.package.version, kind: detail.package.kind, description: detail.package.description, workflowIds: src.workflowIds ?? [], agentIds: src.agentIds ?? [], skillIds: src.skillIds ?? [] }
      : null;
    try {
      await api(`/v1/packages/${pkg.id}`, { method: 'DELETE' });
      onClose();
      onDeleted();
      toast.undo(`Deleted "${pkg.name}"`, async () => {
        try {
          if (isLibraryPkg && mfst) {
            await api('/v1/packages/import', { method: 'POST', body: JSON.stringify({ manifest: mfst }) });
          } else if (snapshot) {
            await api('/v1/packages', { method: 'POST', body: JSON.stringify(snapshot) });
          }
          toast.success('Restored', pkg.name);
          onDeleted();
        } catch { toast.error('Could not restore', pkg.name); }
      });
    } catch (err: unknown) {
      const e = err as { message?: string };
      toast.error('Delete failed', e.message ?? 'Unknown error');
    }
  }

  const Icon = TYPE_ICONS[pkg.kind];
  const totalItems = (detail?.workflows.length ?? 0)
    + (detail?.agents.length ?? 0)
    + (detail?.skills.length ?? 0);

  return (
    <>
      {/* Backdrop */}
      <div className="fixed inset-0 z-[55] bg-black/40" onClick={onClose} />
      {/* Panel */}
      <div className="animate-slide-in-right fixed inset-y-0 right-0 z-[56] flex w-full max-w-md flex-col border-l border-line bg-surface shadow-modal">
        {/* Header */}
        <div className="flex items-start gap-3 border-b border-line px-5 py-4">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-card bg-surface-2 text-text-secondary">
            <Icon size={18} />
          </span>
          <div className="min-w-0 flex-1">
            <div className="text-heading text-text-primary">{pkg.name}</div>
            <div className="mt-0.5 text-[11px] capitalize text-text-muted">
              {pkg.kind}{pkg.version ? ` · v${pkg.version}` : ''}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="-m-1 rounded-md p-1 text-text-muted hover:bg-surface-2 hover:text-text-primary"
          >
            <X size={16} />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-5 py-4">
          {loading ? (
            <div className="space-y-3">
              <Skeleton height={20} /><Skeleton height={80} /><Skeleton height={80} />
            </div>
          ) : (
            <div className="space-y-5">
              {pkg.description && (
                <p className="text-[13px] text-text-secondary">{pkg.description}</p>
              )}

              {(detail?.workflows.length ?? 0) > 0 && (
                <section>
                  <div className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-text-muted">
                    <WorkflowIcon size={10} /> Workflows
                  </div>
                  <div className="space-y-1">
                    {detail!.workflows.map((w) => (
                      <div key={w.id} className="flex items-center justify-between rounded-card border border-line bg-surface-2 px-3 py-2.5">
                        <span className="text-[13px] text-text-primary">{w.title}</span>
                        {w.id && !w.id.startsWith('pkg:') && (
                          <button
                            type="button"
                            onClick={() => { onClose(); nav(`/workflows/${w.id}`); }}
                            className="text-[11px] font-medium text-accent hover:underline"
                          >
                            Open canvas →
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                </section>
              )}

              {(detail?.agents.length ?? 0) > 0 && (
                <section>
                  <div className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-text-muted">
                    <Bot size={10} /> Agents
                  </div>
                  <div className="space-y-1">
                    {detail!.agents.map((a) => (
                      <div key={a.id} className="flex items-center justify-between rounded-card border border-line bg-surface-2 px-3 py-2.5">
                        <div>
                          <span className="text-[13px] text-text-primary">{a.name}</span>
                          <span className="ml-2 text-[11px] text-text-muted">{harnessLabel(a.adapterType)}</span>
                        </div>
                        {a.id && !a.id.startsWith('pkg:') && (
                          <button
                            type="button"
                            onClick={() => { onClose(); nav(`/agents/${a.id}`); }}
                            className="text-[11px] font-medium text-accent hover:underline"
                          >
                            Open →
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                </section>
              )}

              {(detail?.skills.length ?? 0) > 0 && (
                <section>
                  <div className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-text-muted">
                    <Sparkles size={10} /> Skills
                  </div>
                  <div className="space-y-1">
                    {detail!.skills.map((s) => (
                      <div key={s.id} className="rounded-card border border-line bg-surface-2 px-3 py-2.5">
                        <span className="text-[13px] text-text-primary">{s.name}</span>
                        <span className="ml-2 text-[11px] capitalize text-text-muted">{s.runtime} · v{s.version}</span>
                      </div>
                    ))}
                  </div>
                </section>
              )}

              {!loading && totalItems === 0 && (
                <div className="rounded-card border border-line bg-surface-2 px-4 py-8 text-center text-[12px] text-text-muted">
                  No linked resources in this package.
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center gap-2 border-t border-line bg-surface-2 px-5 py-3">
          {pkg.kind === 'app' && (
            <Button
              variant="primary"
              size="sm"
              onClick={() => void drawerLaunch()}
              disabled={!detail || launching}
            >
              {launching ? 'Launching…' : 'Launch App'}
            </Button>
          )}
          <Button
            variant="secondary"
            size="sm"
            iconLeft={<Copy size={12} />}
            onClick={() => void drawerDuplicate()}
            disabled={!detail || duplicating}
          >
            {duplicating ? 'Duplicating…' : 'Duplicate'}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            iconLeft={<ArrowUpFromLine size={12} />}
            onClick={() => void drawerExport()}
            disabled={!detail}
          >
            Export
          </Button>
          <button
            type="button"
            onClick={() => void drawerDelete()}
            className="ml-auto inline-flex h-8 items-center gap-1.5 rounded-btn px-2.5 text-[12px] font-medium text-danger hover:bg-danger-soft"
          >
            <Trash2 size={12} />
            Delete
          </button>
        </div>
      </div>
    </>
  );
}

function harnessLabel(adapterType: string) {
  switch (adapterType) {
    case 'openclaw': return 'OpenClaw';
    case 'hermes_agent': return 'Hermes Agent';
    case 'claude_code': return 'Claude Code';
    case 'codex': return 'Codex';
    case 'cursor': return 'Cursor';
    case 'http': return 'HTTP / Webhook';
    default: return 'Harness';
  }
}
