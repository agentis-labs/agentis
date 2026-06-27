import { Link } from 'react-router-dom';
import clsx from 'clsx';
import { MessageSquare, MoreHorizontal, Play } from 'lucide-react';
import { BudgetBar, money } from './BudgetBar';

export interface CommandAgent {
  id: string;
  name: string;
  adapterType: string;
  runtimeModel?: string | null;
  role?: string | null;
  status: string;
  colorHex?: string | null;
  capabilityTags?: string[] | null;
  instructions?: string | null;
  avatarGlyph?: string | null;
  lastHeartbeatAt?: string | null;
  currentTaskId?: string | null;
  isPaused?: boolean | null;
  monthlyBudgetCents?: number | null;
  currentMonthSpendCents?: number | null;
}

export type Readiness = 'live' | 'running' | 'standby' | 'unreachable' | 'failed';

export function readinessOf(agent: CommandAgent): Readiness {
  if (agent.isPaused) return 'standby';
  if (agent.status === 'error') return 'failed';
  if (agent.status === 'busy' || agent.currentTaskId) return 'running';
  if (agent.status === 'online') return 'live';
  if (agent.lastHeartbeatAt) {
    const ageMs = Date.now() - new Date(agent.lastHeartbeatAt).getTime();
    if (ageMs < 60_000) return 'live';
  }
  return 'unreachable';
}

export function readinessLabel(readiness: Readiness) {
  return readiness;
}

export function AgentCard({
  agent,
  pendingApprovals = 0,
  runsToday = 0,
  onOpenThread,
  onEditPlaybook,
}: {
  agent: CommandAgent;
  pendingApprovals?: number;
  runsToday?: number;
  onOpenThread: (agent: CommandAgent) => void;
  onEditPlaybook: (agent: CommandAgent) => void;
}) {
  const readiness = readinessOf(agent);
  const excerpt = firstSentence(agent.instructions) || 'No playbook set yet.';
  return (
    <article
      id={`agent-card-${agent.id}`}
      className="group flex min-h-[240px] flex-col rounded-lg border border-line bg-surface p-4 shadow-card transition hover:border-accent/40 hover:bg-surface-2"
    >
      <Link to={`/agents/${agent.id}`} className="min-w-0 flex-1">
        <header className="mb-3 flex items-start gap-3">
          <span
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-line bg-canvas text-sm font-medium"
            style={{ color: agent.colorHex ?? undefined }}
          >
            {agent.avatarGlyph || '◈'}
          </span>
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium text-text-primary">{agent.name}</div>
            <div className="truncate text-xs text-text-muted">
              {agent.role || 'agent'} · {agent.runtimeModel || harnessLabel(agent.adapterType)}
            </div>
          </div>
          <span className={clsx('inline-flex items-center gap-1 text-[11px]', readinessTone(readiness))}>
            <span className={clsx('h-2 w-2 rounded-full', readinessDot(readiness))} />
            {readinessLabel(readiness)}
          </span>
        </header>
        <p className="mb-4 line-clamp-2 min-h-[2.5rem] text-sm text-text-muted">"{excerpt}"</p>
        <div className="mb-4 grid grid-cols-3 overflow-hidden rounded-md border border-line bg-canvas text-center text-[11px]">
          <Metric label="today" value={money(agent.currentMonthSpendCents ?? 0)} />
          <Metric label="runs" value={String(runsToday)} />
          <Metric label="approval" value={String(pendingApprovals)} />
        </div>
        <BudgetBar currentCents={agent.currentMonthSpendCents} limitCents={agent.monthlyBudgetCents} />
      </Link>
      <footer className="mt-4 flex items-center gap-2">
        <button type="button" onClick={() => onOpenThread(agent)} className="agent-card-action">
          <MessageSquare size={13} /> Thread
        </button>
        <button type="button" onClick={() => onEditPlaybook(agent)} className="ml-auto rounded-md p-1.5 text-text-muted hover:bg-canvas hover:text-text-primary" title="Edit playbook">
          <MoreHorizontal size={15} />
        </button>
      </footer>
    </article>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="border-r border-line px-2 py-2 last:border-r-0">
      <div className="truncate text-text-primary">{value}</div>
      <div className="truncate text-[10px] text-text-muted">{label}</div>
    </div>
  );
}

function firstSentence(value?: string | null) {
  const compact = (value ?? '').replace(/\s+/g, ' ').trim();
  if (!compact) return '';
  const dot = compact.search(/[.!?](\s|$)/);
  return dot > 0 ? compact.slice(0, dot + 1) : compact.slice(0, 120);
}

function readinessTone(readiness: Readiness) {
  if (readiness === 'live') return 'text-accent';
  if (readiness === 'running') return 'text-warn';
  if (readiness === 'failed') return 'text-danger';
  return 'text-text-muted';
}

function readinessDot(readiness: Readiness) {
  if (readiness === 'live') return 'bg-accent readiness--live';
  if (readiness === 'running') return 'bg-warn readiness--running';
  if (readiness === 'failed') return 'bg-danger';
  return 'bg-text-muted';
}

function harnessLabel(adapterType: string) {
  switch (adapterType) {
    case 'openclaw': return 'OpenClaw';
    case 'hermes_agent': return 'Hermes Agent';
    case 'claude_code': return 'Claude Code';
    case 'codex': return 'Codex';
    case 'cursor': return 'Cursor';
    case 'gemini': return 'Gemini CLI';
    case 'antigravity': return 'Antigravity CLI';
    case 'http': return 'HTTP';
    default: return 'Harness';
  }
}
