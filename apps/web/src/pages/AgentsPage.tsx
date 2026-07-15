/**
 * AgentsPage — hierarchy canvas with table fallback, search, filters, space grouping.
 *
 * The constellation view is killed (per UIUX-REPLAN §7.2). Grid mode
 * shows agent cards; Table mode shows a sortable list. Both group by
 * space when spaces are configured.
 */

import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Bot, Plus, Network, List as ListIcon, Search, SearchX, X, Zap, Sparkles, ChevronDown, FolderInput, PackagePlus, UserPlus, Brain as BrainIcon, SlidersHorizontal } from 'lucide-react';
import { InfoHint } from '../components/shared/InfoHint';
import { ImportAgentsWizard } from '../components/agents/ImportAgentsWizard';
import { checkImportUpdates, type ImportUpdate } from '../lib/agentImport';
import clsx from 'clsx';
import { api, apiCached, apiErrorMessage, peekCached, workspace as wsStore } from '../lib/api';
import { rtSubscribe, useRealtime } from '../lib/realtime';
import { Button } from '../components/shared/Button';
import { useToast } from '../components/shared/Toast';
import { DomainToolbar } from '../components/shared/DomainToolbar';
import { Skeleton, SkeletonCard } from '../components/shared/Skeleton';
import { EmptyState } from '../components/shared/EmptyState';
import { AgentCreateWizard } from '../components/agents/AgentCreateWizard';
import { AgentHierarchyCanvas } from '../components/agents/AgentHierarchyCanvas';
import type { AgentHierarchyCreatePreset } from '../components/agents/AgentHierarchyCanvas';
import { agentImportSetupToOverrides, createDefaultAgentImportSetup } from '../components/agents/AgentImportSetupPanel';
import { DomainEditorSheet } from '../components/agents/DomainEditorSheet';
import {
  AgentPackageSetupModal,
  AgentTable,
  ImportUpdatesBanner,
  agentHarnessType,
  type AgentRow,
  type PendingAgentPackageImport,
  type Space,
} from '../components/agents/AgentsPageSupport';
import { REALTIME_EVENTS, isSpecialistRole } from '@agentis/core';
import { AgentBrainPanel, type AgentBrainView } from '../components/brain/AgentBrainPanel';

type View = 'fleet' | 'table';
type AgentsSurface = 'agents' | 'brain';
type FilterValue = 'all' | 'active' | 'idle' | 'setup_needed';
const AGENT_BRAIN_VIEWS = new Set<AgentBrainView>(['map', 'memory', 'knowledge', 'skills', 'examples']);

const FILTERS = [
  { value: 'all', label: 'All' },
  { value: 'active', label: 'Active' },
  { value: 'idle', label: 'Idle' },
  { value: 'setup_needed', label: 'Setup needed' },
] as const satisfies ReadonlyArray<{ value: FilterValue; label: string }>;

function passesFilter(a: AgentRow, f: FilterValue): boolean {
  if (f === 'all') return true;
  const status = (a.status ?? '').toLowerCase();
  if (f === 'active') return status === 'online' || status === 'active' || status === 'running';
  if (f === 'idle') return status === 'idle' || status === 'paused' || status === 'offline';
  if (f === 'setup_needed') return !agentHarnessType(a);
  return true;
}

/** The two surfaces: the Fleet canvas and the agent Brain. */
function AgentsSurfaceToggle({ value, onChange }: { value: AgentsSurface; onChange: (value: AgentsSurface) => void }) {
  return (
    <div className="flex h-9 shrink-0 items-center gap-0.5 rounded-lg border border-line bg-surface-2/90 p-0.5 backdrop-blur-md">
      <button
        type="button"
        onClick={() => onChange('agents')}
        className={clsx(
          'inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-[12px] transition-colors',
          value === 'agents' ? 'bg-surface-3 text-text-primary' : 'text-text-muted hover:text-text-primary',
        )}
      >
        <Network size={13} /> Fleet
      </button>
      <button
        type="button"
        onClick={() => onChange('brain')}
        className={clsx(
          'inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-[12px] transition-colors',
          value === 'brain' ? 'bg-surface-3 text-text-primary' : 'text-text-muted hover:text-text-primary',
        )}
      >
        <BrainIcon size={13} /> Brain
      </button>
    </div>
  );
}

/** Canvas vs List layout choice inside the config popover. */
function LayoutOption({ active, icon, label, onClick }: { active: boolean; icon: ReactNode; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={clsx(
        'inline-flex h-8 flex-1 items-center justify-center gap-1.5 rounded-md border text-[11px] transition-colors',
        active ? 'border-accent/45 bg-accent-soft text-accent' : 'border-line bg-surface-2 text-text-secondary hover:bg-surface-3 hover:text-text-primary',
      )}
    >
      {icon} {label}
    </button>
  );
}

