import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import clsx from 'clsx';
import { AppWindow, CircleAlert, Plus, Workflow } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import type { FleetFilterValue } from './FleetToolbar';

export type AgentHierarchyCreatePreset = {
  role?: 'orchestrator' | 'manager' | 'worker';
  spaceId?: string | null;
};

export interface AgentHierarchyAgent {
  id: string;
  name: string;
  description?: string | null;
  status?: string | null;
  adapterType?: string | null;
  runtimeModel?: string | null;
  avatarGlyph?: string | null;
  colorHex?: string | null;
  role?: string | null;
  reportsTo?: string | null;
  isPaused?: boolean | null;
  currentTaskId?: string | null;
  lastHeartbeatAt?: string | null;
  currentMonthSpendCents?: number | null;
  monthlyBudgetCents?: number | null;
  canvasPosition?: { x: number; y: number } | null;
  runsToday?: number | null;
  spendTodayCents?: number | null;
  pendingApprovals?: number | null;
  spaceId?: string | null;
  spaceName?: string | null;
  spaceColorHex?: string | null;
  connectionSummary?: {
    apps: Array<{ id: string; slug: string; name: string; description?: string | null; category?: string | null }>;
    workflows: Array<{ id: string; name: string; lastRunStatus?: string | null; lastRunAt?: string | null }>;
    totalApps: number;
    totalWorkflows: number;
  } | null;
  duplicateOrchestrator?: boolean;
  unconnectedWorker?: boolean;
  isGhost?: boolean;
  ghostDescription?: string | null;
  createPreset?: AgentHierarchyCreatePreset;
}

export interface AgentNodeData extends Record<string, unknown> {
  agent: AgentHierarchyAgent;
  dimmed?: boolean;
  highlighted?: boolean;
  onGhostCreate?: (preset?: AgentHierarchyCreatePreset) => void;
}

