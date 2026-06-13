/**
 * AgentsPage — hierarchy canvas with table fallback, search, filters, space grouping.
 *
 * The constellation view is killed (per UIUX-REPLAN §7.2). Grid mode
 * shows agent cards; Table mode shows a sortable list. Both group by
 * space when spaces are configured.
 */

import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Bot, Plus, Network, List as ListIcon, MessageCircle, Settings as SettingsIcon, Search, SearchX, X, Zap, ChevronDown, Check, Sparkles } from 'lucide-react';
import clsx from 'clsx';
import { api, workspace as wsStore } from '../lib/api';
import { rtSubscribe, useRealtime } from '../lib/realtime';
import { Button } from '../components/shared/Button';
import { StatusBadge } from '../components/shared/StatusBadge';
import { Skeleton, SkeletonCard } from '../components/shared/Skeleton';
import { EmptyState } from '../components/shared/EmptyState';
import { AgentCreateWizard } from '../components/agents/AgentCreateWizard';
import { AgentHierarchyCanvas } from '../components/agents/AgentHierarchyCanvas';
import type { AgentHierarchyCreatePreset } from '../components/agents/AgentHierarchyCanvas';
import { DomainEditorSheet, type DomainOption } from '../components/agents/DomainEditorSheet';
import { AbilitiesModal } from '../components/abilities/AbilitiesModal';
import { REALTIME_EVENTS } from '@agentis/core';

interface AgentRow {
  id: string;
  name: string;
  status?: string;
  description?: string;
  spaceId?: string | null;
  spaceName?: string | null;
  spaceColorHex?: string | null;
  adapterType?: string;
  runtimeModel?: string | null;
  adapter?: { type?: string; model?: string };
  avatarUrl?: string | null;
  currentTask?: string;
  currentTaskId?: string | null;
  lastActiveAt?: string;
  lastHeartbeatAt?: string | null;
  role?: string | null;
  reportsTo?: string | null;
  avatarGlyph?: string | null;
  colorHex?: string | null;
  isPaused?: boolean | null;
  monthlyBudgetCents?: number | null;
  currentMonthSpendCents?: number | null;
  canvasPosition?: { x: number; y: number } | null;
  runsToday?: number | null;
  spendTodayCents?: number | null;
  pendingApprovals?: number | null;
  connectionCounts?: {
    workflows: number;
  } | null;
  spaceTag?: string | null;
}

interface Space extends DomainOption {}

type View = 'fleet' | 'table' | 'specialists';
type FilterValue = 'all' | 'active' | 'idle' | 'setup_needed';

/**
 * The specialist class = any agent whose role is not the orchestrator or manager
 * hierarchy tier (custom slugs like `frontend_architect`, legacy `worker`, plain
 * `agent`). These stay OUT of the hierarchy canvas/table so it remains focused on
 * orchestrator + managers, and live in the dedicated Specialists view instead.
 */
function isSpecialistRole(role: string | null | undefined): boolean {
  const r = (role ?? '').toLowerCase();
  return r !== 'orchestrator' && r !== 'manager';
}

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
  if (f === 'setup_needed') return !agentHarnessType(a);
  return true;
}

