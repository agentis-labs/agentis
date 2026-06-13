import { useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronDown, Crown, Network, NotebookPen, Plus, Search, Sparkles, Trash2, Users, X } from 'lucide-react';
import clsx from 'clsx';
import { api, apiErrorMessage } from '../../lib/api';
import { AgentAbilitiesPanel } from '../agents/AgentAbilitiesPanel';
import { Button } from '../shared/Button';
import { useToast } from '../shared/Toast';
import { ScopedBrainMap } from './ScopedBrainMap';

interface AgentRow { id: string; name: string; role?: string | null; description?: string | null; capabilityTags?: string[] | null }

type SubjectTier = 'orchestrator' | 'manager' | 'specialist';

function subjectTier(role?: string | null): SubjectTier {
  const r = (role ?? '').toLowerCase();
  if (r === 'orchestrator') return 'orchestrator';
  if (r === 'manager') return 'manager';
  return 'specialist';
}
interface MemoryEntry { id: string; section: string; content: string; createdAt: string }

export function AgentBrainPanel() {
  const toast = useToast();
  const [agents, setAgents] = useState<AgentRow[]>([]);
  const [agentId, setAgentId] = useState('');
  const [entries, setEntries] = useState<MemoryEntry[]>([]);
  const [content, setContent] = useState('');
  const [view, setView] = useState<'map' | 'memory' | 'abilities'>('map');
  const [pickerOpen, setPickerOpen] = useState(false);

  const loadAgents = useCallback(async () => {
    const data = await api<{ agents: AgentRow[] }>('/v1/agents');
    setAgents(data.agents);
    // Default to the orchestrator — the always-on workspace brain owner.
    setAgentId((current) =>
      current || data.agents.find((a) => subjectTier(a.role) === 'orchestrator')?.id || data.agents[0]?.id || '',
    );
  }, []);

  const current = useMemo(() => agents.find((a) => a.id === agentId) ?? null, [agents, agentId]);

  const loadMemory = useCallback(async (id: string) => {
    if (!id) { setEntries([]); return; }
    const data = await api<{ entries: MemoryEntry[] }>(`/v1/brain/agents/${id}/memory`);
    setEntries(data.entries);
  }, []);

  useEffect(() => { void loadAgents().catch(() => {}); }, [loadAgents]);
  useEffect(() => { void loadMemory(agentId).catch(() => {}); }, [agentId, loadMemory]);

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
        <ScopeToggle view={view} onChange={setView} />
      </div>
      <div className="min-h-0 flex-1">
        {view === 'map' ? (
          <ScopedBrainMap
            endpoint={agentId ? `/v1/brain/agents/${agentId}/graph` : null}
            detailEndpoint={agentId ? `/v1/brain/agents/${agentId}/graph/node` : null}
            layoutKey={`agent:${agentId}`}
            emptyMessage="Add memories or let this agent accumulate lessons to reveal its map."
          />
        ) : view === 'memory' ? (
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
            {entries.length === 0 && <p className="py-10 text-center text-[13px] text-text-muted">No memory has accumulated for this agent yet.</p>}
            {entries.map((entry) => (
              <article key={entry.id} className="flex items-start justify-between gap-3 rounded-card border border-line bg-surface-2 px-4 py-3">
                <div>
                  <p className="text-[11px] font-medium uppercase tracking-wide text-text-muted">{entry.section}</p>
                  <p className="mt-1 whitespace-pre-wrap text-[13px] leading-5 text-text-secondary">{entry.content}</p>
                </div>
                <button type="button" aria-label="Delete memory" className="rounded-btn p-1.5 text-text-muted hover:bg-danger-soft hover:text-danger" onClick={() => void remove(entry.id)}><Trash2 size={13} /></button>
              </article>
            ))}
          </div>
              </section>
            </div>
          </div>
        ) : (
          <div className="h-full overflow-y-auto px-6 py-5">
            <div className="mx-auto max-w-4xl">
              <AgentAbilitiesPanel agentId={agentId} />
            </div>
          </div>
        )}
      </div>
      {pickerOpen && (
        <BrainSubjectPicker
          agents={agents}
          selectedId={agentId}
          onSelect={(id) => { setAgentId(id); setPickerOpen(false); }}
          onClose={() => setPickerOpen(false)}
        />
      )}
    </div>
  );
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
                      {a.role ? <span className="font-mono">{a.role}</span> : 'agent'}
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
  view: 'map' | 'memory' | 'abilities';
  onChange: (value: 'map' | 'memory' | 'abilities') => void;
}) {
  return (
    <div className="flex items-center gap-1.5 text-[12px]">
      <button type="button" onClick={() => onChange('map')} className={`inline-flex items-center gap-1.5 rounded-pill px-3 py-1 ${view === 'map' ? 'bg-accent-soft text-accent' : 'text-text-muted hover:text-text-primary'}`}><Network size={12} /> Map</button>
      <button type="button" onClick={() => onChange('memory')} className={`inline-flex items-center gap-1.5 rounded-pill px-3 py-1 ${view === 'memory' ? 'bg-accent-soft text-accent' : 'text-text-muted hover:text-text-primary'}`}><NotebookPen size={12} /> Memory</button>
      <button type="button" onClick={() => onChange('abilities')} className={`inline-flex items-center gap-1.5 rounded-pill px-3 py-1 ${view === 'abilities' ? 'bg-accent-soft text-accent' : 'text-text-muted hover:text-text-primary'}`}><Sparkles size={12} /> Abilities</button>
    </div>
  );
}
