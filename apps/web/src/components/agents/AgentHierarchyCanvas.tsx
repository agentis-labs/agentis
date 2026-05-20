import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Background,
  Controls,
  Handle,
  Panel,
  Position,
  ReactFlow,
  useEdgesState,
  useNodesState,
  type Connection,
  type Edge,
  type Node,
  type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import clsx from 'clsx';
import { Loader2, Plus, RotateCcw } from 'lucide-react';
import { api } from '../../lib/api';
import { useAgentInstallSession } from '../../hooks/useBackgroundInstall';
import { dismissInstallSession, type InstallSession } from '../../lib/backgroundInstall';
import { AgentQuickDetailPanel } from './AgentQuickDetailPanel';

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
  currentTask?: string | null;
  capabilityTags?: string[] | null;
  lastActiveAt?: string | null;
  lastHeartbeatAt?: string | null;
  currentMonthSpendCents?: number | null;
  monthlyBudgetCents?: number | null;
  canvasPosition?: { x: number; y: number } | null;
  runsToday?: number | null;
  spendTodayCents?: number | null;
  pendingApprovals?: number | null;
  connectionCounts?: {
    workflows: number;
  } | null;
  isGhost?: boolean | null;
  ghostDescription?: string | null;
  createPreset?: AgentHierarchyCreatePreset | null;
}

interface AgentNodeData extends Record<string, unknown> {
  agent: AgentHierarchyAgent;
  onGhostCreate?: (preset?: AgentHierarchyCreatePreset) => void;
}

const TIER_Y: Record<'orchestrator' | 'manager' | 'worker' | 'unassigned', number> = {
  orchestrator: 40,
  manager: 250,
  worker: 460,
  unassigned: 690,
};

const TIER_LABELS = [
  { label: 'Orchestrator', y: TIER_Y.orchestrator },
  { label: 'Managers', y: TIER_Y.manager },
  { label: 'Workers', y: TIER_Y.worker },
  { label: 'Unassigned', y: TIER_Y.unassigned },
];

const nodeTypes = { agentHierarchy: AgentHierarchyNode };

export function AgentHierarchyCanvas({
  agents,
  onChanged,
  onSelect,
  selectedAgent,
  onCloseSelection,
  onCreate,
  onGhostCreate,
}: {
  agents: AgentHierarchyAgent[];
  onChanged: () => void;
  onSelect: (agent: AgentHierarchyAgent) => void;
  selectedAgent: AgentHierarchyAgent | null;
  onCloseSelection: () => void;
  onCreate: () => void;
  onGhostCreate?: (preset?: AgentHierarchyCreatePreset) => void;
}) {
  const onGhostCreateRef = useRef(onGhostCreate);
  onGhostCreateRef.current = onGhostCreate;
  const stableOnGhostCreate = useMemo(
    () => (preset?: AgentHierarchyCreatePreset) => onGhostCreateRef.current?.(preset),
    [],
  );
  const graph = useMemo(() => buildGraph(agents, {}, stableOnGhostCreate), [agents, stableOnGhostCreate]);
  const [nodes, setNodes, onNodesChange] = useNodesState<Node<AgentNodeData>>(graph.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(graph.edges);
  const [resettingLayout, setResettingLayout] = useState(false);
  const persistTimers = useRef(new Map<string, number>());

  useEffect(() => {
    setNodes(graph.nodes);
    setEdges(graph.edges);
  }, [graph, setEdges, setNodes]);

  useEffect(() => {
    return () => {
      for (const timeoutId of persistTimers.current.values()) window.clearTimeout(timeoutId);
      persistTimers.current.clear();
    };
  }, []);

  async function connectAgents(connection: Connection) {
    if (!connection.source || !connection.target || connection.source === connection.target) return;
    await api(`/v1/agents/${connection.target}`, {
      method: 'PATCH',
      body: JSON.stringify({ reportsTo: connection.source }),
    });
    onChanged();
  }

  function persistPosition(node: Node) {
    const existing = persistTimers.current.get(node.id);
    if (existing) window.clearTimeout(existing);
    const timeoutId = window.setTimeout(() => {
      void api(`/v1/agents/${node.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ canvasPosition: node.position }),
      }).then(() => onChanged()).finally(() => {
        if (persistTimers.current.get(node.id) === timeoutId) persistTimers.current.delete(node.id);
      });
    }, 180);
    persistTimers.current.set(node.id, timeoutId);
  }

  async function resetLayout() {
    setResettingLayout(true);
    try {
      const nextGraph = buildGraph(agents, { forceAutoLayout: true }, stableOnGhostCreate);
      setNodes(nextGraph.nodes);
      setEdges(nextGraph.edges);
      await Promise.all(nextGraph.nodes.map((node) => api(`/v1/agents/${node.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ canvasPosition: node.position }),
      })));
      onChanged();
    } finally {
      setResettingLayout(false);
    }
  }

  return (
    <div className="relative h-full min-h-[34rem] overflow-hidden rounded-lg border border-line bg-canvas">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={(connection) => void connectAgents(connection)}
        onNodeClick={(_event, node) => onSelect(node.data.agent)}
        onNodeDragStop={(_event, node) => void persistPosition(node)}
        fitView
        nodesDraggable
        nodesConnectable
        elementsSelectable
        proOptions={{ hideAttribution: true }}
        className="bg-canvas"
      >
        <Background color="#23252d" gap={28} />
        <Controls position="bottom-right" className="!border-line !bg-surface-2" />
        <Panel position="top-left" className="pointer-events-none space-y-[168px] pt-6 text-[11px] font-semibold uppercase tracking-wider text-text-muted">
          {TIER_LABELS.map((tier) => <div key={tier.label}>{tier.label}</div>)}
        </Panel>
        <Panel position="top-right" className="pointer-events-auto flex items-center gap-2">
          <button type="button" onClick={() => void resetLayout()} disabled={resettingLayout} aria-label="Reset layout" className="inline-flex h-8 items-center gap-1.5 rounded-md border border-line bg-surface-2 px-3 text-xs font-medium text-text-secondary hover:bg-surface-3 hover:text-text-primary disabled:opacity-50">
            <RotateCcw size={13} /> {resettingLayout ? 'Resetting...' : 'Reset layout'}
          </button>
          <button type="button" onClick={onCreate} className="inline-flex h-8 items-center gap-1.5 rounded-md border border-line bg-surface-2 px-3 text-xs font-medium text-text-secondary hover:bg-surface-3 hover:text-text-primary">
            <Plus size={13} /> Agent
          </button>
        </Panel>
      </ReactFlow>
      <AgentQuickDetailPanel
        open={Boolean(selectedAgent)}
        agent={selectedAgent}
        onClose={onCloseSelection}
      />
    </div>
  );
}