export function AgentsPage() {
  const nav = useNavigate();
  const [agents, setAgents] = useState<AgentRow[]>([]);
  const [spaces, setSpaces] = useState<Space[]>([]);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<View>(() => {
    try {
      // Legacy value 'canvas' migrates to 'fleet' (AGENTS-PAGE-REDESIGN.md §1.1).
      const stored = localStorage.getItem('agentis.agents.view');
      return stored === 'table' || stored === 'specialists' ? stored : 'fleet';
    } catch { return 'fleet'; }
  });
  const [creating, setCreating] = useState(false);
  const [creatingPreset, setCreatingPreset] = useState<AgentHierarchyCreatePreset | undefined>(undefined);
  const [selectedDomainId, setSelectedDomainId] = useState<'all' | 'unassigned' | string>('all');
  const [editingDomain, setEditingDomain] = useState<Space | null>(null);
  const [domainEditorOpen, setDomainEditorOpen] = useState(false);
  const [abilitiesOpen, setAbilitiesOpen] = useState(false);
  const [filter, setFilter] = useState<FilterValue>('all');
  const [search, setSearch] = useState('');
  const [selectedAgent, setSelectedAgent] = useState<AgentRow | null>(null);

  useEffect(() => {
    try { localStorage.setItem('agentis.agents.view', view); } catch { /* ignore */ }
  }, [view]);

  useEffect(() => {
    if (view !== 'fleet') {
      setSelectedAgent(null);
      setFilter('all');
      setSearch('');
    }
  }, [view]);

  useEffect(() => {
    setSelectedAgent((current) => current ? agents.find((agent) => agent.id === current.id) ?? current : null);
  }, [agents]);

  async function refresh() {
    setLoading(true);
    try {
      const [aRes, sRes] = await Promise.allSettled([
        api<{ agents: AgentRow[] }>('/v1/agents'),
        api<{ data: Space[] }>('/v1/spaces'),
      ]);
      if (aRes.status === 'fulfilled') setAgents(aRes.value.agents ?? []);
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
      REALTIME_EVENTS.AGENT_STATUS_CHANGED,
      REALTIME_EVENTS.AGENT_HEARTBEAT,
      REALTIME_EVENTS.AGENT_CREATED,
      REALTIME_EVENTS.AGENT_UPDATED,
      REALTIME_EVENTS.SPACE_CREATED,
      REALTIME_EVENTS.SPACE_UPDATED,
      REALTIME_EVENTS.SPACE_DELETED,
    ],
    () => { void refresh(); },
  );

  useEffect(() => {
    const onBackgroundInstallUpdate = () => { void refresh(); };
    window.addEventListener('agentis:background-install-updated', onBackgroundInstallUpdate);
    return () => window.removeEventListener('agentis:background-install-updated', onBackgroundInstallUpdate);
  }, []);

  useEffect(() => {
    if (selectedDomainId !== 'all' && selectedDomainId !== 'unassigned' && !spaces.some((space) => space.id === selectedDomainId)) {
      setSelectedDomainId('all');
    }
  }, [selectedDomainId, spaces]);

  const domainAgentsForCanvas = useMemo(() => {
    // Hierarchy canvas shows only the orchestrator + managers structure.
    const fleet = agents.filter((agent) => !isSpecialistRole(agent.role));
    if (selectedDomainId === 'all') return fleet;
    return fleet.filter((agent) => {
      if (agent.role === 'orchestrator') return true;
      if (selectedDomainId === 'unassigned') return !agent.spaceId;
      return agent.spaceId === selectedDomainId;
    });
  }, [agents, selectedDomainId]);

  const filteredAgents = useMemo(() => {
    return agents.filter((a) => {
      if (isSpecialistRole(a.role)) return false;
      if (selectedDomainId === 'unassigned' && a.spaceId) return false;
      if (selectedDomainId !== 'all' && selectedDomainId !== 'unassigned' && a.spaceId !== selectedDomainId) return false;
      if (!passesFilter(a, filter)) return false;
      if (search.trim()) {
        const q = search.toLowerCase();
        return a.name.toLowerCase().includes(q) || (a.description ?? '').toLowerCase().includes(q);
      }
      return true;
    });
  }, [agents, filter, search, selectedDomainId]);

  // Filter + group
  const grouped = useMemo(() => {
    const bySpace = new Map<string, AgentRow[]>();
    for (const a of filteredAgents) {
      const k = a.spaceId ?? '__ungrouped__';
      if (!bySpace.has(k)) bySpace.set(k, []);
      bySpace.get(k)!.push(a);
    }
    return bySpace;
  }, [filteredAgents]);

  const total = agents.filter((a) => !isSpecialistRole(a.role)).length;
  const filteredCount = Array.from(grouped.values()).reduce((s, arr) => s + arr.length, 0);
  const managers = useMemo(() => agents.filter((agent) => agent.role === 'manager'), [agents]);

  const specialistList = useMemo(() => {
    const list = agents.filter((a) => isSpecialistRole(a.role));
    if (!search.trim()) return list;
    const q = search.toLowerCase();
    return list.filter((a) => a.name.toLowerCase().includes(q)
      || (a.role ?? '').toLowerCase().includes(q)
      || (a.description ?? '').toLowerCase().includes(q));
  }, [agents, search]);
  const specialistCount = useMemo(() => agents.filter((a) => isSpecialistRole(a.role)).length, [agents]);

  function openCreateAgent() {
    const spaceId = selectedDomainId !== 'all' && selectedDomainId !== 'unassigned' ? selectedDomainId : null;
    setCreatingPreset(spaceId ? { role: 'manager', spaceId } : undefined);
    setCreating(true);
  }

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
      <div className="space-y-4 border-b border-line px-6 py-4">
        <div className="flex flex-wrap items-center gap-3">
        <div>
          <h1 className="text-display text-text-primary">Agents</h1>
          <div className="mt-0.5 text-[12px] text-text-muted">{total} {total === 1 ? 'agent' : 'agents'}</div>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <div className="flex h-9 items-center gap-0.5 rounded-btn border border-line bg-surface-2 p-0.5">
            <button
              type="button"
              onClick={() => setView('fleet')}
              aria-label="Fleet view"
              className={clsx(
                'inline-flex h-7 items-center gap-1 rounded-md px-2 text-[12px] transition-colors',
                view === 'fleet' ? 'bg-surface-3 text-text-primary' : 'text-text-muted hover:text-text-primary',
              )}
            >
              <Network size={12} /> Fleet
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
            <button
              type="button"
              onClick={() => setView('specialists')}
              aria-label="Specialists view"
              className={clsx(
                'inline-flex h-7 items-center gap-1 rounded-md px-2 text-[12px] transition-colors',
                view === 'specialists' ? 'bg-surface-3 text-text-primary' : 'text-text-muted hover:text-text-primary',
              )}
            >
              <Sparkles size={12} /> Specialists
              {specialistCount > 0 && (
                <span className="rounded-full bg-surface-3 px-1.5 py-0.5 text-[9px] text-text-muted">{specialistCount}</span>
              )}
            </button>
          </div>
          <button
            type="button"
            className="btn-premium-highlight btn-premium-abilities"
            onClick={() => setAbilitiesOpen(true)}
          >
            <Zap size={14} className="btn-icon-zap mr-2" />
            <span>Abilities</span>
          </button>
          <Button variant="primary" size="md" iconLeft={<Plus size={14} />} onClick={openCreateAgent}>
            Add agent
          </Button>
        </div>
        </div>
        {total > 0 && (
          <div className="flex flex-wrap items-center gap-2">
            <DomainToolbar
              spaces={spaces}
              agents={agents}
              selected={selectedDomainId}
              onSelect={setSelectedDomainId}
              onCreate={() => { setEditingDomain(null); setDomainEditorOpen(true); }}
              onEdit={(domain) => { setEditingDomain(domain); setDomainEditorOpen(true); }}
            />
            {view === 'fleet' && (
              <AgentFleetHeaderControls
                filter={filter}
                search={search}
                onFilterChange={setFilter}
                onSearchChange={setSearch}
                onClear={() => { setSearch(''); setFilter('all'); }}
              />
            )}
          </div>
        )}
      </div>

      {/* List body */}
      <div className={clsx('min-h-0 flex-1', view === 'fleet' ? 'overflow-hidden px-0 py-0' : 'overflow-y-auto px-6 py-5')}>
        {agents.length === 0 ? (
          <EmptyState
            icon={<Bot size={48} />}
            title="No agents yet"
            body="Create your first agent to start automating work."
            primaryAction={<Button variant="primary" size="md" iconLeft={<Plus size={14} />} onClick={openCreateAgent}>Add agent</Button>}
            variant="page"
          />
        ) : view === 'specialists' ? (
          <SpecialistsView
            specialists={specialistList}
            total={specialistCount}
            search={search}
            onSearch={setSearch}
            onCreate={() => { setCreatingPreset({ role: 'worker' }); setCreating(true); }}
          />
        ) : view === 'fleet' ? (
          <AgentHierarchyCanvas
            agents={domainAgentsForCanvas}
            filter={filter}
            search={search}
            onClearFilters={() => { setSearch(''); setFilter('all'); setSelectedDomainId('all'); }}
            onChanged={() => void refresh()}
            onSelect={(agent) => setSelectedAgent(agent as unknown as AgentRow)}
            selectedAgent={selectedAgent}
            onCloseSelection={() => setSelectedAgent(null)}
            onGhostCreate={(preset) => { setCreatingPreset(preset); setCreating(true); }}
          />
        ) : filteredCount === 0 ? (
          <EmptyState
            icon={<SearchX size={48} />}
            title="No matching agents"
            body="Try adjusting your search or filters."
            primaryAction={<Button variant="secondary" size="sm" onClick={() => { setSearch(''); setFilter('all'); setSelectedDomainId('all'); }}>Clear filters</Button>}
            variant="page"
          />
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
                <AgentTable rows={list} spaces={spaces} onSelect={(id) => nav(`/agents/${id}`)} />
              </div>
            );
          })
        )}
      </div>

      <AgentCreateWizard
        open={creating}
        onClose={() => { setCreating(false); setCreatingPreset(undefined); }}
        onCreated={(agent) => {
          setCreating(false);
          setCreatingPreset(undefined);
          // Specialists open straight into their detail subpage — the "complete"
          // surface where mind (memory & knowledge) and abilities are configured.
          const isSpecialist = agent.role && agent.role !== 'orchestrator' && agent.role !== 'manager';
          if (isSpecialist) {
            void refresh();
            nav(`/agents/${agent.id}?tab=abilities`);
            return;
          }
          // Orchestrator/manager stay on the fleet canvas so users see the
          // "setting up" card + progress. Refresh immediately so it appears.
          void refresh();
          setTimeout(() => {
            setSelectedAgent((current) => current ?? agents.find((a) => a.id === agent.id) ?? { id: agent.id, name: agent.name } as AgentRow);
          }, 300);
        }}
        initialRole={creatingPreset?.role}
        initialSpaceId={creatingPreset?.spaceId ?? null}
        lockInitialRole={Boolean(creatingPreset?.role)}
      />
      <DomainEditorSheet
        open={domainEditorOpen}
        domain={editingDomain}
        managers={managers}
        onClose={() => { setDomainEditorOpen(false); setEditingDomain(null); }}
        onSaved={(domain) => {
          if (domain) setSelectedDomainId(domain.id);
          else setSelectedDomainId('all');
          void refresh();
        }}
      />
      {abilitiesOpen && <AbilitiesModal onClose={() => setAbilitiesOpen(false)} />}
    </div>
  );
}

