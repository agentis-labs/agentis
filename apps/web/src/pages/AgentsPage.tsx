/**
 * AgentsPage — agent list with Grid/Table toggle, search, filters, space grouping.
 *
 * The constellation view is killed (per UIUX-REPLAN §7.2). Grid mode
 * shows agent cards; Table mode shows a sortable list. Both group by
 * space when spaces are configured.
 */

import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Bot, Plus, Grid3x3, List as ListIcon, MessageCircle, Settings as SettingsIcon, SearchX } from 'lucide-react';
import clsx from 'clsx';
import { api, workspace as wsStore } from '../lib/api';
import { rtSubscribe, useRealtime } from '../lib/realtime';
import { Button } from '../components/shared/Button';
import { SearchInput } from '../components/shared/SearchInput';
import { FilterBar } from '../components/shared/FilterBar';
import { StatusBadge } from '../components/shared/StatusBadge';
import { Skeleton, SkeletonCard } from '../components/shared/Skeleton';
import { EmptyState } from '../components/shared/EmptyState';
import { AgentCreateWizard } from '../components/agents/AgentCreateWizard';

interface AgentRow {
  id: string;
  name: string;
  status?: string;
  description?: string;
  spaceId?: string | null;
  spaceName?: string;
  adapter?: { type?: string; model?: string };
  avatarUrl?: string | null;
  currentTask?: string;
  lastActiveAt?: string;
}

interface Space { id: string; name: string; colorHex?: string; }

type View = 'grid' | 'table';
type FilterValue = 'all' | 'active' | 'idle' | 'setup_needed';