function buildGraph(
  agents: AgentHierarchyAgent[],
  options: { forceAutoLayout?: boolean } = {},
  onGhostCreate?: (preset?: AgentHierarchyCreatePreset) => void,
): { nodes: Node<AgentNodeData>[]; edges: Edge[] } {
  const forceAutoLayout = options.forceAutoLayout ?? false;
  const byId = new Set(agents.map((agent) => agent.id));
  const groups = {
    orchestrator: agents.filter((agent) => normalizeRole(agent) === 'orchestrator'),
    manager: agents.filter((agent) => normalizeRole(agent) === 'manager'),
    worker: agents.filter((agent) => normalizeRole(agent) === 'worker'),
    unassigned: agents.filter((agent) => normalizeRole(agent) === 'unassigned'),
  };

  const nodes: Node<AgentNodeData>[] = [];
  for (const [tier, list] of Object.entries(groups) as Array<[keyof typeof groups, AgentHierarchyAgent[]]>) {
    list.sort((a, b) => a.name.localeCompare(b.name)).forEach((agent, index) => {
      const fallback = fallbackPosition(tier, index, list.length);
      nodes.push({
        id: agent.id,
        type: 'agentHierarchy',
        position: !forceAutoLayout && isPosition(agent.canvasPosition) ? agent.canvasPosition : fallback,
        data: { agent, onGhostCreate },
      });
    });
  }

  // Ghost orchestrator — shown when no orchestrator exists
  if (groups.orchestrator.length === 0) {
    nodes.push({
      id: '__ghost_orchestrator__',
      type: 'agentHierarchy',
      position: { x: 0, y: TIER_Y.orchestrator },
      data: {
        agent: {
          id: '__ghost_orchestrator__',
          name: 'Set up the workspace orchestrator',
          ghostDescription: 'The orchestrator routes work, approvals, and command.',
          isGhost: true,
          createPreset: { role: 'orchestrator' },
          role: 'orchestrator',
          status: null,
          adapterType: null,
          runtimeModel: null,
          reportsTo: null,
        },
        onGhostCreate,
      },
    });
  }

  const edges = agents
    .filter((agent) => agent.reportsTo && byId.has(agent.reportsTo))
    .map((agent) => ({
      id: `${agent.reportsTo}-${agent.id}`,
      source: agent.reportsTo!,
      target: agent.id,
      type: 'smoothstep',
      animated: agent.status === 'busy' || Boolean(agent.currentTaskId),
      style: { stroke: agent.colorHex ?? '#6366f1', strokeWidth: 1.5 },
    } satisfies Edge));

  return { nodes, edges };
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

// Tier-specific border colors — AGENTS-PAGE-REDESIGN.md §1.3.
const TIER_BORDER: Record<'orchestrator' | 'manager' | 'worker' | 'unassigned', string> = {
  orchestrator: '#8b5cf6',
  manager: '#06b6d4',
  worker: '#2a2c34',
  unassigned: '#2a2c34',
};

function AgentHierarchyNode({ data }: NodeProps<Node<AgentNodeData>>) {
  const agent = data.agent;
  const installSession = useAgentInstallSession(agent.id);

  if (agent.isGhost) {
    return (
      <div className="w-[240px] rounded-lg border border-dashed border-zinc-700 bg-surface px-3 py-3 shadow-card">
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-dashed border-zinc-600 bg-zinc-900/70 text-zinc-300">?</span>
            <div className="min-w-0">
              <div className="truncate text-sm font-medium text-text-primary">{agent.name}</div>
              {agent.ghostDescription ? <div className="mt-0.5 text-[11px] text-text-muted">{agent.ghostDescription}</div> : null}
            </div>
          </div>
          <button
            type="button"
            onClick={(event) => { event.stopPropagation(); data.onGhostCreate?.(agent.createPreset ?? undefined); }}
            className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-line bg-surface-2 text-text-secondary transition-colors hover:bg-surface-3 hover:text-text-primary"
            aria-label="Set up the workspace orchestrator"
          >
            <Plus size={14} />
          </button>
        </div>
      </div>
    );
  }

  const role = normalizeRole(agent);
  const installComplete = installSession?.phase === 'complete';
  const installFailed = installSession?.phase === 'error';
  const isSettingUp = installSession ? !installComplete && !installFailed : agent.status === 'setting_up';
  const readiness = installComplete ? 'live' : installFailed ? 'failed' : isSettingUp ? 'setting_up' : readinessOf(agent);
  const GlyphIcon = role === 'orchestrator' ? OrchestratorGlyph : role === 'manager' ? ManagerGlyph : WorkerGlyph;
  const activity = isSettingUp ? installActivity(installSession) : liveActivity(agent, readiness);
  const running = readiness === 'running';
  const settingUp = readiness === 'setting_up';

  return (
    <div
      role="article"
      aria-label={`${agent.name} — ${readiness}`}
      className={clsx(
        'relative w-64 rounded-lg border-2 bg-surface p-3.5 shadow-card transition-colors',
        running && 'ring-1 ring-warn/20',
        settingUp && 'ring-1 ring-cyan-500/20',
      )}
      style={{
        borderColor: settingUp ? '#06b6d4' : TIER_BORDER[role],
        boxShadow: settingUp ? '0 0 16px rgba(6, 182, 212, 0.08)' : running ? `0 0 12px ${TIER_BORDER[role]}22` : undefined,
      }}
    >
      <Handle type="target" position={Position.Top} className="!h-2.5 !w-2.5 !border-line !bg-surface" />
      <div className="flex items-center gap-2.5">
        <span
          className={clsx(
            'flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-canvas',
            settingUp && 'animate-pulse',
          )}
          style={{ color: settingUp ? '#06b6d4' : TIER_BORDER[role] }}
        >
          {settingUp ? <Loader2 size={16} className="animate-spin" /> : (agent.avatarGlyph || <GlyphIcon size={16} />)}
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium text-text-primary">{agent.name}</div>
          <div className="mt-0.5 truncate text-[11px] capitalize text-text-muted">
            {settingUp ? 'setting up runtime' : `${role} · ${harnessLabel(agent.adapterType)}`}
          </div>
        </div>
        <StatusDot readiness={readiness} />
      </div>
      {settingUp && installSession ? (
        <SetupProgressBar session={installSession} />
      ) : (
        <div className="mt-3 border-t border-line pt-2.5">
          <div className={clsx('truncate text-[12px]', activity.tone)} aria-live="polite">
            {activity.text}
          </div>
        </div>
      )}
      <Handle type="source" position={Position.Bottom} className="!h-2.5 !w-2.5 !border-line !bg-surface" />
    </div>
  );
}

/** Inline install progress bar shown on the fleet card during setup. */
function SetupProgressBar({ session }: { session: InstallSession }) {
  const totalSteps = 4;
  const completedSteps = session.steps.filter((s) => s.status === 'done').length;
  const currentStep = session.steps.find((s) => s.status === 'running');
  const progress = Math.min(100, Math.round((completedSteps / totalSteps) * 100));
  const hasError = session.phase === 'error';

  return (
    <div className="mt-3 border-t border-line pt-2.5 space-y-1.5">
      <div className="flex items-center gap-2">
        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-2">
          <div
            className={clsx(
              'h-full rounded-full transition-all duration-500',
              hasError ? 'bg-danger' : 'bg-cyan-500',
            )}
            style={{ width: `${progress}%` }}
          />
        </div>
        <span className="text-[10px] tabular-nums text-text-muted">{progress}%</span>
      </div>
      <div className={clsx('truncate text-[11px]', hasError ? 'text-danger' : 'text-cyan-400')}>
        {hasError
          ? (session.error ?? 'Install failed')
          : currentStep
            ? currentStep.label
            : session.phase === 'complete'
              ? 'Ready!'
              : 'Starting install…'}
      </div>
    </div>
  );
}

/** Live activity text for an agent that is currently being set up. */
function installActivity(session: InstallSession | undefined): { text: string; tone: string } {
  if (!session) return { text: 'setting up…', tone: 'text-cyan-400' };
  if (session.phase === 'error') return { text: session.error ?? 'install failed', tone: 'text-danger' };
  if (session.phase === 'complete') return { text: 'runtime installed — going live', tone: 'text-accent' };
  const step = session.steps.find((s) => s.status === 'running');
  return { text: step?.label ?? 'installing runtime…', tone: 'text-cyan-400' };
}

function StatusDot({ readiness }: { readiness: string }) {
  if (readiness === 'running') {
    return (
      <span className="relative flex h-2.5 w-2.5 shrink-0" aria-label="running">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-warn opacity-60" />
        <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-warn" />
      </span>
    );
  }
  if (readiness === 'setting_up') {
    return (
      <span className="relative flex h-2.5 w-2.5 shrink-0" aria-label="setting up">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-cyan-500 opacity-50" />
        <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-cyan-500" />
      </span>
    );
  }
  return <span className={clsx('h-2.5 w-2.5 shrink-0 rounded-full', readinessDot(readiness))} aria-label={readiness} />;
}

/** Single-sentence live activity line — AGENTS-PAGE-REDESIGN.md §1.3. */
function liveActivity(
  agent: AgentHierarchyAgent,
  readiness: string,
): { text: string; tone: string } {
  if (readiness === 'setting_up') {
    return { text: 'installing runtime…', tone: 'text-cyan-400' };
  }
  if (!agent.adapterType) {
    return { text: 'setup needed · connect harness', tone: 'text-warn' };
  }
  if (readiness === 'failed') {
    return { text: 'failed — needs review', tone: 'text-danger' };
  }
  if (readiness === 'running') {
    const task = (agent.currentTask ?? '').trim();
    return { text: task ? `running: ${truncate(task, 34)}` : 'running…', tone: 'text-warn' };
  }
  if (readiness === 'live') {
    const tags = (agent.capabilityTags ?? []).filter(Boolean).slice(0, 2);
    return { text: tags.length > 0 ? `ready — ${tags.join(', ')}` : 'ready for work', tone: 'text-accent' };
  }
  const last = agent.lastActiveAt ?? agent.lastHeartbeatAt;
  return { text: last ? `idle — last active ${relativeTime(last)}` : 'idle', tone: 'text-text-muted' };
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function relativeTime(iso: string): string {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return '';
  const diff = Date.now() - t;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

function fallbackPosition(tier: 'orchestrator' | 'manager' | 'worker' | 'unassigned', index: number, count: number) {
  const spacing = 300;
  return { x: (index - (count - 1) / 2) * spacing, y: TIER_Y[tier] };
}

function isPosition(value: unknown): value is { x: number; y: number } {
  return Boolean(value && typeof value === 'object' && typeof (value as { x?: unknown }).x === 'number' && typeof (value as { y?: unknown }).y === 'number');
}

function normalizeRole(agent: AgentHierarchyAgent): 'orchestrator' | 'manager' | 'worker' | 'unassigned' {
  if (agent.role === 'orchestrator' || agent.role === 'manager' || agent.role === 'worker') return agent.role;
  return agent.reportsTo ? 'worker' : 'unassigned';
}

function readinessOf(agent: AgentHierarchyAgent) {
  if (agent.status === 'setting_up') return 'setting_up';
  if (agent.isPaused || agent.status === 'paused') return 'standby';
  if (agent.status === 'error') return 'failed';
  if (agent.status === 'busy' || agent.currentTaskId) return 'running';
  if (agent.status === 'online') return 'live';
  if (agent.lastHeartbeatAt && Date.now() - new Date(agent.lastHeartbeatAt).getTime() < 120_000) return 'live';
  return 'offline';
}

function readinessDot(readiness: string) {
  if (readiness === 'live') return 'bg-accent';
  if (readiness === 'running') return 'bg-warn';
  if (readiness === 'setting_up') return 'bg-cyan-500';
  if (readiness === 'failed') return 'bg-danger';
  if (readiness === 'standby') return 'bg-text-muted';
  return 'bg-line';
}

function harnessLabel(adapterType?: string | null) {
  switch (adapterType) {
    case 'openclaw': return 'OpenClaw';
    case 'hermes_agent': return 'Hermes';
    case 'claude_code': return 'Claude Code';
    case 'codex': return 'Codex';
    case 'cursor': return 'Cursor';
    case 'http': return 'HTTP';
    default: return 'runtime';
  }
}
