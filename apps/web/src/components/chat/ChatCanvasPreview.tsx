import { useEffect, useMemo, useState } from 'react';
import { Activity, AlertTriangle, CheckCircle2, GitBranch, Maximize2, Sparkles, X } from 'lucide-react';
import { REALTIME_EVENTS } from '@agentis/core';
import { useNavigate } from 'react-router-dom';
import type { Edge, Node } from '@xyflow/react';
import { api } from '../../lib/api';
import { useRealtime } from '../../lib/realtime';
import { CanvasEngine } from '../canvas/CanvasEngine';

interface WorkflowDetail {
  id: string;
  title: string;
  description: string | null;
  graph: {
    nodes: Array<{
      id: string;
      type: string;
      title: string;
      position: { x: number; y: number };
      config: { kind: string; [k: string]: unknown };
    }>;
    edges: Array<{ id: string; source: string; target: string }>;
  };
}

interface ChatCanvasPreviewProps {
  workflowId: string;
  runId?: string;
  onClose: () => void;
}

const PHASES = ['analyzing', 'drafting', 'repairing', 'reviewing', 'building', 'complete'] as const;
type BuildPhase = (typeof PHASES)[number] | 'blocked';

const PHASE_LABEL: Record<BuildPhase, string> = {
  analyzing: 'Analyzing',
  drafting: 'Drafting',
  repairing: 'Repairing',
  reviewing: 'Reviewing',
  building: 'Placing',
  complete: 'Ready',
  blocked: 'Blocked',
};

const SCAFFOLD_NODES: Node[] = [
  {
    id: 'preview-trigger',
    type: 'agentis',
    position: { x: 0, y: 72 },
    data: { label: 'Trigger', kind: 'trigger', type: 'trigger' },
  },
  {
    id: 'preview-agent',
    type: 'agentis',
    position: { x: 260, y: 24 },
    data: { label: 'Agent work', kind: 'agent', type: 'agent' },
  },
  {
    id: 'preview-output',
    type: 'agentis',
    position: { x: 520, y: 72 },
    data: { label: 'Output', kind: 'output', type: 'output' },
  },
];

const SCAFFOLD_EDGES: Edge[] = [
  { id: 'preview-trigger-agent', source: 'preview-trigger', target: 'preview-agent', type: 'agentis', animated: true, data: { type: 'default' } },
  { id: 'preview-agent-output', source: 'preview-agent', target: 'preview-output', type: 'agentis', animated: true, data: { type: 'default' } },
];

function mergeById<T extends { id: string }>(current: T[], incoming: T[]): T[] {
  const merged = new Map(current.map((item) => [item.id, item]));
  for (const item of incoming) merged.set(item.id, item);
  return Array.from(merged.values());
}

function mapWorkflowNode(node: WorkflowDetail['graph']['nodes'][number]): Node {
  return {
    id: node.id,
    type: 'agentis',
    position: node.position,
    data: {
      label: node.title,
      kind: node.config.kind ?? node.type,
      type: node.type,
    },
  };
}

function mapWorkflowEdge(edge: WorkflowDetail['graph']['edges'][number], animated: boolean): Edge {
  return {
    id: edge.id,
    source: edge.source,
    target: edge.target,
    type: 'agentis',
    animated,
    data: { type: 'default' },
  };
}

function mapLiveNode(node: Node): Node {
  return { ...node, type: 'agentis' };
}

function mapLiveEdge(edge: Edge, animated: boolean): Edge {
  return { ...edge, type: 'agentis', animated, data: { type: 'default', ...edge.data } };
}