function AddAgentMenu({
  open,
  busy,
  menuRef,
  onToggle,
  onCreate,
  onImportExisting,
  onImportPackage,
}: {
  open: boolean;
  busy: boolean;
  menuRef: RefObject<HTMLDivElement>;
  onToggle: () => void;
  onCreate: () => void;
  onImportExisting: () => void;
  onImportPackage: () => void;
}) {
  return (
    <div ref={menuRef} className="relative flex items-center">
      <button
        type="button"
        onClick={onToggle}
        aria-haspopup="menu"
        aria-expanded={open}
        className="inline-flex h-9 items-center gap-1.5 rounded-l-lg bg-accent pl-3 pr-2.5 text-[12px] font-semibold text-canvas hover:bg-accent-hover"
      >
        <Plus size={14} /> Add agent
      </button>
      <button
        type="button"
        onClick={onToggle}
        aria-label="More create options"
        aria-haspopup="menu"
        aria-expanded={open}
        className="inline-flex h-9 items-center rounded-r-lg border-l border-canvas/25 bg-accent px-1.5 text-canvas hover:bg-accent-hover"
      >
        <ChevronDown size={14} className={clsx('transition-transform', open && 'rotate-180')} />
      </button>
      {open && (
        <div
          role="menu"
          aria-label="Add agent options"
          className="absolute right-0 top-[calc(100%+0.4rem)] z-40 w-56 overflow-hidden rounded-card border border-line bg-surface p-1 shadow-dropdown"
        >
          <AddAgentMenuItem
            icon={<UserPlus size={13} />}
            title="New agent"
            info="Commission an orchestrator, manager, or specialist."
            onClick={onCreate}
          />
          <AddAgentMenuItem
            icon={<FolderInput size={13} />}
            title="Import existing agent"
            info="Bring a local agent into Agentis with its identity, memory, and skills."
            onClick={onImportExisting}
          />
          <AddAgentMenuItem
            icon={<PackagePlus size={13} />}
            title={busy ? 'Importing agent package...' : 'Import agent package'}
            info="Install a portable .agentisagt package into this workspace."
            onClick={onImportPackage}
            disabled={busy}
          />
        </div>
      )}
    </div>
  );
}

function AddAgentMenuItem({
  icon,
  title,
  info,
  onClick,
  disabled = false,
}: {
  icon: ReactNode;
  title: string;
  info: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      onClick={onClick}
      className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-[12px] text-text-secondary transition-colors hover:bg-surface-2 hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-60"
    >
      {icon}
      <span className="min-w-0 flex-1">{title}</span>
      <InfoHint text={info} />
    </button>
  );
}

