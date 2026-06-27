/**
 * ImportAgentsWizard — "Bring your agents" full transition (AGENT-TRANSITION B9/P7).
 *
 * Master/detail: a grouped, searchable roster (left) + a per-agent transition
 * manifest (right). One transition brings an agent's whole self — identity +
 * harness logo + runtime + memories + skills(→abilities) — pre-connected. Scales
 * to dozens; one clear primary CTA. Imported agents land online and complete.
 */

import { useEffect, useMemo, useState } from 'react';
import { Sparkles, Check, AlertCircle, Loader2, Search, FolderTree, Zap, ChevronRight, ChevronDown, RefreshCw } from 'lucide-react';
import { apiErrorMessage } from '../../lib/api';
import {
  discoverImportableAgents,
  previewAgentImport,
  importAgents,
  checkImportUpdates,
  type DiscoveredAgentRow,
  type AgentImportPreview,
  type ImportAgentSpec,
} from '../../lib/agentImport';
import { Drawer } from '../shared/Drawer';
import { Button } from '../shared/Button';
import { harnessOf, type HarnessIcon } from './harnessMeta';

interface Props {
  open: boolean;
  onClose: () => void;
  onImported?: () => void;
}

interface PerAgent {
  acceptedHashes?: string[];   // undefined = all
  acceptedSkillPaths?: string[];
}