function DomainToolbar({
  spaces,
  agents,
  selected,
  onSelect,
  onCreate,
  onEdit,
}: {
  spaces: Space[];
  agents: AgentRow[];
  selected: 'all' | 'unassigned' | string;
  onSelect: (value: 'all' | 'unassigned' | string) => void;
  onCreate: () => void;
  onEdit: (space: Space) => void;
}) {
  const [open, setOpen] = useState(false);
  const countFor = (spaceId: string | null) => agents.filter((agent) => !isSpecialistRole(agent.role) && (spaceId === null ? !agent.spaceId : agent.spaceId === spaceId)).length;
  const total = agents.filter((agent) => !isSpecialistRole(agent.role)).length;
  const options: Array<{ value: 'all' | 'unassigned' | string; label: string; count: number; colorHex?: string }> = [
    { value: 'all', label: 'All domains', count: total },
    { value: 'unassigned', label: 'Unassigned', count: countFor(null) },
    ...spaces.map((s) => ({ value: s.id, label: s.name, count: countFor(s.id), colorHex: s.colorHex ?? undefined })),
  ];
  const current = options.find((o) => o.value === selected) ?? options[0]!;
  const selectedSpace = spaces.find((s) => s.id === selected);
  const isActive = selected !== 'all';

  return (
    <div className="flex items-center gap-1.5">
      <div className="relative inline-block">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className={clsx(
            'inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-[12px] font-medium transition-colors select-none',
            isActive ? 'border-accent bg-accent-soft text-accent' : 'border-line bg-surface-2 text-text-secondary hover:bg-surface-3 hover:text-text-primary',
          )}
        >
          {current.colorHex && <span className="h-2 w-2 rounded-full" style={{ backgroundColor: current.colorHex }} />}
          <span className="text-text-muted">Domain:</span>
          <span className={clsx('font-semibold', isActive ? 'text-accent' : 'text-text-primary')}>{current.label}</span>
          <span className="rounded-full bg-surface-3 px-1.5 py-0.5 text-[9px] font-medium text-text-muted">{current.count}</span>
          <ChevronDown size={11} className={clsx('transition-transform', open && 'rotate-180')} />
        </button>
        {open && (
          <>
            <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
            <div className="absolute left-0 top-full z-50 mt-1.5 w-64 origin-top-left rounded-card border border-line bg-surface shadow-modal animate-in fade-in slide-in-from-top-1 duration-150">
              <div className="max-h-[280px] overflow-y-auto py-1">
                {options.map((option) => {
                  const isSel = option.value === selected;
                  return (
                    <button
                      key={option.value}
                      type="button"
                      onClick={() => { onSelect(option.value); setOpen(false); }}
                      className={clsx('flex w-full items-center gap-2 px-3 py-2 text-left text-[12px] transition-colors', isSel ? 'bg-surface-2 text-text-primary font-medium' : 'text-text-secondary hover:bg-surface-2 hover:text-text-primary')}
                    >
                      <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center">{isSel && <Check size={12} className="text-accent" />}</span>
                      {option.colorHex && <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: option.colorHex }} />}
                      <span className="flex-1 truncate">{option.label}</span>
                      <span className="rounded-full bg-surface-3 px-1.5 py-0.5 text-[9px] font-medium text-text-muted">{option.count}</span>
                    </button>
                  );
                })}
              </div>
              <button
                type="button"
                onClick={() => { setOpen(false); onCreate(); }}
                className="flex w-full items-center gap-2 border-t border-line px-3 py-2.5 text-left text-[12px] text-text-secondary hover:bg-surface-2 hover:text-text-primary"
              >
                <Plus size={13} className="text-text-muted" /> New domain
              </button>
            </div>
          </>
        )}
      </div>
      {selectedSpace && (
        <button
          type="button"
          onClick={() => onEdit(selectedSpace)}
          aria-label={`Edit ${selectedSpace.name}`}
          title="Edit domain"
          className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-line bg-surface-2 text-text-muted transition-colors hover:border-accent/45 hover:text-text-primary"
        >
          <SettingsIcon size={13} />
        </button>
      )}
    </div>
  );
}