function OrchestratorGlyph({ size = 15 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true"><polygon points="8,1 14,4.5 14,11.5 8,15 2,11.5 2,4.5" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinejoin="round" /></svg>;
}
function ManagerGlyph({ size = 15 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true"><polygon points="8,1.5 14.5,8 8,14.5 1.5,8" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinejoin="round" /></svg>;
}
function WorkerGlyph({ size = 15 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true"><rect x="3" y="3" width="10" height="10" rx="2" stroke="currentColor" strokeWidth="1.5" fill="none" /></svg>;
}

export function AgentHierarchyNode({ data }: NodeProps<Node<AgentNodeData>>) {
  const nav = useNavigate();
  const agent = data.agent;
  const role = displayRole(agent);
  const tier = layoutTier(agent);
  const status = agentStatus(agent);
  const GlyphIcon = role === 'orchestrator' ? OrchestratorGlyph : role === 'manager' ? ManagerGlyph : WorkerGlyph;
  const isGhost = Boolean(agent.isGhost);
  const connections = agent.connectionSummary ?? { apps: [], workflows: [], totalApps: 0, totalWorkflows: 0 };
  const chips = [
    ...connections.apps.map((app) => ({
      id: `app-${app.id}`,
      icon: AppWindow,
      label: app.name,
      title: app.description ? `${app.name} - ${app.description}` : app.category ? `${app.name} - ${app.category}` : app.name,
      onClick: () => nav(`/apps/${app.slug}`),
    })),
    ...connections.workflows.map((workflow) => ({
      id: `workflow-${workflow.id}`,
      icon: Workflow,
      label: workflow.name,
      title: workflow.lastRunStatus
        ? `${workflow.name} - ${workflow.lastRunStatus}${workflow.lastRunAt ? ` ${workflow.lastRunAt}` : ''}`
        : workflow.name,
      onClick: () => nav(`/workflows/${workflow.id}`),
    })),
  ].slice(0, 2);
  const overflow = Math.max(0, connections.totalApps + connections.totalWorkflows - chips.length);

  if (isGhost) {
    return (
      <div className={ghostCardClass(data)}>
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-dashed border-zinc-600 bg-zinc-900/70 text-zinc-300">
              ?
            </span>
            <div className="min-w-0">
              <div className="truncate text-sm font-medium text-text-primary">{agent.name}</div>
              {agent.ghostDescription ? (
                <div className="mt-0.5 text-[11px] text-text-muted">{agent.ghostDescription}</div>
              ) : null}
            </div>
          </div>
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              data.onGhostCreate?.(agent.createPreset);
            }}
            className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-line bg-surface-2 text-text-secondary transition-colors hover:bg-surface-3 hover:text-text-primary"
            aria-label={`Create ${role}`}
          >
            <Plus size={14} />
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className={cardClass(data, role, tier)} style={cardStyle(role)}>
      <Handle type="target" position={Position.Top} className="!h-2.5 !w-2.5 !border-line !bg-surface" />
      <div className="flex items-start gap-3">
        <span className={clsx('flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-line bg-canvas text-text-primary', role === 'orchestrator' && 'shadow-[0_0_10px_rgba(139,92,246,0.18)]')}>
          {agent.avatarGlyph || <GlyphIcon size={15} />}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <span className="truncate text-sm font-medium text-text-primary">{agent.name}</span>
            <StatusDot status={status} />
            {agent.duplicateOrchestrator ? (
              <span
                title="This workspace already has an orchestrator. One orchestrator per workspace is recommended."
                className="inline-flex items-center gap-1 rounded-full border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-amber-300"
              >
                <CircleAlert size={10} /> Duplicate
              </span>
            ) : null}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <span className={roleBadgeClass(role, tier)}>{roleBadge(role, tier)}</span>
          </div>
          {role === 'manager' ? (
            <div className="mt-1.5 flex items-center gap-1.5 text-[11px] text-text-secondary">
              {agent.spaceName ? (
                <>
                  <span className="truncate">{agent.spaceName}</span>
                  <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: agent.spaceColorHex ?? '#71717a' }} />
                </>
              ) : (
                <span className="text-zinc-500">No space assigned</span>
              )}
            </div>
          ) : null}
          <div className="mt-1.5 truncate text-[11px] text-text-muted">{harnessLabel(agent.adapterType)}{agent.runtimeModel ? ` - ${agent.runtimeModel}` : ''}</div>
          {chips.length > 0 || overflow > 0 ? (
            <div className="mt-3 flex flex-wrap gap-1.5">
              {chips.map((chip) => {
                const ChipIcon = chip.icon;
                return (
                  <button
                    key={chip.id}
                    type="button"
                    title={chip.title}
                    onClick={(event) => {
                      event.stopPropagation();
                      chip.onClick();
                    }}
                    className="inline-flex items-center gap-1 rounded-sm border border-zinc-700 bg-zinc-800 px-1.5 py-0.5 text-[11px] text-zinc-300 transition-colors hover:border-zinc-600 hover:text-white"
                  >
                    <ChipIcon size={11} />
                    <span className="max-w-[110px] truncate">{chip.label}</span>
                  </button>
                );
              })}
              {overflow > 0 ? (
                <span className="inline-flex items-center rounded-sm border border-zinc-700 bg-zinc-800 px-1.5 py-0.5 text-[11px] text-zinc-300">
                  +{overflow}
                </span>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
      <Handle type="source" position={Position.Bottom} className="!h-2.5 !w-2.5 !border-line !bg-surface" />
    </div>
  );
}

export function displayRole(agent: AgentHierarchyAgent): 'orchestrator' | 'manager' | 'worker' | 'unassigned' {
  if (agent.role === 'orchestrator' || agent.role === 'manager' || agent.role === 'worker') return agent.role;
  return 'unassigned';
}

export function layoutTier(agent: AgentHierarchyAgent): 'orchestrator' | 'manager' | 'worker' | 'unassigned' {
  const role = displayRole(agent);
  if (role === 'worker' && !agent.reportsTo) return 'unassigned';
  return role;
}

export function agentNeedsSetup(agent: AgentHierarchyAgent): boolean {
  return Boolean(agent.isGhost || !agent.adapterType || agent.status === 'setup_needed');
}

export function matchesFleetFilter(agent: AgentHierarchyAgent, filter: FleetFilterValue): boolean {
  if (filter === 'all') return true;
  const status = agentStatus(agent);
  if (filter === 'active') return status === 'active';
  if (filter === 'idle') return status === 'idle' || status === 'paused';
  if (filter === 'setup_needed') return status === 'error' || status === 'setup_needed';
  return true;
}

export function matchesFleetSearch(agent: AgentHierarchyAgent, search: string): boolean {
  if (!search.trim()) return true;
  const query = search.trim().toLowerCase();
  return [agent.name, agent.spaceName, agent.runtimeModel, harnessLabel(agent.adapterType)]
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
    .some((value) => value.toLowerCase().includes(query));
}

function agentStatus(agent: AgentHierarchyAgent): 'active' | 'idle' | 'error' | 'paused' | 'setup_needed' {
  if (agent.isGhost) return 'setup_needed';
  if (agent.isPaused || agent.status === 'paused') return 'paused';
  if (agent.status === 'error' || agent.status === 'failed') return 'error';
  if (agentNeedsSetup(agent)) return 'setup_needed';
  if (agent.status === 'online' || agent.status === 'active' || agent.status === 'busy' || agent.status === 'running' || Boolean(agent.currentTaskId)) return 'active';
  if (agent.lastHeartbeatAt && Date.now() - new Date(agent.lastHeartbeatAt).getTime() < 120_000) return 'active';
  return 'idle';
}

function cardClass(data: AgentNodeData, role: ReturnType<typeof displayRole>, tier: ReturnType<typeof layoutTier>) {
  return clsx(
    'relative w-[240px] rounded-lg border bg-surface px-3 py-3 shadow-card transition-all',
    role === 'orchestrator' ? 'border-violet-500/30' : role === 'manager' ? 'border-cyan-500/30' : role === 'worker' ? 'border-blue-400/25' : 'border-zinc-700 border-dashed',
    tier === 'unassigned' && role === 'worker' && 'opacity-60',
    data.highlighted && 'ring-1 ring-accent/50',
    data.dimmed && 'pointer-events-none opacity-25',
  );
}

function ghostCardClass(data: AgentNodeData) {
  return clsx(
    'w-[240px] rounded-lg border border-dashed border-zinc-700 bg-surface px-3 py-3 shadow-card',
    data.highlighted && 'ring-1 ring-accent/50',
    data.dimmed && 'pointer-events-none opacity-25',
  );
}

function cardStyle(role: ReturnType<typeof displayRole>) {
  if (role === 'orchestrator') {
    return {
      borderTopColor: '#8b5cf6',
      borderTopWidth: 3,
      boxShadow: '0 0 14px rgba(139,92,246,0.22)',
    };
  }
  if (role === 'manager') return { borderTopColor: '#06b6d4', borderTopWidth: 3 };
  if (role === 'worker') return { borderTopColor: '#60a5fa', borderTopWidth: 2 };
  return { borderTopColor: '#52525b', borderTopWidth: 1, borderTopStyle: 'dashed' as const };
}

function roleBadgeClass(role: ReturnType<typeof displayRole>, tier: ReturnType<typeof layoutTier>) {
  const effectiveRole = tier === 'unassigned' && role === 'worker' ? 'worker' : role;
  return clsx(
    'inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider',
    effectiveRole === 'orchestrator' && 'bg-violet-500/15 text-violet-300',
    effectiveRole === 'manager' && 'bg-cyan-500/15 text-cyan-300',
    effectiveRole === 'worker' && 'bg-blue-400/15 text-blue-300',
    effectiveRole === 'unassigned' && 'bg-zinc-700/50 text-zinc-400',
  );
}

function roleBadge(role: ReturnType<typeof displayRole>, tier: ReturnType<typeof layoutTier>) {
  if (tier === 'unassigned' && role === 'worker') return 'WORKER';
  return role.toUpperCase();
}

function StatusDot({ status }: { status: ReturnType<typeof agentStatus> }) {
  return (
    <span className="relative flex h-3 w-3 shrink-0 items-center justify-center">
      {status === 'error' || status === 'setup_needed' ? (
        <span className="absolute inline-flex h-3 w-3 rounded-full bg-red-500/40 animate-ping" />
      ) : null}
      <span
        className={clsx(
          'relative inline-flex h-2.5 w-2.5 rounded-full',
          status === 'active' && 'bg-emerald-400 animate-pulse',
          status === 'idle' && 'bg-zinc-500',
          status === 'paused' && 'bg-amber-400',
          (status === 'error' || status === 'setup_needed') && 'bg-red-500',
        )}
      />
    </span>
  );
}

function harnessLabel(adapterType?: string | null) {
  switch (adapterType) {
    case 'openclaw': return 'OpenClaw';
    case 'hermes_agent': return 'Hermes Agent';
    case 'claude_code': return 'Claude Code';
    case 'codex': return 'Codex';
    case 'cursor': return 'Cursor';
    case 'http': return 'HTTP / Webhook';
    default: return 'Runtime';
  }
}