export function ImportAgentsWizard({ open, onClose, onImported }: Props) {
  const [agents, setAgents] = useState<DiscoveredAgentRow[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [focused, setFocused] = useState<string | null>(null);
  const [overrides] = useState<Map<string, PerAgent>>(new Map());
  const [updates, setUpdates] = useState<Map<string, number>>(new Map());
  const [search, setSearch] = useState('');
  const [scanning, setScanning] = useState(false);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ agents: number; atoms: number; abilities: number } | null>(null);
  const [showImported, setShowImported] = useState(false);
  const [previewCache, setPreviewCache] = useState<Map<string, AgentImportPreview>>(new Map());

  useEffect(() => { if (open) void scan(); else reset(); /* eslint-disable-next-line */ }, [open]);

  function reset() {
    setAgents(null); setSelected(new Set()); setFocused(null); setError(null);
    setImporting(false); setDone(null); setSearch(''); overrides.clear(); setUpdates(new Map()); setPreviewCache(new Map());
  }

  async function scan() {
    setScanning(true); setError(null); setDone(null); setPreviewCache(new Map());
    try {
      const res = await discoverImportableAgents();
      setAgents(res.agents);
      const fresh = res.agents.filter((a) => !a.alreadyImported);
      setSelected(new Set(fresh.map((a) => a.externalId)));
      setFocused(fresh[0]?.externalId ?? res.agents[0]?.externalId ?? null);
      try {
        const up = await checkImportUpdates();
        setUpdates(new Map(up.updates.map((u) => [u.externalId, (u.pendingMemory ?? u.pendingNew ?? 0) + (u.pendingSkills ?? 0)])));
      } catch { /* best-effort */ }
    } catch (e) {
      setError(apiErrorMessage(e));
    } finally {
      setScanning(false);
    }
  }

  function toggle(externalId: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(externalId)) next.delete(externalId); else next.add(externalId);
      return next;
    });
  }

  async function runImport(only?: string) {
    if (!agents) return;
    setImporting(true); setError(null);
    try {
      const ids = only ? [only] : [...selected];
      const specs: ImportAgentSpec[] = ids.map((id) => ({
        externalId: id,
        acceptedHashes: overrides.get(id)?.acceptedHashes,
        acceptedSkillPaths: overrides.get(id)?.acceptedSkillPaths,
      }));
      const res = await importAgents(specs);
      setDone({ agents: res.imported.length, atoms: res.totalAtoms, abilities: res.totalAbilities });
      onImported?.();
      if (only) setUpdates((p) => { const n = new Map(p); n.delete(only); return n; });
    } catch (e) {
      setError(apiErrorMessage(e));
    } finally {
      setImporting(false);
    }
  }

  const q = search.trim().toLowerCase();
  const visible = (agents ?? []).filter((a) => !q || a.name.toLowerCase().includes(q) || harnessOf(a.adapterType).label.toLowerCase().includes(q));
  const fresh = visible.filter((a) => !a.alreadyImported);
  const imported = visible.filter((a) => a.alreadyImported);
  const groups = useMemo(() => groupByHarness(fresh), [fresh]);
  const totals = useMemo(() => sumTotals(agents ?? []), [agents]);
  const focusedAgent = (agents ?? []).find((a) => a.externalId === focused) ?? null;

  return (
    <Drawer
      open={open}
      onClose={onClose}
      width="xl"
      title={<span className="flex items-center gap-2"><Sparkles size={16} className="text-accent" /> Bring your agents</span>}
      subtitle={agents && agents.length > 0
        ? `Found ${totals.count} agent${totals.count === 1 ? '' : 's'} · ${totals.memories} memories · ${totals.skills} skills → abilities`
        : 'Import agents you already run outside Agentis — identity, memory and skills.'}
      footer={done ? (
        <div className="flex items-center justify-between">
          <span className="flex items-center gap-1.5 text-[13px] text-success">
            <Check size={14} /> Transitioned {done.agents} agent{done.agents === 1 ? '' : 's'} · {done.atoms} memories · {done.abilities} abilities.
          </span>
          <Button size="sm" onClick={onClose}>Done</Button>
        </div>
      ) : (
        <div className="flex items-center justify-between gap-3">
          <span className="text-[12px] text-text-muted">{selected.size} of {fresh.length} selected</span>
          <div className="flex gap-2">
            <Button size="sm" variant="secondary" onClick={() => void scan()} loading={scanning} iconLeft={<RefreshCw size={13} />}>Re-scan</Button>
            <Button size="sm" onClick={() => void runImport()} loading={importing} disabled={selected.size === 0}>
              Transition {selected.size > 0 ? selected.size : ''} agent{selected.size === 1 ? '' : 's'}
            </Button>
          </div>
        </div>
      )}
    >
      {error && <p className="mb-3 flex items-center gap-1 text-[12px] text-danger"><AlertCircle size={13} /> {error}</p>}
      {scanning && !agents && <p className="flex items-center gap-2 text-[13px] text-text-muted"><Loader2 size={14} className="animate-spin" /> Scanning this machine for agents…</p>}
      {agents && agents.length === 0 && !scanning && (
        <div className="rounded-lg border border-line bg-surface p-6 text-center">
          <FolderTree size={28} className="mx-auto text-text-muted" />
          <p className="mt-2 text-subheading text-text-primary">No external agents found</p>
          <p className="mt-1 text-[12px] text-text-muted">We looked for Claude Code, Hermes, Codex and Cursor agents (and their memory + skills) on this machine.</p>
        </div>
      )}

      {agents && agents.length > 0 && (
        <div className="grid h-[min(640px,calc(100vh-220px))] min-h-[500px] grid-cols-[248px_1fr] overflow-hidden rounded-lg border border-line">
          {/* Roster */}
          <div className="flex min-h-0 flex-col border-r border-line">
            <div className="border-b border-line p-2.5">
              <div className="flex items-center gap-1.5 rounded-md border border-line px-2 py-1.5">
                <Search size={13} className="text-text-muted" />
                <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={`Search ${agents.length} agents…`}
                  className="w-full bg-transparent text-[12.5px] outline-none placeholder:text-text-muted" aria-label="Search agents" />
              </div>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto">
              {[...groups.entries()].map(([type, list]) => {
                const { label, Icon } = harnessOf(type);
                const allSel = list.every((a) => selected.has(a.externalId));
                return (
                  <div key={type}>
                    <div className="flex items-center justify-between px-2.5 py-1.5">
                      <span className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-text-muted">
                        <Icon className="h-3.5 w-3.5" /> {label} · {list.length}
                      </span>
                      <button type="button" className="text-[11px] text-accent" onClick={() => setSelected((prev) => {
                        const next = new Set(prev);
                        if (allSel) list.forEach((a) => next.delete(a.externalId)); else list.forEach((a) => next.add(a.externalId));
                        return next;
                      })}>{allSel ? 'none' : 'all'}</button>
                    </div>
                    {list.map((a) => (
                      <RosterRow key={a.externalId} agent={a} Icon={Icon}
                        checked={selected.has(a.externalId)} active={focused === a.externalId}
                        onToggle={() => toggle(a.externalId)} onFocus={() => setFocused(a.externalId)} />
                    ))}
                  </div>
                );
              })}

              {imported.length > 0 && (
                <div className="border-t border-line">
                  <button type="button" onClick={() => setShowImported((v) => !v)}
                    className="flex w-full items-center gap-1.5 px-2.5 py-2 text-[12px] text-text-muted">
                    {showImported ? <ChevronDown size={13} /> : <ChevronRight size={13} />} Already in Agentis · {imported.length}
                  </button>
                  {showImported && imported.map((a) => {
                    const { Icon } = harnessOf(a.adapterType);
                    const pending = updates.get(a.externalId) ?? 0;
                    return (
                      <div key={a.externalId} className="flex items-center gap-2 px-2.5 py-2 opacity-80">
                        <span className="flex h-6 w-6 items-center justify-center rounded-full bg-surface"><Icon className="h-3.5 w-3.5" /></span>
                        <span className="min-w-0 flex-1 truncate text-[12.5px]">{a.name}</span>
                        {pending > 0
                          ? <button type="button" onClick={() => void runImport(a.externalId)} disabled={importing}
                              className="flex items-center gap-1 rounded bg-accent/15 px-1.5 py-0.5 text-[11px] text-accent">{pending} new · pull</button>
                          : <Check size={13} className="text-success" />}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>

          {/* Detail / manifest */}
          <div className="min-h-0 overflow-y-auto p-4">
            {focusedAgent
              ? <ManifestPane key={focusedAgent.externalId} agent={focusedAgent}
                  cachedPreview={previewCache.get(focusedAgent.externalId) ?? null}
                  acceptedHashes={overrides.get(focusedAgent.externalId)?.acceptedHashes}
                  acceptedSkillPaths={overrides.get(focusedAgent.externalId)?.acceptedSkillPaths}
                  onPreviewLoaded={(preview) => setPreviewCache((prev) => {
                    const next = new Map(prev);
                    next.set(focusedAgent.externalId, preview);
                    return next;
                  })}
                  onAccepted={(hashes) => { overrides.set(focusedAgent.externalId, { ...overrides.get(focusedAgent.externalId), acceptedHashes: hashes }); }}
                  onSkillsAccepted={(paths) => { overrides.set(focusedAgent.externalId, { ...overrides.get(focusedAgent.externalId), acceptedSkillPaths: paths }); }} />
              : <p className="text-[13px] text-text-muted">Select an agent to see what will transition.</p>}
          </div>
        </div>
      )}
    </Drawer>
  );
}

function RosterRow({ agent, Icon, checked, active, onToggle, onFocus }: {
  agent: DiscoveredAgentRow; Icon: HarnessIcon; checked: boolean; active: boolean; onToggle: () => void; onFocus: () => void;
}) {
  const s = agent.summary;
  const chips = [s.memoryFiles > 0 ? `${s.memoryFiles} mem` : null, s.skills > 0 ? `${s.skills} skills` : null, s.workspaceFiles > 0 ? `${s.workspaceFiles} rules` : null].filter(Boolean).join(' · ');
  return (
    <div className={`flex items-center gap-2.5 px-2.5 py-2 ${active ? 'border-l-2 border-accent bg-surface' : 'border-l-2 border-transparent'}`}>
      <input type="checkbox" checked={checked} onChange={onToggle} aria-label={`Transition ${agent.name}`} />
      <button type="button" onClick={onFocus} className="flex min-w-0 flex-1 items-center gap-2 text-left">
        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-line bg-surface"><Icon className="h-3.5 w-3.5" /></span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[12.5px] font-medium text-text-primary">{agent.name}</span>
          {chips && <span className="block truncate text-[11px] text-text-muted">{chips}</span>}
        </span>
      </button>
    </div>
  );
}

function ManifestPane({ agent, cachedPreview, acceptedHashes, acceptedSkillPaths, onPreviewLoaded, onAccepted, onSkillsAccepted }: {
  agent: DiscoveredAgentRow;
  cachedPreview: AgentImportPreview | null;
  acceptedHashes?: string[];
  acceptedSkillPaths?: string[];
  onPreviewLoaded: (preview: AgentImportPreview) => void;
  onAccepted: (hashes: string[]) => void;
  onSkillsAccepted: (paths: string[]) => void;
}) {
  const [preview, setPreview] = useState<AgentImportPreview | null>(cachedPreview);
  const [loading, setLoading] = useState(!cachedPreview);
  const [acceptedMem, setAcceptedMem] = useState<Set<string>>(new Set());
  const [acceptedSkills, setAcceptedSkills] = useState<Set<string>>(new Set());
  const { label, Icon } = harnessOf(agent.adapterType);

  useEffect(() => {
    let cancelled = false;
    function applyPreview(p: AgentImportPreview) {
      setPreview(p);
      const defaultMem = p.candidates.filter((c) => !c.duplicateOf).map((c) => c.hash);
      const defaultSkills = p.skills.filter((s) => s.origin !== 'marketplace' && !s.alreadyImported).map((s) => s.path);
      const mem = new Set(acceptedHashes ?? defaultMem);
      const skills = new Set(acceptedSkillPaths ?? defaultSkills);
      setAcceptedMem(mem); setAcceptedSkills(skills);
      onAccepted([...mem]); onSkillsAccepted([...skills]);
    }
    if (cachedPreview) {
      applyPreview(cachedPreview);
      setLoading(false);
      return () => { cancelled = true; };
    }
    setLoading(true); setPreview(null);
    void previewAgentImport(agent.externalId).then((p) => {
      if (cancelled) return;
      onPreviewLoaded(p);
      applyPreview(p);
    }).catch(() => { if (!cancelled) setLoading(false); }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line
  }, [agent.externalId, cachedPreview]);

  function toggleMem(hash: string) {
    setAcceptedMem((prev) => { const n = new Set(prev); n.has(hash) ? n.delete(hash) : n.add(hash); onAccepted([...n]); return n; });
  }
  function toggleSkill(p: string) {
    setAcceptedSkills((prev) => { const n = new Set(prev); n.has(p) ? n.delete(p) : n.add(p); onSkillsAccepted([...n]); return n; });
  }

  const ws = preview?.candidates.filter((c) => c.scopeHint === 'workspace') ?? [];
  const ag = preview?.candidates.filter((c) => c.scopeHint === 'agent') ?? [];
  const memoryCount = preview ? preview.candidates.length : agent.summary.memoryFiles + agent.summary.workspaceFiles + agent.summary.agentFiles;
  const skillCount = preview ? preview.skills.length : agent.summary.skills;

  return (
    <div>
      <div className="flex items-center gap-2.5">
        <span className="flex h-9 w-9 items-center justify-center rounded-full border border-line bg-surface"><Icon className="h-5 w-5" /></span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-subheading text-text-primary">{agent.name}</div>
          <div className="text-[12px] text-text-muted">Everything here connects to this agent on transition.</div>
        </div>
        {agent.alreadyImported
          ? <span className="rounded bg-surface px-2 py-0.5 text-[11px] text-success">imported</span>
          : <span className="rounded bg-success/15 px-2 py-0.5 text-[11px] text-success">→ online</span>}
      </div>

      <div className="mt-3 grid grid-cols-3 gap-2">
        <Metric label="Identity" value={agent.persona ? '✓ persona' : '—'} />
        <Metric label="Memories" value={String(memoryCount)} />
        <Metric label="Skills → abilities" value={String(skillCount)} />
      </div>

      <div className="mt-3 grid gap-2 md:grid-cols-2">
        <HelpCard title="Memories update here">
          Selected memories are merged into Agentis. New memories are written, known memories are reinforced or skipped, and future pulls only bring in fresh changes.
        </HelpCard>
        <HelpCard title="Operator-owned after import">
          The provider stays as the runtime, but the agent identity, memories, and abilities become operator-owned Agentis data you can inspect, edit, and move.
        </HelpCard>
      </div>

      <Section label="Runtime">
        <div className="flex items-center gap-2 rounded-md border border-line px-2.5 py-2">
          <Icon className="h-4 w-4" />
          <span className="text-[12.5px]">{label}{agent.detectedModel ? ` · ${agent.detectedModel}` : ''}</span>
          <span className="ml-auto text-[11px] text-accent">swappable</span>
        </div>
      </Section>

      {loading && <p className="mt-3 flex items-center gap-1.5 text-[12px] text-text-muted"><Loader2 size={12} className="animate-spin" /> Distilling memory + skills…</p>}

      {preview && (ws.length > 0 || ag.length > 0) && (
        <Section label={`Memories · ${ws.length + ag.length}`}>
          <div className="max-h-[280px] space-y-1.5 overflow-y-auto pr-1">
            {[...ag, ...ws].map((c) => (
              <label key={c.hash} className="flex items-start gap-2 rounded border border-line bg-bg p-2">
                <input type="checkbox" className="mt-0.5" checked={acceptedMem.has(c.hash)} onChange={() => toggleMem(c.hash)} aria-label={`Import ${c.title}`} />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2 text-[10.5px] text-text-muted">
                    <span className={`rounded px-1.5 py-0.5 ${c.scopeHint === 'workspace' ? 'bg-accent/15 text-accent' : 'bg-surface'}`}>{c.scopeHint === 'workspace' ? 'Workspace' : 'Agent'}</span>
                    <span>q{Math.round(c.quality * 100)}</span>
                    {c.duplicateOf && <span className="text-warn">already known</span>}
                  </span>
                  <span className="mt-0.5 block whitespace-pre-wrap break-words text-[12px] leading-relaxed text-text-secondary">{c.summary}</span>
                </span>
              </label>
            ))}
          </div>
        </Section>
      )}

      {preview && preview.skills.length > 0 && (
        <Section label={`Skills → abilities · ${preview.skills.length}`}>
          <div className="max-h-[300px] space-y-1.5 overflow-y-auto pr-1">
            {preview.skills.map((s) => (
              <label key={s.path} className="flex items-start gap-2 rounded border border-line bg-bg p-2">
                <input type="checkbox" className="mt-0.5" checked={acceptedSkills.has(s.path)} disabled={s.alreadyImported} onChange={() => toggleSkill(s.path)} aria-label={`Transition skill ${s.name}`} />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2 text-[10.5px] text-text-muted">
                    <Zap size={11} className="text-accent" />
                    {s.origin === 'marketplace' && <span className="rounded bg-surface px-1.5 py-0.5">marketplace</span>}
                    {s.alreadyImported && <span className="text-success">already an ability</span>}
                  </span>
                  <span className="mt-0.5 block text-[12px] font-medium text-text-primary">{s.name}</span>
                  {s.description && <span className="block whitespace-pre-wrap break-words text-[11px] leading-relaxed text-text-muted">{s.description}</span>}
                </span>
              </label>
            ))}
          </div>
        </Section>
      )}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md bg-surface p-2.5">
      <div className="text-[11px] text-text-muted">{label}</div>
      <div className="mt-0.5 text-[14px] font-medium text-text-primary">{value}</div>
    </div>
  );
}
function HelpCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-2 rounded-md border border-accent/25 bg-accent/10 p-2.5">
      <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-accent/40 text-[12px] font-bold text-accent">!</span>
      <span className="min-w-0">
        <span className="block text-[12px] font-semibold text-text-primary">{title}</span>
        <span className="mt-0.5 block text-[11.5px] leading-relaxed text-text-secondary">{children}</span>
      </span>
    </div>
  );
}
function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mt-4">
      <div className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-text-muted">{label}</div>
      {children}
    </div>
  );
}
function groupByHarness(agents: DiscoveredAgentRow[]): Map<string, DiscoveredAgentRow[]> {
  const map = new Map<string, DiscoveredAgentRow[]>();
  for (const a of agents) { const l = map.get(a.adapterType) ?? []; l.push(a); map.set(a.adapterType, l); }
  return map;
}
function sumTotals(agents: DiscoveredAgentRow[]) {
  return agents.reduce((acc, a) => ({
    count: acc.count + 1,
    memories: acc.memories + a.summary.memoryFiles + a.summary.workspaceFiles + a.summary.agentFiles,
    skills: acc.skills + a.summary.skills,
  }), { count: 0, memories: 0, skills: 0 });
}
