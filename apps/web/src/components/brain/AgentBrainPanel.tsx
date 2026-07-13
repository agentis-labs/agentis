import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { BookOpen, Check, ChevronDown, Download, FileCode, Network, NotebookPen, RefreshCw, Search, Sparkles, type LucideIcon } from 'lucide-react';
import { RoleGlyph } from '../agents/AgentRoleGlyphs';
import clsx from 'clsx';
import { api, apiErrorMessage, workspace as wsStore } from '../../lib/api';
import { harnessOf } from '../agents/harnessMeta';
import { importAgents, checkImportUpdates, type ImportUpdate } from '../../lib/agentImport';
import { useToast } from '../shared/Toast';
import { useConfirm } from '../shared/ConfirmDialog';
import { ScopedBrainMap } from './ScopedBrainMap';
import { KnowledgeTab } from '../knowledge/KnowledgeTab';
import { ScopeVisibilityToggle } from './ScopeVisibilityToggle';
import { SkillsTab } from './SkillsTab';
import { ExamplesTab } from './ExamplesTab';
import { WorkspaceMemoryTab } from '../knowledge/WorkspaceMemoryTab';
import { EpisodesTab } from '../knowledge/EpisodesTab';
import { Button } from '../shared/Button';

interface ImportOrigin { adapterType: string; externalId: string }
interface AgentRow { id: string; name: string; role?: string | null; description?: string | null; capabilityTags?: string[] | null; importOrigin?: ImportOrigin | null; domainName?: string | null }

type SubjectTier = 'orchestrator' | 'manager' | 'specialist';

function subjectTier(role?: string | null): SubjectTier {
  const r = (role ?? '').toLowerCase();
  if (r === 'orchestrator') return 'orchestrator';
  if (r === 'manager') return 'manager';
  return 'specialist';
}

export type AgentBrainView = 'map' | 'memory' | 'knowledge' | 'skills' | 'examples';

