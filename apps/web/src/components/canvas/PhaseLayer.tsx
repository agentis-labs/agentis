import { useMemo } from 'react';
import { useStore, ViewportPortal } from '@xyflow/react';
import clsx from 'clsx';

/**
 * PhaseLayer groups related workflow nodes into soft canvas lanes.
 *
 * The tinted lane background stays behind the graph, while the readable phase
 * header is rendered as a separate zoom-aware overlay above the nodes.
 */
export interface PhaseNode {
  id: string;
  position: { x: number; y: number };
  width?: number;
  height?: number;
  data?: {
    pendingConfig?: boolean;
    liveStatus?: 'running' | 'completed' | 'failed' | 'retry' | 'waiting';
    kind?: string;
    requiredCapabilities?: string[];
    runtimeLabel?: string;
    toolPreview?: string;
    liveExtra?: {
      runtimeActivity?: unknown;
      progress?: { completed?: number; total?: number };
    };
    agentMatches?: Array<{ satisfied: boolean }>;
  };
}

export interface PhaseSpec {
  id: string;
  name: string;
  description?: string;
  color: string;
  nodeIds: string[];
}

interface PhaseLayerProps {
  phases: PhaseSpec[];
  nodes: PhaseNode[];
  focusedPhaseId?: string | null;
}

export type PhaseRunStatus = 'idle' | 'failed' | 'running' | 'completed';

export function derivePhaseStatus(members: PhaseNode[]): { status: PhaseRunStatus; pending: number } {
  const pending = members.filter((node) => node.data?.pendingConfig).length;
  const statuses = members.map((node) => node.data?.liveStatus).filter(Boolean);
  const status: PhaseRunStatus = statuses.includes('failed')
    ? 'failed'
    : statuses.includes('running') || statuses.includes('retry') || statuses.includes('waiting')
      ? 'running'
      : members.length > 0 && statuses.length === members.length && statuses.every((item) => item === 'completed')
        ? 'completed'
        : 'idle';
  return { status, pending };
}

export function stripPhasePrefix(name: string): string {
  return name.replace(/^Phase\s+\d+\s*[^A-Za-z0-9]*\s*/i, '').trim() || name;
}

const NODE_WIDTH = 300;
const BASE_NODE_HEIGHT = 86;
const AGENT_NODE_HEIGHT = 124;
const HEADER_HEIGHT = 104;
const PAD_X = 20;
const PAD_TOP = 20;
const PAD_BOTTOM = 40;

