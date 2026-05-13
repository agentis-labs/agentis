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
import type { MemoryKind } from '../components/knowledge/types';

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
  const tab = searchParams.get('tab') ?? 'overview';
  const [agent, setAgent] = useState<AgentDetail | null>(null);
  const [loading, setLoading] = useState(true);

  async function refresh() {
    if (!id) return;
    setLoading(true);
    try {
      const a = await api<{ agent: AgentDetail }>(`/v1/agents/${id}`);
      setAgent(a.agent);
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
        defaultValue="overview"
        tabs={[
          { value: 'overview',     label: 'Overview' },
          { value: 'instructions', label: 'Instructions' },
          { value: 'memory',       label: 'Memory' },
          { value: 'connections',  label: 'Connections' },
          { value: 'history',      label: 'History' },
        ]}
        className="px-6"
      />

      <div className="flex-1 overflow-y-auto px-6 py-5">
        {tab === 'overview' && <OverviewTab agent={agent} />}
        {tab === 'instructions' && <InstructionsTab agent={agent} />}
        {tab === 'memory' && <MemoryTab agent={agent} />}
        {tab === 'connections' && <ConnectionsTab agent={agent} onChange={refresh} />}
        {tab === 'history' && <HistoryTab agent={agent} />}
      </div>
    </div>
  );
}

function OverviewTab({ agent }: { agent: AgentDetail }) {
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <Stat label="Status" value={agent.status ?? 'offline'} />
        <Stat label="Harness" value={harnessLabel(agentHarnessType(agent))} />
        <Stat label="Model" value={agentRuntimeModel(agent) ?? '—'} />
      </div>
      {agent.description && (
        <div className="rounded-card border border-line bg-surface p-4">
          <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-text-muted">Description</div>
          <p className="text-[13px] leading-relaxed text-text-primary">{agent.description}</p>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="rounded-card border border-line bg-surface p-4">
      <div className="text-[11px] font-medium uppercase tracking-wider text-text-muted">{label}</div>
      <div className="mt-1 text-heading capitalize text-text-primary">{value}</div>
    </div>
  );
}

function InstructionsTab({ agent }: { agent: AgentDetail }) {
  const toast = useToast();
  const [files, setFiles] = useState<InstructionFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [active, setActive] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);

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
      <EmptyState
        icon={<FileText size={48} />}
        title="No instruction files"
        body="This agent's harness hasn't declared any instruction files yet. Files appear here automatically when the harness ships them."
        variant="page"
      />
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
            {f.source === 'harness' && (
              <span className="text-[10px] text-text-muted">harness</span>
            )}
          </button>
        ))}
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

function ConnectionsTab({ agent, onChange }: { agent: AgentDetail; onChange: () => void }) {
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
      }}
      allAgents={[]}
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
