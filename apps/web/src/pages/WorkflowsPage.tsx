/**
 * WorkflowsPage — workflow list with space grouping, status-first cards, dual-path creation.
 *
 * Per UIUX-REPLAN §7.3: grouped by space, status as first visual signal,
 * last run inline, single primary action per state.
 */

import { useEffect, useMemo, useState, useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import clsx from 'clsx';
import {
  Plus,
  Workflow as WorkflowIcon,
  Webhook,
  Clock,
  MousePointer,
  Trash2,
  RotateCcw,
  SearchX,
  FolderTree,
  X,
  Bot,
  Upload,
  Download,
  ChevronDown,
  Tags,
  Check,
  Puzzle,
  Sparkles,
} from 'lucide-react';
import { ExtensionsModal } from '../components/extensions/ExtensionsModal';
import { REALTIME_EVENTS } from '@agentis/core';
import { api, apiErrorMessage, workspace as wsStore } from '../lib/api';
import { useRealtime, rtSubscribe } from '../lib/realtime';
import { useToast } from '../components/shared/Toast';
import { useConfirm } from '../components/shared/ConfirmDialog';
import { Button } from '../components/shared/Button';
import { SearchInput } from '../components/shared/SearchInput';
import { FilterBar } from '../components/shared/FilterBar';
import { Skeleton } from '../components/shared/Skeleton';
import { EmptyState } from '../components/shared/EmptyState';
import { StatusBadge } from '../components/shared/StatusBadge';


interface Workflow {
  id: string;
  title: string;
  status?: 'active' | 'idle' | 'draft' | 'broken' | 'failed' | 'running' | 'paused' | 'waiting' | 'pending';
  triggerType?: 'webhook' | 'cron' | 'manual' | 'event';
  triggerLabel?: string;
  lastRun?: { status: string; finishedAt?: string; failedNode?: string };
  nextRunAt?: string;
  activeRunStep?: { current: number; total: number; durationMs?: number };
  createdAt?: string;
  isReusable?: boolean;
  /** Collection name from settings.collection (10.13). */
  collection?: string | null;
  settings?: Record<string, unknown>;
  spaceId?: string | null;
}

interface Space { id: string; name: string; colorHex?: string; }

interface Collection {
  name: string;
  count: number;
}

type FilterValue = 'all' | 'active' | 'scheduled' | 'draft' | 'broken';

const FILTERS = [
  { value: 'all', label: 'All' },
  { value: 'active', label: 'Active' },
  { value: 'scheduled', label: 'Scheduled' },
  { value: 'draft', label: 'Draft' },
  { value: 'broken', label: 'Broken' },
] as const satisfies ReadonlyArray<{ value: FilterValue; label: string }>;

function relativeTime(iso?: string): string {
  if (!iso) return '';
  try {
    const d = Date.now() - new Date(iso).getTime();
    if (d < 60000) return 'just now';
    if (d < 3600_000) return `${Math.floor(d / 60000)}m ago`;
    if (d < 86_400_000) return `${Math.floor(d / 3600_000)}h ago`;
    return `${Math.floor(d / 86_400_000)}d ago`;
  } catch {
    return '';
  }
}

function passesFilter(w: Workflow, f: FilterValue): boolean {
  if (f === 'all') return true;
  const s = (w.status ?? '').toLowerCase();
  if (f === 'active') return s === 'active' || s === 'running' || s === 'paused' || s === 'waiting' || s === 'pending';
  if (f === 'scheduled') return w.triggerType === 'cron' || !!w.nextRunAt;
  if (f === 'draft') return s === 'draft';
  if (f === 'broken') return s === 'broken' || s === 'failed' || w.lastRun?.status === 'failed';
  return true;
}

function triggerIcon(t?: string) {
  if (t === 'webhook') return Webhook;
  if (t === 'cron') return Clock;
  if (t === 'manual') return MousePointer;
  return WorkflowIcon;
}

export function WorkflowsPage() {
  const nav = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const collectionFilter = searchParams.get('collection');
  const spaceFilter = searchParams.get('space');
  const toast = useToast();
  const confirm = useConfirm();
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [collections, setCollections] = useState<Collection[]>([]);
  const [spaces, setSpaces] = useState<Space[]>([]);

  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<FilterValue>('all');
  const [search, setSearch] = useState('');
  const [createPending, setCreatePending] = useState(false);
  const [newMenuOpen, setNewMenuOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [extManagerOpen, setExtManagerOpen] = useState(false);
  const [importing, setImporting] = useState(false);
  const [assigningWorkflow, setAssigningWorkflow] = useState<Workflow | null>(null);
  const importRef = useRef<HTMLInputElement>(null);



  async function refresh() {
    setLoading(true);
    try {
      const [wRes, cRes, sRes] = await Promise.allSettled([
        api<{ workflows: Workflow[] }>('/v1/workflows'),
        api<{ collections: Collection[] }>('/v1/workflows/collections'),
        api<{ data: Space[] }>('/v1/spaces'),
      ]);
      if (wRes.status === 'fulfilled') {
        setWorkflows(
          (wRes.value.workflows ?? []).map((w) => ({
            ...w,
            collection:
              ((w.settings as Record<string, unknown> | undefined)?.collection as
                | string
                | undefined) ?? null,
          })),
        );
      }
      if (cRes.status === 'fulfilled') setCollections(cRes.value.collections ?? []);
      if (sRes.status === 'fulfilled') setSpaces(sRes.value.data ?? []);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    const ws = wsStore.get();
    const unsubscribe = ws ? rtSubscribe('workspace', { workspaceId: ws }) : undefined;
    void refresh();
    return () => unsubscribe?.();
  }, []);

  useRealtime(
    [
      REALTIME_EVENTS.WORKFLOW_CREATED,
      REALTIME_EVENTS.WORKFLOW_UPDATED,
      REALTIME_EVENTS.WORKFLOW_DELETED,
      REALTIME_EVENTS.RUN_CREATED,
      REALTIME_EVENTS.RUN_RUNNING,
      REALTIME_EVENTS.RUN_COMPLETED,
      REALTIME_EVENTS.RUN_FAILED,
      REALTIME_EVENTS.NODE_STARTED,
      REALTIME_EVENTS.NODE_COMPLETED,
      REALTIME_EVENTS.NODE_FAILED,
      REALTIME_EVENTS.NODE_WAITING_FOR_INPUT,
    ],
    () => {
      void refresh();
    },
  );

  const collectionOptions = useMemo(() => {
    const byName = new Map<string, number>();
    for (const collection of collections) {
      if (!collection.name.trim()) continue;
      byName.set(collection.name, collection.count);
    }
    for (const workflow of workflows) {
      const name = workflow.collection?.trim();
      if (!name) continue;
      byName.set(name, byName.get(name) ?? 0);
    }
    return Array.from(byName.entries())
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [collections, workflows]);

  const unassignedDomainCount = useMemo(
    () => workflows.filter((workflow) => !workflow.spaceId).length,
    [workflows],
  );
  const uncategorizedCollectionCount = useMemo(
    () => workflows.filter((workflow) => !workflow.collection?.trim()).length,
    [workflows],
  );

  // Dynamic filter counts computed relative to current space and collection filters
  const baseFilteredWorkflows = useMemo(() => {
    return workflows.filter((w) => {
      if (spaceFilter) {
        if (spaceFilter === '__unassigned__') {
          if (w.spaceId) return false;
        } else if (w.spaceId !== spaceFilter) {
          return false;
        }
      }
      if (collectionFilter) {
        if (collectionFilter === '__uncategorized__') {
          if (w.collection?.trim()) return false;
        } else if (w.collection !== collectionFilter) {
          return false;
        }
      }
      return true;
    });
  }, [workflows, spaceFilter, collectionFilter]);

  const filterOptions = useMemo(() => {
    return [
      { value: 'all', label: 'All', count: baseFilteredWorkflows.length },
      { value: 'active', label: 'Active', count: baseFilteredWorkflows.filter((w) => passesFilter(w, 'active')).length },
      { value: 'scheduled', label: 'Scheduled', count: baseFilteredWorkflows.filter((w) => passesFilter(w, 'scheduled')).length },
      { value: 'draft', label: 'Draft', count: baseFilteredWorkflows.filter((w) => passesFilter(w, 'draft')).length },
      { value: 'broken', label: 'Broken', count: baseFilteredWorkflows.filter((w) => passesFilter(w, 'broken')).length },
    ] as const;
  }, [baseFilteredWorkflows]);

  const grouped = useMemo(() => {
    const filtered = workflows.filter((w) => {
      if (spaceFilter) {
        if (spaceFilter === '__unassigned__') {
          if (w.spaceId) return false;
        } else if (w.spaceId !== spaceFilter) {
          return false;
        }
      }
      if (collectionFilter) {
        if (collectionFilter === '__uncategorized__') {
          if (w.collection?.trim()) return false;
        } else if (w.collection !== collectionFilter) {
          return false;
        }
      }
      if (!passesFilter(w, filter)) return false;
      if (search.trim()) {
        const q = search.toLowerCase();
        const titleMatch = w.title.toLowerCase().includes(q);
        const collectionMatch = w.collection ? w.collection.toLowerCase().includes(q) : false;
        const space = spaces.find((item) => item.id === w.spaceId);
        const spaceMatch = space ? space.name.toLowerCase().includes(q) : false;
        return titleMatch || collectionMatch || spaceMatch;
      }
      return true;
    });
    const map = new Map<string, Workflow[]>();
    for (const w of filtered) {
      const key = w.collection?.trim() ? `c:${w.collection.trim()}` : '__uncategorized__';
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(w);
    }
    return map;
  }, [workflows, filter, search, collectionFilter, spaceFilter, spaces]);

  const total = workflows.length;
  const filteredCount = Array.from(grouped.values()).reduce((s, a) => s + a.length, 0);

  function setWorkflowParam(key: 'collection' | 'space', value: string) {
    setSearchParams((params) => {
      const next = new URLSearchParams(params);
      if (value) next.set(key, value);
      else next.delete(key);
      return next;
    });
  }

  function clearWorkflowFilters() {
    setSearch('');
    setFilter('all');
    setSearchParams((params) => {
      const next = new URLSearchParams(params);
      next.delete('collection');
      next.delete('space');
      return next;
    });
  }

  async function handleDelete(w: Workflow) {
    const ok = await confirm({
      title: `Delete workflow "${w.title}"?`,
      body: 'This action cannot be undone.',
      confirmLabel: 'Delete',
      tone: 'danger',
    });
    if (!ok) return;
    try {
      await api(`/v1/workflows/${w.id}`, { method: 'DELETE' });
      toast.undo(`Deleted ${w.title}`, async () => {
        try {
          await api(`/v1/workflows/${w.id}/restore`, { method: 'POST' });
          toast.success(`Restored ${w.title}`);
          void refresh();
        } catch {
          toast.error('Failed to restore');
        }
      });
      void refresh();
    } catch (e) {
      toast.error('Failed to delete', apiErrorMessage(e));
    }
  }

  async function handleRetry(w: Workflow) {
    try {
      await api(`/v1/workflows/${w.id}/run`, { method: 'POST' });
      toast.success('Retry started');
      void refresh();
    } catch (e) {
      toast.error('Retry failed', apiErrorMessage(e));
    }
  }

  /** 10.13: assign a workflow to a (possibly new) collection. */
  function handleAssignCollection(w: Workflow) {
    setAssigningWorkflow(w);
  }

  // Create a workflow (optionally named/placed) and jump to the canvas.
  async function createWorkflow(opts?: { title?: string; spaceId?: string | null; collection?: string }) {
    if (createPending) return;
    setCreatePending(true);
    try {
      const settings = opts?.collection?.trim() ? { collection: opts.collection.trim() } : undefined;
      const data = await api<{ workflow: { id: string } }>('/v1/workflows', {
        method: 'POST',
        body: JSON.stringify({
          title: opts?.title?.trim() || 'Untitled workflow',
          ...(opts?.spaceId ? { spaceId: opts.spaceId } : {}),
          ...(settings ? { settings } : {}),
        }),
      });
      nav(`/workflows/${data.workflow.id}`);
    } catch (e) {
      toast.error('Failed to create workflow', apiErrorMessage(e));
    } finally {
      setCreatePending(false);
    }
  }

  /** Import a .agentiswf / .json package file and navigate to the created workflow. */
  async function handleImportFile(file: File) {
    setImporting(true);
    try {
      const text = await file.text();
      const json = JSON.parse(text) as unknown;
      const data = await api<{ workflowId: string; path: string; warnings?: { message: string }[] }>(
        '/v1/packages/import',
        { method: 'POST', body: JSON.stringify(json) },
      );
      if (data.warnings?.length) {
        toast.success(`Imported with ${data.warnings.length} warning(s): ${data.warnings[0]?.message}`);
      } else {
        toast.success('Workflow imported successfully');
      }
      nav(data.path ?? `/workflows/${data.workflowId}`);
    } catch (e) {
      toast.error('Import failed', apiErrorMessage(e));
    } finally {
      setImporting(false);
      // Reset file input so the same file can be re-imported.
      if (importRef.current) importRef.current.value = '';
    }
  }

  /** Pack a workflow then download its export envelope as a .agentis file. */
  async function handleExport(w: Workflow) {
    try {
      const packed = await api<{ id: string }>(`/v1/packages/pack/workflow/${w.id}`, { method: 'POST', body: JSON.stringify({}) });
      const envelope = await api<Record<string, unknown>>(`/v1/packages/${packed.id}/export`);
      const blob = new Blob([JSON.stringify(envelope, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${w.title.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.agentiswf`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      toast.error('Export failed', apiErrorMessage(e));
    }
  }

  if (loading && total === 0) {
    return (
      <div className="space-y-4 p-6">
        <Skeleton width={150} height={28} />
        <Skeleton height={48} />
        <Skeleton height={48} />
        <Skeleton height={48} />
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col" onClick={() => setNewMenuOpen(false)}>
      <div className="flex flex-wrap items-center gap-3 border-b border-line px-6 py-4">
        <div>
          <h1 className="text-display text-text-primary">Workflows</h1>
          <div className="mt-0.5 text-[12px] text-text-muted">
            {total} {total === 1 ? 'workflow' : 'workflows'}
          </div>
        </div>

        <div className="ml-auto flex items-center gap-2">
          {/* Extensions manager — deterministic code units, left of New workflow. */}
          <button
            type="button"
            className="btn-premium-highlight btn-premium-extensions"
            onClick={() => setExtManagerOpen(true)}
          >
            <Puzzle size={14} className="btn-icon-puzzle mr-2" />
            <span>Extensions</span>
          </button>

          {/* New workflow ▾ — create or import in one control. */}
          <div className="relative" onClick={(e) => e.stopPropagation()}>
            <Button
              variant="primary"
              size="md"
              iconLeft={<Plus size={14} />}
              iconRight={<ChevronDown size={12} />}
              onClick={() => setNewMenuOpen((v) => !v)}
              disabled={createPending || importing}
            >
              {createPending ? 'Creating…' : importing ? 'Importing…' : 'New workflow'}
            </Button>
            {newMenuOpen && (
              <div className="absolute right-0 top-full z-50 mt-1 w-60 rounded-card border border-line bg-surface shadow-modal animate-in fade-in slide-in-from-top-1 duration-150">
                <button
                  type="button"
                  className="flex w-full items-center gap-2.5 px-3 py-2.5 text-left text-[13px] text-text-primary hover:bg-surface-2 transition-colors"
                  onClick={() => { setNewMenuOpen(false); setCreateOpen(true); }}
                >
                  <Sparkles size={14} className="text-accent" />
                  <span className="flex-1">
                    Create new
                    <span className="block text-[11px] text-text-muted">Start from a blank canvas</span>
                  </span>
                </button>
                <button
                  type="button"
                  className="flex w-full items-center gap-2.5 border-t border-line px-3 py-2.5 text-left text-[13px] text-text-primary hover:bg-surface-2 transition-colors"
                  onClick={() => { setNewMenuOpen(false); importRef.current?.click(); }}
                >
                  <Upload size={14} className="text-text-muted" />
                  <span className="flex-1">
                    Import
                    <span className="block text-[11px] text-text-muted">From a .agentiswf file</span>
                  </span>
                  <span className="text-[11px] text-text-muted">.agentiswf</span>
                </button>
                <button
                  type="button"
                  disabled
                  className="flex w-full items-center gap-2.5 border-t border-line px-3 py-2.5 text-left text-[13px] text-text-muted opacity-50 cursor-not-allowed"
                >
                  <Bot size={14} />
                  <span className="flex-1">
                    From AgentisHub
                    <span className="block text-[11px]">Coming soon</span>
                  </span>
                </button>
              </div>
            )}
          </div>

          {/* Hidden file input for Import */}
          <input
            ref={importRef}
            type="file"
            accept=".agentiswf,.json"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void handleImportFile(file);
            }}
          />
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 border-b border-line px-6 py-3">
        <FilterBar options={filterOptions} value={filter} onChange={setFilter} />

        {/* Organization filters surface only when there's something to organize by. */}
        {spaces.length > 0 && (
          <CustomFilterSelect
            icon={<Tags size={11} />}
            label="Domain"
            value={spaceFilter ?? ''}
            onChange={(value) => setWorkflowParam('space', value)}
            options={[
              ...spaces.map((space) => ({
                value: space.id,
                label: space.name,
                count: workflows.filter((workflow) => workflow.spaceId === space.id).length,
              })),
              ...(unassignedDomainCount > 0
                ? [{ value: '__unassigned__', label: 'Unassigned', count: unassignedDomainCount }]
                : []),
            ]}
          />
        )}

        {collectionOptions.length > 0 && (
          <CustomFilterSelect
            icon={<FolderTree size={11} />}
            label="Collection"
            value={collectionFilter ?? ''}
            onChange={(value) => setWorkflowParam('collection', value)}
            options={[
              ...collectionOptions.map((collection) => ({
                value: collection.name,
                label: collection.name,
                count: collection.count,
              })),
              ...(uncategorizedCollectionCount > 0
                ? [{ value: '__uncategorized__', label: 'Uncategorized', count: uncategorizedCollectionCount }]
                : []),
            ]}
          />
        )}

        <div className="ml-auto w-full sm:w-72">
          <SearchInput
            value={search}
            onChange={setSearch}
            placeholder="Search workflows…"
            bindSlashShortcut
          />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-5">
        {filteredCount === 0 ? (
          total === 0 ? (
            <EmptyState
              icon={<WorkflowIcon size={48} />}
              title="No workflows yet"
              body="Workflows are visual automations that chain AI tasks together. Create your first one — describe it in words, start from scratch, or use a template."
              primaryAction={
                <Button
                  variant="primary"
                  size="md"
                  iconLeft={<Plus size={14} />}
                  onClick={() => setCreateOpen(true)}
                  disabled={createPending}
                >
                  {createPending ? 'Creating…' : 'New workflow'}
                </Button>
              }
              variant="page"
            />
          ) : (
            <EmptyState
              icon={<SearchX size={48} />}
              title="No matching workflows"
              body="Try adjusting your search or filters."
              primaryAction={
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    clearWorkflowFilters();
                  }}
                >
                  Clear filters
                </Button>
              }
              variant="page"
            />
          )
        ) : (
          Array.from(grouped.entries()).map(([groupKey, list]) => {
            const groupLabel = groupKey === '__uncategorized__'
              ? 'Uncategorized'
              : groupKey.startsWith('c:')
                ? groupKey.slice(2)
                : groupKey;
            return (
              <div key={groupKey} className="mb-8 last:mb-0">
                <div className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-text-muted">
                  {groupLabel}{' '}
                  <span className="ml-1 font-normal normal-case tracking-normal">
                    · {list.length}
                  </span>
                </div>
                <div className="space-y-2">
                  {list.map((w) => {
                    const space = spaces.find(s => s.id === w.spaceId);
                    return (
                      <WorkflowCard
                        key={w.id}
                        w={w}
                        space={space}
                        onOpen={() => nav(`/workflows/${w.id}`)}
                        onRetry={() => void handleRetry(w)}
                        onDelete={() => void handleDelete(w)}
                        onAssignCollection={() => handleAssignCollection(w)}
                        onExport={() => void handleExport(w)}
                      />
                    );
                  })}
                </div>
              </div>
            );
          })
        )}
      </div>

      {assigningWorkflow && (
        <WorkflowAssignCollectionDialog
          workflow={assigningWorkflow}
          spaces={spaces}
          onClose={() => setAssigningWorkflow(null)}
          onSaved={() => {
            setAssigningWorkflow(null);
            void refresh();
          }}
        />
      )}

      {createOpen && (
        <CreateWorkflowModal
          spaces={spaces}
          pending={createPending}
          onClose={() => setCreateOpen(false)}
          onCreate={(opts) => void createWorkflow(opts)}
        />
      )}

      {extManagerOpen && <ExtensionsModal onClose={() => setExtManagerOpen(false)} />}
    </div>
  );
}

function CreateWorkflowModal({
  spaces,
  pending,
  onClose,
  onCreate,
}: {
  spaces: Space[];
  pending: boolean;
  onClose: () => void;
  onCreate: (opts: { title?: string; spaceId?: string | null; collection?: string }) => void;
}) {
  const [title, setTitle] = useState('');
  const [spaceId, setSpaceId] = useState('');
  const [collection, setCollection] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const t = setTimeout(() => inputRef.current?.focus(), 50);
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => { clearTimeout(t); window.removeEventListener('keydown', onKey); };
  }, [onClose]);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    onCreate({ title, spaceId: spaceId || null, collection });
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-overlay p-4 backdrop-blur-sm" onClick={onClose}>
      <form
        onSubmit={submit}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md rounded-card border border-line bg-surface p-6 shadow-modal"
      >
        <div className="flex items-center gap-3 border-b border-line pb-3">
          <span className="flex h-9 w-9 items-center justify-center rounded-card border border-accent/20 bg-accent-soft text-accent">
            <WorkflowIcon size={16} />
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="text-heading text-text-primary">New workflow</h2>
            <p className="text-[12px] text-text-muted">Start from a blank canvas — name it now or later.</p>
          </div>
          <Button variant="ghost" size="sm" onClick={onClose} aria-label="Close"><X size={16} /></Button>
        </div>
        <div className="mt-4 space-y-4">
          <div>
            <label className="block text-[12px] font-semibold text-text-secondary">Name</label>
            <input
              ref={inputRef}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Untitled workflow"
              className="mt-1 w-full rounded-btn border border-line bg-surface-2 px-3 py-2 text-[13px] text-text-primary outline-none focus:border-accent"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-[12px] font-semibold text-text-secondary">Domain</label>
              <select
                value={spaceId}
                onChange={(e) => setSpaceId(e.target.value)}
                className="mt-1 w-full rounded-btn border border-line bg-surface-2 px-3 py-2 text-[13px] text-text-primary outline-none focus:border-accent"
              >
                <option value="">None</option>
                {spaces.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-[12px] font-semibold text-text-secondary">Collection</label>
              <input
                value={collection}
                onChange={(e) => setCollection(e.target.value)}
                placeholder="Optional"
                className="mt-1 w-full rounded-btn border border-line bg-surface-2 px-3 py-2 text-[13px] text-text-primary outline-none focus:border-accent"
              />
            </div>
          </div>
        </div>
        <div className="mt-6 flex justify-end gap-2 border-t border-line pt-4">
          <Button variant="secondary" size="md" onClick={onClose}>Cancel</Button>
          <Button variant="primary" size="md" type="submit" disabled={pending} iconLeft={<Plus size={14} />}>
            {pending ? 'Creating…' : 'Create workflow'}
          </Button>
        </div>
      </form>
    </div>
  );
}

function CustomFilterSelect({
  icon,
  label,
  value,
  options,
  onChange,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  options: Array<{ value: string; label: string; count: number }>;
  onChange: (value: string) => void;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const selectedOption = options.find((opt) => opt.value === value);
  const displayLabel = selectedOption ? selectedOption.label : 'All';
  const isActive = value !== '';

  return (
    <div className="relative inline-block">
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className={clsx(
          "inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-[11px] font-medium transition-all duration-200 select-none",
          isActive
            ? "border-accent bg-accent-soft text-accent hover:bg-accent-soft/80"
            : "border-line bg-surface-2 text-text-secondary hover:bg-surface-3 hover:text-text-primary"
        )}
      >
        <span className={clsx(isActive ? "text-accent" : "text-text-muted")}>{icon}</span>
        <span>{label}:</span>
        <span className={clsx("font-semibold", isActive ? "text-accent" : "text-text-primary")}>{displayLabel}</span>
        <ChevronDown size={11} className={clsx("transition-transform duration-200", isOpen && "rotate-180")} />
      </button>

      {isOpen && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setIsOpen(false)} />
          <div className="absolute left-0 top-full z-50 mt-1.5 w-60 origin-top-left rounded-card border border-line bg-surface shadow-modal py-1 focus:outline-none animate-in fade-in slide-in-from-top-1 duration-150">
            <div className="max-h-[260px] overflow-y-auto py-1">
              <button
                type="button"
                onClick={() => {
                  onChange('');
                  setIsOpen(false);
                }}
                className={clsx(
                  "flex w-full items-center gap-2 px-3 py-2 text-left text-[12px] transition-colors",
                  value === ''
                    ? "bg-surface-2 text-text-primary font-medium"
                    : "text-text-secondary hover:bg-surface-2 hover:text-text-primary"
                )}
              >
                <div className="flex h-3.5 w-3.5 shrink-0 items-center justify-center">
                  {value === '' && <Check size={12} className="text-accent" />}
                </div>
                <span className="flex-1">All</span>
              </button>

              {options.map((option) => {
                const isSelected = option.value === value;
                return (
                  <button
                    key={option.value}
                    type="button"
                    onClick={() => {
                      onChange(option.value);
                      setIsOpen(false);
                    }}
                    className={clsx(
                      "flex w-full items-center gap-2 px-3 py-2 text-left text-[12px] transition-colors",
                      isSelected
                        ? "bg-surface-2 text-text-primary font-medium"
                        : "text-text-secondary hover:bg-surface-2 hover:text-text-primary"
                    )}
                  >
                    <div className="flex h-3.5 w-3.5 shrink-0 items-center justify-center">
                      {isSelected && <Check size={12} className="text-accent" />}
                    </div>
                    <span className="flex-1 truncate">{option.label}</span>
                    <span className="rounded-full bg-surface-3 px-1.5 py-0.5 text-[9px] font-medium text-text-muted">
                      {option.count}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function WorkflowCard({
  w,
  space,
  onOpen,
  onRetry,
  onDelete,
  onAssignCollection,
  onExport,
}: {
  w: Workflow;
  space?: Space;
  onOpen: () => void;
  onRetry: () => void;
  onDelete: () => void;
  onAssignCollection: () => void;
  onExport: () => void;
}) {
  const TI = triggerIcon(w.triggerType);
  const isFailed = w.status === 'broken' || w.status === 'failed' || w.lastRun?.status === 'failed';
  const isRunning = w.status === 'running' || w.status === 'active' || w.status === 'paused' || w.status === 'waiting' || w.status === 'pending';
  const isDraft = w.status === 'draft';

  return (
    <div
      onClick={onOpen}
      className="group rounded-card border border-line bg-surface p-4 transition-colors hover:border-line-strong hover:bg-surface-2 cursor-pointer"
    >
      <div className="flex items-center gap-3">
        <span
          className={`inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-card ${isFailed ? 'bg-danger-soft text-danger' : isRunning ? 'bg-accent-soft text-accent' : isDraft ? 'bg-surface-2 text-text-muted' : 'bg-surface-2 text-text-secondary'}`}
        >
          <TI size={16} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-subheading text-text-primary">{w.title}</span>
            {space && (
              <span className="inline-flex items-center gap-1.5 rounded-full border border-line bg-surface-2 px-2 py-0.5 text-[10px] font-medium text-text-secondary">
                {space.colorHex && <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: space.colorHex }} />}
                {space.name}
              </span>
            )}
            <StatusBadge status={w.status ?? 'idle'} size="sm" />
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[12px] text-text-muted">
            <span className="capitalize">
              {w.triggerLabel ?? w.triggerType ?? 'manual'} trigger
            </span>
            {isRunning && w.activeRunStep && (
              <span className="text-accent">
                step {w.activeRunStep.current}/{w.activeRunStep.total}
              </span>
            )}
            {!isRunning && w.lastRun && (
              <span>
                Last:{' '}
                <span
                  className={w.lastRun.status === 'failed' ? 'text-danger' : 'text-text-secondary'}
                >
                  {w.lastRun.status === 'failed'
                    ? `failed${w.lastRun.failedNode ? ` at ${w.lastRun.failedNode}` : ''}`
                    : w.lastRun.status}
                </span>{' '}
                {relativeTime(w.lastRun.finishedAt)}
              </span>
            )}
            {!isRunning && !w.lastRun && w.nextRunAt && (
              <span>Next run: {new Date(w.nextRunAt).toLocaleString()}</span>
            )}
            {isDraft && w.createdAt && <span>Created {relativeTime(w.createdAt)}</span>}
          </div>
        </div>
        <div className="flex shrink-0 gap-1.5">
          <Button
            variant="ghost"
            size="sm"
            aria-label="Edit workflow organization"
            title="Edit workflow organization"
            onClick={(e) => {
              e.stopPropagation();
              onAssignCollection();
            }}
          >
            <Tags size={12} />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            aria-label="Download as .agentiswf"
            title="Download as .agentiswf"
            onClick={(e) => {
              e.stopPropagation();
              onExport();
            }}
          >
            <Download size={12} />
          </Button>
          {isFailed && (
            <Button
              variant="primary"
              size="sm"
              iconLeft={<RotateCcw size={12} />}
              onClick={(e) => {
                e.stopPropagation();
                onRetry();
              }}
            >
              Retry
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            aria-label="Delete"
            onClick={(e) => {
              e.stopPropagation();
              onDelete();
            }}
          >
            <Trash2 size={12} />
          </Button>
        </div>
      </div>
    </div>
  );
}

interface WorkflowAssignCollectionDialogProps {
  workflow: Workflow;
  spaces: Space[];
  onClose: () => void;
  onSaved: () => void;
}

export function WorkflowAssignCollectionDialog({
  workflow,
  spaces,
  onClose,
  onSaved,
}: WorkflowAssignCollectionDialogProps) {
  const toast = useToast();
  const [value, setValue] = useState(workflow.collection ?? '');
  const [spaceId, setSpaceId] = useState(workflow.spaceId ?? '');
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    // Autofocus input
    setTimeout(() => inputRef.current?.focus(), 50);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = value.trim();
    setSaving(true);
    try {
      const settings = { ...(workflow.settings ?? {}), collection: trimmed || undefined };
      await api(`/v1/workflows/${workflow.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ settings, spaceId: spaceId || null }),
      });
      toast.success('Workflow updated');
      onSaved();
    } catch (e) {
      toast.error('Failed to update workflow', apiErrorMessage(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-overlay p-4 backdrop-blur-sm">
      <form
        onSubmit={handleSubmit}
        className="w-full max-w-md rounded-card border border-line bg-surface p-6 shadow-modal"
      >
        <div className="flex items-center justify-between border-b border-line pb-3">
          <h2 className="text-heading text-text-primary">Workflow settings</h2>
          <Button variant="ghost" size="sm" onClick={onClose} aria-label="Close">
            <X size={16} />
          </Button>
        </div>
        <div className="mt-4 space-y-4">
          <div>
            <label className="block text-[12px] font-semibold text-text-secondary">Space</label>
            <select
              value={spaceId}
              onChange={(e) => setSpaceId(e.target.value)}
              className="mt-1 w-full rounded-btn border border-line bg-surface-2 px-3 py-2 text-[13px] text-text-primary outline-none focus:border-accent"
            >
              <option value="">No Space</option>
              {spaces.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-[12px] font-semibold text-text-secondary">Collection</label>
            <input
              ref={inputRef}
              type="text"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder="e.g. Marketing, Support"
              className="mt-1 w-full rounded-btn border border-line bg-surface-2 px-3 py-2 text-[13px] text-text-primary outline-none focus:border-accent"
            />
          </div>
        </div>
        <div className="mt-6 flex justify-end gap-2 border-t border-line pt-4">
          <Button variant="secondary" size="md" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" size="md" type="submit" disabled={saving}>
            {saving ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </form>
    </div>
  );
}