export function PhaseLayer({ phases, nodes, focusedPhaseId }: PhaseLayerProps) {
  const zoom = useStore((state) => state.transform[2]);
  const counterScale = zoom < 1 ? 1 / Math.max(zoom, 0.24) : 1;

  const lanes = useMemo(() => {
    if (phases.length === 0) return [];
    const nodeById = new Map(nodes.map((node) => [node.id, node]));
    return phases.flatMap((phase) => {
      const members = phase.nodeIds.map((id) => nodeById.get(id)).filter(Boolean) as PhaseNode[];
      if (members.length === 0) return [];
      const minX = Math.min(...members.map((node) => node.position.x)) - PAD_X;
      const maxX = Math.max(...members.map((node) => node.position.x + estimatedNodeWidth(node))) + PAD_X;
      const minY = Math.min(...members.map((node) => node.position.y)) - HEADER_HEIGHT - PAD_TOP;
      const maxY = Math.max(...members.map((node) => node.position.y + estimatedNodeHeight(node))) + PAD_BOTTOM;
      const { pending, status } = derivePhaseStatus(members);
      return [{
        phase,
        x: minX,
        y: minY,
        width: maxX - minX,
        height: maxY - minY,
        pending,
        status,
      }];
    });
  }, [nodes, phases]);

  if (lanes.length === 0) return null;

  return (
    <ViewportPortal>
      {lanes.map(({ phase, x, y, width, height }) => {
        const dimmed = Boolean(focusedPhaseId && focusedPhaseId !== phase.id);
        const active = focusedPhaseId === phase.id;
        return (
          <div
            key={phase.id}
            data-phase-id={phase.id}
            data-testid="phase-band"
            className={clsx('absolute rounded-[20px] transition-opacity duration-200', dimmed && 'opacity-20')}
            style={{
              transform: `translate(${x}px, ${y}px)`,
              width,
              height,
              // Minimal grouping: a smooth top-to-bottom tint (no border).
              // The bottom is almost transparent but still visible.
              background: active
                ? `linear-gradient(180deg, ${phase.color}28 0%, ${phase.color}05 100%)`
                : `linear-gradient(180deg, ${phase.color}18 0%, ${phase.color}03 100%)`,
              pointerEvents: 'none',
              zIndex: -1,
            }}
          />
        );
      })}
      {lanes.map(({ phase, x, y, width, pending, status }, index) => {
        const dimmed = Boolean(focusedPhaseId && focusedPhaseId !== phase.id);
        const active = focusedPhaseId === phase.id;
        const laneScreenWidth = width * zoom;
        const compact = laneScreenWidth < 180;
        const headerWidth = Math.max(72, Math.min(compact ? 164 : 260, Math.round(laneScreenWidth - 6)));
        const headerY = y + Math.max(4, Math.min(10, 8 / counterScale));
        return (
          <div
            key={`${phase.id}-header`}
            data-phase-id={phase.id}
            data-testid="phase-header"
            className={clsx('pointer-events-none absolute', dimmed && 'opacity-20')}
            style={{
              transform: `translate(${x + 14}px, ${headerY}px)`,
              zIndex: 6,
            }}
          >
            <div
              className="inline-flex items-center gap-1.5"
              style={{
                transform: counterScale !== 1 ? `scale(${counterScale})` : undefined,
                transformOrigin: 'top left',
                maxWidth: headerWidth,
                textShadow: active ? '0 1px 4px rgba(0,0,0,0.9)' : '0 1px 3px rgba(0,0,0,0.76)',
              }}
            >
              <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: phase.color }} aria-hidden />
              <span className="shrink-0 font-semibold tabular-nums" style={{ color: phase.color, fontSize: compact ? 11 : 12 }}>
                {index + 1}
              </span>
              <span
                className="min-w-0 flex-1 truncate font-semibold text-text-primary"
                style={{ fontSize: compact ? 11.5 : 12.5 }}
                title={stripPhasePrefix(phase.name)}
              >
                {stripPhasePrefix(phase.name)}
              </span>
              {pending > 0 ? (
                <span
                  className="shrink-0 font-medium text-warn"
                  style={{ fontSize: compact ? 9 : 10 }}
                  title={`${pending} node${pending === 1 ? '' : 's'} still need setup`}
                >
                  {pending}
                </span>
              ) : status === 'running' ? (
                <span
                  className="shrink-0 font-medium text-accent"
                  style={{ fontSize: compact ? 9 : 10 }}
                  title="Phase running"
                >
                  Live
                </span>
              ) : status === 'failed' ? (
                <span
                  className="shrink-0 font-medium text-danger"
                  style={{ fontSize: compact ? 9 : 10 }}
                  title="Phase blocked"
                >
                  Error
                </span>
              ) : null}
            </div>
          </div>
        );
      })}
    </ViewportPortal>
  );
}

function estimatedNodeWidth(node: PhaseNode): number {
  return typeof node.width === 'number' && node.width > 0 ? node.width : NODE_WIDTH;
}

function estimatedNodeHeight(node: PhaseNode): number {
  if (typeof node.height === 'number' && node.height > 0) return node.height;
  const isAgentNode = node.data?.kind === 'agent_task' || node.data?.kind === 'agent_session';
  let height = isAgentNode ? AGENT_NODE_HEIGHT : BASE_NODE_HEIGHT;
  if (node.data?.pendingConfig) height += 28;
  if (Array.isArray(node.data?.agentMatches) && node.data.agentMatches.some((match) => !match.satisfied)) height += 52;
  if (node.data?.liveExtra?.progress && typeof node.data.liveExtra.progress.total === 'number') height += 24;
  if (node.data?.toolPreview) height += 30;
  return height;
}
