/**
 * AgentDetailPage — restructured tabs (Overview / Instructions / Memory / Connections / History).
 *
 * No more playground tab. Avatar uses image fallback to initials.
 * Instructions renders files discovered from the real runtime profile and
 * project, with the Agentis overlay shown as one explicit context layer.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowLeft, MessageCircle, Save, Trash2, FileText, Upload, Sparkles, Pin, PinOff, ArrowUpFromLine } from 'lucide-react';
import { api, apiErrorMessage } from '../lib/api';
import { openRunModal } from '../lib/runModal';
import { useToast } from '../components/shared/Toast';
import { useConfirm } from '../components/shared/ConfirmDialog';
import { Tabs } from '../components/shared/Tabs';
import { Button } from '../components/shared/Button';
import { Skeleton } from '../components/shared/Skeleton';
import { StatusBadge } from '../components/shared/StatusBadge';
import { EmptyState } from '../components/shared/EmptyState';
import { AgentConfigPanel } from '../components/agents/AgentConfigPanel';
import { AgentChannelsTab } from '../components/agents/AgentChannelsTab';
import { AgentInteractionFeed } from '../components/agents/AgentInteractionFeed';
import { RuntimeNativePanel } from '../components/agents/RuntimeNativePanel';
import { DeleteAgentDialog } from '../components/agents/DeleteAgentDialog';
import { DomainEditorSheet, type DomainOption } from '../components/agents/DomainEditorSheet';
import { useAgentInstallSession } from '../hooks/useBackgroundInstall';

type TabKey = 'identity' | 'instructions' | 'runtime' | 'memory' | 'channels' | 'interactions' | 'history';

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
    case 'interactions':
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
  const [searchParams] = useSearchParams();
  const tab = normalizeTab(searchParams.get('tab'));
  const [agent, setAgent] = useState<AgentDetail | null>(null);
  const [allAgents, setAllAgents] = useState<AgentSummary[]>([]);
  const [allSpaces, setAllSpaces] = useState<Array<{ id: string; name: string; parentDomainId?: string | null }>>([]);
  const [loading, setLoading] = useState(true);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const installSession = useAgentInstallSession(agent?.id);

  async function refresh() {
    if (!id) return;
    setLoading(true);
    try {
      const [agentResult, agentsResult, spacesResult] = await Promise.allSettled([
        api<{ agent: AgentDetail }>(`/v1/agents/${id}`),
        api<{ agents: AgentSummary[] }>('/v1/agents'),
        api<{ data: Array<{ id: string; name: string }> }>('/v1/domains'),
      ]);
      if (agentResult.status === 'fulfilled') setAgent(agentResult.value.agent);
      else setAgent(null);
      if (agentsResult.status === 'fulfilled') setAllAgents(agentsResult.value.agents ?? []);
      if (spacesResult.status === 'fulfilled') setAllSpaces(spacesResult.value.data ?? []);
    } catch { setAgent(null); }
    finally { setLoading(false); }
  }

  useEffect(() => { void refresh(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [id]);

  function handleDelete() {
    if (!agent) return;
    setDeleteOpen(true);
  }

  async function handlePackageAgent() {
    if (!agent) return;
    try {
      const packed = await api<{ id: string }>(`/v1/packages/pack/agent/${agent.id}`, { method: 'POST', body: JSON.stringify({}) });
      const envelope = await api<Record<string, unknown>>(`/v1/packages/${packed.id}/export`);
      const filename = `${agent.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.agentisagt`;
      downloadJson(envelope, filename);
      toast.success('Agent packaged successfully', agent.name);
    } catch (e) {
      toast.error('Failed to package agent', apiErrorMessage(e));
    }
  }

  function downloadJson(value: unknown, fileName: string) {
    const blob = new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
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

  const installActive = installSession?.phase === 'installing' || installSession?.phase === 'verifying';
  const displayStatus = agent.status === 'setting_up' && !installActive ? 'error' : agent.status ?? 'offline';
  const displayStatusLabel = agent.status === 'setting_up' && !installActive ? 'runtime missing' : undefined;

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
              <StatusBadge status={displayStatus} label={displayStatusLabel} pulse={installActive ? undefined : false} size="sm" />
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
            <Button
              variant="secondary"
              size="sm"
              iconLeft={<MessageCircle size={12} />}
              onClick={() => window.dispatchEvent(new CustomEvent('agentis:chat-panel-open', {
                detail: { agentId: agent.id, name: agent.name, mode: 'fullscreen' },
              }))}
            >
              Talk
            </Button>
            <Button variant="secondary" size="sm" iconLeft={<ArrowUpFromLine size={12} />} onClick={() => void handlePackageAgent()}>Package</Button>
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
          { value: 'runtime',      label: 'Runtime' },
          { value: 'memory',       label: 'Memory' },
          { value: 'channels',     label: 'Channels' },
          { value: 'interactions', label: 'Interactions' },
          { value: 'history',      label: 'History' },
        ]}
        className="px-6"
      />

      <div className="flex-1 overflow-y-auto px-6 py-5">
        {tab === 'identity' && <IdentityTab agent={agent} allAgents={allAgents} allSpaces={allSpaces} onChange={refresh} />}
        {tab === 'instructions' && <RuntimeNativePanel agentId={agent.id} mode="resources" />}
        {tab === 'runtime' && <RuntimeTab agent={agent} allAgents={allAgents} onChange={refresh} />}
        {tab === 'memory' && <MemoryTab agent={agent} />}
        {tab === 'channels' && <AgentChannelsTab agentId={agent.id} agentName={agent.name} />}
        {tab === 'interactions' && <AgentInteractionFeed agentId={agent.id} />}
        {tab === 'history' && <HistoryTab agent={agent} />}
      </div>
      {deleteOpen && (
        <DeleteAgentDialog
          agent={{ id: agent.id, name: agent.name }}
          allAgents={allAgents.map((a) => ({ id: a.id, name: a.name }))}
          onClose={() => setDeleteOpen(false)}
          onDeleted={() => { setDeleteOpen(false); toast.success(`Deleted ${agent.name}`); nav('/agents'); }}
        />
      )}
    </div>
  );
}

const ROLE_OPTIONS = [
  { value: 'orchestrator', label: 'Orchestrator' },
  { value: 'manager', label: 'Manager' },
  { value: 'worker', label: 'Specialist' },
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
  allSpaces: Array<{ id: string; name: string; parentDomainId?: string | null }>;
  onChange: () => void;
}) {
  const toast = useToast();
  const confirm = useConfirm();
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [name, setName] = useState(agent.name);
  const [role, setRole] = useState(agent.role ?? 'worker');
  const [description, setDescription] = useState(agent.description ?? '');
  const [reportsTo, setReportsTo] = useState(agent.reportsTo ?? '');
  const [spaceId, setSpaceId] = useState(agent.spaceId ?? '');
  const [spaces, setSpaces] = useState<DomainOption[]>(() => allSpaces.map((space) => ({ id: space.id, name: space.name, parentDomainId: space.parentDomainId ?? null })));
  const [avatarUrl, setAvatarUrl] = useState(agent.avatarUrl ?? '');
  const [domainEditorOpen, setDomainEditorOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const managers = useMemo(
    () => allAgents
      .filter((candidate) => candidate.id !== agent.id && candidate.role === 'manager')
      .map((candidate) => ({ id: candidate.id, name: candidate.name, role: candidate.role ?? null })),
    [agent.id, allAgents],
  );

  useEffect(() => {
    setName(agent.name);
    setRole(agent.role ?? 'worker');
    setDescription(agent.description ?? '');
    setReportsTo(agent.reportsTo ?? '');
    setSpaceId(agent.spaceId ?? '');
    setAvatarUrl(agent.avatarUrl ?? '');
  }, [agent]);

  useEffect(() => {
    setSpaces(allSpaces.map((space) => ({ id: space.id, name: space.name, parentDomainId: space.parentDomainId ?? null })));
  }, [allSpaces]);

  function handleAvatarInput(file: File | undefined) {
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      toast.error('Unsupported image', 'Use PNG, JPG, or WEBP.');
      return;
    }
    if (file.size > 2_500_000) {
      toast.error('Image too large', 'Use an image up to 2.5MB.');
      return;
    }
    const reader = new FileReader();
    reader.onload = (event) => setAvatarUrl(String(event.target?.result ?? ''));
    reader.readAsDataURL(file);
  }

  function handleSpaceChange(value: string) {
    if (value === '__create__') {
      setDomainEditorOpen(true);
      return;
    }
    setSpaceId(value);
  }

  const needsSupervisor = role === 'manager' || role === 'worker';
  const dirty =
    name.trim() !== agent.name ||
    role !== (agent.role ?? 'worker') ||
    description !== (agent.description ?? '') ||
    (needsSupervisor ? reportsTo : '') !== (agent.reportsTo ?? '') ||
    (needsSupervisor ? spaceId : '') !== (agent.spaceId ?? '') ||
    avatarUrl !== (agent.avatarUrl ?? '');

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
          avatarUrl: avatarUrl || null,
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
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          className="group relative h-16 w-16 shrink-0 overflow-hidden rounded-full border border-line bg-surface-2"
          aria-label="Upload avatar image"
        >
          {avatarUrl ? (
            <img src={avatarUrl} alt={agent.name} className="h-full w-full object-cover" />
          ) : (
            <span className="flex h-full w-full items-center justify-center text-[20px] font-bold text-text-primary">
              {agent.avatarGlyph || initials(agent.name)}
            </span>
          )}
          <span className="absolute inset-0 hidden items-center justify-center bg-black/55 text-white group-hover:flex">
            <Upload size={14} />
          </span>
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          onChange={(event) => {
            handleAvatarInput(event.target.files?.[0]);
            event.target.value = '';
          }}
          className="hidden"
        />
        <div className="text-[12px] text-text-muted">
          {avatarUrl ? (
            <button type="button" onClick={() => setAvatarUrl('')} className="text-text-secondary hover:text-text-primary">
              Remove image
            </button>
          ) : (
            'Upload an avatar image (optional).'
          )}
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
          <IdentityField label="Domain">
            <select value={spaceId} onChange={(event) => handleSpaceChange(event.target.value)} className={IDENTITY_INPUT_CLS}>
              <option value="">No domain</option>
              {spaces.map((space) => {
                const parent = space.parentDomainId ? spaces.find((d) => d.id === space.parentDomainId) : null;
                return <option key={space.id} value={space.id}>{parent ? `${parent.name} › ${space.name}` : space.name}</option>;
              })}
              <option value="__create__">Create new domain...</option>
            </select>
          </IdentityField>
        </>
      )}

      <Button variant="primary" size="md" iconLeft={<Save size={13} />} disabled={saving || !dirty} onClick={() => void save()}>
        {saving ? 'Saving…' : 'Save identity'}
      </Button>
      <DomainEditorSheet
        open={domainEditorOpen}
        managers={managers}
        onClose={() => setDomainEditorOpen(false)}
        onSaved={(domain) => {
          if (!domain) return;
          setSpaces((current) => [...current.filter((item) => item.id !== domain.id), domain].sort((a, b) => a.name.localeCompare(b.name)));
          setSpaceId(domain.id);
          onChange();
        }}
      />
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

/**
 * Runtime tab — how the agent connects to a harness, its model, capability
 * tags, budget, and supervisor (AGENTS-PAGE-REDESIGN.md §3.4).
 */