function AgentFleetHeaderControls({
  filter,
  search,
  onFilterChange,
  onSearchChange,
  onClear,
}: {
  filter: FilterValue;
  search: string;
  onFilterChange: (value: FilterValue) => void;
  onSearchChange: (value: string) => void;
  onClear: () => void;
}) {
  const hasFilters = filter !== 'all' || search.trim().length > 0;
  return (
    <div className="flex min-w-[min(100%,34rem)] flex-1 flex-wrap items-center gap-2">
      <div className="flex flex-wrap gap-1">
        {FILTERS.map((option) => (
          <button
            key={option.value}
            type="button"
            onClick={() => onFilterChange(option.value)}
            className={clsx(
              'inline-flex h-8 items-center rounded-pill border px-3 text-[12px] transition-colors',
              filter === option.value
                ? 'border-accent/45 bg-accent-soft text-accent'
                : 'border-line bg-surface-2 text-text-secondary hover:bg-surface-3 hover:text-text-primary',
            )}
          >
            {option.label}
          </button>
        ))}
      </div>
      <label className="flex h-8 min-w-[220px] flex-1 items-center gap-2 rounded-xl border border-line bg-surface-2 px-2.5 text-text-muted focus-within:border-line-strong focus-within:text-text-primary xl:max-w-sm">
        <Search size={13} />
        <input
          value={search}
          onChange={(event) => onSearchChange(event.target.value)}
          placeholder="Search agents..."
          className="min-w-0 flex-1 bg-transparent text-[12px] text-text-primary outline-none placeholder:text-text-muted"
          aria-label="Search agents"
        />
        {hasFilters && (
          <button
            type="button"
            onClick={onClear}
            aria-label="Clear agent filters"
            className="inline-flex h-5 w-5 items-center justify-center rounded-md text-text-muted hover:bg-surface-3 hover:text-text-primary"
          >
            <X size={12} />
          </button>
        )}
      </label>
    </div>
  );
}

