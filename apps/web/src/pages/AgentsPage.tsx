/**
 * AgentsPage — hierarchy canvas with table fallback, search, filters, space grouping.
 *
 * The constellation view is killed (per UIUX-REPLAN §7.2). Grid mode
 * shows agent cards; Table mode shows a sortable list. Both group by
 * space when spaces are configured.
 */

import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Bot, Plus, Network, List as ListIcon, Search, SearchX, X, Zap, Sparkles, Download } from 'lucide-react';
import { ImportAgentsWizard } from '../components/agents/ImportAgentsWizard';
import { harnessOf } from '../components/agents/harnessMeta';
import { checkImportUpdates, type ImportUpdate } from '../lib/agentImport';
import clsx from 'clsx';
import { api, workspace as wsStore } from '../lib/api';
import { rtSubscribe, useRealtime } from '../lib/realtime';
import { Button } from '../components/shared/Button';
import { DomainToolbar } from '../components/shared/DomainToolbar';
import { StatusBadge } from '../components/shared/StatusBadge';
import { Skeleton, SkeletonCard } from '../components/shared/Skeleton';
import { EmptyState } from '../components/shared/EmptyState';
import { AgentCreateWizard } from '../components/agents/AgentCreateWizard';
import { AgentHierarchyCanvas } from '../components/agents/AgentHierarchyCanvas';
import type { AgentHierarchyCreatePreset } from '../components/agents/AgentHierarchyCanvas';
import { DomainEditorSheet, type DomainOption } from '../components/agents/DomainEditorSheet';
import { REALTIME_EVENTS, isSpecialistRole } from '@agentis/core';

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
  importOrigin?: { adapterType: string; externalId: string } | null;
}

interface Space extends DomainOption {}