export function AgentBrainPanel({
  agents: providedAgents,
  selectedAgentId,
  onSelectedAgentIdChange,
  view,
  onViewChange,
  topRightSlot,
}: {
  agents?: AgentRow[];
  selectedAgentId?: string | null;
  onSelectedAgentIdChange?: (id: string) => void;
  view?: AgentBrainView;
  onViewChange?: (view: AgentBrainView) => void;
  /** Shared surface controls (Fleet/Brain + Add agent) floated on the map. */
  topRightSlot?: ReactNode;
} = {}) {
  const toast = useToast();
  const confirm = useConfirm();
  const [loadedAgents, setLoadedAgents] = useState<AgentRow[]>([]);
  const [internalAgentId, setInternalAgentId] = useState('');
  // Full memory/episode content now renders via WorkspaceMemoryTab + EpisodesTab
  // (self-fetching); this count only feeds the imported-agent provenance strip.
  const [episodeCount, setEpisodeCount] = useState(0);
  const [skillCount, setSkillCount] = useState(0);
  const [imports, setImports] = useState<ImportUpdate[]>([]);
  const [pulling, setPulling] = useState(false);
  const [internalView, setInternalView] = useState<AgentBrainView>('map');
  // The orchestrator has no domain, so its subject-picker row shows the
  // workspace name it presides over instead.
  const [workspaceName, setWorkspaceName] = useState('');
  const agents = providedAgents ?? loadedAgents;
  const agentId = selectedAgentId ?? internalAgentId;
  const activeView = view ?? internalView;

  const selectAgent = useCallback((id: string) => {
    setInternalAgentId(id);
    onSelectedAgentIdChange?.(id);
  }, [onSelectedAgentIdChange]);

  const selectView = useCallback((next: AgentBrainView) => {
    setInternalView(next);
    onViewChange?.(next);
  }, [onViewChange]);

  const loadAgents = useCallback(async () => {
    const data = await api<{ agents: AgentRow[] }>('/v1/agents');
    setLoadedAgents(data.agents);
  }, []);

  const loadMemory = useCallback(async (id: string) => {
    if (!id) { setEpisodeCount(0); return; }
    // Episodes are recorded against their own agentId column — not `scopeId`,
    // which is the App id for App-owned runs — so an agentId filter is what
    // finds every episode formed while this agent worked, including inside Apps.
    try {
      const { episodes } = await api<{ episodes: Array<{ id: string }> }>(`/v1/memory/episodes?agentId=${encodeURIComponent(id)}&limit=200`);
      setEpisodeCount(episodes.length);
    } catch {
      setEpisodeCount(0);
    }
  }, []);

  const loadImports = useCallback(async () => {
    try { setImports((await checkImportUpdates()).updates); } catch { setImports([]); }
  }, []);

  const loadSkillCount = useCallback(async (id: string) => {
    if (!id) { setSkillCount(0); return; }
    try {
      const res = await api<{ skills: unknown[] }>(`/v1/skills?scopeId=${encodeURIComponent(id)}&includeWorkspace=false`);
      setSkillCount(res.skills.length);
    } catch {
      setSkillCount(0);
    }
  }, []);

  useEffect(() => {
    if (providedAgents) return;
    void loadAgents().catch(() => {});
  }, [loadAgents, providedAgents]);

  useEffect(() => {
    const wsId = wsStore.get();
    void api<{ workspaces: Array<{ id: string; name: string }> }>('/v1/workspaces')
      .then((data) => {
        const ws = data.workspaces.find((w) => w.id === wsId) ?? data.workspaces[0];
        if (ws) setWorkspaceName(ws.name);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (agents.length === 0) return;
    if (agentId && agents.some((agent) => agent.id === agentId)) return;
    selectAgent(agents.find((agent) => subjectTier(agent.role) === 'orchestrator')?.id || agents[0]?.id || '');
  }, [agentId, agents, selectAgent]);

  useEffect(() => { void loadMemory(agentId).catch(() => {}); void loadSkillCount(agentId); void loadImports(); }, [agentId, loadMemory, loadSkillCount, loadImports]);

  const current = useMemo(() => agents.find((a) => a.id === agentId) ?? null, [agents, agentId]);
  const pending = useMemo(() => imports.find((u) => u.agentId === agentId) ?? null, [imports, agentId]);

  async function pullUpdates() {
    if (!current?.importOrigin || pulling) return;
    const pendingMemory = pending?.pendingMemory ?? pending?.pendingNew ?? 0;
    const pendingSkills = pending?.pendingSkills ?? 0;
    const ok = await confirm({
      title: `Re-sync ${current.name}?`,
      body: (
        <div className="space-y-2">
          <p>This will scan the provider again and push accepted memories plus SKILL.md files into this agent&apos;s Brain.</p>
          <p className="font-medium text-text-primary">
            {pendingMemory} new {pendingMemory === 1 ? 'memory' : 'memories'} · {pendingSkills} new {pendingSkills === 1 ? 'skill' : 'skills'}
          </p>
        </div>
      ),
      confirmLabel: 'Re-sync',
      tone: 'neutral',
    });
    if (!ok) return;
    setPulling(true);
    try {
      const result = await importAgents([{ externalId: current.importOrigin.externalId }]);
      await Promise.all([loadMemory(agentId), loadSkillCount(agentId), loadImports()]);
      toast.success(
        'Agent Brain re-synced',
        `${result.totalAtoms} ${result.totalAtoms === 1 ? 'memory' : 'memories'} · ${result.totalAbilities} ${result.totalAbilities === 1 ? 'skill' : 'skills'}.`,
      );
    } catch (error) {
      toast.error('Could not re-sync agent Brain', apiErrorMessage(error));
    } finally {
      setPulling(false);
    }
  }

  const scopeCluster = (
    <div className="flex h-9 items-center gap-1 rounded-lg border border-line bg-surface-2/90 px-1 backdrop-blur-md">
      <BrainSubjectDropdown agents={agents} selectedId={agentId} onSelect={selectAgent} workspaceName={workspaceName} />
      <span className="h-4 w-px shrink-0 bg-line" />
      <BrainViewTabs view={activeView} onChange={selectView} />
      {agentId && (
        <>
          <span className="h-4 w-px shrink-0 bg-line" />
          <ScopeVisibilityToggle scopeId={agentId} compact />
        </>
      )}
    </div>
  );

  // Map view floats its controls on the canvas; other views use a slim bar.
  const mapContent = (
    <ScopedBrainMap
      endpoint={agentId ? `/v1/brain/graph?scope=scoped&scopeId=${encodeURIComponent(agentId)}&includeWorkspace=false` : null}
      detailEndpoint={agentId ? `/v1/brain/graph/node/:id?scope=scoped&scopeId=${encodeURIComponent(agentId)}&includeWorkspace=false` : null}
      layoutKey={`agent:${agentId}`}
      scopeName={current?.name}
      scopeId={agentId || undefined}
      emptyMessage="Add memories or let this agent accumulate lessons to reveal its map."
      searchPositionClassName="right-3 top-16"
    />
  );

  const otherViewContent =
    activeView === 'memory' ? (
      agentId && (
        <div className="h-full overflow-y-auto px-6 py-5">
          <div className="mx-auto max-w-4xl space-y-4">
            <section className="rounded-card border border-line bg-surface p-4">
              <div className="mb-4">
                <div className="text-[11px] font-semibold uppercase tracking-wide text-text-muted">Memory</div>
                <p className="mt-1 text-[12px] text-text-muted">Facts, rules, preferences, and patterns this agent always recalls.</p>
              </div>
              <WorkspaceMemoryTab
                scopeId={agentId}
                showTitle={false}
                maxHeightClassName="max-h-[65vh]"
                submitLabel="Save to agent memory"
                placeholder="What should this agent always remember?"
                emptyBody="Add facts, rules, and preferences that only this agent recalls."
              />
            </section>
            <section className="rounded-card border border-line bg-surface p-4">
              <div className="mb-4">
                <div className="text-[11px] font-semibold uppercase tracking-wide text-text-muted">Episodes</div>
                <p className="mt-1 text-[12px] text-text-muted">Decisions, failures, recoveries, and lessons distilled from this agent's own runs.</p>
              </div>
              <EpisodesTab agentId={agentId} maxHeightClassName="max-h-[65vh]" />
            </section>
          </div>
        </div>
      )
    ) : activeView === 'knowledge' ? (
          agentId ? <KnowledgeTab scopeId={agentId} scopeName={current?.name} /> : null
        ) : activeView === 'skills' ? (
          agentId ? <SkillsTab scopeId={agentId} scopeName={current?.name} /> : null
        ) : (
          agentId ? <ExamplesTab scopeId={agentId} scopeName={current?.name} /> : null
        );

  return (
    <div className="flex h-full flex-col bg-canvas">
      {current?.importOrigin && (
        <ProviderBrainStrip
          origin={current.importOrigin}
          memoryCount={episodeCount}
          skillCount={skillCount}
          pending={pending}
          pulling={pulling}
          onPull={() => void pullUpdates()}
        />
      )}
      <div className="relative min-h-0 flex-1">
        {activeView === 'map' ? (
          <>
            <div className="h-full">{mapContent}</div>
            <div className="pointer-events-none absolute inset-x-3 top-3 z-30 flex items-start gap-2">
              <div className="pointer-events-auto flex min-w-0 items-center gap-2">{scopeCluster}</div>
              {topRightSlot && <div className="pointer-events-auto ml-auto flex shrink-0 items-center gap-2">{topRightSlot}</div>}
            </div>
          </>
        ) : (
          <div className="flex h-full flex-col">
            <div className="flex flex-wrap items-center gap-2 px-4 py-2.5">
              <div className="flex min-w-0 items-center gap-2">{scopeCluster}</div>
              {topRightSlot && <div className="ml-auto flex shrink-0 items-center gap-2">{topRightSlot}</div>}
            </div>
            <div className="min-h-0 flex-1">{otherViewContent}</div>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Provider→Brain strip (Solution 2): makes the harness→agent-brain memory flow
 * visible — source harness, how much has been pulled, what's pending upstream,
 * and an approval-gated pull, right where you inspect the agent's mind.
 */
function ProviderBrainStrip({
  origin,
  memoryCount,
  skillCount,
  pending,
  pulling,
  onPull,
}: {
  origin: ImportOrigin;
  memoryCount: number;
  skillCount: number;
  pending: ImportUpdate | null;
  pulling: boolean;
  onPull: () => void;
}) {
  const { Icon, label } = harnessOf(origin.adapterType);
  const pendingCount = pending ? (pending.pendingMemory ?? pending.pendingNew ?? 0) + (pending.pendingSkills ?? 0) : 0;
  return (
    <div className="flex flex-wrap items-center gap-3 border-b border-line bg-surface-2/60 px-6 py-2">
      <div className="flex items-center gap-2 text-[12px]">
        <Icon className="h-4 w-4 text-text-secondary" aria-label={label} />
        <span className="font-medium text-text-primary">{label}</span>
        <span className="text-text-muted">→ Agent Brain</span>
      </div>
      <span className="text-[12px] text-text-muted">{memoryCount} {memoryCount === 1 ? 'memory' : 'memories'} pulled</span>
      <span className="text-[12px] text-text-muted">{skillCount} {skillCount === 1 ? 'skill' : 'skills'} pushed</span>
      {pendingCount > 0 ? (
        <span className="inline-flex items-center rounded-pill bg-accent-soft px-2 py-0.5 text-[11px] text-accent">{pendingCount} new available</span>
      ) : (
        <span className="text-[11px] text-text-muted">up to date</span>
      )}
      <div className="ml-auto">
        <Button
          variant={pendingCount > 0 ? 'primary' : 'secondary'}
          size="sm"
          iconLeft={pulling ? <RefreshCw size={13} className="animate-spin" /> : <Download size={13} />}
          disabled={pulling}
          onClick={onPull}
        >
          {pulling ? 'Pulling…' : pendingCount > 0 ? 'Pull updates' : 'Re-sync'}
        </Button>
      </div>
    </div>
  );
}

const SUBJECT_GROUPS: Array<{ tier: SubjectTier; label: string }> = [
  { tier: 'orchestrator', label: 'Orchestrator' },
  { tier: 'manager', label: 'Managers' },
  { tier: 'specialist', label: 'Specialists' },
];

/**
 * Subject selector for Agent Brain — a compact dropdown (same shape as the
 * Fleet domain picker) grouped by tier, with a search filter and the shared
 * monochrome role glyphs.
 */
function BrainSubjectDropdown({
  agents,
  selectedId,
  onSelect,
  workspaceName,
}: {
  agents: AgentRow[];
  selectedId: string;
  onSelect: (id: string) => void;
  workspaceName: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const current = agents.find((a) => a.id === selectedId) ?? null;
  const grouped = useMemo(() => {
    const q = query.trim().toLowerCase();
    const match = (a: AgentRow) =>
      !q ||
      a.name.toLowerCase().includes(q) ||
      (a.role ?? '').toLowerCase().includes(q) ||
      (a.description ?? '').toLowerCase().includes(q) ||
      (a.capabilityTags ?? []).some((t) => t.toLowerCase().includes(q));
    const sorted = [...agents].filter(match).sort((a, b) => a.name.localeCompare(b.name));
    return SUBJECT_GROUPS.map((group) => ({
      ...group,
      items: sorted.filter((a) => subjectTier(a.role) === group.tier),
    }));
  }, [agents, query]);
  const hasResults = grouped.some((group) => group.items.length > 0);

  function close() {
    setOpen(false);
    setQuery('');
  }

  return (
    <div className="relative inline-block">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-[12px] text-text-primary transition-colors hover:bg-surface-3"
      >
        {current && <RoleGlyph role={current.role} size={12} />}
        <span className="font-semibold">{current?.name ?? 'Select subject'}</span>
        <ChevronDown size={11} className={clsx('text-text-muted transition-transform', open && 'rotate-180')} />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={close} />
          <div className="absolute left-0 top-full z-50 mt-1.5 w-64 origin-top-left overflow-hidden rounded-card border border-line bg-surface shadow-modal animate-in fade-in slide-in-from-top-1 duration-150">
            <label className="flex h-9 items-center gap-2 border-b border-line px-3 text-text-muted focus-within:text-text-primary">
              <Search size={13} className="shrink-0" />
              <input
                autoFocus
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search agents…"
                className="min-w-0 flex-1 bg-transparent text-[12px] text-text-primary outline-none placeholder:text-text-muted"
              />
            </label>
            <div className="max-h-[300px] overflow-y-auto py-1">
              {!hasResults ? (
                <p className="px-3 py-6 text-center text-[12px] text-text-muted">No agents match.</p>
              ) : (
                grouped.map((group) =>
                  group.items.length === 0 ? null : (
                    <div key={group.tier}>
                      <div className="flex items-center gap-1.5 px-3 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wider text-text-muted">
                        <RoleGlyph role={group.tier} size={11} />
                        {group.label}
                        <span className="font-normal normal-case tracking-normal">· {group.items.length}</span>
                      </div>
                      {group.items.map((a) => {
                        const isSel = a.id === selectedId;
                        // Orchestrator presides over the workspace; managers and
                        // specialists show their domain (blank when they have none).
                        const context = group.tier === 'orchestrator' ? workspaceName : a.domainName ?? '';
                        return (
                          <button
                            key={a.id}
                            type="button"
                            onClick={() => { onSelect(a.id); close(); }}
                            className={clsx(
                              'flex w-full items-center gap-2 px-3 py-2 text-left text-[12px] transition-colors',
                              isSel ? 'bg-surface-2 font-medium text-text-primary' : 'text-text-secondary hover:bg-surface-2 hover:text-text-primary',
                            )}
                          >
                            <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center">
                              {isSel && <Check size={12} className="text-accent" />}
                            </span>
                            <span className="min-w-0 flex-1 truncate">{a.name}</span>
                            {context && <span className="ml-2 max-w-[45%] shrink-0 truncate text-[11px] text-text-muted">{context}</span>}
                          </button>
                        );
                      })}
                    </div>
                  ),
                )
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

const BRAIN_VIEWS: Array<{ key: AgentBrainView; label: string; Icon: LucideIcon }> = [
  { key: 'map', label: 'Map', Icon: Network },
  { key: 'memory', label: 'Memory', Icon: NotebookPen },
  { key: 'knowledge', label: 'Knowledge', Icon: BookOpen },
  { key: 'skills', label: 'Skills', Icon: FileCode },
  { key: 'examples', label: 'Examples', Icon: Sparkles },
];

/** The five brain views — active shows its label, the rest are icon-only. */
function BrainViewTabs({
  view,
  onChange,
}: {
  view: AgentBrainView;
  onChange: (value: AgentBrainView) => void;
}) {
  return (
    <div className="flex items-center gap-0.5">
      {BRAIN_VIEWS.map(({ key, label, Icon }) => {
        const active = view === key;
        return (
          <button
            key={key}
            type="button"
            onClick={() => onChange(key)}
            aria-label={label}
            title={label}
            className={clsx(
              'inline-flex h-7 items-center gap-1.5 rounded-md text-[12px] transition-colors',
              active
                ? 'bg-surface-3 px-2.5 text-text-primary'
                : 'w-7 justify-center text-text-muted hover:bg-surface-3 hover:text-text-primary',
            )}
          >
            <Icon size={14} />
            {active && label}
          </button>
        );
      })}
    </div>
  );
}



