/**
 * WorkflowsPage — workflow list with space grouping, status-first cards, dual-path creation.
 *
 * Per UIUX-REPLAN §7.3: grouped by space, status as first visual signal,
 * last run inline, single primary action per state.
 */

import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Plus, Search, Workflow as WorkflowIcon, Webhook, Clock, MousePointer,
  Sparkles, FileCode, Trash2, RotateCcw, ArrowRight, SearchX,
} from 'lucide-react';
import { api, workspace as wsStore } from '../lib/api';
import { useRealtime, rtSubscribe } from '../lib/realtime';
import { useToast } from '../components/shared/Toast';
import { useConfirm } from '../components/shared/ConfirmDialog';
import { Button } from '../components/shared/Button';
import { SearchInput } from '../components/shared/SearchInput';
import { FilterBar } from '../components/shared/FilterBar';
import { Skeleton } from '../components/shared/Skeleton';
import { EmptyState } from '../components/shared/EmptyState';
import { StatusBadge } from '../components/shared/StatusBadge';
import { WorkflowCreateDialog } from '../components/workflows/WorkflowCreateDialog';

interface Workflow {
  id: string;
  name: string;
  status?: 'active' | 'idle' | 'draft' | 'broken' | 'failed' | 'running';
  spaceId?: string;
  spaceName?: string;
  triggerType?: 'webhook' | 'cron' | 'manual' | 'event';
  triggerLabel?: string;
  lastRun?: { status: string; finishedAt?: string; failedNode?: string };
  nextRunAt?: string;
  activeRunStep?: { current: number; total: number; durationMs?: number };
  createdAt?: string;
  isReusable?: boolean;
}

interface Space { id: string; name: string; }

type FilterValue = 'all' | 'active' | 'scheduled' | 'draft' | 'broken';

const FILTERS = [
  { value: 'all',       label: 'All' },
  { value: 'active',    label: 'Active' },
  { value: 'scheduled', label: 'Scheduled' },
  { value: 'draft',     label: 'Draft' },
  { value: 'broken',    label: 'Broken' },
] as const satisfies ReadonlyArray<{ value: FilterValue; label: string }>;

function relativeTime(iso?: string): string {
  if (!iso) return '';
  try {
    const d = Date.now() - new Date(iso).getTime();
    if (d < 60000) return 'just now';
    if (d < 3600_000) return `${Math.floor(d / 60000)}m ago`;
    if (d < 86_400_000) return `${Math.floor(d / 3600_000)}h ago`;
    return `${Math.floor(d / 86_400_000)}d ago`;
  } catch { return ''; }
}