type View = 'fleet' | 'table';
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
      return stored === 'table' ? stored : 'fleet';
    } catch { return 'fleet'; }
  });
  const [creating, setCreating] = useState(false);
  const [importingAgents, setImportingAgents] = useState(false);
  const [creatingPreset, setCreatingPreset] = useState<AgentHierarchyCreatePreset | undefined>(undefined);
  const [selectedDomainId, setSelectedDomainId] = useState<'all' | 'unassigned' | string>('all');
  const [editingDomain, setEditingDomain] = useState<Space | null>(null);
  const [domainEditorOpen, setDomainEditorOpen] = useState(false);
  // Stacked subdomain editor (opened from the domain editor or the toolbar).
  const [editingSubdomain, setEditingSubdomain] = useState<Space | null>(null);
  const [addingSubdomainParent, setAddingSubdomainParent] = useState<string | null>(null);
  const [subdomainEditorOpen, setSubdomainEditorOpen] = useState(false);
  // When creating a specialist to OWN a subdomain, remember which one to assign.
  const [pendingOwnerSubdomain, setPendingOwnerSubdomain] = useState<{ subdomainId: string; parentManagerId: string | null } | null>(null);
  const [creatingReportsTo, setCreatingReportsTo] = useState<string | null>(null);
  const [filter, setFilter] = useState<FilterValue>('all');
  const [search, setSearch] = useState('');
  const [selectedAgent, setSelectedAgent] = useState<AgentRow | null>(null);
  // §AGENT-TRANSITION P4 — ambient surface for the continuous harness sync: new
  // memory accrued by already-imported agents, ready to pull (approval-gated).
  const [importUpdates, setImportUpdates] = useState<ImportUpdate[]>([]);
  const [dismissedUpdates, setDismissedUpdates] = useState(false);

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
        api<{ data: Space[] }>('/v1/domains'),
      ]);
      if (aRes.status === 'fulfilled') setAgents(aRes.value.agents ?? []);
      if (sRes.status === 'fulfilled') setSpaces(sRes.value.data ?? []);
    } finally {
      setLoading(false);
    }
  }

  async function loadImportUpdates() {
    try {
      const res = await checkImportUpdates();
      const updates = res?.updates ?? [];
      setImportUpdates(updates);
      if (updates.length > 0) setDismissedUpdates(false);
    } catch { /* best-effort — the banner just stays hidden */ }
  }

  useEffect(() => {
    const ws = wsStore.get();
    const unsubscribe = ws ? rtSubscribe('workspace', { workspaceId: ws }) : undefined;
    void refresh();
    void loadImportUpdates();
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

  // The 6h continuous-sync service emits this when imported agents accrue new
  // harness memory — refresh the banner so the operator can pull it in.
  useRealtime([REALTIME_EVENTS.HARNESS_IMPORT_UPDATES], () => { void loadImportUpdates(); });

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
    // Hierarchy canvas shows orchestrators, managers, and specialists.
    const fleet = agents;
    if (selectedDomainId === 'all') return fleet;
    return fleet.filter((agent) => {
      if (agent.role === 'orchestrator') return true;
      if (selectedDomainId === 'unassigned') return !agent.spaceId;
      return agent.spaceId === selectedDomainId;
    });
  }, [agents, selectedDomainId]);

  const filteredAgents = useMemo(() => {
    return agents.filter((a) => {
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
      if (isSpecialistRole(a.role)) continue;
      const k = a.spaceId ?? '__ungrouped__';
      if (!bySpace.has(k)) bySpace.set(k, []);
      bySpace.get(k)!.push(a);
    }
    return bySpace;
  }, [filteredAgents]);

  const tableSpecialists = useMemo(() => filteredAgents.filter(a => isSpecialistRole(a.role)), [filteredAgents]);

  const total = agents.filter((a) => !isSpecialistRole(a.role)).length;
  const filteredCount = filteredAgents.length;
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

  // Manager-owned org: split Domains from Subdomains (a domain row with a parent).
  const topDomains = useMemo(() => spaces.filter((s) => !s.parentDomainId), [spaces]);
  const subdomainsByParent = useMemo(() => {
    const map = new Map<string, Space[]>();
    for (const s of spaces) {
      if (!s.parentDomainId) continue;
      (map.get(s.parentDomainId) ?? map.set(s.parentDomainId, []).get(s.parentDomainId)!).push(s);
    }
    return map;
  }, [spaces]);
  const specialistOptions = useMemo(
    () => agents.filter((a) => isSpecialistRole(a.role)).map((a) => ({ id: a.id, name: a.name, role: a.role ?? null })),
    [agents],
  );
  const resolveAgentName = (id: string | null | undefined) => (id ? agents.find((a) => a.id === id)?.name : undefined);
  const specialistCountFor = (subdomainId: string) =>
    agents.filter((a) => a.spaceId === subdomainId && isSpecialistRole(a.role)).length;

  function openAddSubdomain(parentDomainId: string) {
    setEditingSubdomain(null);
    setAddingSubdomainParent(parentDomainId);
    setSubdomainEditorOpen(true);
  }
  function openEditDomainOrSubdomain(target: Space) {
    if (target.parentDomainId) { openEditSubdomain(target); return; }
    setEditingDomain(target);
    setDomainEditorOpen(true);
  }
  function openEditSubdomain(sub: Space) {
    setEditingSubdomain(sub);
    setAddingSubdomainParent(null);
    setSubdomainEditorOpen(true);
  }
  function handleCreateSpecialistForSubdomain(ctx: { subdomainId: string; parentManagerId: string | null }) {
    setSubdomainEditorOpen(false);
    setDomainEditorOpen(false);
    setPendingOwnerSubdomain(ctx);
    setCreatingPreset({ role: 'worker', spaceId: ctx.subdomainId });
    setCreatingReportsTo(ctx.parentManagerId);
    setCreating(true);
  }

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
          </div>
          <Button variant="secondary" size="md" iconLeft={<Download size={14} />} onClick={() => setImportingAgents(true)}>
            Import agents
          </Button>
          <Button variant="primary" size="md" iconLeft={<Plus size={14} />} onClick={openCreateAgent}>
            Add agent
          </Button>
        </div>
        </div>
        {total > 0 && (
          <div className="flex flex-wrap items-center gap-2">
            <DomainToolbar
              domains={spaces}
              selected={selectedDomainId}
              onSelect={setSelectedDomainId}
              totalCount={total}
              countForDomain={(spaceId) => agents.filter((agent) => (spaceId === null ? !agent.spaceId : agent.spaceId === spaceId)).length}
              onCreate={() => { setEditingDomain(null); setDomainEditorOpen(true); }}
              onEdit={(domain) => openEditDomainOrSubdomain(domain)}
              onAddSubdomain={openAddSubdomain}
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

      {importUpdates.length > 0 && !dismissedUpdates && (
        <ImportUpdatesBanner
          updates={importUpdates}
          onReview={() => setImportingAgents(true)}
          onDismiss={() => setDismissedUpdates(true)}
        />
      )}

      {/* List body */}
      <div className={clsx('min-h-0 flex-1', view === 'fleet' ? 'overflow-hidden px-0 py-0' : 'overflow-y-auto px-6 py-5')}>
        {agents.length === 0 ? (
          <EmptyState
            icon={<Bot size={48} />}
            title="No agents yet"
            body="Create your first agent — or bring in agents you already run outside Agentis, with their memory."
            primaryAction={<Button variant="primary" size="md" iconLeft={<Plus size={14} />} onClick={openCreateAgent}>Add agent</Button>}
            secondaryAction={<Button variant="secondary" size="md" iconLeft={<Download size={14} />} onClick={() => setImportingAgents(true)}>Import existing agents</Button>}
            variant="page"
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
          <>
            {Array.from(grouped.entries()).map(([spaceKey, list]) => {
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
            })}
            {tableSpecialists.length > 0 && (
              <div key="specialists" className="mb-8 last:mb-0">
                <div className="mb-3 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-text-muted">
                  <Sparkles size={12} className="text-text-muted" />
                  Specialist Bench
                  <span className="text-[10px] font-normal normal-case tracking-normal text-text-muted">· {tableSpecialists.length}</span>
                </div>
                <AgentTable rows={tableSpecialists} spaces={spaces} onSelect={(id) => nav(`/agents/${id}`)} />
              </div>
            )}
          </>
        )}
      </div>

      <AgentCreateWizard
        open={creating}
        onClose={() => { setCreating(false); setCreatingPreset(undefined); setCreatingReportsTo(null); setPendingOwnerSubdomain(null); }}
        onCreated={async (agent) => {
          setCreating(false);
          setCreatingPreset(undefined);
          setCreatingReportsTo(null);
          const ownerCtx = pendingOwnerSubdomain;
          setPendingOwnerSubdomain(null);
          // Created to OWN a subdomain: assign it as the subdomain's specialist,
          // then reopen the parent domain editor so the owner shows in its list.
          if (ownerCtx) {
            try {
              await api(`/v1/domains/${ownerCtx.subdomainId}`, { method: 'PATCH', body: JSON.stringify({ managerId: agent.id }) });
            } catch { /* best-effort owner assignment */ }
            await refresh();
            if (editingDomain) setDomainEditorOpen(true);
            return;
          }
          // Specialists open straight into their detail subpage — the "complete"
          // surface where mind (memory & knowledge) is configured.
          const isSpecialist = agent.role && agent.role !== 'orchestrator' && agent.role !== 'manager';
          if (isSpecialist) {
            void refresh();
            nav(`/agents/${agent.id}?tab=knowledge`);
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
        initialReportsTo={creatingReportsTo}
        lockInitialRole={Boolean(creatingPreset?.role)}
      />
      <DomainEditorSheet
        open={domainEditorOpen}
        domain={editingDomain}
        managers={managers}
        parentOptions={topDomains}
        specialists={specialistOptions}
        subdomains={editingDomain ? (subdomainsByParent.get(editingDomain.id) ?? []) : []}
        resolveAgentName={resolveAgentName}
        specialistCountFor={specialistCountFor}
        onAddSubdomain={() => { if (editingDomain) openAddSubdomain(editingDomain.id); }}
        onEditSubdomain={(sub) => openEditSubdomain(sub as Space)}
        onClose={() => { setDomainEditorOpen(false); setEditingDomain(null); }}
        onSaved={(domain) => {
          if (domain) setSelectedDomainId(domain.id);
          else setSelectedDomainId('all');
          void refresh();
        }}
      />
      <DomainEditorSheet
        open={subdomainEditorOpen}
        domain={editingSubdomain}
        initialParentDomainId={addingSubdomainParent}
        managers={managers}
        parentOptions={topDomains}
        specialists={specialistOptions}
        onCreateSpecialist={handleCreateSpecialistForSubdomain}
        onClose={() => { setSubdomainEditorOpen(false); setEditingSubdomain(null); setAddingSubdomainParent(null); }}
        onSaved={(domain) => {
          if (domain) setSelectedDomainId(domain.id);
          void refresh();
        }}
      />
      <ImportAgentsWizard
        open={importingAgents}
        onClose={() => setImportingAgents(false)}
        onImported={() => void refresh()}
      />
    </div>
  );
}

/**
 * Ambient surface for the continuous harness sync — shows when imported agents
 * have accrued new memory/skills upstream, with the harness logos and a single
 * approval-gated "Review & pull" CTA into the import wizard.
 */
function ImportUpdatesBanner({
  updates,
  onReview,
  onDismiss,
}: {
  updates: ImportUpdate[];
  onReview: () => void;
  onDismiss: () => void;
}) {
  const totalMemories = updates.reduce((sum, u) => sum + (u.pendingMemory ?? u.pendingNew ?? 0), 0);
  const totalSkills = updates.reduce((sum, u) => sum + (u.pendingSkills ?? 0), 0);
  const harnesses = Array.from(new Set(updates.map((u) => u.adapterType)));
  const parts: string[] = [];
  if (totalMemories > 0) parts.push(`${totalMemories} new ${totalMemories === 1 ? 'memory' : 'memories'}`);
  if (totalSkills > 0) parts.push(`${totalSkills} new ${totalSkills === 1 ? 'skill' : 'skills'}`);
  return (
    <div className="flex flex-wrap items-center gap-3 border-b border-accent/30 bg-accent-soft/60 px-6 py-2.5">
      <div className="flex items-center gap-1.5">
        {harnesses.map((type) => {
          const { Icon, label } = harnessOf(type);
          return <Icon key={type} className="h-4 w-4 text-text-secondary" aria-label={label} />;
        })}
      </div>
      <div className="text-[13px] text-text-primary">
        <span className="font-semibold">{parts.join(' · ') || 'New memory'}</span>
        <span className="text-text-secondary">
          {' '}from {updates.length} imported {updates.length === 1 ? 'agent' : 'agents'} — pull it into Agentis Brain.
        </span>
      </div>
      <div className="ml-auto flex items-center gap-2">
        <Button variant="primary" size="sm" iconLeft={<Download size={13} />} onClick={onReview}>
          Review &amp; pull
        </Button>
        <button
          type="button"
          aria-label="Dismiss"
          onClick={onDismiss}
          className="rounded-btn p-1 text-text-muted hover:bg-surface-2 hover:text-text-primary"
        >
          <X size={14} />
        </button>
      </div>
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
  if (norm === 'worker') return 'Specialist';
  if (norm) return labelize(norm);
  return 'Specialist';
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
    case 'antigravity': return 'Antigravity CLI';
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