function AgentGridCard({ a }: { a: AgentRow }) {
  const nav = useNavigate();
  const status = a.status ?? 'offline';
  const adapterMissing = !agentHarnessType(a);
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
            {a.spaceName ?? 'No space'} · {agentHarnessLabel(a)}
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

function SpecialistsView({
  specialists,
  total,
  search,
  onSearch,
  onCreate,
}: {
  specialists: AgentRow[];
  total: number;
  search: string;
  onSearch: (value: string) => void;
  onCreate: () => void;
}) {
  if (total === 0) {
    return (
      <EmptyState
        icon={<Sparkles size={48} />}
        title="No specialists yet"
        body="Specialists are expert roles you can route to on demand. Commission one — then feed its mind and attach abilities from its detail page."
        primaryAction={<Button variant="primary" size="md" iconLeft={<Plus size={14} />} onClick={onCreate}>Add specialist</Button>}
        variant="page"
      />
    );
  }
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <label className="flex h-9 min-w-[220px] flex-1 items-center gap-2 rounded-xl border border-line bg-surface-2 px-2.5 text-text-muted focus-within:border-line-strong focus-within:text-text-primary xl:max-w-sm">
          <Search size={13} />
          <input
            value={search}
            onChange={(event) => onSearch(event.target.value)}
            placeholder="Search specialists..."
            className="min-w-0 flex-1 bg-transparent text-[12px] text-text-primary outline-none placeholder:text-text-muted"
            aria-label="Search specialists"
          />
          {search.trim() && (
            <button type="button" onClick={() => onSearch('')} aria-label="Clear search" className="inline-flex h-5 w-5 items-center justify-center rounded-md text-text-muted hover:bg-surface-3 hover:text-text-primary"><X size={12} /></button>
          )}
        </label>
        <Button variant="primary" size="sm" iconLeft={<Plus size={13} />} onClick={onCreate}>Add specialist</Button>
      </div>
      {specialists.length === 0 ? (
        <EmptyState
          icon={<SearchX size={48} />}
          title="No matching specialists"
          body="Try a different search."
          primaryAction={<Button variant="secondary" size="sm" onClick={() => onSearch('')}>Clear search</Button>}
          variant="page"
        />
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {specialists.map((a) => <AgentGridCard key={a.id} a={a} />)}
        </div>
      )}
    </div>
  );
}

