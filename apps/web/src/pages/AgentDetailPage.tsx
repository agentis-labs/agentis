/**
 * AgentDetailPage — restructured tabs (Overview / Instructions / Memory / Connections / History).
 *
 * No more playground tab. Avatar uses image fallback to initials.
 * Instructions tab renders harness-declared files (soul.md, agents.md, etc.)
 * generically — Agentis does not assume specific file types.
 */

import { useEffect, useState } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowLeft, MessageCircle, Save, Trash2, FileText } from 'lucide-react';
import { api } from '../lib/api';
import { useToast } from '../components/shared/Toast';
import { useConfirm } from '../components/shared/ConfirmDialog';
import { Tabs } from '../components/shared/Tabs';
import { Button } from '../components/shared/Button';
import { Skeleton } from '../components/shared/Skeleton';
import { StatusBadge } from '../components/shared/StatusBadge';
import { EmptyState } from '../components/shared/EmptyState';
import { MemoryEntryRow } from '../components/knowledge/MemoryEntryRow';
import { MemoryWriteForm } from '../components/knowledge/MemoryWriteForm';
import { AgentConfigPanel } from '../components/agents/AgentConfigPanel';
import { AgentChannelsTab } from '../components/agents/AgentChannelsTab';
import type { MemoryKind } from '../components/knowledge/types';

type TabKey = 'identity' | 'instructions' | 'memory' | 'runtime' | 'channels' | 'history';

/** Map legacy tab values (overview / connections) onto the redesigned set. */
function normalizeTab(raw: string | null): TabKey {
  switch (raw) {
    case 'overview':
    case 'identity':
      return 'identity';
    case 'connections':
    case 'runtime':
      return 'runtime';
    case 'instructions':
    case 'memory':
    case 'channels':
    case 'history':
      return raw;
    default:
      return 'identity';
  }
}

interface AgentDetail {
  id: string;
  name: string;
  description?: string;
  status?: string;
  spaceId?: string;
  spaceName?: string;
  adapterType?: string;
  runtimeModel?: string | null;
  config?: Record<string, unknown> | null;
  role?: string | null;
  colorHex?: string | null;
  capabilityTags?: string[] | null;
  instructions?: string | null;
  avatarGlyph?: string | null;
  monthlyBudgetCents?: number | null;
  currentMonthSpendCents?: number | null;
  isPaused?: boolean | null;
  reportsTo?: string | null;
  adapter?: { type?: string; model?: string; config?: Record<string, unknown> };
  avatarUrl?: string | null;
  systemPrompt?: string;
  createdAt?: string;
}

interface InstructionFile {
  name: string;
  description?: string;
  content: string;
  readonly?: boolean;
  source: 'harness' | 'platform';
}

interface MemoryEntry {
  id: string;
  source: 'agent' | 'platform';
  sourceType?: string;
  type?: string;
  kind?: string;
  title?: string;
  content: string;
  trust?: number;
  confidence?: number;
  importance?: number;
  createdAt: string;
  updatedAt?: string;
}

interface RunHistoryEntry {
  id: string;
  workflowName?: string;
  status: string;
  startedAt: string;
  finishedAt?: string;
}

interface AgentSummary {
  id: string;
  name: string;
  role?: string | null;
}

function initials(name: string): string {
  const p = name.trim().split(/\s+/).filter(Boolean);
  if (p.length === 0) return '?';
  const first = p[0] ?? '';
  if (p.length === 1) return first.slice(0, 2).toUpperCase();
  const last = p[p.length - 1] ?? '';
  return ((first[0] ?? '') + (last[0] ?? '')).toUpperCase();
}

function relativeTime(iso: string): string {
  try {
    const d = Date.now() - new Date(iso).getTime();
    if (d < 60000) return 'just now';
    if (d < 3600_000) return `${Math.floor(d / 60000)}m ago`;
    if (d < 86_400_000) return `${Math.floor(d / 3600_000)}h ago`;
    return `${Math.floor(d / 86_400_000)}d ago`;
  } catch { return ''; }
}