const FILTERS = [
  { value: 'all', label: 'All' },
  { value: 'active', label: 'Active' },
  { value: 'idle', label: 'Idle' },
  { value: 'setup_needed', label: 'Setup needed' },
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

function initials(name: string): string {
  if (!name) return '?';
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  const first = parts[0] ?? '';
  if (parts.length === 1) return first.slice(0, 2).toUpperCase();
  const last = parts[parts.length - 1] ?? '';
  return ((first[0] ?? '') + (last[0] ?? '')).toUpperCase();
}

function passesFilter(a: AgentRow, f: FilterValue): boolean {
  if (f === 'all') return true;
  const status = (a.status ?? '').toLowerCase();
  if (f === 'active') return status === 'online' || status === 'active' || status === 'running';
  if (f === 'idle') return status === 'idle' || status === 'paused' || status === 'offline';
  if (f === 'setup_needed') return !a.adapter?.type;
  return true;
}

export function AgentsPage() {
  const nav = useNavigate();
  const [agents, setAgents] = useState<AgentRow[]>([]);
  const [spaces, setSpaces] = useState<Space[]>([]);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<View>(() => {
    try { return (localStorage.getItem('agentis.agents.view') as View) || 'grid'; } catch { return 'grid'; }
  });
  const [creating, setCreating] = useState(false);
  const [filter, setFilter] = useState<FilterValue>('all');
  const [search, setSearch] = useState('');

  useEffect(() => {
    try { localStorage.setItem('agentis.agents.view', view); } catch { /* ignore */ }
  }, [view]);

  async function refresh() {
    setLoading(true);
    try {
      const [aRes, sRes] = await Promise.allSettled([
        api<{ agents: AgentRow[] }>('/v1/agents'),
        api<{ spaces: Space[] }>('/v1/spaces'),
      ]);
      if (aRes.status === 'fulfilled') setAgents(aRes.value.agents ?? []);
      if (sRes.status === 'fulfilled') setSpaces(sRes.value.spaces ?? []);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    const ws = wsStore.get();
    if (ws) rtSubscribe('workspace', { workspaceId: ws });
    void refresh();
  }, []);

  useRealtime(
    ['agent.status.changed', 'agent.heartbeat', 'agent.created', 'agent.updated'],
    () => { void refresh(); },
  );

  // Filter + group
  const grouped = useMemo(() => {
    const filtered = agents.filter((a) => {
      if (!passesFilter(a, filter)) return false;
      if (search.trim()) {
        const q = search.toLowerCase();
        return a.name.toLowerCase().includes(q) || (a.description ?? '').toLowerCase().includes(q);
      }
      return true;
    });
    const bySpace = new Map<string, AgentRow[]>();
    for (const a of filtered) {
      const k = a.spaceId ?? '__ungrouped__';
      if (!bySpace.has(k)) bySpace.set(k, []);
      bySpace.get(k)!.push(a);
    }
    return bySpace;
  }, [agents, filter, search]);

  const total = agents.length;
  const filteredCount = Array.from(grouped.values()).reduce((s, arr) => s + arr.length, 0);

  if (loading && total === 0) {
    return (
      <div className="space-y-4 p-6">
        <div className="flex items-center gap-3">
          <Skeleton width={120} height={28} />
          <Skeleton width={80} height={20} />
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <SkeletonCard /><SkeletonCard /><SkeletonCard />
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex flex-wrap items-center gap-3 border-b border-line px-6 py-4">
        <div>
          <h1 className="text-display text-text-primary">Agents</h1>
          <div className="mt-0.5 text-[12px] text-text-muted">{total} {total === 1 ? 'agent' : 'agents'}</div>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <div className="flex h-9 items-center gap-0.5 rounded-btn border border-line bg-surface-2 p-0.5">
            <button
              type="button"
              onClick={() => setView('grid')}
              aria-label="Grid view"
              className={clsx(
                'inline-flex h-7 items-center gap-1 rounded-md px-2 text-[12px] transition-colors',
                view === 'grid' ? 'bg-surface-3 text-text-primary' : 'text-text-muted hover:text-text-primary',
              )}
            >
              <Grid3x3 size={12} /> Grid
            </button>
            <button
              type="button"
              onClick={() => setView('table')}
              aria-label="Table view"
              className={clsx(
                'inline-flex h-7 items-center gap-1 rounded-md px-2 text-[12px] transition-colors',
                view === 'table' ? 'bg-surface-3 text-text-primary' : 'text-text-muted hover:text-text-primary',
              )}
            >
              <ListIcon size={12} /> Table
            </button>
          </div>
          <Button variant="primary" size="md" iconLeft={<Plus size={14} />} onClick={() => setCreating(true)}>
            Add agent
          </Button>
        </div>
      </div>

      {/* Filter row */}
      <div className="flex flex-wrap items-center gap-3 border-b border-line px-6 py-3">
        <FilterBar options={FILTERS} value={filter} onChange={setFilter} />
        <div className="ml-auto w-full sm:w-72">
          <SearchInput value={search} onChange={setSearch} placeholder="Search agents…" bindSlashShortcut />
        </div>
      </div>

      {/* List body */}
      <div className="flex-1 overflow-y-auto px-6 py-5">
        {filteredCount === 0 ? (
          total === 0 ? (
            <EmptyState
              icon={<Bot size={48} />}
              title="No agents yet"
              body="Create your first agent to start automating work."
              primaryAction={<Button variant="primary" size="md" iconLeft={<Plus size={14} />} onClick={() => setCreating(true)}>Add agent</Button>}
              variant="page"
            />
          ) : (
            <EmptyState
              icon={<SearchX size={48} />}
              title="No matching agents"
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
                <div className="mb-3 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-text-muted">
                  {space?.colorHex && <span className="h-2 w-2 rounded-full" style={{ backgroundColor: space.colorHex }} />}
                  {groupLabel}
                  <span className="text-[10px] font-normal normal-case tracking-normal text-text-muted">· {list.length}</span>
                </div>
                {view === 'grid' ? (
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                    {list.map((a) => <AgentGridCard key={a.id} a={a} />)}
                  </div>
                ) : (
                  <AgentTable rows={list} onSelect={(id) => nav(`/agents/${id}`)} />
                )}
              </div>
            );
          })
        )}
      </div>

      <AgentCreateWizard
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={(agent) => { setCreating(false); nav(`/agents/${agent.id}`); }}
      />
    </div>
  );
}