function labelize(value: string): string {
  return value
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function formatAgentRole(role: string | null | undefined, spaceId: string | null | undefined, spaceTag: string | null | undefined, spaces: Space[]): string {
  const norm = (role ?? '').toLowerCase();
  if (norm === 'orchestrator') return 'Orchestrator';
  if (norm === 'manager') {
    const space = spaces.find(s => s.id === spaceId);
    if (space?.name?.trim()) {
      return `${labelize(space.name.trim())} Manager`;
    }
    if (spaceTag?.trim()) {
      return `${labelize(spaceTag.trim())} Manager`;
    }
    return 'Manager';
  }
  return 'Agent';
}

function AgentTable({ rows, spaces, onSelect }: { rows: AgentRow[]; spaces: Space[]; onSelect: (id: string) => void }) {
  return (
    <div className="overflow-hidden rounded-card border border-line bg-surface">
      <table className="w-full">
        <thead>
          <tr className="border-b border-line text-[11px] font-medium uppercase tracking-wider text-text-muted">
            <th className="px-4 py-2.5 text-left">Agent</th>
            <th className="px-4 py-2.5 text-left">Role / Domain</th>
            <th className="px-4 py-2.5 text-left">Status</th>
            <th className="px-4 py-2.5 text-left">Harness</th>
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
              <td className="px-4 py-3">
                <span className="text-[12px] font-semibold text-text-primary capitalize">
                  {formatAgentRole(a.role, a.spaceId, a.spaceTag, spaces)}
                </span>
              </td>
              <td className="px-4 py-3"><StatusBadge status={a.status ?? 'offline'} size="sm" /></td>
              <td className="px-4 py-3 text-[12px] text-text-secondary">{agentHarnessLabel(a)}</td>
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

function agentHarnessType(agent: AgentRow) {
  return agent.adapterType ?? agent.adapter?.type ?? '';
}

function agentHarnessLabel(agent: AgentRow) {
  const type = agentHarnessType(agent);
  const model = agent.runtimeModel ?? agent.adapter?.model;
  const label = harnessLabel(type);
  return model ? `${label} · ${model}` : label;
}

function harnessLabel(adapterType: string) {
  switch (adapterType) {
    case 'openclaw': return 'OpenClaw';
    case 'hermes_agent': return 'Hermes Agent';
    case 'claude_code': return 'Claude Code';
    case 'codex': return 'Codex';
    case 'cursor': return 'Cursor';
    case 'http': return 'HTTP / Webhook';
    default: return 'No harness';
  }
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
