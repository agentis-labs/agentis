import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Bot, Check, ChevronRight, ClipboardList, Plus, RefreshCw, Save, Sparkles, Users } from 'lucide-react';
import { api } from '../lib/api';
import { useToast } from '../components/shared/Toast';

interface Team {
  id: string;
  name: string;
  slug: string;
  description?: string | null;
  iconGlyph?: string | null;
  colorHex?: string | null;
  ambientId: string;
  stats?: TeamStats;
}

interface TeamStats {
  agents: number;
  liveAgents: number;
  workflows: number;
  pendingApprovals: number;
}

interface TeamContext {
  operatingPrinciples: string;
  constraints: string;
  handoffs: string;
  successMetrics: string;
  escalationRules: string;
  sharedPrompt: string;
}

interface AgentRow {
  id: string;
  name: string;
  status: string;
  role?: string | null;
  avatarGlyph?: string | null;
}

interface WorkflowRow {
  id: string;
  title: string;
  summary?: string | null;
  updatedAt: string;
}

interface ApprovalRow {
  id: string;
  title: string;
  summary: string;
  kind: string;
  priority: number;
  createdAt: string;
}

interface TeamDetail {
  team: Team;
  context: TeamContext;
  stats: TeamStats;
  agents: AgentRow[];
  workflows: WorkflowRow[];
  approvals: ApprovalRow[];
}

interface ArchitectProposal {
  summary: string;
  agents: Array<{ name: string; role: string; capabilityTags: string[] }>;
  context: TeamContext;
}

type TeamTab = 'overview' | 'agents' | 'workflows';
const TEAM_TABS: Array<{ id: TeamTab; label: string }> = [
  { id: 'overview', label: 'Overview' },
  { id: 'agents', label: 'Agents' },
  { id: 'workflows', label: 'Workflows' },
];