function RuntimeTab({ agent, allAgents, onChange }: { agent: AgentDetail; allAgents: AgentSummary[]; onChange: () => void }) {
  return (
    <div className="space-y-6">
      <RuntimeNativePanel agentId={agent.id} onRuntimeChanged={onChange} />
      <div className="rounded-card border border-line bg-surface p-5">
        <div className="mb-4">
          <h2 className="text-heading text-text-primary">Agentis runtime policy</h2>
          <p className="mt-1 text-[12px] text-text-secondary">
            Configure the Agentis-side model, budget, capabilities, and connection policy.
          </p>
        </div>
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
          allAgents={allAgents}
          onSaved={onChange}
        />
      </div>
    </div>
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
    case 'antigravity': return 'Antigravity CLI';
    case 'http': return 'HTTP / Webhook';
    default: return 'Harness';
  }
}

function HistoryTab({ agent }: { agent: AgentDetail }) {
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
          onClick={() => openRunModal({ runId: r.id, source: 'agent-history' })}
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

// ────────────────────────────────────────────────────────────
// Memory tab — the agent's personal Brain (§G11)
// ────────────────────────────────────────────────────────────

interface AgentMemoryRow {
  id: string;
  section: string;
  content: string;
  tags: string[];
  createdAt: string;
}

/**
 * The agent's own memory: findings and decisions it has accumulated across every
 * workflow and chat it has run — separate from the shared workspace memory log.
 */
function MemoryTab({ agent }: { agent: AgentDetail }) {
  const toast = useToast();
  const confirm = useConfirm();
  const [entries, setEntries] = useState<AgentMemoryRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const data = await api<{ entries: AgentMemoryRow[] }>(`/v1/brain/agents/${agent.id}/memory`);
        if (!cancelled) setEntries(data.entries ?? []);
      } catch { if (!cancelled) setEntries([]); }
      finally { if (!cancelled) setLoading(false); }
    })();
    return () => { cancelled = true; };
  }, [agent.id]);

  async function clearAll() {
    const ok = await confirm({
      title: 'Clear agent memory',
      body: `Permanently delete everything ${agent.name} has remembered? This cannot be undone.`,
      confirmLabel: 'Clear memory',
      tone: 'danger',
    });
    if (!ok) return;
    try {
      await api(`/v1/brain/agents/${agent.id}/memory`, { method: 'DELETE' });
      toast.success('Agent memory cleared');
      setEntries([]);
    } catch (err) {
      toast.error('Failed to clear memory', err instanceof Error ? err.message : undefined);
    }
  }

  async function removeOne(id: string) {
    try {
      await api(`/v1/brain/agents/${agent.id}/memory/${id}`, { method: 'DELETE' });
      setEntries((prev) => prev.filter((e) => e.id !== id));
    } catch (err) {
      toast.error('Failed to delete entry', err instanceof Error ? err.message : undefined);
    }
  }

  if (loading) return <Skeleton height={300} />;

  if (entries.length === 0) {
    return (
      <EmptyState
        icon={<FileText size={48} />}
        title="No memories yet"
        body={`As ${agent.name} runs tasks, the findings and decisions it chooses to remember will accumulate here — its personal expertise, separate from the shared workspace memory.`}
      />
    );
  }

  const bySection = new Map<string, AgentMemoryRow[]>();
  for (const e of entries) {
    const list = bySection.get(e.section) ?? [];
    list.push(e);
    bySection.set(e.section, list);
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <p className="text-[12px] text-text-muted">
          {entries.length} {entries.length === 1 ? 'memory' : 'memories'} this agent carries across every workflow it runs.
        </p>
        <Button variant="ghost" size="sm" iconLeft={<Trash2 size={12} />} onClick={clearAll}>Clear all</Button>
      </div>
      {[...bySection.entries()].map(([section, rows]) => (
        <section key={section}>
          <h3 className="mb-2 text-[11px] font-medium uppercase tracking-wide text-text-muted">{section}</h3>
          <div className="space-y-1.5">
            {rows.map((e) => (
              <div key={e.id} className="group flex items-start gap-3 rounded-md border border-line bg-surface px-4 py-2.5">
                <span className="flex-1 text-[13px] leading-snug text-text-primary">{e.content}</span>
                <span className="shrink-0 text-[11px] text-text-muted">{relativeTime(e.createdAt)}</span>
                <button
                  type="button"
                  onClick={() => removeOne(e.id)}
                  className="shrink-0 text-text-muted opacity-0 transition-opacity hover:text-danger group-hover:opacity-100"
                  aria-label="Delete memory"
                >
                  <Trash2 size={13} />
                </button>
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