export function AgentsPage() {
  const nav = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const toast = useToast();
  const addMenuRef = useRef<HTMLDivElement>(null);
  const agentPackageInputRef = useRef<HTMLInputElement>(null);
  const [agents, setAgents] = useState<AgentRow[]>(() => peekCached<{ agents: AgentRow[] }>('/v1/agents')?.agents ?? []);
  const [spaces, setSpaces] = useState<Space[]>(() => peekCached<{ data: Space[] }>('/v1/domains')?.data ?? []);
  // Only block on a spinner when nothing is cached; a revisit paints instantly
  // and revalidates silently in the background.
  const [loading, setLoading] = useState(() => peekCached('/v1/agents') === undefined);
  const [view, setView] = useState<View>(() => {
    try {
      // Legacy value 'canvas' migrates to 'fleet' (AGENTS-PAGE-REDESIGN.md §1.1).
      const stored = localStorage.getItem('agentis.agents.view');
      return stored === 'table' ? stored : 'fleet';
    } catch { return 'fleet'; }
  });
  const [creating, setCreating] = useState(false);
  const [importingAgents, setImportingAgents] = useState(false);
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const [importingAgentPackage, setImportingAgentPackage] = useState(false);
  const [pendingAgentPackage, setPendingAgentPackage] = useState<PendingAgentPackageImport | null>(null);
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
  // Canvas floating controls: search collapses to an icon, view options (status
  // + Canvas/List layout) live behind a config popover.
  const [searchOpen, setSearchOpen] = useState(false);
  const [configOpen, setConfigOpen] = useState(false);
  const configRef = useRef<HTMLDivElement>(null);
  const [selectedAgent, setSelectedAgent] = useState<AgentRow | null>(null);
  // §AGENT-TRANSITION P4 — ambient surface for the continuous harness sync: new
  // memory accrued by already-imported agents, ready to pull (approval-gated).
  const [importUpdates, setImportUpdates] = useState<ImportUpdate[]>([]);
  const [dismissedUpdates, setDismissedUpdates] = useState(false);
  const surface: AgentsSurface = searchParams.get('tab') === 'brain' ? 'brain' : 'agents';
  const brainAgentId = searchParams.get('agentId') || null;
  const rawBrainTab = searchParams.get('brainTab');
  const brainView: AgentBrainView = rawBrainTab && AGENT_BRAIN_VIEWS.has(rawBrainTab as AgentBrainView)
    ? rawBrainTab as AgentBrainView
    : 'map';

  function patchQuery(patch: Record<string, string | null>, replace = true) {
    const next = new URLSearchParams(searchParams);
    for (const [key, value] of Object.entries(patch)) {
      if (value === null) next.delete(key);
      else next.set(key, value);
    }
    setSearchParams(next, { replace });
  }

  function setSurface(next: AgentsSurface) {
    if (next === 'brain') {
      patchQuery({ tab: 'brain' });
      return;
    }
    patchQuery({ tab: null, agentId: null, brainTab: null });
  }

  function setBrainAgentId(id: string) {
    patchQuery({ tab: 'brain', agentId: id });
  }

  function setBrainView(next: AgentBrainView) {
    patchQuery({ tab: 'brain', brainTab: next === 'map' ? null : next });
  }

  useEffect(() => {
    try { localStorage.setItem('agentis.agents.view', view); } catch { /* ignore */ }
  }, [view]);

  useEffect(() => {
    if (!addMenuOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!addMenuRef.current?.contains(event.target as Node)) setAddMenuOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setAddMenuOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [addMenuOpen]);

  useEffect(() => {
    if (!configOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!configRef.current?.contains(event.target as Node)) setConfigOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setConfigOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [configOpen]);

  useEffect(() => {
    // The quick-detail panel is canvas-only; drop the selection off-canvas.
    if (view !== 'fleet') setSelectedAgent(null);
  }, [view]);

  useEffect(() => {
    setSelectedAgent((current) => current ? agents.find((agent) => agent.id === current.id) ?? current : null);
  }, [agents]);

  async function refresh() {
    // Silent revalidation when we already have cached data on screen.
    if (peekCached('/v1/agents') === undefined) setLoading(true);
    try {
      const [aRes, sRes] = await Promise.allSettled([
        apiCached<{ agents: AgentRow[] }>('/v1/agents'),
        apiCached<{ data: Space[] }>('/v1/domains'),
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
    } catch {  }
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
    setAddMenuOpen(false);
    const spaceId = selectedDomainId !== 'all' && selectedDomainId !== 'unassigned' ? selectedDomainId : null;
    setCreatingPreset(spaceId ? { role: 'manager', spaceId } : undefined);
    setCreating(true);
  }

  function openExistingAgentImport() {
    setAddMenuOpen(false);
    setImportingAgents(true);
  }

  function openAgentPackagePicker() {
    setAddMenuOpen(false);
    agentPackageInputRef.current?.click();
  }

  async function handleImportAgentPackageFile(file?: File | null) {
    if (!file) return;
    try {
      const raw = JSON.parse(await file.text()) as Record<string, unknown>;
      const manifest = 'manifest' in raw
        ? raw.manifest
        : 'packageManifest' in raw
          ? raw.packageManifest
          : raw;
      const manifestObj = manifest && typeof manifest === 'object' ? manifest as Record<string, unknown> : null;
      const contents = manifestObj?.contents && typeof manifestObj.contents === 'object'
        ? manifestObj.contents as Record<string, unknown>
        : null;
      if (manifestObj?.kind !== 'agent' && contents?.kind !== 'agent') {
        throw new Error('Choose an Agentis agent package (.agentisagt).');
      }
      const agent = contents?.agent && typeof contents.agent === 'object'
        ? contents.agent as Record<string, unknown>
        : {};
      setPendingAgentPackage({
        fileName: file.name,
        manifest,
        packageName: typeof manifestObj?.name === 'string' ? manifestObj.name : file.name,
        packageDescription: typeof manifestObj?.description === 'string' ? manifestObj.description : null,
        setup: createDefaultAgentImportSetup({
          name: typeof agent.name === 'string' ? agent.name : file.name.replace(/\.[^.]+$/, ''),
          role: typeof agent.role === 'string' ? agent.role : null,
          existingAgents: agents,
          preferOrchestratorWhenEmpty: agents.length === 0,
        }),
      });
    } catch (error) {
      toast.error('Agent package import failed', apiErrorMessage(error));
    } finally {
      if (agentPackageInputRef.current) agentPackageInputRef.current.value = '';
    }
  }

  async function installPendingAgentPackage() {
    if (!pendingAgentPackage) return;
    setImportingAgentPackage(true);
    try {
      const imported = await api<{ agentId?: string }>('/v1/packages/import', {
        method: 'POST',
        body: JSON.stringify({
          manifest: pendingAgentPackage.manifest,
          overrides: { agent: agentImportSetupToOverrides(pendingAgentPackage.setup) },
        }),
      });
      toast.success('Agent package imported', pendingAgentPackage.fileName);
      setPendingAgentPackage(null);
      await refresh();
      if (imported.agentId) nav(`/agents?tab=brain&agentId=${encodeURIComponent(imported.agentId)}`);
    } catch (error) {
      toast.error('Agent package import failed', apiErrorMessage(error));
    } finally {
      setImportingAgentPackage(false);
    }
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

  const filterActive = filter !== 'all';

  // ── Left cluster: scope & find (search · domain · view-options popover). ──
  const scopeCluster = (
    <div className="flex h-9 items-center gap-1 rounded-lg border border-line bg-surface-2/90 px-1 backdrop-blur-md">
      {searchOpen ? (
        <div className="flex items-center gap-1.5 pl-1.5">
          <Search size={14} className="shrink-0 text-text-muted" />
          <input
            autoFocus
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            onBlur={() => { if (!search.trim()) setSearchOpen(false); }}
            onKeyDown={(event) => { if (event.key === 'Escape') { setSearch(''); setSearchOpen(false); } }}
            placeholder="Search agents..."
            aria-label="Search agents"
            className="w-40 bg-transparent text-[12px] text-text-primary outline-none placeholder:text-text-muted"
          />
          <button
            type="button"
            aria-label="Clear search"
            onClick={() => { setSearch(''); setSearchOpen(false); }}
            className="inline-flex h-6 w-6 items-center justify-center rounded-md text-text-muted hover:bg-surface-3 hover:text-text-primary"
          >
            <X size={13} />
          </button>
        </div>
      ) : (
        <button
          type="button"
          aria-label="Search agents"
          onClick={() => setSearchOpen(true)}
          className={clsx(
            'inline-flex h-7 w-7 items-center justify-center rounded-md transition-colors hover:bg-surface-3',
            search.trim() ? 'text-accent' : 'text-text-muted hover:text-text-primary',
          )}
        >
          <Search size={15} />
        </button>
      )}
      <span className="h-4 w-px shrink-0 bg-line" />
      <DomainToolbar
        embedded
        domains={spaces}
        selected={selectedDomainId}
        onSelect={setSelectedDomainId}
        totalCount={total}
        countForDomain={(spaceId) => agents.filter((agent) => (spaceId === null ? !agent.spaceId : agent.spaceId === spaceId)).length}
        onCreate={() => { setEditingDomain(null); setDomainEditorOpen(true); }}
        onEdit={(domain) => openEditDomainOrSubdomain(domain)}
        onAddSubdomain={openAddSubdomain}
      />
      <span className="h-4 w-px shrink-0 bg-line" />
      <div className="relative" ref={configRef}>
        <button
          type="button"
          aria-label="View options"
          onClick={() => setConfigOpen((open) => !open)}
          className={clsx(
            'relative inline-flex h-7 w-7 items-center justify-center rounded-md transition-colors',
            configOpen ? 'bg-surface-3 text-text-primary' : 'text-text-muted hover:bg-surface-3 hover:text-text-primary',
          )}
        >
          <SlidersHorizontal size={15} />
          {filterActive && <span className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-accent" />}
        </button>
        {configOpen && (
          <div className="absolute left-0 top-full z-50 mt-1.5 w-56 origin-top-left rounded-card border border-line bg-surface p-3 shadow-modal animate-in fade-in slide-in-from-top-1 duration-150">
            <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-text-muted">Status</div>
            <div className="mb-3 flex flex-wrap gap-1.5">
              {FILTERS.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => setFilter(option.value)}
                  className={clsx(
                    'inline-flex h-7 items-center rounded-pill border px-2.5 text-[11px] transition-colors',
                    filter === option.value
                      ? 'border-accent/45 bg-accent-soft text-accent'
                      : 'border-line bg-surface-2 text-text-secondary hover:bg-surface-3 hover:text-text-primary',
                  )}
                >
                  {option.label}
                </button>
              ))}
            </div>
            <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-text-muted">Layout</div>
            <div className="flex gap-1.5">
              <LayoutOption active={view === 'fleet'} icon={<Network size={14} />} label="Canvas" onClick={() => setView('fleet')} />
              <LayoutOption active={view === 'table'} icon={<ListIcon size={14} />} label="List" onClick={() => setView('table')} />
            </div>
          </div>
        )}
      </div>
    </div>
  );

  // ── Right cluster: the two surfaces + the one primary action. ────────────
  const surfaceCluster = (
    <>
      <AgentsSurfaceToggle value={surface} onChange={setSurface} />
      <AddAgentMenu
        open={addMenuOpen}
        busy={importingAgentPackage}
        menuRef={addMenuRef}
        onToggle={() => setAddMenuOpen((open) => !open)}
        onCreate={openCreateAgent}
        onImportExisting={openExistingAgentImport}
        onImportPackage={openAgentPackagePicker}
      />
    </>
  );

  const groupedTables = (
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
  );

  return (
    <div className="flex h-full flex-col">
      <input
        ref={agentPackageInputRef}
        type="file"
        accept=".agentisagt,.agentis,.json,application/json"
        className="hidden"
        onChange={(event) => { void handleImportAgentPackageFile(event.target.files?.[0] ?? null); }}
      />

      {importUpdates.length > 0 && !dismissedUpdates && (
        <ImportUpdatesBanner
          updates={importUpdates}
          onReview={() => setImportingAgents(true)}
          onDismiss={() => setDismissedUpdates(true)}
        />
      )}

      {/* Body — controls float on the canvas; no page header. */}
      <div className="relative min-h-0 flex-1 overflow-hidden">
        {agents.length === 0 ? (
          <div className="h-full overflow-y-auto px-6 py-5">
            <EmptyState
              icon={<Bot size={48} />}
              title="No agents yet"
              body="Create your first agent — or bring in agents you already run outside Agentis, with their memory."
              primaryAction={<Button variant="primary" size="md" iconLeft={<Plus size={14} />} onClick={openCreateAgent}>Add agent</Button>}
              secondaryAction={<Button variant="secondary" size="md" iconLeft={<FolderInput size={14} />} onClick={openExistingAgentImport}>Import existing agent</Button>}
              variant="page"
            />
          </div>
        ) : surface === 'brain' ? (
          <AgentBrainPanel
            agents={agents}
            selectedAgentId={brainAgentId}
            onSelectedAgentIdChange={setBrainAgentId}
            view={brainView}
            onViewChange={setBrainView}
            importUpdates={importUpdates}
            topRightSlot={surfaceCluster}
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
            topLeftSlot={scopeCluster}
            topRightSlot={surfaceCluster}
          />
        ) : (
          <div className="flex h-full flex-col">
            <div className="flex flex-wrap items-center gap-2 px-4 py-2.5">
              <div className="flex min-w-0 items-center gap-2">{scopeCluster}</div>
              <div className="ml-auto flex shrink-0 items-center gap-2">{surfaceCluster}</div>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-5">
              {filteredCount === 0 ? (
                <EmptyState
                  icon={<SearchX size={48} />}
                  title="No matching agents"
                  body="Try adjusting your search or filters."
                  primaryAction={<Button variant="secondary" size="sm" onClick={() => { setSearch(''); setFilter('all'); setSelectedDomainId('all'); }}>Clear filters</Button>}
                  variant="page"
                />
              ) : (
                groupedTables
              )}
            </div>
          </div>
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
            } catch {  }
            await refresh();
            if (editingDomain) setDomainEditorOpen(true);
            return;
          }
          // Specialists open straight into their detail subpage — the "complete"
          // surface where mind (memory & knowledge) is configured.
          const isSpecialist = agent.role && agent.role !== 'orchestrator' && agent.role !== 'manager';
          if (isSpecialist) {
            void refresh();
            nav(`/agents?tab=brain&agentId=${encodeURIComponent(agent.id)}&brainTab=knowledge`);
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
        existingAgents={agents}
      />
      <AgentPackageSetupModal
        pending={pendingAgentPackage}
        existingAgents={agents}
        installing={importingAgentPackage}
        onChange={(setup) => setPendingAgentPackage((current) => current ? { ...current, setup } : current)}
        onInstall={() => void installPendingAgentPackage()}
        onClose={() => { if (!importingAgentPackage) setPendingAgentPackage(null); }}
      />
    </div>
  );
}