function passesFilter(w: Workflow, f: FilterValue): boolean {
  if (f === 'all') return true;
  const s = (w.status ?? '').toLowerCase();
  if (f === 'active') return s === 'active' || s === 'running';
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
  const toast = useToast();
  const confirm = useConfirm();
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [spaces, setSpaces] = useState<Space[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<FilterValue>('all');
  const [search, setSearch] = useState('');
  const [creating, setCreating] = useState(false);

  async function refresh() {
    setLoading(true);
    try {
      const [wRes, sRes] = await Promise.allSettled([
        api<{ workflows: Workflow[] }>('/v1/workflows'),
        api<{ spaces: Space[] }>('/v1/spaces'),
      ]);
      if (wRes.status === 'fulfilled') setWorkflows(wRes.value.workflows ?? []);
      if (sRes.status === 'fulfilled') setSpaces(sRes.value.spaces ?? []);
    } finally { setLoading(false); }
  }

  useEffect(() => {
    const ws = wsStore.get();
    if (ws) rtSubscribe('workspace', { workspaceId: ws });
    void refresh();
  }, []);

  useRealtime(['workflow.created', 'workflow.updated', 'workflow.deleted', 'run.created', 'run.completed', 'run.failed'], () => {
    void refresh();
  });

  const grouped = useMemo(() => {
    const filtered = workflows.filter((w) => {
      if (!passesFilter(w, filter)) return false;
      if (search.trim()) {
        const q = search.toLowerCase();
        return w.name.toLowerCase().includes(q);
      }
      return true;
    });
    const map = new Map<string, Workflow[]>();
    for (const w of filtered) {
      const k = w.spaceId ?? '__ungrouped__';
      if (!map.has(k)) map.set(k, []);
      map.get(k)!.push(w);
    }
    return map;
  }, [workflows, filter, search]);

  const total = workflows.length;
  const filteredCount = Array.from(grouped.values()).reduce((s, a) => s + a.length, 0);

  async function handleDelete(w: Workflow) {
    const ok = await confirm({
      title: `Delete workflow "${w.name}"?`,
      body: 'This action cannot be undone.',
      confirmLabel: 'Delete',
      tone: 'danger',
    });
    if (!ok) return;
    try {
      await api(`/v1/workflows/${w.id}`, { method: 'DELETE' });
      toast.undo(`Deleted ${w.name}`, async () => {
        try { await api(`/v1/workflows/${w.id}/restore`, { method: 'POST' }); toast.success(`Restored ${w.name}`); void refresh(); }
        catch { toast.error('Failed to restore'); }
      });
      void refresh();
    } catch (e) { toast.error('Failed to delete', String(e)); }
  }

  async function handleRetry(w: Workflow) {
    try { await api(`/v1/workflows/${w.id}/run`, { method: 'POST' }); toast.success('Retry started'); void refresh(); }
    catch (e) { toast.error('Retry failed', String(e)); }
  }

  if (loading && total === 0) {
    return (
      <div className="space-y-4 p-6">
        <Skeleton width={150} height={28} />
        <Skeleton height={48} /><Skeleton height={48} /><Skeleton height={48} />
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-center gap-3 border-b border-line px-6 py-4">
        <div>
          <h1 className="text-display text-text-primary">Workflows</h1>
          <div className="mt-0.5 text-[12px] text-text-muted">{total} {total === 1 ? 'workflow' : 'workflows'}</div>
        </div>
        <div className="ml-auto">
          <Button variant="primary" size="md" iconLeft={<Plus size={14} />} onClick={() => setCreating(true)}>
            New workflow
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3 border-b border-line px-6 py-3">
        <FilterBar options={FILTERS} value={filter} onChange={setFilter} />
        <div className="ml-auto w-full sm:w-72">
          <SearchInput value={search} onChange={setSearch} placeholder="Search workflows…" bindSlashShortcut />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-5">
        {filteredCount === 0 ? (
          total === 0 ? (
            <EmptyState
              icon={<WorkflowIcon size={48} />}
              title="No workflows yet"
              body="Workflows are visual automations that chain AI tasks together. Create your first one — describe it in words, start from scratch, or use a template."
              primaryAction={<Button variant="primary" size="md" iconLeft={<Plus size={14} />} onClick={() => setCreating(true)}>New workflow</Button>}
              variant="page"
            />
          ) : (
            <EmptyState
              icon={<SearchX size={48} />}
              title="No matching workflows"
              body="Try adjusting your search or filters."
              primaryAction={<Button variant="secondary" size="sm" onClick={() => { setSearch(''); setFilter('all'); }}>Clear filters</Button>}
              variant="page"
            />
          )
        ) : (
          Array.from(grouped.entries()).map(([spaceKey, list]) => {
            const space = spaces.find((s) => s.id === spaceKey);
            const groupLabel = space?.name ?? (spaceKey === '__ungrouped__' ? 'Ungrouped' : 'Other');
            return (
              <div key={spaceKey} className="mb-8 last:mb-0">
                <div className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-text-muted">
                  {groupLabel} <span className="ml-1 font-normal normal-case tracking-normal">· {list.length}</span>
                </div>
                <div className="space-y-2">
                  {list.map((w) => (
                    <WorkflowCard
                      key={w.id}
                      w={w}
                      onOpen={() => nav(`/workflows/${w.id}`)}
                      onRetry={() => void handleRetry(w)}
                      onDelete={() => void handleDelete(w)}
                    />
                  ))}
                </div>
              </div>
            );
          })
        )}
      </div>

      <WorkflowCreateDialog
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={(workflowId) => { setCreating(false); nav(`/workflows/${workflowId}`); }}
      />
    </div>
  );
}

function WorkflowCard({ w, onOpen, onRetry, onDelete }: {
  w: Workflow;
  onOpen: () => void;
  onRetry: () => void;
  onDelete: () => void;
}) {
  const TI = triggerIcon(w.triggerType);
  const isFailed = w.status === 'broken' || w.status === 'failed' || w.lastRun?.status === 'failed';
  const isRunning = w.status === 'running' || w.status === 'active';
  const isDraft = w.status === 'draft';

  return (
    <div className="group rounded-card border border-line bg-surface p-4 transition-colors hover:border-line-strong hover:bg-surface-2">
      <div className="flex items-center gap-3">
        <span className={`inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-card ${isFailed ? 'bg-danger-soft text-danger' : isRunning ? 'bg-accent-soft text-accent' : isDraft ? 'bg-surface-2 text-text-muted' : 'bg-surface-2 text-text-secondary'}`}>
          <TI size={16} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-subheading text-text-primary">{w.name}</span>
            <StatusBadge status={w.status ?? 'idle'} size="sm" />
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[12px] text-text-muted">
            <span className="capitalize">{w.triggerLabel ?? w.triggerType ?? 'manual'} trigger</span>
            {isRunning && w.activeRunStep && (
              <span className="text-accent">step {w.activeRunStep.current}/{w.activeRunStep.total}</span>
            )}
            {!isRunning && w.lastRun && (
              <span>
                Last:{' '}
                <span className={w.lastRun.status === 'failed' ? 'text-danger' : 'text-text-secondary'}>
                  {w.lastRun.status === 'failed' ? `failed${w.lastRun.failedNode ? ` at ${w.lastRun.failedNode}` : ''}` : w.lastRun.status}
                </span>
                {' '}{relativeTime(w.lastRun.finishedAt)}
              </span>
            )}
            {!isRunning && !w.lastRun && w.nextRunAt && (
              <span>Next run: {new Date(w.nextRunAt).toLocaleString()}</span>
            )}
            {isDraft && w.createdAt && <span>Created {relativeTime(w.createdAt)}</span>}
          </div>
        </div>
        <div className="flex shrink-0 gap-1.5">
          {isFailed ? (
            <Button variant="primary" size="sm" iconLeft={<RotateCcw size={12} />} onClick={(e) => { e.stopPropagation(); onRetry(); }}>Retry</Button>
          ) : (
            <Button variant="secondary" size="sm" iconRight={<ArrowRight size={12} />} onClick={(e) => { e.stopPropagation(); onOpen(); }}>Open</Button>
          )}
          <Button variant="ghost" size="sm" aria-label="Delete" onClick={(e) => { e.stopPropagation(); onDelete(); }}><Trash2 size={12} /></Button>
        </div>
      </div>
    </div>
  );
}
