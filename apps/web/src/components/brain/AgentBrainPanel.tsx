import { useCallback, useEffect, useMemo, useState } from 'react';
import { BookOpen, ChevronDown, Crown, Download, FileCode, Network, NotebookPen, Plus, RefreshCw, Search, Sparkles, Trash2, Users, X } from 'lucide-react';
import clsx from 'clsx';
import { api, apiErrorMessage } from '../../lib/api';
import { harnessOf } from '../agents/harnessMeta';
import { importAgents, checkImportUpdates, type ImportUpdate } from '../../lib/agentImport';
import { Button } from '../shared/Button';
import { useToast } from '../shared/Toast';
import { useConfirm } from '../shared/ConfirmDialog';
import { ScopedBrainMap } from './ScopedBrainMap';
import { KnowledgeTab } from '../knowledge/KnowledgeTab';
import { ScopeVisibilityToggle } from './ScopeVisibilityToggle';
import { SkillsTab } from './SkillsTab';
import { ExamplesTab } from './ExamplesTab';

interface ImportOrigin { adapterType: string; externalId: string }
interface AgentRow { id: string; name: string; role?: string | null; description?: string | null; capabilityTags?: string[] | null; importOrigin?: ImportOrigin | null }

/** One agent-scoped episodic memory atom (the real Brain content). */
interface EpisodeRow {
  id: string;
  title: string;
  summary: string;
  source: string;
  tags: string[];
  metadata?: Record<string, unknown>;
  reinforcedAt?: string | null;
  createdAt: string;
}

type MemoryOrigin = 'imported' | 'learned' | 'operator';

/** Where a memory came from — drives the provenance badge in the Memory tab. */
function memoryOrigin(ep: EpisodeRow): MemoryOrigin {
  const harnessMeta = (ep.metadata?.harness ?? (ep.metadata?.provenance as Record<string, unknown> | undefined)?.adapterType) != null;
  if (ep.source === 'harness_ingest' || harnessMeta || ep.tags.includes('imported')) return 'imported';
  if (ep.source === 'operator_write') return 'operator';
  return 'learned';
}

type SubjectTier = 'orchestrator' | 'manager' | 'specialist';

function subjectTier(role?: string | null): SubjectTier {
  const r = (role ?? '').toLowerCase();
  if (r === 'orchestrator') return 'orchestrator';
  if (r === 'manager') return 'manager';
  return 'specialist';
}
interface MemoryRecord { id: string; section: string; content: string; createdAt: string }

export type AgentBrainView = 'map' | 'memory' | 'knowledge' | 'skills' | 'examples';