export function ChatCanvasPreview({ workflowId, runId, onClose }: ChatCanvasPreviewProps) {
  const nav = useNavigate();
  const [wf, setWf] = useState<WorkflowDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [nodes, setNodes] = useState<Node[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const [phase, setPhase] = useState<BuildPhase>('analyzing');
  const [phaseDetail, setPhaseDetail] = useState('');

  useEffect(() => {
    setLoading(true);
    setLoadFailed(false);
    setWf(null);
    setNodes([]);
    setEdges([]);
    setPhase('analyzing');
    setPhaseDetail('');
    api<{ workflow: WorkflowDetail }>(`/v1/workflows/${workflowId}`)
      .then((res) => {
        setWf(res.workflow);
        setNodes((current) => mergeById(current, res.workflow.graph.nodes.map(mapWorkflowNode)));
        setEdges((current) => mergeById(current, res.workflow.graph.edges.map((edge) => mapWorkflowEdge(edge, false))));
      })
      .catch(() => setLoadFailed(true))
      .finally(() => setLoading(false));
  }, [workflowId, runId]);

  useRealtime(
    [
      REALTIME_EVENTS.WORKFLOW_BUILD_PHASE,
      REALTIME_EVENTS.CANVAS_NODE_PLACED,
      REALTIME_EVENTS.CANVAS_EDGE_CONNECTED,
      REALTIME_EVENTS.CANVAS_BUILD_COMPLETE,
    ],
    (env) => {
      const payload = env.payload as {
        workflowId?: string;
        runId?: string;
        phase?: string;
        detail?: string;
        node?: Node;
        edge?: Edge;
      };
      if (payload.workflowId !== workflowId) return;
      if (runId && payload.runId && payload.runId !== runId) return;

      if (env.event === REALTIME_EVENTS.WORKFLOW_BUILD_PHASE) {
        if (payload.phase === 'blocked') setPhase('blocked');
        else if (payload.phase && PHASES.includes(payload.phase as Exclude<BuildPhase, 'blocked'>)) {
          setPhase(payload.phase as Exclude<BuildPhase, 'blocked'>);
        }
        if (payload.detail) setPhaseDetail(payload.detail);
      } else if (env.event === REALTIME_EVENTS.CANVAS_NODE_PLACED && payload.node) {
        setLoading(false);
        setNodes((current) => mergeById(current, [mapLiveNode(payload.node!)]));
      } else if (env.event === REALTIME_EVENTS.CANVAS_EDGE_CONNECTED && payload.edge) {
        setEdges((current) => mergeById(current, [mapLiveEdge(payload.edge!, true)]));
      } else if (env.event === REALTIME_EVENTS.CANVAS_BUILD_COMPLETE) {
        setPhase('complete');
        setEdges((current) => current.map((edge) => ({ ...edge, animated: false })));
      }
    },
  );

  const fit = useMemo(() => ({ padding: 0.18 }), []);
  const hasLiveGraph = nodes.length > 0;
  const shownNodes = hasLiveGraph ? nodes : SCAFFOLD_NODES;
  const shownEdges = hasLiveGraph ? edges : SCAFFOLD_EDGES;
  const nodeCount = nodes.length;
  const edgeCount = edges.length;
  const phaseIndex = phase === 'blocked' ? 0 : Math.max(0, PHASES.indexOf(phase));
  const complete = phase === 'complete';
  const blocked = phase === 'blocked';

  return (
    <div className="flex h-full flex-col overflow-hidden bg-surface-2">
      <header className="flex h-12 shrink-0 items-center justify-between border-b border-line bg-surface/90 px-3 backdrop-blur-sm">
        <div className="flex min-w-0 items-center gap-2">
          <div className={`grid h-7 w-7 shrink-0 place-items-center rounded-md ${complete ? 'bg-accent/15' : blocked ? 'bg-danger/10' : 'bg-accent/10'}`}>
            {complete ? (
              <CheckCircle2 size={14} className="text-accent" />
            ) : blocked ? (
              <AlertTriangle size={14} className="text-danger" />
            ) : (
              <Sparkles size={13} className="animate-pulse text-accent" />
            )}
          </div>
          <div className="min-w-0">
            <h2 className="truncate text-[12px] font-semibold text-text-primary">
              {wf ? wf.title : 'Workflow canvas'}
            </h2>
            <div className="truncate text-[9.5px] text-text-muted">
              {complete
                ? `${nodeCount} nodes | ${edgeCount} edges`
                : blocked
                  ? phaseDetail || 'Build stopped'
                  : hasLiveGraph
                    ? `${PHASE_LABEL[phase]} | ${nodeCount} nodes placed`
                    : loading
                      ? 'Preparing the live graph'
                      : loadFailed
                        ? 'Waiting for live graph events'
                        : 'Drafting graph structure'}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => nav(`/workflows/${workflowId}`)}
            className="group flex h-7 items-center gap-1 rounded-md bg-accent px-2.5 text-[11px] font-semibold text-canvas transition-all hover:bg-accent/90 active:scale-[0.97]"
          >
            <Maximize2 size={11} className="transition-transform group-hover:scale-110" />
            Editor
          </button>
          <button
            type="button"
            onClick={onClose}
            className="grid h-7 w-7 place-items-center rounded-md text-text-muted transition-colors hover:bg-surface hover:text-text-primary"
            aria-label="Close preview"
          >
            <X size={13} />
          </button>
        </div>
      </header>

      <div className="grid grid-cols-6 gap-px border-b border-line/40 bg-line/40" aria-hidden>
        {PHASES.map((item, index) => (
          <span
            key={item}
            className={`h-0.5 transition-colors duration-500 ${complete || index <= phaseIndex ? 'bg-accent' : 'bg-surface-3'}`}
            title={PHASE_LABEL[item]}
          />
        ))}
      </div>

      <div className="flex items-center gap-2 border-b border-line/40 bg-surface/60 px-3 py-2 text-[10px] text-text-muted">
        {blocked ? <AlertTriangle size={12} className="text-danger" /> : <Activity size={12} className={complete ? 'text-accent' : 'animate-pulse text-accent'} />}
        <span className="font-medium text-text-secondary">{PHASE_LABEL[phase]}</span>
        {phaseDetail && <span className="min-w-0 flex-1 truncate">{phaseDetail}</span>}
        <span className="ml-auto inline-flex items-center gap-1 font-mono">
          <GitBranch size={11} />
          {hasLiveGraph ? `${nodeCount}/${edgeCount}` : 'scaffold'}
        </span>
      </div>

      <div className="relative flex-1 overflow-hidden">
        <div className="h-full w-full bg-[radial-gradient(circle_at_22%_8%,rgba(74,222,128,0.08),transparent_30%),linear-gradient(180deg,var(--color-surface-2),var(--color-canvas))]">
          <CanvasEngine
            nodes={shownNodes}
            edges={shownEdges}
            fitView
            fitViewOptions={fit}
            nodesDraggable={hasLiveGraph}
            nodesConnectable={false}
            elementsSelectable={hasLiveGraph}
            panOnDrag
            zoomOnScroll
            zoomOnPinch
            zoomOnDoubleClick
            controlsPosition="bottom-left"
            backgroundGap={24}
            backgroundColor="transparent"
            proOptions={{ hideAttribution: true }}
          />
        </div>
        {!hasLiveGraph && !blocked && (
          <div className="pointer-events-none absolute inset-x-4 bottom-4 rounded-lg border border-line/50 bg-surface/85 px-3 py-2 text-[11px] text-text-muted shadow-card backdrop-blur">
            <div className="mb-1 flex items-center gap-2 text-text-secondary">
              <Activity size={12} className="animate-pulse text-accent" />
              <span className="font-medium">Live scaffold active</span>
            </div>
            Nodes will replace this scaffold as the builder places them.
          </div>
        )}
        {blocked && (
          <div className="absolute inset-x-4 bottom-4 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-[11px] text-danger shadow-card backdrop-blur">
            {phaseDetail || 'The workflow build was blocked before canvas nodes were created.'}
          </div>
        )}
      </div>
    </div>
  );
}