export function AgentDetailPage() {
  const { id } = useParams<{ id: string }>();
  const nav = useNavigate();
  const toast = useToast();
  const confirm = useConfirm();
  const [searchParams] = useSearchParams();
  const tab = normalizeTab(searchParams.get('tab'));
  const [agent, setAgent] = useState<AgentDetail | null>(null);
  const [allAgents, setAllAgents] = useState<AgentSummary[]>([]);
  const [allSpaces, setAllSpaces] = useState<Array<{ id: string; name: string }>>([]);
  const [loading, setLoading] = useState(true);

  async function refresh() {
    if (!id) return;
    setLoading(true);
    try {
      const [agentResult, agentsResult, spacesResult] = await Promise.allSettled([
        api<{ agent: AgentDetail }>(`/v1/agents/${id}`),
        api<{ agents: AgentSummary[] }>('/v1/agents'),
        api<{ spaces: Array<{ id: string; name: string }> }>('/v1/spaces'),
      ]);
      if (agentResult.status === 'fulfilled') setAgent(agentResult.value.agent);
      else setAgent(null);
      if (agentsResult.status === 'fulfilled') setAllAgents(agentsResult.value.agents ?? []);
      if (spacesResult.status === 'fulfilled') setAllSpaces(spacesResult.value.spaces ?? []);
    } catch { setAgent(null); }
    finally { setLoading(false); }
  }

  useEffect(() => { void refresh(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [id]);

  async function handleDelete() {
    if (!agent) return;
    const ok = await confirm({
      title: `Delete agent "${agent.name}"?`,
      body: 'This will remove the agent from this workspace. This action cannot be undone.',
      confirmLabel: 'Delete agent',
      tone: 'danger',
      typeToConfirm: agent.name,
    });
    if (!ok) return;
    try {
      await api(`/v1/agents/${agent.id}`, { method: 'DELETE' });
      toast.undo(`Deleted ${agent.name}`, async () => {
        try {
          await api(`/v1/agents/${agent.id}/restore`, { method: 'POST' });
          toast.success(`Restored ${agent.name}`);
          void refresh();
        } catch { toast.error('Failed to restore'); }
      });
      nav('/agents');
    } catch (e) { toast.error('Failed to delete', String(e)); }
  }

  if (loading && !agent) {
    return (
      <div className="space-y-4 p-6">
        <Skeleton width={200} height={28} />
        <Skeleton height={120} />
        <Skeleton height={400} />
      </div>
    );
  }

  if (!agent) {
    return (
      <div className="p-8">
        <EmptyState
          icon={<FileText size={48} />}
          title="Agent not found"
          body="This agent may have been deleted or you don't have access."
          primaryAction={<Button variant="primary" size="md" onClick={() => nav('/agents')}>Back to agents</Button>}
          variant="page"
        />
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="border-b border-line px-6 py-4">
        <button
          onClick={() => nav('/agents')}
          className="mb-3 inline-flex items-center gap-1 text-[12px] text-text-muted hover:text-text-primary"
        >
          <ArrowLeft size={12} /> Agents
        </button>
        <div className="flex items-start gap-4">
          <div className="h-16 w-16 shrink-0 overflow-hidden rounded-full border border-line bg-surface-2">
            {agent.avatarUrl ? (
              <img src={agent.avatarUrl} alt={agent.name} className="h-full w-full object-cover" />
            ) : (
              <span className="flex h-full w-full items-center justify-center text-[20px] font-bold text-text-primary">
                {initials(agent.name)}
              </span>
            )}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h1 className="truncate text-display text-text-primary">{agent.name}</h1>
              <StatusBadge status={agent.status ?? 'offline'} size="sm" />
            </div>
            {agent.description && (
              <p className="mt-1 text-[13px] text-text-secondary">{agent.description}</p>
            )}
            <div className="mt-2 flex flex-wrap gap-3 text-[12px] text-text-muted">
              {agent.spaceName && <span>{agent.spaceName}</span>}
              <span>{harnessLabel(agentHarnessType(agent))}{agentRuntimeModel(agent) ? ` · ${agentRuntimeModel(agent)}` : ''}</span>
              {agent.createdAt && <span>Created {relativeTime(agent.createdAt)}</span>}
            </div>
          </div>
          <div className="flex shrink-0 gap-1.5">
            <Button variant="secondary" size="sm" iconLeft={<MessageCircle size={12} />} onClick={() => nav(`/chat/agent/${agent.id}`)}>Talk</Button>
            <Button variant="danger" size="sm" iconLeft={<Trash2 size={12} />} onClick={() => void handleDelete()}>Delete</Button>
          </div>
        </div>
      </div>

      <Tabs
        param="tab"
        value={tab}
        defaultValue="identity"
        tabs={[
          { value: 'identity',     label: 'Identity' },
          { value: 'instructions', label: 'Instructions' },
          { value: 'memory',       label: 'Memory' },
          { value: 'runtime',      label: 'Runtime' },
          { value: 'channels',     label: 'Channels' },
          { value: 'history',      label: 'History' },
        ]}
        className="px-6"
      />

      <div className="flex-1 overflow-y-auto px-6 py-5">
        {tab === 'identity' && <IdentityTab agent={agent} allAgents={allAgents} allSpaces={allSpaces} onChange={refresh} />}
        {tab === 'instructions' && <InstructionsTab agent={agent} />}
        {tab === 'memory' && <MemoryTab agent={agent} />}
        {tab === 'runtime' && <RuntimeTab agent={agent} allAgents={allAgents} onChange={refresh} />}
        {tab === 'channels' && <AgentChannelsTab agentId={agent.id} agentName={agent.name} />}
        {tab === 'history' && <HistoryTab agent={agent} />}
      </div>
    </div>
  );
}

const ROLE_OPTIONS = [
  { value: 'orchestrator', label: 'Orchestrator' },
  { value: 'manager', label: 'Manager' },
  { value: 'worker', label: 'Worker' },
] as const;

const IDENTITY_INPUT_CLS =
  'w-full rounded-input border border-line bg-surface-2 px-3 py-2 text-[13px] text-text-primary placeholder:text-text-muted focus:border-accent focus:outline-none';

/**
 * Identity tab — who the agent is: name, role, avatar, description, and the
 * chain-of-command placement (AGENTS-PAGE-REDESIGN.md §3.2). Technical harness
 * and model fields live in the Runtime tab.
 */
function IdentityTab({
  agent,
  allAgents,
  allSpaces,
  onChange,
}: {
  agent: AgentDetail;
  allAgents: AgentSummary[];
  allSpaces: Array<{ id: string; name: string }>;
  onChange: () => void;
}) {
  const toast = useToast();
  const confirm = useConfirm();
  const [name, setName] = useState(agent.name);
  const [role, setRole] = useState(agent.role ?? 'worker');
  const [description, setDescription] = useState(agent.description ?? '');
  const [reportsTo, setReportsTo] = useState(agent.reportsTo ?? '');
  const [spaceId, setSpaceId] = useState(agent.spaceId ?? '');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setName(agent.name);
    setRole(agent.role ?? 'worker');
    setDescription(agent.description ?? '');
    setReportsTo(agent.reportsTo ?? '');
    setSpaceId(agent.spaceId ?? '');
  }, [agent]);

  const needsSupervisor = role === 'manager' || role === 'worker';
  const dirty =
    name.trim() !== agent.name ||
    role !== (agent.role ?? 'worker') ||
    description !== (agent.description ?? '') ||
    (needsSupervisor ? reportsTo : '') !== (agent.reportsTo ?? '') ||
    (needsSupervisor ? spaceId : '') !== (agent.spaceId ?? '');

  async function save() {
    if (!name.trim()) {
      toast.error('Name is required');
      return;
    }
    setSaving(true);
    try {
      const currentOrchestrator = allAgents.find((candidate) => candidate.id !== agent.id && candidate.role === 'orchestrator');
      const replaceExistingOrchestrator = role === 'orchestrator' && Boolean(currentOrchestrator);
      if (replaceExistingOrchestrator && currentOrchestrator) {
        const ok = await confirm({
          title: `Make ${agent.name} the orchestrator?`,
          body: `${currentOrchestrator.name} is the current workspace orchestrator. This will demote ${currentOrchestrator.name} to manager and route managers to ${agent.name}.`,
          confirmLabel: 'Make orchestrator',
          tone: 'warn',
        });
        if (!ok) return;
      }
      await api(`/v1/agents/${agent.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          name: name.trim(),
          role,
          description: description.trim() || null,
          reportsTo: needsSupervisor ? reportsTo || null : null,
          spaceId: needsSupervisor ? spaceId || null : null,
          ...(replaceExistingOrchestrator ? { replaceExistingOrchestrator: true } : {}),
        }),
      });
      toast.success('Identity saved');
      onChange();
    } catch (err) {
      toast.error('Could not save identity', String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="max-w-xl space-y-5">
      <div className="flex items-center gap-4">
        <div className="h-16 w-16 shrink-0 overflow-hidden rounded-full border border-line bg-surface-2">
          {agent.avatarUrl ? (
            <img src={agent.avatarUrl} alt={agent.name} className="h-full w-full object-cover" />
          ) : (
            <span className="flex h-full w-full items-center justify-center text-[20px] font-bold text-text-primary">
              {agent.avatarGlyph || initials(agent.name)}
            </span>
          )}
        </div>
        <div className="text-[12px] text-text-muted">
          The avatar is set from the agent's harness glyph.
        </div>
      </div>

      <IdentityField label="Name">
        <input value={name} onChange={(event) => setName(event.target.value)} className={IDENTITY_INPUT_CLS} />
      </IdentityField>

      <IdentityField label="Role">
        <div className="flex flex-wrap gap-2">
          {ROLE_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              onClick={() => setRole(option.value)}
              className={
                'rounded-btn border px-3 py-1.5 text-[13px] font-medium transition-colors ' +
                (role === option.value
                  ? 'border-accent bg-accent-soft text-accent'
                  : 'border-line bg-surface-2 text-text-secondary hover:border-line-strong hover:text-text-primary')
              }
            >
              {option.label}
            </button>
          ))}
        </div>
      </IdentityField>

      <IdentityField label="Description" hint="Optional">
        <textarea
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          rows={3}
          className={IDENTITY_INPUT_CLS + ' resize-none'}
          placeholder="What this agent is responsible for."
        />
      </IdentityField>

      {needsSupervisor && (
        <>
          <IdentityField label="Reports to">
            <select value={reportsTo} onChange={(event) => setReportsTo(event.target.value)} className={IDENTITY_INPUT_CLS}>
              <option value="">No supervisor</option>
              {allAgents
                .filter((candidate) => candidate.id !== agent.id)
                .map((candidate) => (
                  <option key={candidate.id} value={candidate.id}>{candidate.name}</option>
                ))}
            </select>
          </IdentityField>
          <IdentityField label="Space">
            <select value={spaceId} onChange={(event) => setSpaceId(event.target.value)} className={IDENTITY_INPUT_CLS}>
              <option value="">No space</option>
              {allSpaces.map((space) => (
                <option key={space.id} value={space.id}>{space.name}</option>
              ))}
            </select>
          </IdentityField>
        </>
      )}

      <Button variant="primary" size="md" iconLeft={<Save size={13} />} disabled={saving || !dirty} onClick={() => void save()}>
        {saving ? 'Saving…' : 'Save identity'}
      </Button>
    </div>
  );
}

function IdentityField({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-text-muted">
        {label}
        {hint && <span className="font-normal normal-case tracking-normal text-text-muted">· {hint}</span>}
      </span>
      {children}
    </label>
  );
}

function InstructionsTab({ agent }: { agent: AgentDetail }) {
  const toast = useToast();
  const [files, setFiles] = useState<InstructionFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [active, setActive] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [newFileName, setNewFileName] = useState<string | null>(null);

  function createFile() {
    const raw = (newFileName ?? '').trim();
    if (!raw) return;
    const fileName = /\.[a-z0-9]+$/i.test(raw) ? raw : `${raw}.md`;
    if (files.some((f) => f.name === fileName)) {
      toast.error('File already exists', fileName);
      return;
    }
    const created: InstructionFile = { name: fileName, content: '', source: 'platform' };
    setFiles((arr) => [...arr, created]);
    setActive(fileName);
    setDraft('');
    setNewFileName(null);
  }

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setLoading(true);
      try {
        const data = await api<{ files: InstructionFile[] }>(`/v1/agents/${agent.id}/instructions`);
        if (cancelled) return;
        const list = data.files ?? [];
        setFiles(list);
        const first = list[0];
        if (first) {
          setActive(first.name);
          setDraft(first.content);
        }
      } catch {
        if (cancelled) return;
        const sys = agent.systemPrompt ?? '';
        const fallback: InstructionFile[] = sys
          ? [{ name: 'system.md', content: sys, source: 'platform', description: 'System prompt' }]
          : [];
        setFiles(fallback);
        if (fallback[0]) { setActive(fallback[0].name); setDraft(fallback[0].content); }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [agent.id, agent.systemPrompt]);

  const activeFile = files.find((f) => f.name === active);

  async function save() {
    if (!activeFile) return;
    setSaving(true);
    try {
      await api(`/v1/agents/${agent.id}/instructions/${encodeURIComponent(activeFile.name)}`, {
        method: 'PUT',
        body: JSON.stringify({ content: draft }),
      });
      toast.success('Saved', activeFile.name);
      setFiles((arr) => arr.map((f) => f.name === activeFile.name ? { ...f, content: draft } : f));
    } catch (e) { toast.error('Failed to save', String(e)); }
    finally { setSaving(false); }
  }

  if (loading) return <Skeleton height={400} />;

  if (files.length === 0) {
    return (
      <div className="mx-auto max-w-md rounded-card border border-line bg-surface px-6 py-8 text-center">
        <FileText size={40} className="mx-auto text-text-muted" />
        <h3 className="mt-3 text-subheading text-text-primary">No instruction files yet</h3>
        <p className="mt-1.5 text-[13px] leading-relaxed text-text-secondary">
          Start by creating one — give this agent a persona, a role, or standing operating instructions.
        </p>
        {newFileName === null ? (
          <Button variant="primary" size="sm" className="mt-4" onClick={() => setNewFileName('')}>
            + Create first file
          </Button>
        ) : (
          <div className="mt-4 flex items-center gap-2">
            <input
              autoFocus
              value={newFileName}
              onChange={(event) => setNewFileName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') createFile();
                if (event.key === 'Escape') setNewFileName(null);
              }}
              placeholder="File name (e.g. persona.md)"
              className="flex-1 rounded-input border border-line bg-surface-2 px-3 py-2 font-mono text-[13px] text-text-primary placeholder:text-text-muted focus:border-accent focus:outline-none"
            />
            <Button variant="primary" size="sm" onClick={createFile}>Create</Button>
            <Button variant="ghost" size="sm" onClick={() => setNewFileName(null)}>Cancel</Button>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-[200px_1fr]">
      <aside className="space-y-1">
        {files.map((f) => (
          <button
            key={f.name}
            type="button"
            onClick={() => { setActive(f.name); setDraft(f.content); }}
            className={`flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-[13px] transition-colors ${
              active === f.name
                ? 'bg-surface-2 text-text-primary'
                : 'text-text-muted hover:bg-surface-2 hover:text-text-primary'
            }`}
          >
            <FileText size={12} />
            <span className="flex-1 truncate font-mono">{f.name}</span>
            <span className="text-[10px] text-text-muted">{f.source}</span>
          </button>
        ))}
        {newFileName === null ? (
          <button
            type="button"
            onClick={() => setNewFileName('')}
            className="flex w-full items-center gap-2 rounded-md border border-dashed border-line px-2.5 py-2 text-left text-[13px] text-text-muted transition-colors hover:border-line-strong hover:text-text-primary"
          >
            <FileText size={12} /> + New file
          </button>
        ) : (
          <div className="space-y-1.5 rounded-md border border-line bg-surface-2 p-2">
            <input
              autoFocus
              value={newFileName}
              onChange={(event) => setNewFileName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') createFile();
                if (event.key === 'Escape') setNewFileName(null);
              }}
              placeholder="persona.md"
              className="w-full rounded-input border border-line bg-surface px-2 py-1.5 font-mono text-[12px] text-text-primary placeholder:text-text-muted focus:border-accent focus:outline-none"
            />
            <div className="flex gap-1.5">
              <Button variant="primary" size="sm" onClick={createFile}>Create</Button>
              <Button variant="ghost" size="sm" onClick={() => setNewFileName(null)}>Cancel</Button>
            </div>
          </div>
        )}
      </aside>

      {activeFile && (
        <div className="space-y-3">
          <div className="flex items-center gap-3">
            <div>
              <div className="font-mono text-subheading text-text-primary">{activeFile.name}</div>
              {activeFile.description && (
                <div className="text-[11px] text-text-muted">{activeFile.description}</div>
              )}
            </div>
            <div className="ml-auto">
              <Button
                variant="primary" size="sm" iconLeft={<Save size={12} />}
                disabled={saving || draft === activeFile.content || activeFile.readonly}
                onClick={() => void save()}
              >Save</Button>
            </div>
          </div>
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            disabled={activeFile.readonly}
            className="h-[480px] w-full resize-none rounded-input border border-line bg-surface-2 p-4 font-mono text-[13px] leading-relaxed text-text-primary placeholder:text-text-muted focus:border-accent focus:outline-none"
            spellCheck={false}
          />
        </div>
      )}
    </div>
  );
}

function MemoryTab({ agent }: { agent: AgentDetail }) {
  const toast = useToast();
  const [entries, setEntries] = useState<MemoryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<'all' | 'agent' | 'platform'>('all');
  const [kindFilter, setKindFilter] = useState<'all' | MemoryKind>('all');

  async function refresh() {
    setLoading(true);
    try {
      const data = await api<{ entries: MemoryEntry[] }>(`/v1/agents/${agent.id}/memory`);
      setEntries(data.entries ?? []);
    } catch {
      setEntries([]);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void refresh(); }, [agent.id]);

  async function saveMemory(entry: { kind: MemoryKind; title: string; content: string }) {
    await api(`/v1/agents/${agent.id}/memory`, { method: 'POST', body: JSON.stringify(entry) });
    toast.success('Agent memory saved', entry.title);
    await refresh();
  }

  async function archiveMemory(id: string) {
    await api(`/v1/memory/${id}`, { method: 'DELETE' });
    toast.success('Agent memory archived');
    await refresh();
  }

  const filtered = entries.filter((e) => {
    if (filter !== 'all' && e.source !== filter) return false;
    return kindFilter === 'all' || (e.kind ?? e.type) === kindFilter;
  });

  if (loading) return <Skeleton height={300} />;

  return (
    <div className="space-y-4">
      <MemoryWriteForm
        submitLabel="Save to agent memory"
        placeholder="A rule, fact, or preference injected into this agent's future work."
        onSubmit={saveMemory}
      />

      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[12px] text-text-muted">{entries.length} {entries.length === 1 ? 'memory' : 'memories'}</span>
        <div className="ml-auto flex flex-wrap gap-1">
          {(['all', 'agent', 'platform'] as const).map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => setFilter(f)}
              className={`inline-flex h-7 items-center rounded-pill border px-2.5 text-[11px] font-medium ${
                filter === f
                  ? 'border-accent-muted bg-accent-soft text-accent'
                  : 'border-line bg-surface-2 text-text-secondary hover:bg-surface-3 hover:text-text-primary'
              }`}
            >{f === 'all' ? 'All' : f === 'agent' ? 'Agent-native' : 'Platform'}</button>
          ))}
          {(['fact', 'rule', 'preference', 'pattern', 'lesson'] as const).map((kind) => (
            <button
              key={kind}
              type="button"
              onClick={() => setKindFilter(kindFilter === kind ? 'all' : kind)}
              className={`inline-flex h-7 items-center rounded-pill border px-2.5 text-[11px] font-medium capitalize ${
                kindFilter === kind
                  ? 'border-accent-muted bg-accent-soft text-accent'
                  : 'border-line bg-surface-2 text-text-secondary hover:bg-surface-3 hover:text-text-primary'
              }`}
            >{kind}</button>
          ))}
        </div>
      </div>

      {filtered.length === 0 ? (
        <EmptyState
          icon={<FileText size={48} />}
          title="No memories yet"
          body="Add a rule, fact, or preference to shape how this agent behaves on every task. Auto-learned memories will appear here as the agent works."
        />
      ) : (
        <div className="space-y-2">
          {filtered.map((m) => <MemoryEntryRow key={m.id} entry={m} onArchive={(id) => void archiveMemory(id)} />)}
        </div>
      )}
    </div>
  );
}

/**
 * Runtime tab — how the agent connects to a harness, its model, capability
 * tags, budget, and supervisor (AGENTS-PAGE-REDESIGN.md §3.4).
 */
function RuntimeTab({ agent, allAgents, onChange }: { agent: AgentDetail; allAgents: AgentSummary[]; onChange: () => void }) {
  return (
    <AgentConfigPanel
      agent={{
        id: agent.id,
        name: agent.name,
        adapterType: agentHarnessType(agent),
        runtimeModel: agentRuntimeModel(agent),
        role: agent.role ?? null,
        status: agent.status ?? 'offline',
        colorHex: agent.colorHex ?? null,
        capabilityTags: agent.capabilityTags ?? null,
        instructions: agent.instructions ?? agent.systemPrompt ?? null,
        avatarGlyph: agent.avatarGlyph ?? null,
        isPaused: agent.isPaused ?? null,
        monthlyBudgetCents: agent.monthlyBudgetCents ?? null,
        currentMonthSpendCents: agent.currentMonthSpendCents ?? null,
        config: agent.config ?? agent.adapter?.config ?? null,
        reportsTo: agent.reportsTo ?? null,
        spaceId: agent.spaceId ?? null,
      }}
      allAgents={allAgents}
      onSaved={onChange}
    />
  );
}

function agentHarnessType(agent: AgentDetail) {
  return agent.adapterType ?? agent.adapter?.type ?? 'http';
}

function agentRuntimeModel(agent: AgentDetail) {
  return agent.runtimeModel ?? agent.adapter?.model ?? null;
}

function harnessLabel(adapterType: string) {
  switch (adapterType) {
    case 'openclaw': return 'OpenClaw';
    case 'hermes_agent': return 'Hermes Agent';
    case 'claude_code': return 'Claude Code';
    case 'codex': return 'Codex';
    case 'cursor': return 'Cursor';
    case 'http': return 'HTTP / Webhook';
    default: return 'Harness';
  }
}

function HistoryTab({ agent }: { agent: AgentDetail }) {
  const nav = useNavigate();
  const [runs, setRuns] = useState<RunHistoryEntry[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const data = await api<{ runs: RunHistoryEntry[] }>(`/v1/agents/${agent.id}/runs?limit=20`);
        if (!cancelled) setRuns(data.runs ?? []);
      } catch { if (!cancelled) setRuns([]); }
      finally { if (!cancelled) setLoading(false); }
    })();
    return () => { cancelled = true; };
  }, [agent.id]);

  if (loading) return <Skeleton height={300} />;

  if (runs.length === 0) {
    return (
      <EmptyState
        icon={<FileText size={48} />}
        title="No history yet"
        body="Runs and activity for this agent will appear here."
      />
    );
  }
  return (
    <div className="space-y-1">
      {runs.map((r) => (
        <button
          key={r.id}
          type="button"
          onClick={() => nav(`/runs/${r.id}`)}
          className="flex w-full items-center gap-3 rounded-md border border-line bg-surface px-4 py-3 text-left transition-colors hover:bg-surface-2"
        >
          <StatusBadge status={r.status} size="sm" />
          <span className="flex-1 truncate text-[13px] text-text-primary">{r.workflowName ?? 'Workflow run'}</span>
          <span className="text-[11px] text-text-muted">{relativeTime(r.startedAt)}</span>
        </button>
      ))}
    </div>
  );
}