export function AgentBrainPanel({
  agents: providedAgents,
  selectedAgentId,
  onSelectedAgentIdChange,
  view,
  onViewChange,
}: {
  agents?: AgentRow[];
  selectedAgentId?: string | null;
  onSelectedAgentIdChange?: (id: string) => void;
  view?: AgentBrainView;
  onViewChange?: (view: AgentBrainView) => void;
} = {}) {
  const toast = useToast();
  const confirm = useConfirm();
  const [loadedAgents, setLoadedAgents] = useState<AgentRow[]>([]);
  const [internalAgentId, setInternalAgentId] = useState('');
  const [entries, setEntries] = useState<MemoryRecord[]>([]);
  const [episodes, setEpisodes] = useState<EpisodeRow[]>([]);
  const [skillCount, setSkillCount] = useState(0);
  const [imports, setImports] = useState<ImportUpdate[]>([]);
  const [pulling, setPulling] = useState(false);
  const [content, setContent] = useState('');
  const [internalView, setInternalView] = useState<AgentBrainView>('map');
  const [pickerOpen, setPickerOpen] = useState(false);
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
    if (!id) { setEntries([]); setEpisodes([]); return; }
    // The agent's real Brain content lives in the episodic substrate — imported
    // (the agent that actually executed the run), not `scopeId`: scopeId is the
    // App id for App-owned runs, so a scopeId-only filter would silently miss
    // every episode formed while this agent worked inside an App. The
    // provenance badge.
    const [mem, eps] = await Promise.all([
      api<{ entries: MemoryRecord[] }>(`/v1/brain/agents/${id}/memory`).catch(() => ({ entries: [] as MemoryRecord[] })),
      api<{ episodes: EpisodeRow[] }>(`/v1/memory/episodes?agentId=${encodeURIComponent(id)}&limit=200`).catch(() => ({ episodes: [] as EpisodeRow[] })),
    ]);
    setEntries(mem.entries);
    setEpisodes(eps.episodes);
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

  async function save() {
    if (!agentId || !content.trim()) return;
    try {
      await api(`/v1/brain/agents/${agentId}/memory`, {
        method: 'POST',
        body: JSON.stringify({ section: 'Operator notes', content: content.trim() }),
      });
      setContent('');
      await loadMemory(agentId);
    } catch (error) {
      toast.error('Could not save agent memory', apiErrorMessage(error));
    }
  }

  async function remove(id: string) {
    const ok = await confirm({
      title: 'Delete memory entry?',
      body: 'This memory entry will be permanently removed from this agent.',
      tone: 'danger',
      confirmLabel: 'Delete',
    });
    if (!ok) return;
    await api(`/v1/brain/agents/${agentId}/memory/${id}`, { method: 'DELETE' });
    await loadMemory(agentId);
  }

  return (
    <div className="flex h-full flex-col bg-canvas">
      <div className="flex h-11 shrink-0 items-center justify-between gap-3 border-b border-line bg-surface px-6">
        <button
          type="button"
          onClick={() => setPickerOpen(true)}
          className="inline-flex h-7 items-center gap-1.5 rounded-pill border border-line bg-surface-2 px-3 text-[12px] text-text-secondary transition-colors hover:border-line-strong hover:text-text-primary"
        >
          <span className="text-text-muted">Agent Brain:</span>
          <TierIcon tier={subjectTier(current?.role)} />
          <span className="font-semibold text-text-primary">{current?.name ?? 'Select subject'}</span>
          <ChevronDown size={11} className="text-text-muted" />
        </button>
        <div className="flex items-center gap-2">
          {agentId && <ScopeVisibilityToggle scopeId={agentId} />}
          <ScopeToggle view={activeView} onChange={selectView} />
        </div>
      </div>
      {current?.importOrigin && (
        <ProviderBrainStrip
          origin={current.importOrigin}
          memoryCount={episodes.length}
          skillCount={skillCount}
          pending={pending}
          pulling={pulling}
          onPull={() => void pullUpdates()}
        />
      )}
      <div className="min-h-0 flex-1">
        {activeView === 'map' ? (
          <ScopedBrainMap
            endpoint={agentId ? `/v1/brain/graph?scope=scoped&scopeId=${encodeURIComponent(agentId)}&includeWorkspace=false` : null}
            detailEndpoint={agentId ? `/v1/brain/graph/node/:id?scope=scoped&scopeId=${encodeURIComponent(agentId)}&includeWorkspace=false` : null}
            layoutKey={`agent:${agentId}`}
            scopeName={current?.name}
            scopeId={agentId || undefined}
            emptyMessage="Add memories or let this agent accumulate lessons to reveal its map."
          />
        ) : activeView === 'memory' ? (
          <div className="h-full overflow-y-auto px-6 py-5">
            <div className="mx-auto max-w-4xl space-y-4">
              <section className="rounded-card border border-line bg-surface p-5">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <p className="mt-1 text-[13px] text-text-muted">Persistent expertise and failure lessons owned by one agent.</p>
            </div>
          </div>
          <textarea value={content} onChange={(event) => setContent(event.target.value)} placeholder="Add a lesson or operating note for this agent..." rows={3} className="mt-4 w-full resize-none rounded-input border border-line bg-surface-2 p-3 text-[13px] text-text-primary outline-none focus:border-accent" />
          <div className="mt-3 flex justify-end">
            <Button variant="primary" iconLeft={<Plus size={13} />} disabled={!agentId || !content.trim()} onClick={() => void save()}>Add memory</Button>
          </div>
              </section>
              <section className="rounded-card border border-line bg-surface p-4">
          <div className="space-y-2">
            {episodes.length === 0 && entries.length === 0 && (
              <p className="py-10 text-center text-[13px] text-text-muted">No memory has accumulated for this agent yet.</p>
            )}
            {episodes.map((ep) => {
              const origin = memoryOrigin(ep);
              return (
                <article key={ep.id} className="rounded-card border border-line bg-surface-2 px-4 py-3">
                  <div className="flex items-center gap-2">
                    <OriginBadge origin={origin} harness={current?.importOrigin?.adapterType} />
                    {ep.reinforcedAt && <span className="rounded bg-accent-soft px-1.5 py-0.5 text-[10px] text-accent">reinforced</span>}
                    <span className="ml-auto text-[10px] text-text-muted">{relTime(ep.createdAt)}</span>
                  </div>
                  <p className="mt-1.5 text-[13px] font-medium text-text-primary">{ep.title}</p>
                  <p className="mt-0.5 whitespace-pre-wrap text-[13px] leading-5 text-text-secondary">{ep.summary}</p>
                </article>
              );
            })}
            {entries.map((entry) => (
              <article key={entry.id} className="flex items-start justify-between gap-3 rounded-card border border-line bg-surface-2 px-4 py-3">
                <div>
                  <div className="flex items-center gap-2">
                    <OriginBadge origin="operator" />
                    <span className="text-[11px] font-medium uppercase tracking-wide text-text-muted">{entry.section}</span>
                  </div>
                  <p className="mt-1 whitespace-pre-wrap text-[13px] leading-5 text-text-secondary">{entry.content}</p>
                </div>
                <button type="button" aria-label="Delete memory" className="rounded-btn p-1.5 text-text-muted hover:bg-danger-soft hover:text-danger" onClick={() => void remove(entry.id)}><Trash2 size={13} /></button>
              </article>
            ))}
          </div>
              </section>
            </div>
          </div>
        ) : activeView === 'knowledge' ? (
          agentId ? <KnowledgeTab scopeId={agentId} scopeName={current?.name} /> : null
        ) : activeView === 'skills' ? (
          agentId ? <SkillsTab scopeId={agentId} scopeName={current?.name} /> : null
        ) : (
          agentId ? <ExamplesTab scopeId={agentId} scopeName={current?.name} /> : null
        )}
      </div>
      {pickerOpen && (
        <BrainSubjectPicker
          agents={agents}
          selectedId={agentId}
          onSelect={(id) => { selectAgent(id); setPickerOpen(false); }}
          onClose={() => setPickerOpen(false)}
        />
      )}
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

/** Provenance badge for a memory entry in the Memory tab (Solution 3). */
function OriginBadge({ origin, harness }: { origin: MemoryOrigin; harness?: string | null }) {
  if (origin === 'imported') {
    return <span className="rounded bg-violet-500/15 px-1.5 py-0.5 text-[10px] font-medium text-violet-300">imported{harness ? ` · ${harnessOf(harness).label}` : ''}</span>;
  }
  if (origin === 'operator') {
    return <span className="rounded bg-sky-500/15 px-1.5 py-0.5 text-[10px] font-medium text-sky-300">operator note</span>;
  }
  return <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-300">learned</span>;
}

function relTime(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const mins = Math.round((Date.now() - t) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

function TierIcon({ tier }: { tier: SubjectTier }) {
  if (tier === 'orchestrator') return <Crown size={12} className="text-violet-400" />;
  if (tier === 'manager') return <Users size={12} className="text-sky-400" />;
  return <Sparkles size={12} className="text-amber-400" />;
}

const TIER_TABS: Array<{ key: SubjectTier; label: string }> = [
  { key: 'orchestrator', label: 'Orchestrator' },
  { key: 'manager', label: 'Managers' },
  { key: 'specialist', label: 'Specialists' },
];

/**
 * Modal subject picker for Agent Brain. Keeps the page calm by default and
 * scales past a 50-specialist workspace via tabs + search, instead of a single
 * giant dropdown (SPECIALISTS-10X §UI/UX → Brain Page Subject Picker).
 */
function BrainSubjectPicker({
  agents,
  selectedId,
  onSelect,
  onClose,
}: {
  agents: AgentRow[];
  selectedId: string;
  onSelect: (id: string) => void;
  onClose: () => void;
}) {
  const initialTier = subjectTier(agents.find((a) => a.id === selectedId)?.role);
  const [tier, setTier] = useState<SubjectTier>(initialTier);
  const [query, setQuery] = useState('');

  const counts = useMemo(() => {
    const c: Record<SubjectTier, number> = { orchestrator: 0, manager: 0, specialist: 0 };
    for (const a of agents) c[subjectTier(a.role)] += 1;
    return c;
  }, [agents]);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return agents
      .filter((a) => subjectTier(a.role) === tier)
      .filter((a) => {
        if (!q) return true;
        return (
          a.name.toLowerCase().includes(q) ||
          (a.role ?? '').toLowerCase().includes(q) ||
          (a.description ?? '').toLowerCase().includes(q) ||
          (a.capabilityTags ?? []).some((t) => t.toLowerCase().includes(q))
        );
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [agents, tier, query]);

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 pt-[12vh]" onClick={onClose}>
      <div
        className="flex max-h-[70vh] w-full max-w-lg flex-col overflow-hidden rounded-card border border-line bg-surface shadow-modal"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3 border-b border-line px-5 py-4">
          <div>
            <div className="text-sm font-medium text-text-primary">Brain Subject</div>
            <div className="text-[12px] text-text-muted">Select whose mind you want to inspect.</div>
          </div>
          <button type="button" aria-label="Close" onClick={onClose} className="rounded-md p-1 text-text-muted hover:bg-surface-2 hover:text-text-primary"><X size={16} /></button>
        </div>

        <div className="flex items-center gap-1 border-b border-line px-5 py-2.5">
          {TIER_TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => setTier(t.key)}
              className={clsx(
                'inline-flex items-center gap-1.5 rounded-pill px-3 py-1 text-[12px] transition-colors',
                tier === t.key ? 'bg-accent-soft text-accent' : 'text-text-muted hover:text-text-primary',
              )}
            >
              <TierIcon tier={t.key} /> {t.label}
              <span className="rounded-full bg-surface-3 px-1.5 py-0.5 text-[9px] text-text-muted">{counts[t.key]}</span>
            </button>
          ))}
        </div>

        <label className="flex h-9 items-center gap-2 border-b border-line px-5 text-text-muted focus-within:text-text-primary">
          <Search size={13} />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search specialists, abilities, tools…"
            className="min-w-0 flex-1 bg-transparent text-[12px] text-text-primary outline-none placeholder:text-text-muted"
          />
        </label>

        <div className="min-h-0 flex-1 overflow-y-auto py-1">
          {rows.length === 0 ? (
            <p className="px-5 py-10 text-center text-[12px] text-text-muted">
              {tier === 'orchestrator'
                ? 'No orchestrator yet — commission one from the Agents page.'
                : `No ${tier === 'manager' ? 'managers' : 'specialists'} match.`}
            </p>
          ) : (
            rows.map((a) => {
              const isSel = a.id === selectedId;
              return (
                <button
                  key={a.id}
                  type="button"
                  onClick={() => onSelect(a.id)}
                  className={clsx(
                    'flex w-full items-center gap-3 px-5 py-2.5 text-left transition-colors',
                    isSel ? 'bg-surface-2' : 'hover:bg-surface-2',
                  )}
                >
                  <TierIcon tier={subjectTier(a.role)} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13px] font-medium text-text-primary">{a.name}</div>
                    <div className="truncate text-[11px] text-text-muted">
                      {a.role ? <span className="font-mono">{a.role === 'worker' ? 'specialist' : a.role}</span> : 'agent'}
                      {a.capabilityTags && a.capabilityTags.length > 0 && ` · ${a.capabilityTags.slice(0, 3).join(', ')}`}
                    </div>
                  </div>
                  {isSel && <span className="text-[11px] text-accent">current</span>}
                </button>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}

function ScopeToggle({
  view,
  onChange,
}: {
  view: AgentBrainView;
  onChange: (value: AgentBrainView) => void;
}) {
  return (
    <div className="flex items-center gap-1.5 text-[12px]">
      <button type="button" onClick={() => onChange('map')} className={`inline-flex items-center gap-1.5 rounded-pill px-3 py-1 ${view === 'map' ? 'bg-accent-soft text-accent' : 'text-text-muted hover:text-text-primary'}`}><Network size={12} /> Map</button>
      <button type="button" onClick={() => onChange('memory')} className={`inline-flex items-center gap-1.5 rounded-pill px-3 py-1 ${view === 'memory' ? 'bg-accent-soft text-accent' : 'text-text-muted hover:text-text-primary'}`}><NotebookPen size={12} /> Memory</button>
      <button type="button" onClick={() => onChange('knowledge')} className={`inline-flex items-center gap-1.5 rounded-pill px-3 py-1 ${view === 'knowledge' ? 'bg-accent-soft text-accent' : 'text-text-muted hover:text-text-primary'}`}><BookOpen size={12} /> Knowledge</button>
      <button type="button" onClick={() => onChange('skills')} className={`inline-flex items-center gap-1.5 rounded-pill px-3 py-1 ${view === 'skills' ? 'bg-accent-soft text-accent' : 'text-text-muted hover:text-text-primary'}`}><FileCode size={12} /> Skills</button>
      <button type="button" onClick={() => onChange('examples')} className={`inline-flex items-center gap-1.5 rounded-pill px-3 py-1 ${view === 'examples' ? 'bg-accent-soft text-accent' : 'text-text-muted hover:text-text-primary'}`}><Sparkles size={12} /> Examples</button>
    </div>
  );
}