export function TeamsPage() {
  const nav = useNavigate();
  const toast = useToast();
  const [teams, setTeams] = useState<Team[]>([]);
  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);

  async function load() {
    const data = await api<{ teams: Team[] }>('/v1/teams');
    setTeams(data.teams);
  }

  useEffect(() => {
    void load();
  }, []);

  async function createTeam() {
    if (!name.trim()) return;
    setCreating(true);
    try {
      const res = await api<{ team: Team }>('/v1/teams', {
        method: 'POST',
        body: JSON.stringify({ name: name.trim() }),
      });
      setName('');
      toast.success('Team created', res.team.name);
      nav(`/teams/${res.team.id}`);
    } catch (error) {
      toast.error('Team not created', messageFrom(error));
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="flex h-full flex-col bg-canvas p-6">
      <header className="mb-5 flex flex-wrap items-center gap-3">
        <div>
          <h1 className="text-lg font-medium text-text-primary">Teams</h1>
          <p className="text-xs text-text-muted">Organize agents, execution context, and approvals around teams.</p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="New team name"
            className="h-8 w-56 rounded-md border border-line bg-surface px-3 text-xs text-text-primary outline-none focus:border-accent"
          />
          <button
            type="button"
            disabled={creating || !name.trim()}
            onClick={() => void createTeam()}
            className="inline-flex h-8 items-center gap-1 rounded-md bg-accent px-3 text-xs font-medium text-canvas disabled:opacity-50"
          >
            <Plus size={13} /> New Team
          </button>
        </div>
      </header>

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {teams.map((team) => (
          <Link key={team.id} to={`/teams/${team.id}`} className="rounded-lg border border-line bg-surface p-4 transition hover:border-accent/50">
            <div className="flex items-start gap-3">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-line bg-canvas text-sm font-medium" style={team.colorHex ? { color: team.colorHex } : undefined}>
                {team.iconGlyph || team.name.slice(0, 1).toUpperCase()}
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <h2 className="truncate text-sm font-medium text-text-primary">{team.name}</h2>
                  <ChevronRight size={14} className="ml-auto text-text-muted" />
                </div>
                <p className="mt-1 line-clamp-2 text-xs text-text-muted">{team.description || team.slug}</p>
              </div>
            </div>
            <div className="mt-4 grid grid-cols-4 gap-2 text-center text-xs">
              <Metric label="Agents" value={team.stats?.agents ?? 0} />
              <Metric label="Live" value={team.stats?.liveAgents ?? 0} />
              <Metric label="Reviews" value={team.stats?.pendingApprovals ?? 0} />
              <Metric label="Flows" value={team.stats?.workflows ?? 0} />
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}

export function TeamPage() {
  const { id } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const toast = useToast();
  const [detail, setDetail] = useState<TeamDetail | null>(null);
  const [contextDraft, setContextDraft] = useState<TeamContext | null>(null);
  const [architectBrief, setArchitectBrief] = useState('');
  const [proposal, setProposal] = useState<ArchitectProposal | null>(null);
  const [busy, setBusy] = useState(false);
  const tabParam = searchParams.get('tab') as TeamTab | null;
  const tab: TeamTab = tabParam && TEAM_TABS.some((item) => item.id === tabParam) ? tabParam : 'overview';

  function selectTab(next: TeamTab) {
    const params = new URLSearchParams(searchParams);
    if (next === 'overview') params.delete('tab');
    else params.set('tab', next);
    setSearchParams(params, { replace: true });
  }

  async function load() {
    if (!id) return;
    const data = await api<TeamDetail>(`/v1/teams/${id}`);
    setDetail(data);
    setContextDraft(data.context);
  }

  useEffect(() => {
    void load();
  }, [id]);

  async function saveContext() {
    if (!id || !contextDraft) return;
    setBusy(true);
    try {
      const data = await api<{ context: TeamContext }>(`/v1/teams/${id}/context`, { method: 'PATCH', body: JSON.stringify(contextDraft) });
      setContextDraft(data.context);
      await load();
      toast.success('Context saved');
    } catch (error) {
      toast.error('Context not saved', messageFrom(error));
    } finally {
      setBusy(false);
    }
  }

  async function resolveApproval(approvalId: string, decision: 'approve' | 'reject') {
    try {
      await api(`/v1/approvals/${approvalId}/resolve`, { method: 'POST', body: JSON.stringify({ decision }) });
      await load();
      toast.success(decision === 'approve' ? 'Approved' : 'Rejected');
    } catch (error) {
      toast.error('Approval not resolved', messageFrom(error));
    }
  }

  async function design(applyContext = false) {
    if (!id || !architectBrief.trim()) return;
    setBusy(true);
    try {
      const data = await api<{ proposal: ArchitectProposal; context: TeamContext }>(`/v1/teams/${id}/design`, {
        method: 'POST',
        body: JSON.stringify({ brief: architectBrief.trim(), applyContext }),
      });
      setProposal(data.proposal);
      if (applyContext) {
        setContextDraft(data.context);
        await load();
        toast.success('Architect context applied');
      }
    } catch (error) {
      toast.error('Architect failed', messageFrom(error));
    } finally {
      setBusy(false);
    }
  }

  if (!detail || !contextDraft) {
    return <div className="flex h-full items-center justify-center bg-canvas text-sm text-text-muted">Loading team…</div>;
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-canvas">
      <header className="shrink-0 border-b border-line bg-surface px-6 py-4">
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex h-11 w-11 items-center justify-center rounded-md border border-line bg-canvas text-base font-medium" style={detail.team.colorHex ? { color: detail.team.colorHex } : undefined}>
            {detail.team.iconGlyph || detail.team.name.slice(0, 1).toUpperCase()}
          </div>
          <div>
            <h1 className="text-lg font-medium text-text-primary">{detail.team.name}</h1>
            <p className="text-xs text-text-muted">{detail.team.description || detail.team.slug}</p>
          </div>
          <button type="button" onClick={() => void load()} className="ml-auto inline-flex h-8 items-center gap-1 rounded-md border border-line bg-surface-2 px-2.5 text-xs text-text-muted hover:text-text-primary">
            <RefreshCw size={13} /> Refresh
          </button>
        </div>
        <div className="mt-4 grid gap-2 md:grid-cols-4">
          <Metric label="Agents" value={detail.stats.agents} />
          <Metric label="Live" value={detail.stats.liveAgents} />
          <Metric label="Workflows" value={detail.stats.workflows} />
          <Metric label="Reviews" value={detail.stats.pendingApprovals} />
        </div>
        <nav className="mt-4 flex flex-wrap gap-1" aria-label="Team tabs">
          {TEAM_TABS.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => selectTab(item.id)}
              className={`rounded-md px-3 py-1.5 text-xs transition ${tab === item.id ? 'bg-accent/10 text-accent' : 'text-text-muted hover:bg-surface-2 hover:text-text-primary'}`}
            >
              {item.label}
            </button>
          ))}
        </nav>
      </header>

      <div className="min-h-0 flex-1 overflow-auto p-6">
        {tab === 'overview' && (
        <div className="grid gap-6 xl:grid-cols-[minmax(0,1.1fr)_minmax(320px,0.9fr)]">
          <section className="rounded-lg border border-line bg-surface p-4">
            <div className="mb-3 flex items-center gap-2">
              <Users size={16} className="text-accent" />
              <h2 className="text-sm font-medium text-text-primary">Team Context Block</h2>
              <button disabled={busy} onClick={() => void saveContext()} className="ml-auto inline-flex h-8 items-center gap-1 rounded-md border border-line bg-canvas px-2.5 text-xs hover:border-accent/50 disabled:opacity-50"><Save size={13} /> Save</button>
            </div>
            <div className="grid gap-3 md:grid-cols-2">
              <ContextField label="Operating Principles" value={contextDraft.operatingPrinciples} onChange={(value) => setContextDraft({ ...contextDraft, operatingPrinciples: value })} />
              <ContextField label="Constraints" value={contextDraft.constraints} onChange={(value) => setContextDraft({ ...contextDraft, constraints: value })} />
              <ContextField label="Handoffs" value={contextDraft.handoffs} onChange={(value) => setContextDraft({ ...contextDraft, handoffs: value })} />
              <ContextField label="Success Metrics" value={contextDraft.successMetrics} onChange={(value) => setContextDraft({ ...contextDraft, successMetrics: value })} />
              <ContextField label="Escalation Rules" value={contextDraft.escalationRules} onChange={(value) => setContextDraft({ ...contextDraft, escalationRules: value })} />
              <ContextField label="Shared Prompt" value={contextDraft.sharedPrompt} onChange={(value) => setContextDraft({ ...contextDraft, sharedPrompt: value })} />
            </div>
          </section>

          <section className="rounded-lg border border-line bg-surface p-4">
            <div className="mb-3 flex items-center gap-2">
              <Sparkles size={16} className="text-accent" />
              <h2 className="text-sm font-medium text-text-primary">Team Architect</h2>
            </div>
            <textarea value={architectBrief} onChange={(event) => setArchitectBrief(event.target.value)} placeholder="Describe the team's purpose, constraints, and kind of agents you expect." rows={5} className="w-full resize-none rounded-md border border-line bg-canvas p-3 text-xs outline-none focus:border-accent" />
            <div className="mt-2 flex gap-2">
              <button disabled={busy || !architectBrief.trim()} onClick={() => void design(false)} className="inline-flex h-8 items-center gap-1 rounded-md border border-line bg-canvas px-2.5 text-xs hover:border-accent/50 disabled:opacity-50"><Sparkles size={13} /> Propose</button>
              <button disabled={busy || !architectBrief.trim()} onClick={() => void design(true)} className="inline-flex h-8 items-center gap-1 rounded-md bg-accent px-2.5 text-xs font-medium text-canvas disabled:opacity-50"><Check size={13} /> Apply context</button>
            </div>
            {proposal && <ArchitectProposalView proposal={proposal} />}
          </section>
        </div>
        )}

        {(tab === 'overview' || tab === 'agents') && (
        <div className="mt-6 grid gap-6 xl:grid-cols-3">
          {(tab === 'overview' || tab === 'agents') && (
          <Panel title="Agents" icon={<Bot size={16} className="text-accent" />} empty="No agents assigned to this team.">
            {detail.agents.map((agent) => <Link key={agent.id} to={`/agents/${agent.id}`} className="flex items-center justify-between rounded-md border border-line bg-canvas px-3 py-2 text-xs hover:border-accent/50"><span>{agent.avatarGlyph || '*'} {agent.name}</span><span className="text-text-muted">{agent.status}</span></Link>)}
          </Panel>
          )}
          {tab === 'overview' && (
          <Panel title="Attention" icon={<ClipboardList size={16} className="text-accent" />} empty="No pending approvals.">
            {detail.approvals.map((approval) => (
              <div key={approval.id} className="rounded-md border border-line bg-canvas p-3 text-xs">
                <div className="font-medium text-text-primary">{approval.title}</div>
                <p className="mt-1 text-text-muted">{approval.summary}</p>
                <div className="mt-2 flex gap-1">
                  <button type="button" onClick={() => void resolveApproval(approval.id, 'approve')} className="rounded bg-accent px-2 py-1 text-[10px] font-medium text-canvas">Approve</button>
                  <button type="button" onClick={() => void resolveApproval(approval.id, 'reject')} className="rounded border border-line px-2 py-1 text-[10px] text-text-muted hover:text-danger">Reject</button>
                </div>
              </div>
            ))}
          </Panel>
          )}
        </div>
        )}

        {(tab === 'overview' || tab === 'workflows') && (
        <section className="mt-6 rounded-lg border border-line bg-surface p-4">
          <div className="mb-3 text-sm font-medium text-text-primary">Team Workflows</div>
          <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
            {detail.workflows.map((workflow) => <Link key={workflow.id} to={`/workflows/${workflow.id}`} className="rounded-md border border-line bg-canvas p-3 text-xs hover:border-accent/50"><div className="font-medium text-text-primary">{workflow.title}</div><p className="mt-1 line-clamp-2 text-text-muted">{workflow.summary || 'Workflow canvas'}</p></Link>)}
            {detail.workflows.length === 0 && <div className="text-xs text-text-muted">No workflows scoped to this team.</div>}
          </div>
        </section>
        )}
      </div>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return <div className="rounded-md border border-line bg-canvas px-2 py-2"><div className="text-[10px] uppercase tracking-wide text-text-muted">{label}</div><div className="mt-1 text-sm font-medium text-text-primary">{value}</div></div>;
}

function ContextField({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return <label className="block"><span className="mb-1 block text-[11px] uppercase tracking-wide text-text-muted">{label}</span><textarea value={value} onChange={(event) => onChange(event.target.value)} rows={5} className="w-full resize-none rounded-md border border-line bg-canvas p-3 text-xs outline-none focus:border-accent" /></label>;
}

function Panel({ title, icon, empty, children }: { title: string; icon: ReactNode; empty: string; children: ReactNode }) {
  const hasChildren = Array.isArray(children) ? children.length > 0 : Boolean(children);
  return <section className="rounded-lg border border-line bg-surface p-4"><div className="mb-3 flex items-center gap-2 text-sm font-medium text-text-primary">{icon}{title}</div><div className="space-y-2">{hasChildren ? children : <div className="text-xs text-text-muted">{empty}</div>}</div></section>;
}

function ArchitectProposalView({ proposal }: { proposal: ArchitectProposal }) {
  return <div className="mt-3 rounded-md border border-line bg-canvas p-3 text-xs"><div className="font-medium text-text-primary">{proposal.summary}</div><div className="mt-2 space-y-1">{proposal.agents.map((agent) => <div key={agent.name} className="text-text-muted"><span className="text-text-primary">{agent.name}</span> - {agent.role}</div>)}</div></div>;
}

function messageFrom(error: unknown) {
  return (error as { message?: string })?.message ?? 'The request failed.';
}