function AgentGridCard({ a }: { a: AgentRow }) {
  const nav = useNavigate();
  const status = a.status ?? 'offline';
  const adapterMissing = !a.adapter?.type;
  return (
    <div
      className="cursor-pointer rounded-card border border-line bg-surface p-4 transition-colors hover:border-line-strong hover:bg-surface-2"
      onClick={() => nav(`/agents/${a.id}`)}
    >
      <div className="flex items-start gap-3">
        <Avatar name={a.name} imageUrl={a.avatarUrl ?? undefined} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-subheading text-text-primary">{a.name}</span>
            <StatusBadge status={status} size="sm" />
          </div>
          <div className="mt-0.5 truncate text-[12px] text-text-muted">
            {a.spaceName ?? 'No space'} · {a.adapter?.type ?? 'No adapter'}
          </div>
          {(a.currentTask || a.description) && (
            <div className="mt-2 line-clamp-2 text-[12px] text-text-secondary">
              {a.currentTask ?? a.description}
            </div>
          )}
          {!a.currentTask && a.lastActiveAt && (
            <div className="mt-2 text-[11px] text-text-muted">Last active: {relativeTime(a.lastActiveAt)}</div>
          )}
        </div>
      </div>
      <div className="mt-3 flex gap-1.5">
        <Button
          variant="secondary" size="sm" iconLeft={<MessageCircle size={11} />}
          onClick={(e) => { e.stopPropagation(); nav(`/chat/agent/${a.id}`); }}
        >Talk</Button>
        <Button
          variant="ghost" size="sm" iconLeft={<SettingsIcon size={11} />}
          onClick={(e) => { e.stopPropagation(); nav(`/agents/${a.id}`); }}
        >Configure</Button>
        {adapterMissing && (
          <span className="ml-auto inline-flex items-center text-[11px] text-warn">Setup needed</span>
        )}
      </div>
    </div>
  );
}

function AgentTable({ rows, onSelect }: { rows: AgentRow[]; onSelect: (id: string) => void }) {
  return (
    <div className="overflow-hidden rounded-card border border-line bg-surface">
      <table className="w-full">
        <thead>
          <tr className="border-b border-line text-[11px] font-medium uppercase tracking-wider text-text-muted">
            <th className="px-4 py-2.5 text-left">Agent</th>
            <th className="px-4 py-2.5 text-left">Status</th>
            <th className="px-4 py-2.5 text-left">Adapter</th>
            <th className="px-4 py-2.5 text-left">Last active</th>
            <th className="px-2 py-2.5"></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((a) => (
            <tr
              key={a.id}
              className="cursor-pointer border-b border-line/60 transition-colors hover:bg-surface-2 last:border-b-0"
              onClick={() => onSelect(a.id)}
            >
              <td className="px-4 py-3">
                <div className="flex items-center gap-2.5">
                  <Avatar name={a.name} imageUrl={a.avatarUrl ?? undefined} size={28} />
                  <span className="text-[13px] font-medium text-text-primary">{a.name}</span>
                </div>
              </td>
              <td className="px-4 py-3"><StatusBadge status={a.status ?? 'offline'} size="sm" /></td>
              <td className="px-4 py-3 text-[12px] text-text-secondary">{a.adapter?.type ?? '—'}</td>
              <td className="px-4 py-3 text-[12px] text-text-muted">{relativeTime(a.lastActiveAt)}</td>
              <td className="px-2 py-3">
                <span className="text-text-muted">›</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Avatar({ name, imageUrl, size = 36 }: { name: string; imageUrl?: string; size?: number }) {
  return (
    <div
      className="overflow-hidden rounded-full border border-line bg-surface-2"
      style={{ width: size, height: size, flexShrink: 0 }}
    >
      {imageUrl ? (
        <img src={imageUrl} alt={name} className="h-full w-full object-cover" />
      ) : (
        <span
          className="flex h-full w-full items-center justify-center font-semibold text-text-primary"
          style={{ fontSize: Math.max(10, size / 3) }}
        >
          {initials(name)}
        </span>
      )}
    </div>
  );
}
