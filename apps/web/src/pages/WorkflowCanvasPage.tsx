/**
 * WorkflowCanvasPage — visual workflow editor.
 *
 * Per UIUX-REPLAN §7.3:
 *   - Clear toolbar with editable title, undo/redo, Inputs, Test run, Publish
 *   - Auto-save every 30s with "Saved ·" indicator + "Unsaved" dot
 *   - Toggleable minimap
 *   - Run input form (no confusing variable prompt)
 *   - Stays inside Shell
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { REALTIME_EVENTS } from '@agentis/core';
import {
  Handle,
  Position,
  useNodesState,
  useEdgesState,
  type Node,
  type Edge,
  type Connection,
} from '@xyflow/react';
import {
  ArrowLeft,
  Play,
  Upload,
  Map as MapIcon,
  MapPinOff,
  ChevronDown,
  X,
  Variable,
  Trash2,
  Webhook,
  Clock as ClockIcon,
  Copy,
  BookOpen,
  ExternalLink,
  FileSignature,
  GitBranch,
  Sparkles,
  BarChart3,
  MoreHorizontal,
  Settings,
  AlertCircle,
  LayoutGrid,
  Pause,
  Power,
  RadioTower,
  RefreshCw,
} from 'lucide-react';
import clsx from 'clsx';
import { api, apiErrorMessage, workspace as workspaceStore } from '../lib/api';
import { rtSubscribe, useRealtime, type RealtimeEnvelope } from '../lib/realtime';
import {
  affordanceLabel,
  connectedAgentMatches,
  hasAgentRequirements,
  normalizeAgentRequirements,
  requiredAffordanceKeys,
  type AdapterCapabilitiesLite,
  type AgentRequirements,
} from '../lib/agentCapabilities';
import { NodePalette } from '../components/canvas/NodePalette';
import { AgentisEdge } from '../components/canvas/AgentisEdge';
import { NodeCommandPalette } from '../components/canvas/NodeCommandPalette';
import {
  WorkflowContractsPanel,
  type WorkflowContractValue,
} from '../components/canvas/WorkflowContractsPanel';
import { EventChainsPanel } from '../components/canvas/EventChainsPanel';
import { PhaseLayer } from '../components/canvas/PhaseLayer';
import { ContextInspector, type InspectorSelection } from '../components/canvas/ContextInspector';
import { WorkflowMonitorCard } from '../components/canvas/WorkflowMonitorCard';
import { WorkflowLintPanel } from '../components/canvas/WorkflowLintPanel';
import {
  evaluateNodeReadiness,
  type IntegrationManifestLite,
} from '../components/canvas/nodeConfigRegistry';
import { RunDrawer } from '../components/canvas/RunDrawer';
import { CanvasEngine } from '../components/canvas/CanvasEngine';
import { nodeKindMeta, nodeKindColor } from '../components/canvas/nodeKindMeta';
import { autoLayout } from '../components/canvas/autoLayout';
import { AgentFocusOverlayManager } from '../components/canvas/AgentFocusOverlayManager';
import { Typewriter } from '../components/shared/Typewriter';
import { Button } from '../components/shared/Button';
import { SegmentedControl } from '../components/shared/SegmentedControl';
import { useToast } from '../components/shared/Toast';
import { useConfirm } from '../components/shared/ConfirmDialog';
import { WorkflowRunsTab } from '../components/workflows/WorkflowRunsTab';
import { WorkflowOutputTab } from '../components/workflows/WorkflowOutputTab';
import type { WorkflowRunSummary } from '../components/workflows/runFormat';
import { DashboardViewer } from '../components/workflows/OutputViewers';

interface WorkflowDetail {
  id: string;
  title: string;
  description: string | null;
  spaceId?: string | null;
  graph: {
    version: 1;
    nodes: Array<{
      id: string;
      type: string;
      title: string;
      position: { x: number; y: number };
      config: { kind: string; [k: string]: unknown };
    }>;
    edges: Array<{ id: string; source: string; target: string }>;
    viewport: { x: number; y: number; zoom: number };
  };
  variables?: Array<{ name: string; type: string; default?: unknown; label?: string }>;
  isReusable?: boolean;
  isInLibrary?: boolean;
}

interface ExtensionRow {
  id: string;
  slug: string;
  name: string;
  runtime: string;
  manifest?: {
    operations?: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown>; outputSchema?: Record<string, unknown> }>;
  };
}

interface AgentCapabilityRow {
  id: string;
  name: string;
  status?: string | null;
  adapterType?: string | null;
  adapterCapabilities?: AdapterCapabilitiesLite | null;
}

interface WorkflowDeployment {
  triggerId: string;
  workflowId: string;
  triggerType: 'cron' | 'webhook' | 'persistent_listener';
  status: 'active' | 'paused' | 'error';
  updatedAt: string;
  lastFiredAt: string | null;
  webhookUrl?: string;
  webhookSecret?: string;
  config: Record<string, unknown>;
  health?: {
    connected?: boolean;
    status?: 'connecting' | 'active' | 'error' | 'paused';
    eventCount?: number;
    fireCount?: number;
    errorCount?: number;
    lastError?: string;
  } | null;
}

const ACTIVE_RUN_SUMMARY_STATUSES = new Set(['running', 'waiting', 'paused', 'pending']);

function isActiveRunSummary(run: Pick<WorkflowRunSummary, 'status'>): boolean {
  return ACTIVE_RUN_SUMMARY_STATUSES.has(run.status);
}

interface CanvasAgentMatch {
  id: string;
  name: string;
  satisfied: boolean;
  missing: string[];
}

interface SpaceSummary {
  id: string;
  name: string;
  colorHex?: string | null;
}

type SaveState = 'saved' | 'saving' | 'dirty' | 'error';

/** Three-tab model — WORKFLOW-PAGE-REDESIGN.md. */
type WorkflowTab = 'canvas' | 'runs' | 'output';

const MINIMAP_KEY = 'agentis.canvas.minimap';
const WORKFLOW_TAB_SEGMENTS = [
  { value: 'canvas' as WorkflowTab, label: 'Canvas' },
  { value: 'runs' as WorkflowTab, label: 'Runs' },
  { value: 'output' as WorkflowTab, label: 'Output' },
] as const;

export function WorkflowCanvasPage() {
  const { id } = useParams<{ id: string }>();
  const nav = useNavigate();
  const toast = useToast();
  const confirm = useConfirm();

  // Three-tab model: ?tab=canvas|runs|output. Canvas is the default and
  // omits the param to keep the editor URL clean.
  const [searchParams, setSearchParams] = useSearchParams();
  const tabParam = searchParams.get('tab');
  const tab: WorkflowTab = tabParam === 'runs' || tabParam === 'output' ? tabParam : 'canvas';
  const setTab = useCallback(
    (v: WorkflowTab) => {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          if (v === 'canvas') next.delete('tab');
          else next.set('tab', v);
          return next;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );

  const [wf, setWf] = useState<WorkflowDetail | null>(null);
  const [extensions, setExtensions] = useState<ExtensionRow[]>([]);
  const [agents, setAgents] = useState<AgentCapabilityRow[]>([]);
  const [spaces, setSpaces] = useState<SpaceSummary[]>([]);
  const [titleDraft, setTitleDraft] = useState('');
  const [titleEditing, setTitleEditing] = useState(false);

  const [running, setRunning] = useState(false);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [runDialogOpen, setRunDialogOpen] = useState(false);
  const [publishOpen, setPublishOpen] = useState(false);
  const [deployment, setDeployment] = useState<WorkflowDeployment | null>(null);
  const [deploymentLoading, setDeploymentLoading] = useState(false);
  const [deploymentBusy, setDeploymentBusy] = useState(false);
  const [deploymentError, setDeploymentError] = useState<string | null>(null);
  const [overflowOpen, setOverflowOpen] = useState(false);
  const [variablesOpen, setVariablesOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>('saved');
  const [knowledgeBaseCount, setKnowledgeBaseCount] = useState<number | null>(null);
  const [knowledgeChunkCount, setKnowledgeChunkCount] = useState<number | null>(null);
  const [showMinimap, setShowMinimap] = useState<boolean>(() => {
    try {
      return localStorage.getItem(MINIMAP_KEY) === '1';
    } catch {
      return false;
    }
  });

  const [selection, setSelection] = useState<InspectorSelection>({ kind: null });
  const [inspectorOpen, setInspectorOpen] = useState(true);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [contractsOpen, setContractsOpen] = useState(false);
  const [chainsOpen, setChainsOpen] = useState(false);

  // §7.1 analytics dashboard.
  const [analyticsOpen, setAnalyticsOpen] = useState(false);
  const [analytics, setAnalytics] = useState<WorkflowAnalytics | null>(null);
  const [analyticsLoading, setAnalyticsLoading] = useState(false);
  const [integrations, setIntegrations] = useState<IntegrationManifestLite[]>([]);
  const [reusableWorkflows, setReusableWorkflows] = useState<Array<{ id: string; title: string }>>(
    [],
  );
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; nodeId: string } | null>(
    null,
  );
  const overlayHostRef = useRef<HTMLDivElement | null>(null);
  const overlayManagerRef = useRef<AgentFocusOverlayManager | null>(null);
  const saveTimerRef = useRef<number | null>(null);
  const lastSavedFingerprintRef = useRef<string | null>(null);
  const saveStateRef = useRef<SaveState>('saved');
  const saveSequenceRef = useRef(0);
  const saveChainRef = useRef<Promise<void>>(Promise.resolve());
  const toastRef = useRef(toast);
  useEffect(() => {
    toastRef.current = toast;
  }, [toast]);

  useEffect(() => {
    if (!overlayHostRef.current) return;
    const mgr = new AgentFocusOverlayManager();
    mgr.attach(overlayHostRef.current);
    overlayManagerRef.current = mgr;
    return () => mgr.detach();
  }, []);

  useEffect(() => {
    if (!id) return;
    void api<{ workflow: WorkflowDetail }>(`/v1/workflows/${id}`).then((d) => {
      setWf(d.workflow);
      setTitleDraft(d.workflow.title);
      lastSavedFingerprintRef.current = graphFingerprint(d.workflow.graph, d.workflow.title);
    });
    void api<{ extensions: ExtensionRow[] }>('/v1/extensions').then((d) => setExtensions(d.extensions));
    void api<{ agents: AgentCapabilityRow[] }>('/v1/agents')
      .then((d) => setAgents(d.agents ?? []))
      .catch(() => setAgents([]));
    void api<{ data: SpaceSummary[] }>('/v1/spaces')
      .then((d) => setSpaces(d.data ?? []))
      .catch(() => setSpaces([]));
    // The Brain overview reports both base count and total indexed chunks, so the
    // canvas callout can fire when a Brain node has no content to retrieve (§G5).
    void api<{ stats: { knowledgeBases: number; chunks: number } }>('/v1/brain')
      .then((d) => {
        setKnowledgeBaseCount(d.stats.knowledgeBases);
        setKnowledgeChunkCount(d.stats.chunks);
      })
      .catch(() => {
        setKnowledgeBaseCount(0);
        setKnowledgeChunkCount(0);
      });
  }, [id]);

  const hasKnowledgeNode = useMemo(
    () =>
      wf?.graph.nodes.some((n) => n.config.kind === 'knowledge' || n.type === 'knowledge') ?? false,
    [wf],
  );

  // Keep the workspace room subscription alive while editing so run
  // lifecycle events reach the Runs/Output tabs and drive the post-run
  // hand-off (live drawer → Output tab) without a page navigation.
  useEffect(() => {
    const ws = workspaceStore.get();
    if (!ws) return;
    return rtSubscribe('workspace', { workspaceId: ws });
  }, []);

  // Per-node run events (NODE_STARTED/COMPLETED/FAILED/WAITING_FOR_INPUT) are
  // published to the RUN room, not the workspace room. Without subscribing to
  // the active run's room the canvas never receives them — the cause of the
  // "black screen during a run." Subscribe whenever we have an active run.
  useEffect(() => {
    if (!activeRunId) return;
    return rtSubscribe('run', { runId: activeRunId });
  }, [activeRunId]);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    void api<{ runs: WorkflowRunSummary[] }>(`/v1/workflows/${id}/runs?limit=10`)
      .then((data) => {
        if (cancelled) return;
        const active = (data.runs ?? []).find(isActiveRunSummary);
        setActiveRunId(active?.id ?? null);
      })
      .catch(() => {
        if (!cancelled) setActiveRunId(null);
      });
    return () => { cancelled = true; };
  }, [id]);

  const runStartEvents = useMemo(
    () => [REALTIME_EVENTS.RUN_CREATED, REALTIME_EVENTS.RUN_RUNNING],
    [],
  );
  useRealtime(runStartEvents, (env: RealtimeEnvelope) => {
    const payload = (env.payload ?? {}) as { runId?: string; workflowId?: string };
    if (!id || payload.workflowId !== id || !payload.runId) return;
    setActiveRunId(payload.runId);
  });

  const runEndEvents = useMemo(
    () => [REALTIME_EVENTS.RUN_COMPLETED, REALTIME_EVENTS.RUN_FAILED],
    [],
  );
  useRealtime(runEndEvents, (env: RealtimeEnvelope) => {
    const payload = (env.payload ?? {}) as { runId?: string };
    if (!activeRunId || payload.runId !== activeRunId) return;
    // Run finished — close the live drawer and surface the result on the
    // Output tab without leaving /workflows/:id (§Run Button Behavior).
    setDrawerOpen(false);
    setActiveRunId(null);
    setTab('output');
  });

  useEffect(() => {
    try {
      localStorage.setItem(MINIMAP_KEY, showMinimap ? '1' : '0');
    } catch {
      /* ignore */
    }
  }, [showMinimap]);

  // Cmd+K / Ctrl+K opens the command palette. Bound at the page level so it
  // works regardless of which canvas element has focus.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setCommandPaletteOpen((open) => !open);
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [nav]);

  // Load data the command palette needs: integration connectors + reusable
  // workflows. Both are best-effort — failures collapse to empty lists so
  // the palette still surfaces built-in nodes.
  useEffect(() => {
    void api<{
      integrations: IntegrationManifestLite[];
    }>('/v1/integrations')
      .then((d) => setIntegrations(d.integrations ?? []))
      .catch(() => setIntegrations([]));
    void api<{ workflows: Array<{ id: string; title?: string; name?: string }> }>(
      '/v1/workflows?isReusable=true',
    )
      .then((d) =>
        setReusableWorkflows(
          (d.workflows ?? []).map((wf) => ({
            id: wf.id,
            title: wf.title ?? wf.name ?? 'Untitled workflow',
          })),
        ),
      )
      .catch(() => setReusableWorkflows([]));
  }, []);

  // Auto-bind unbound echo extension template (preserved from original)
  useEffect(() => {
    if (!wf) return;
    const echo = extensions.find((s) => s.slug === 'echo');
    if (!echo) return;
    let changed = false;
    const nextNodes = wf.graph.nodes.map((n) => {
      if (n.config.kind === 'extension_task' && n.config.extensionId === 'BIND_AT_RUNTIME') {
        changed = true;
        return { ...n, config: { ...n.config, extensionId: echo.id, operationName: (n.config as { operationName?: string }).operationName ?? 'execute' } };
      }
      return n;
    });
    if (changed) {
      setWf({ ...wf, graph: { ...wf.graph, nodes: nextNodes } });
      void api(`/v1/workflows/${wf.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ graph: { ...wf.graph, nodes: nextNodes } }),
      }).catch(() => {});
    }
  }, [wf, extensions]);

  // React Flow owns the node/edge state so it can manage selection,
  // dragging, and multi-select internally. We sync changes back to
  // wf.graph (for saves) inside the change handlers.
  const [flowNodes, setFlowNodes, onFlowNodesChange] = useNodesState<Node>([]);
  const [flowEdges, setFlowEdges, onFlowEdgesChange] = useEdgesState<Edge>([]);
  // The live React-Flow instance, captured on init so toolbar actions (Tidy,
  // fit) can drive the viewport imperatively.
  const flowInstanceRef = useRef<import('../components/canvas/CanvasEngine').CanvasEngineInstance | null>(null);

  // Stable edge-delete handle threaded into each edge's `data.onDelete` so the
  // hover × affordance in AgentisEdge can remove a connection. The concrete
  // implementation is installed once queueSave exists (see below); routing it
  // through a ref keeps the callback identity stable across renders, which lets
  // us thread it at hydration time without re-running that effect.
  const deleteEdgeRef = useRef<(edgeId: string) => void>(() => {});
  const handleEdgeDelete = useCallback((edgeId: string) => {
    deleteEdgeRef.current(edgeId);
  }, []);
  const edgeTypes = useMemo(() => ({ agentis: AgentisEdge }), []);
  const monitorNodeTitles = useMemo(() => {
    const titles = new Map<string, string>();
    for (const node of flowNodes) {
      const data = node.data as { label?: string } | undefined;
      if (data?.label) titles.set(node.id, data.label);
    }
    return titles;
  }, [flowNodes]);

  const focusMonitorNode = useCallback(
    (nodeId: string) => {
      const node = flowNodes.find((item) => item.id === nodeId);
      const workflowNode = wf?.graph.nodes.find((item) => item.id === nodeId);
      if (!node) return;
      const data = node.data as { label?: string; type?: string } | undefined;
      setSelection({
        kind: 'node',
        nodeId,
        nodeType: data?.type,
        data: workflowNode?.config ?? (node.data as Record<string, unknown>),
        title: workflowNode?.title ?? data?.label,
      });
      setInspectorOpen(true);
      flowInstanceRef.current?.setCenter(node.position.x + 120, node.position.y + 70, {
        zoom: 0.95,
        duration: 360,
      });
    },
    [flowNodes, wf],
  );

  // ── Live per-node status overlay ──────────────────────────────────────
  // The engine fires NODE_STARTED/COMPLETED/FAILED/RETRY_SCHEDULED on the
  // run room for EVERY kind. Project them onto the canvas as a `liveStatus`
  // field that AgentisNode reads to paint pulsing rings, checkmarks, and
  // error borders. Clears automatically when a run terminates.
  const liveStatusEvents = useMemo(
    () => [
      REALTIME_EVENTS.NODE_STARTED,
      REALTIME_EVENTS.NODE_COMPLETED,
      REALTIME_EVENTS.NODE_FAILED,
      REALTIME_EVENTS.NODE_RETRY_SCHEDULED,
      REALTIME_EVENTS.NODE_WAITING_FOR_INPUT,
      REALTIME_EVENTS.LOOP_PROGRESS,
      REALTIME_EVENTS.RUN_COMPLETED,
      REALTIME_EVENTS.RUN_FAILED,
    ],
    [],
  );
  const updateLiveStatus = useCallback(
    (
      nodeId: string,
      status: 'running' | 'completed' | 'failed' | 'retry' | 'waiting',
      extra?: Record<string, unknown>,
    ) => {
      setFlowNodes((prev) =>
        prev.map((n) =>
          n.id === nodeId
            ? { ...n, data: { ...(n.data ?? {}), liveStatus: status, liveExtra: extra } }
            : n,
        ),
      );
    },
    [setFlowNodes],
  );
  const clearLiveNodeStatus = useCallback(() => {
    // Fade after a short delay so users see the final state before it clears.
    window.setTimeout(() => {
      setFlowNodes((prev) =>
        prev.map((n) => {
          const d = (n.data ?? {}) as Record<string, unknown>;
          if (!d.liveStatus) return n;
          const { liveStatus: _ls, liveExtra: _le, ...rest } = d;
          return { ...n, data: rest };
        }),
      );
    }, 3500);
  }, [setFlowNodes]);
  useRealtime(liveStatusEvents, (env: RealtimeEnvelope) => {
    const payload = (env.payload ?? {}) as {
      runId?: string;
      nodeId?: string;
      completed?: number;
      total?: number;
    };
    if (!activeRunId || payload.runId !== activeRunId) return;
    if (env.event === REALTIME_EVENTS.RUN_COMPLETED || env.event === REALTIME_EVENTS.RUN_FAILED) {
      clearLiveNodeStatus();
      return;
    }
    if (!payload.nodeId) return;
    switch (env.event) {
      case REALTIME_EVENTS.NODE_STARTED:
        updateLiveStatus(payload.nodeId, 'running');
        break;
      case REALTIME_EVENTS.NODE_COMPLETED:
        updateLiveStatus(payload.nodeId, 'completed');
        break;
      case REALTIME_EVENTS.NODE_FAILED:
        updateLiveStatus(payload.nodeId, 'failed');
        break;
      case REALTIME_EVENTS.NODE_RETRY_SCHEDULED:
        updateLiveStatus(payload.nodeId, 'retry');
        break;
      case REALTIME_EVENTS.NODE_WAITING_FOR_INPUT:
        updateLiveStatus(payload.nodeId, 'waiting');
        break;
      case REALTIME_EVENTS.LOOP_PROGRESS:
        updateLiveStatus(payload.nodeId, 'running', {
          progress: { completed: payload.completed, total: payload.total },
        });
        break;
      default:
        break;
    }
  });

  // Hydrate RF state once when the workflow loads (and on workflow ID change).
  // We compare by ID to avoid clobbering local edits on re-renders.
  const hydratedIdRef = useRef<string | null>(null);
  const buildCanvasEvents = useMemo(
    () => [
      REALTIME_EVENTS.CANVAS_NODE_PLACED,
      REALTIME_EVENTS.CANVAS_EDGE_CONNECTED,
      REALTIME_EVENTS.CANVAS_BUILD_COMPLETE,
    ],
    [],
  );
  useRealtime(buildCanvasEvents, (env: RealtimeEnvelope) => {
    const payload = (env.payload ?? {}) as {
      workflowId?: string;
      runId?: string;
      node?: { id?: string; type?: string; position?: { x: number; y: number }; data?: { label?: string; kind?: string } };
      edge?: { id?: string; source?: string; target?: string };
    };
    if (!id || payload.workflowId !== id) return;
    setTab('canvas');
    if (payload.runId) setActiveRunId(payload.runId);
    if (env.event === REALTIME_EVENTS.CANVAS_NODE_PLACED && payload.node?.id) {
      const node = payload.node;
      setFlowNodes((prev) => {
        if (prev.some((existing) => existing.id === node.id)) return prev;
        const kind = node.data?.kind ?? node.type ?? 'transform';
        return [
          ...prev,
          {
            id: node.id!,
            type: 'agentis',
            position: node.position ?? { x: 0, y: 0 },
            data: {
              label: node.data?.label ?? nodeKindMeta(kind).label,
              kind,
              type: node.type ?? kind,
              liveStatus: 'running',
            },
          },
        ];
      });
      return;
    }
    if (env.event === REALTIME_EVENTS.CANVAS_EDGE_CONNECTED && payload.edge?.id && payload.edge.source && payload.edge.target) {
      const edge = payload.edge;
      setFlowEdges((prev) => {
        if (prev.some((existing) => existing.id === edge.id)) return prev;
        return [
          ...prev,
          {
            id: edge.id!,
            source: edge.source!,
            target: edge.target!,
            type: 'agentis',
            animated: true,
            data: { type: 'default', onDelete: handleEdgeDelete },
          },
        ];
      });
      return;
    }
    if (env.event === REALTIME_EVENTS.CANVAS_BUILD_COMPLETE) {
      setFlowNodes((prev) =>
        prev.map((node) => ({
          ...node,
          data: { ...(node.data ?? {}), liveStatus: 'completed' },
        })),
      );
      void api<{ workflow: WorkflowDetail }>(`/v1/workflows/${id}`).then((d) => {
        hydratedIdRef.current = null;
        setWf(d.workflow);
        setTitleDraft(d.workflow.title);
        lastSavedFingerprintRef.current = graphFingerprint(d.workflow.graph, d.workflow.title);
      });
    }
  });
  useEffect(() => {
    if (!wf) return;
    if (hydratedIdRef.current === wf.id) return;
    hydratedIdRef.current = wf.id;
    setFlowNodes(
      wf.graph.nodes.map((n) => ({
        id: n.id,
        type: 'agentis',
        position: n.position,
        data: {
          // Fall back to the kind label so a node with no title is never blank.
          label: (typeof n.title === 'string' && n.title.trim())
            ? n.title
            : nodeKindMeta((n.config as { kind?: string }).kind ?? n.type).label,
          kind: (n.config as { kind?: string }).kind ?? n.type,
          type: n.type,
          operationName: (n.config as { operationName?: string }).operationName,
          ...readinessNodeData(n.config, integrations),
          ...agentCapabilityNodeData(n.config, agents),
        },
      })),
    );
    setFlowEdges(
      wf.graph.edges.map((e) => ({
        id: e.id,
        source: e.source,
        target: e.target,
        type: 'agentis',
        animated: false,
        // Carry the edge-type discriminant through to the renderer (used by
        // AgentisEdge for error-edge dashed-red styling) along with any
        // human-edited label.
        data: {
          type: (e as { type?: 'default' | 'error' | 'condition' }).type ?? 'default',
          label: (e as { label?: string }).label,
          condition: (e as { condition?: string }).condition,
          onDelete: handleEdgeDelete,
        },
      })),
    );
  }, [wf, agents, integrations, setFlowNodes, setFlowEdges, handleEdgeDelete]);

  useEffect(() => {
    if (!wf) return;
    const byId = new Map(wf.graph.nodes.map((node) => [node.id, node]));
    setFlowNodes((nodes) =>
      nodes.map((node) => {
        const workflowNode = byId.get(node.id);
        if (!workflowNode) return node;
        return {
          ...node,
          data: {
            ...(node.data ?? {}),
            ...readinessNodeData(workflowNode.config, integrations),
            ...agentCapabilityNodeData(workflowNode.config, agents),
          },
        };
      }),
    );
  }, [wf?.graph.nodes, agents, integrations, setFlowNodes]);

  // Auto-save: debounce 1.2s for snappy feedback, save on unmount.
  //
  // saveNow reads the *live* React Flow state through refs rather than a
  // captured closure. The previous design synced flow→graph inside a
  // requestAnimationFrame whose closure captured a one-render-stale `syncAndSave`,
  // so every mutation persisted the *previous* mutation's graph (1st edit lost,
  // 2nd saved the 1st, …). Reading from refs at fire time means a handler can
  // setFlowNodes/setFlowEdges and queueSave() in the same tick and still persist
  // its own change.
  const wfRef = useRef<WorkflowDetail | null>(null);
  const flowNodesRef = useRef<Node[]>(flowNodes);
  const flowEdgesRef = useRef<Edge[]>(flowEdges);
  useEffect(() => {
    wfRef.current = wf;
  }, [wf]);
  useEffect(() => {
    flowNodesRef.current = flowNodes;
  }, [flowNodes]);
  useEffect(() => {
    flowEdgesRef.current = flowEdges;
  }, [flowEdges]);
  useEffect(() => {
    saveStateRef.current = saveState;
  }, [saveState]);

  const saveNow = useCallback(async (graph?: WorkflowDetail['graph'], title?: string) => {
    const current = wfRef.current;
    if (!current) return;
    // Always project the live flow positions and edges over the authoritative
    // config graph. An inspector save immediately after a drag must not restore
    // the prior position.
    const nextGraph = buildGraphFromFlow(
      graph ?? current.graph,
      flowNodesRef.current,
      flowEdgesRef.current,
    );
    const nextTitle = title ?? current.title;
    const fingerprint = graphFingerprint(nextGraph, nextTitle);
    if (fingerprint === lastSavedFingerprintRef.current) {
      saveStateRef.current = 'saved';
      setSaveState('saved');
      return;
    }
    const sequence = ++saveSequenceRef.current;
    const optimistic = { ...current, graph: nextGraph, title: nextTitle };
    wfRef.current = optimistic;
    setWf(optimistic);
    saveStateRef.current = 'saving';
    setSaveState('saving');
    const persist = async () => {
      try {
        await api(`/v1/workflows/${current.id}`, {
          method: 'PATCH',
          body: JSON.stringify({
            graph: nextGraph,
            title: nextTitle,
          }),
        });
        lastSavedFingerprintRef.current = fingerprint;
        if (sequence === saveSequenceRef.current) {
          saveStateRef.current = 'saved';
          setSaveState('saved');
        }
      } catch (e) {
        if (sequence === saveSequenceRef.current) {
          saveStateRef.current = 'error';
          setSaveState('error');
          toastRef.current.error('Auto-save failed', apiErrorMessage(e));
        }
      }
    };
    const pending = saveChainRef.current.then(persist, persist);
    saveChainRef.current = pending.then(
      () => undefined,
      () => undefined,
    );
    await pending;
  }, []);

  const queueSave = useCallback(() => {
    // Invalidate any in-flight completion immediately; otherwise it can mark
    // the editor saved while this newly dirty change is still waiting on the debounce.
    saveSequenceRef.current += 1;
    saveStateRef.current = 'dirty';
    setSaveState('dirty');
    if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
    saveTimerRef.current = window.setTimeout(() => {
      void saveNow();
    }, 1200);
  }, [saveNow]);

  // Tidy — re-run the shared layered layout over the current graph, persist the
  // new positions, and frame the result. Makes any graph (AI-built or
  // hand-edited) instantly readable.
  const handleTidy = useCallback(() => {
    const inst = flowInstanceRef.current;
    if (!inst) return;
    const laid = autoLayout(inst.getNodes(), inst.getEdges());
    if (laid.length === 0) return;
    const byId = new Map(laid.map((n) => [n.id, n.position] as const));
    setFlowNodes((nds) => nds.map((n) => ({ ...n, position: byId.get(n.id) ?? n.position })));
    setWf((prev) =>
      prev
        ? {
            ...prev,
            graph: {
              ...prev.graph,
              nodes: prev.graph.nodes.map((n) => ({ ...n, position: byId.get(n.id) ?? n.position })),
            },
          }
        : prev,
    );
    queueSave();
    // Fit after the new positions have painted.
    window.setTimeout(() => flowInstanceRef.current?.fitView({ padding: 0.18, duration: 400 }), 60);
  }, [queueSave, setFlowNodes]);

  // Install the concrete edge-delete implementation behind the stable ref the
  // edges were threaded with at hydration. Uses the controlled setter so the
  // removal flows through React Flow's edge state, then persists.
  useEffect(() => {
    deleteEdgeRef.current = (edgeId: string) => {
      setFlowEdges((eds) => eds.filter((e) => e.id !== edgeId));
      queueSave();
    };
  }, [setFlowEdges, queueSave]);

  const handleConnect = useCallback(
    (conn: Connection) => {
      if (!conn.source || !conn.target) return;
      // The AgentisNode renderer exposes an `error` handle on the bottom-right
      // of each node. Edges drawn from that handle persist with `type: 'error'`
      // so AgentisEdge can render them dashed-red and the engine routes failures
      // through them as catch branches.
      const edgeType: 'default' | 'error' = conn.sourceHandle === 'error' ? 'error' : 'default';
      setFlowEdges((eds) => {
        const exists = eds.some(
          (e) =>
            e.source === conn.source &&
            e.target === conn.target &&
            ((e.data as { type?: string } | undefined)?.type ?? 'default') === edgeType,
        );
        if (exists) return eds;
        const id = `e-${conn.source}-${conn.target}-${edgeType === 'error' ? 'err-' : ''}${Date.now().toString(36)}`;
        return [
          ...eds,
          {
            id,
            source: conn.source!,
            target: conn.target!,
            type: 'agentis',
            animated: false,
            data: { type: edgeType, onDelete: handleEdgeDelete },
          },
        ];
      });
      queueSave();
    },
    [setFlowEdges, queueSave, handleEdgeDelete],
  );

  const deleteNodeById = useCallback(
    (nodeId: string) => {
      setFlowNodes((nds) => nds.filter((n) => n.id !== nodeId));
      setFlowEdges((eds) => eds.filter((e) => e.source !== nodeId && e.target !== nodeId));
      setSelection({ kind: null });
      setContextMenu(null);
      queueSave();
    },
    [setFlowNodes, setFlowEdges, queueSave],
  );

  const duplicateNode = useCallback(
    (nodeId: string) => {
      setFlowNodes((nds) => {
        const orig = nds.find((n) => n.id === nodeId);
        if (!orig) return nds;
        const copy: Node = {
          ...orig,
          id: `${(orig.data as { type?: string }).type ?? 'node'}-${Date.now().toString(36)}`,
          position: { x: orig.position.x + 40, y: orig.position.y + 40 },
          selected: false,
          data: {
            ...(orig.data as Record<string, unknown>),
            label: `${(orig.data as { label?: string }).label ?? 'Node'} copy`,
          },
        };
        return [...nds, copy];
      });
      setContextMenu(null);
      queueSave();
    },
    [setFlowNodes, queueSave],
  );

  // Close context menu on global click/escape
  useEffect(() => {
    if (!contextMenu) return;
    const onClick = () => setContextMenu(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setContextMenu(null);
    };
    window.addEventListener('click', onClick);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('click', onClick);
      window.removeEventListener('keydown', onKey);
    };
  }, [contextMenu]);

  // Close publish and overflow dropdowns on global click outside
  useEffect(() => {
    if (!publishOpen && !overflowOpen) return;
    const onClick = () => {
      setPublishOpen(false);
      setOverflowOpen(false);
    };
    window.addEventListener('click', onClick);
    return () => window.removeEventListener('click', onClick);
  }, [publishOpen, overflowOpen]);

  useEffect(() => {
    if (!publishOpen || !wf) return;
    void refreshDeployment();
    // The workflow id is the deployment identity; graph edits are compared in the panel.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [publishOpen, wf?.id]);

  // Manual save with ⌘S / Ctrl+S
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault();
        if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
        void saveNow();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [saveNow]);

  // Flush a pending edit only when leaving the page. Depending on live state
  // here makes React invoke the cleanup during ordinary rerenders, launching
  // duplicate saves that can race one another.
  useEffect(
    () => () => {
      if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
      if (saveStateRef.current === 'dirty') void saveNow();
    },
    [saveNow],
  );

  async function commitTitle() {
    if (!wf || titleDraft.trim() === wf.title) {
      setTitleEditing(false);
      return;
    }
    const next = titleDraft.trim() || wf.title;
    setWf({ ...wf, title: next });
    setTitleEditing(false);
    await saveNow(undefined, next);
  }

  async function handleSaveWorkflow(fields: {
    title: string;
    description: string | null;
    spaceId: string | null;
  }) {
    if (!wf) return;
    try {
      await api(`/v1/workflows/${wf.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          title: fields.title,
          description: fields.description,
          spaceId: fields.spaceId,
        }),
      });
      const nextWorkflow = {
        ...wf,
        title: fields.title,
        description: fields.description,
        spaceId: fields.spaceId,
      };
      wfRef.current = nextWorkflow;
      setWf(nextWorkflow);
      setTitleDraft(fields.title);
      toast.success('Workflow settings saved');
    } catch (e) {
      toast.error('Failed to save workflow settings', apiErrorMessage(e));
    }
  }

  async function runWorkflow(inputs: Record<string, unknown>) {
    if (!wf) return;
    setRunning(true);
    try {
      const res = await api<{ runId: string }>(`/v1/workflows/${wf.id}/run`, {
        method: 'POST',
        body: JSON.stringify({ inputs }),
      });
      setActiveRunId(res.runId);
      setDrawerOpen(true);
      setRunDialogOpen(false);
      setTab('canvas');
      toast.success('Run started');
      // §Run Button Behavior: stay on the canvas with the live RunDrawer.
      // When RUN_COMPLETED/RUN_FAILED arrives, the realtime listener closes
      // the drawer and switches to the Output tab — no page hop.
    } catch (e) {
      toast.error('Failed to start run', apiErrorMessage(e));
    } finally {
      setRunning(false);
    }
  }

  function openFirstIncompleteNode(): boolean {
    const broken = flowNodes.find(
      (node) => (node.data as { pendingConfig?: boolean } | undefined)?.pendingConfig,
    );
    if (!broken) return false;
    const workflowNode = wf?.graph.nodes.find((node) => node.id === broken.id);
    const nodeData = broken.data as { type?: string; readinessMessage?: string };
    setSelection({
      kind: 'node',
      nodeId: broken.id,
      nodeType: nodeData.type,
      data: workflowNode?.config ?? (broken.data as Record<string, unknown>),
      title: workflowNode?.title ?? (broken.data as { label?: string }).label,
    });
    setInspectorOpen(true);
    toast.error('Node needs configuration', nodeData.readinessMessage ?? 'Complete the highlighted node before continuing.');
    return true;
  }

  async function refreshDeployment() {
    if (!wf) return;
    setDeploymentLoading(true);
    setDeploymentError(null);
    try {
      const result = await api<{ deployment: WorkflowDeployment | null }>(
        `/v1/workflows/${wf.id}/deployment`,
      );
      setDeployment(result.deployment);
    } catch (error) {
      setDeploymentError(apiErrorMessage(error));
    } finally {
      setDeploymentLoading(false);
    }
  }

  async function handlePublish() {
    if (!wf) return;
    if (openFirstIncompleteNode()) {
      setPublishOpen(false);
      return;
    }
    setDeploymentBusy(true);
    setDeploymentError(null);
    try {
      await saveNow();
      const result = await api<{ deployment: WorkflowDeployment }>(`/v1/workflows/${wf.id}/publish`, {
        method: 'POST',
        body: JSON.stringify({}),
      });
      setDeployment(result.deployment);
      const refreshed = await api<{ workflow: WorkflowDetail }>(`/v1/workflows/${wf.id}`);
      hydratedIdRef.current = null;
      wfRef.current = refreshed.workflow;
      setWf(refreshed.workflow);
      setTitleDraft(refreshed.workflow.title);
      lastSavedFingerprintRef.current = graphFingerprint(refreshed.workflow.graph, refreshed.workflow.title);
      toast.success(deploymentSuccessMessage(result.deployment.triggerType));
    } catch (e) {
      const message = apiErrorMessage(e);
      setDeploymentError(message);
      toast.error('Publish failed', message);
    } finally {
      setDeploymentBusy(false);
    }
  }

  async function setDeploymentStatus(status: 'active' | 'paused') {
    if (!wf) return;
    setDeploymentBusy(true);
    setDeploymentError(null);
    try {
      const result = await api<{ deployment: WorkflowDeployment }>(
        `/v1/workflows/${wf.id}/deployment`,
        { method: 'PATCH', body: JSON.stringify({ status }) },
      );
      setDeployment(result.deployment);
      toast.success(status === 'active' ? 'Automation resumed' : 'Automation paused');
    } catch (error) {
      const message = apiErrorMessage(error);
      setDeploymentError(message);
      toast.error('Deployment update failed', message);
    } finally {
      setDeploymentBusy(false);
    }
  }

  if (!wf) return <div className="p-6 text-[13px] text-text-muted">Loading workflow…</div>;

  return (
    <div className="flex h-full flex-col">
      {/* Header — breadcrumb, title, save state, view switcher */}
      <div className="flex shrink-0 items-center gap-2 border-b border-line bg-surface px-4 py-2.5">
        <button
          onClick={() => nav('/workflows')}
          className="inline-flex items-center gap-1 text-[12px] text-text-muted transition-colors hover:text-text-primary"
        >
          <ArrowLeft size={12} /> Workflows
        </button>
        <div className="mx-2 h-4 w-px bg-line" />
        {titleEditing ? (
          <input
            autoFocus
            type="text"
            value={titleDraft}
            onChange={(e) => setTitleDraft(e.target.value)}
            onBlur={commitTitle}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void commitTitle();
              if (e.key === 'Escape') {
                setTitleDraft(wf.title);
                setTitleEditing(false);
              }
            }}
            className="h-7 rounded-md border border-line bg-surface-2 px-2 text-[13px] font-medium text-text-primary focus:border-accent focus:outline-none"
          />
        ) : (
          <button
            onClick={() => setTitleEditing(true)}
            className="rounded-md px-1.5 py-0.5 text-[13px] font-medium text-text-primary hover:bg-surface-2"
          >
            {wf.title}
          </button>
        )}
        <SaveIndicator state={saveState} />

        <div className="ml-auto flex items-center">
          <SegmentedControl
            segments={WORKFLOW_TAB_SEGMENTS}
            value={tab}
            onChange={setTab}
            size="sm"
            className="whitespace-nowrap"
          />
        </div>
      </div>

      {/* Tool row — canvas tools, run, and publish actions */}
      <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5 border-b border-line bg-surface px-4 py-2">
        <button
          type="button"
          onClick={() => setShowMinimap((v) => !v)}
          className={clsx(
            'inline-flex h-9 items-center gap-1.5 rounded-btn border border-line bg-surface-2 px-2.5 text-[12px] font-medium transition-colors hover:bg-surface-3',
            showMinimap ? 'text-accent' : 'text-text-muted hover:text-text-primary',
          )}
          title="Toggle minimap"
        >
          {showMinimap ? <MapPinOff size={12} /> : <MapIcon size={12} />}
          Minimap
        </button>
        <button
          type="button"
          onClick={handleTidy}
          className="inline-flex h-9 items-center gap-1.5 rounded-btn border border-line bg-surface-2 px-2.5 text-[12px] font-medium text-text-muted transition-colors hover:bg-surface-3 hover:text-text-primary"
          title="Auto-arrange the graph left-to-right and fit it to view"
        >
          <LayoutGrid size={12} />
          Tidy
        </button>
        <Button
          variant="secondary"
          size="sm"
          iconLeft={<Variable size={12} />}
          onClick={() => setVariablesOpen(true)}
        >
          Inputs
        </Button>
        {(() => {
          const pending = flowNodes.filter(
            (n) => (n.data as { pendingConfig?: boolean } | undefined)?.pendingConfig,
          ).length;
          if (pending === 0) return null;
          return (
            <button
              type="button"
              onClick={() => openFirstIncompleteNode()}
              className="inline-flex h-9 items-center gap-1.5 rounded-btn border border-warn/50 bg-warn/10 px-2.5 text-[12px] font-medium text-warn"
              title="Open the first node that needs setup"
            >
              <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-warn" />
              {pending} {pending === 1 ? 'node needs' : 'nodes need'} setup
            </button>
          );
        })()}
        <Button
          variant="secondary"
          size="sm"
          iconLeft={<BarChart3 size={12} />}
          onClick={async () => {
            setAnalyticsOpen(true);
            setAnalyticsLoading(true);
            try {
              setAnalytics(await api<WorkflowAnalytics>(`/v1/workflows/${wf.id}/analytics`));
            } catch (err) {
              toast.error('Analytics failed', apiErrorMessage(err));
            } finally {
              setAnalyticsLoading(false);
            }
          }}
        >
          Analytics
        </Button>
        <Button
          variant="secondary"
          size="sm"
          iconLeft={<Play size={12} />}
          onClick={() => {
            if (openFirstIncompleteNode()) return;
            setRunDialogOpen(true);
          }}
          disabled={running}
        >
          Test run
        </Button>

        {/* More options menu (⋯) */}
        <div className="relative">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setOverflowOpen((v) => !v);
            }}
            className={clsx(
              'inline-flex h-9 w-9 items-center justify-center rounded-btn border border-line bg-surface-2 text-text-secondary transition-colors hover:bg-surface-3 hover:text-text-primary',
              overflowOpen && 'bg-surface-3 text-text-primary border-line-strong',
            )}
            title="More options"
          >
            <MoreHorizontal size={16} />
          </button>
          {overflowOpen && (
            <div className="absolute right-0 z-50 mt-1.5 w-64 rounded-card border border-line bg-surface shadow-dropdown py-1">
              <MenuOption
                icon={<Settings size={14} />}
                title="Workflow settings"
                desc="Edit title, domain, and description"
                onClick={() => {
                  setOverflowOpen(false);
                  setSettingsOpen(true);
                }}
              />

              <MenuOption
                icon={<FileSignature size={14} />}
                title="I/O Contracts"
                desc="Declare inputs and outputs"
                onClick={() => setContractsOpen(true)}
              />
              <MenuOption
                icon={<GitBranch size={14} />}
                title="Event chains"
                desc="Manage event-driven subscriptions"
                onClick={() => setChainsOpen(true)}
              />
            </div>
          )}
        </div>

        {/* Publish dropdown */}
        <div className="relative">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setPublishOpen((v) => !v);
            }}
            className="inline-flex h-9 items-center gap-1.5 rounded-btn bg-accent px-3 text-[13px] font-semibold text-canvas hover:bg-accent-hover"
          >
            <Upload size={12} /> Publish <ChevronDown size={12} />
          </button>
          {publishOpen && (
            <div
              className="absolute right-0 z-50 mt-1.5 w-[340px] overflow-hidden rounded-card border border-line bg-surface shadow-dropdown"
              onClick={(event) => event.stopPropagation()}
            >
              <DeploymentPanel
                trigger={workflowTriggerConfig(wf)}
                deployment={deployment}
                loading={deploymentLoading}
                busy={deploymentBusy}
                error={deploymentError}
                onPublish={() => void handlePublish()}
                onRefresh={() => void refreshDeployment()}
                onPause={() => void setDeploymentStatus('paused')}
                onResume={() => void setDeploymentStatus('active')}
                onCopy={(value, label) => {
                  void navigator.clipboard.writeText(value).then(() => toast.success(`${label} copied`));
                }}
              />
            </div>
          )}
        </div>
      </div>

      {/* Canvas + side panels — kept mounted across tab switches so React
          Flow state and the agent-focus overlay survive. */}
      <div className={clsx('flex min-h-0 flex-1 overflow-hidden', tab !== 'canvas' && 'hidden')}>
        <NodePalette />
        <div ref={overlayHostRef} className="relative min-h-0 flex-1">
          <CanvasEngine
            nodes={flowNodes}
            edges={flowEdges}
            fitView
            fitViewOptions={{ padding: 0.18, minZoom: 0.2, maxZoom: 1 }}
            minZoom={0.12}
            maxZoom={1.75}
            minimapNodeColor={(n) => nodeKindColor((n.data as { kind?: string } | undefined)?.kind)}
            onReady={(instance) => { flowInstanceRef.current = instance; }}
            nodeTypes={{ agentis: AgentisNode }}
            edgeTypes={edgeTypes}
            dropEffect="copy"
            onDropCanvas={(e, pos) => {
              const raw = e.dataTransfer.getData('application/x-agentis-node');
              if (!raw || !wf) return;
              let nodeType: string;
              let extra: Record<string, unknown> = {};
              try {
                const parsed = JSON.parse(raw) as { type: string; [k: string]: unknown };
                nodeType = parsed.type;
                extra = parsed;
              } catch {
                nodeType = raw;
                extra = {};
              }
              const newId = `${nodeType}-${Date.now().toString(36)}`;
              const label = (extra.label as string | undefined) ?? nodeType.replace(/_/g, ' ');
              setFlowNodes((nds) => [
                ...nds,
                {
                  id: newId,
                  type: 'agentis',
                  position: pos,
                  data: {
                    label,
                    kind: nodeType,
                    type: nodeType,
                    ...extra,
                    ...readinessNodeData({ kind: nodeType, ...extra }, integrations),
                  },
                },
              ]);
              setWf((prev) => {
                if (!prev) return prev;
                return {
                  ...prev,
                  graph: {
                    ...prev.graph,
                    nodes: [
                      ...prev.graph.nodes,
                      {
                        id: newId,
                        type: nodeType,
                        title: label,
                        position: pos,
                        config: { kind: nodeType, ...extra },
                      },
                    ],
                  },
                };
              });
              queueSave();
            }}
            onNodeClick={(_, n) => {
              const wfNode = wf?.graph.nodes.find((wn) => wn.id === n.id);
              setSelection({
                kind: 'node',
                nodeId: n.id,
                nodeType: (n.data as { type?: string }).type,
                data: wfNode?.config ?? (n.data as Record<string, unknown>),
                title: wfNode?.title ?? (n.data as { label?: string }).label,
              });
              setInspectorOpen(true);
            }}
            onNodeContextMenu={(e, n) => {
              e.preventDefault();
              e.stopPropagation();
              setContextMenu({ x: e.clientX, y: e.clientY, nodeId: n.id });
            }}
            onNodeDragStop={() => queueSave()}
            onNodesDelete={queueSave}
            onEdgesDelete={queueSave}
            onPaneClick={() => {
              setSelection({ kind: null });
              setContextMenu(null);
            }}
            onNodesChange={onFlowNodesChange}
            onEdgesChange={onFlowEdgesChange}
            onConnect={handleConnect}
            nodesDraggable
            nodesConnectable
            elementsSelectable
            deleteKeyCode={['Delete', 'Backspace']}
            multiSelectionKeyCode={['Meta', 'Control']}
            showMinimap={showMinimap}
            minimapPosition="bottom-left"
            backgroundGap={20}
            backgroundColor="var(--color-canvas-grid)"
          >
            {wf && Array.isArray((wf.graph as unknown as { phases?: unknown }).phases) && (
              <PhaseLayer
                phases={
                  (
                    wf.graph as unknown as {
                      phases: Array<{ id: string; name: string; color: string; nodeIds: string[] }>;
                    }
                  ).phases
                }
                nodes={flowNodes.map((n) => ({ id: n.id, position: n.position }))}
              />
            )}
          </CanvasEngine>
          <div className="pointer-events-none absolute inset-x-4 top-4 z-40 flex flex-col gap-3 xl:flex-row xl:items-start xl:justify-between">
            <div className="flex min-w-0 flex-1 justify-start">
              <WorkflowLintPanel
                workflowId={wf.id}
                revision={graphFingerprint(wf.graph, wf.title)}
                onFocusNode={focusMonitorNode}
              />
            </div>
            <div className="ml-auto flex w-full max-w-[380px] flex-col items-stretch gap-3">
              <WorkflowMonitorCard
                workflowId={wf.id}
                workflowTitle={wf.title}
                activeRunId={activeRunId}
                nodeTitles={monitorNodeTitles}
                onFocusNode={focusMonitorNode}
                onOpenRun={() => setDrawerOpen(true)}
              />
              {hasKnowledgeNode && (knowledgeBaseCount === 0 || knowledgeChunkCount === 0) && (
                <KnowledgeCanvasCallout onOpen={() => nav('/brain')} />
              )}
            </div>
          </div>
          <RunDrawer runId={activeRunId} open={drawerOpen} onClose={() => setDrawerOpen(false)} />
          {contextMenu && (
            <div
              className="fixed z-50 min-w-[160px] overflow-hidden rounded-card border border-line bg-surface shadow-dropdown"
              style={{ left: contextMenu.x, top: contextMenu.y }}
              onClick={(e) => e.stopPropagation()}
            >
              <button
                type="button"
                onClick={() => duplicateNode(contextMenu.nodeId)}
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-[12px] text-text-secondary hover:bg-surface-2 hover:text-text-primary"
              >
                <Copy size={12} /> Duplicate
              </button>
              <button
                type="button"
                onClick={() => deleteNodeById(contextMenu.nodeId)}
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-[12px] text-danger hover:bg-danger-soft"
              >
                <Trash2 size={12} /> Delete
              </button>
            </div>
          )}
        </div>
        {inspectorOpen && (
          <ContextInspector
            selection={selection}
            workflowId={wf?.id ?? null}
            activeRunId={activeRunId}
            onOpenRun={(runId) => { setActiveRunId(runId); setDrawerOpen(true); }}
            upstream={
              wf
                ? wf.graph.nodes
                    .filter((n) => n.id !== selection.nodeId)
                    .map((n) => {
                      const cfg = (n.config ?? {}) as {
                        kind?: string;
                        outputKey?: string;
                        outputKeys?: string[];
                      };
                      return {
                        id: n.id,
                        title: n.title,
                        type: cfg.kind ?? n.type,
                        outputKeys: Array.isArray(cfg.outputKeys)
                          ? cfg.outputKeys
                          : cfg.outputKey
                            ? [cfg.outputKey]
                            : [],
                      };
                    })
                : []
            }
            onClose={() => setInspectorOpen(false)}
            onSave={(data) => {
              const current = wfRef.current;
              if (!current || !selection.nodeId) return;
              const nextNodes = current.graph.nodes.map((n) =>
                n.id === selection.nodeId ? { ...n, config: { ...n.config, ...data } } : n,
              );
              const nextGraph = { ...current.graph, nodes: nextNodes };
              const nextWorkflow = { ...current, graph: nextGraph };
              wfRef.current = nextWorkflow;
              setWf(nextWorkflow);
              setSelection((s) => ({ ...s, data }));
              // Keep the canvas node's pending-config state (amber ring) in sync
              // with the edited config without a full re-hydration.
              const savedNode = nextNodes.find((n) => n.id === selection.nodeId);
              if (savedNode) {
                setFlowNodes((nds) =>
                  nds.map((n) =>
                    n.id === selection.nodeId
                      ? {
                          ...n,
                          data: {
                            ...(n.data ?? {}),
                            ...readinessNodeData(savedNode.config, integrations),
                            ...agentCapabilityNodeData(savedNode.config, agents),
                          },
                        }
                      : n,
                  ),
                );
              }
              void saveNow(nextGraph);
            }}
            onTitleChange={(title) => {
              const current = wfRef.current;
              if (!current || !selection.nodeId) return;
              const label = title || nodeKindMeta((selection.data as { kind?: string } | undefined)?.kind).label;
              const nextNodes = current.graph.nodes.map((n) =>
                n.id === selection.nodeId ? { ...n, title: label } : n,
              );
              const nextGraph = { ...current.graph, nodes: nextNodes };
              const nextWorkflow = { ...current, graph: nextGraph };
              wfRef.current = nextWorkflow;
              setWf(nextWorkflow);
              setSelection((s) => ({ ...s, title: label }));
              setFlowNodes((nds) =>
                nds.map((n) => (n.id === selection.nodeId ? { ...n, data: { ...(n.data ?? {}), label } } : n)),
              );
              void saveNow(nextGraph);
            }}
          />
        )}
      </div>

      {analyticsOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-canvas/60 backdrop-blur-sm"
          onClick={() => setAnalyticsOpen(false)}
        >
          <div
            className="flex max-h-[80vh] w-[560px] flex-col overflow-hidden rounded-card border border-line bg-surface shadow-lg"
            onClick={(e) => e.stopPropagation()}
          >
            <header className="flex items-center justify-between border-b border-line px-3 py-2.5">
              <div>
                <div className="text-[10px] uppercase tracking-wider text-text-muted">Workflow</div>
                <div className="text-subheading text-text-primary">Analytics</div>
              </div>
              <button
                type="button"
                onClick={() => setAnalyticsOpen(false)}
                className="rounded p-1 text-text-muted hover:text-accent"
                aria-label="Close"
              >
                ×
              </button>
            </header>
            <div className="overflow-y-auto p-3">
              {analyticsLoading || !analytics ? (
                <div className="py-8 text-center text-[12px] text-text-muted">
                  {analyticsLoading ? 'Loading…' : 'No data'}
                </div>
              ) : (
                <div className="flex flex-col gap-3">
                  <div className="grid grid-cols-3 gap-2">
                    <Stat label="Runs" value={String(analytics.runs)} />
                    <Stat
                      label="Success"
                      value={
                        analytics.successRate == null
                          ? '—'
                          : `${Math.round(analytics.successRate * 100)}%`
                      }
                    />
                    <Stat
                      label="Avg cost"
                      value={`$${(analytics.avgCostCents / 100).toFixed(3)}`}
                    />
                    <Stat
                      label="Total cost"
                      value={`$${(analytics.totalCostCents / 100).toFixed(2)}`}
                    />
                    <Stat
                      label="Avg duration"
                      value={
                        analytics.avgDurationMs == null
                          ? '—'
                          : `${(analytics.avgDurationMs / 1000).toFixed(1)}s`
                      }
                    />
                  </div>
                  {Object.keys(analytics.byStatus).length > 0 && (
                    <DashboardViewer
                      spec={{
                        title: 'Runs by status',
                        series: Object.entries(analytics.byStatus).map(([label, value]) => ({
                          label,
                          value,
                        })),
                      }}
                    />
                  )}
                  {analytics.nodeFailures.length > 0 && (
                    <DashboardViewer
                      spec={{
                        title: 'Failures by node',
                        series: analytics.nodeFailures.map((n) => ({
                          label: n.title,
                          value: n.failures,
                        })),
                      }}
                    />
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {chainsOpen && wf && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-canvas/60 backdrop-blur-sm"
          onClick={() => setChainsOpen(false)}
        >
          <div
            className="flex h-[640px] w-[560px] flex-col overflow-hidden rounded-card border border-line bg-surface shadow-lg"
            onClick={(e) => e.stopPropagation()}
          >
            <header className="flex items-center justify-between border-b border-line px-3 py-2.5">
              <div>
                <div className="text-[10px] uppercase tracking-wider text-text-muted">Workflow</div>
                <div className="text-subheading text-text-primary">Event Chains</div>
              </div>
              <button
                type="button"
                onClick={() => setChainsOpen(false)}
                className="rounded p-1 text-text-muted hover:text-accent"
                aria-label="Close"
              >
                ×
              </button>
            </header>
            <div className="flex-1 overflow-hidden px-3 py-3">
              <EventChainsPanel workflowId={wf.id} />
            </div>
          </div>
        </div>
      )}

      {contractsOpen && wf && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-canvas/60 backdrop-blur-sm"
          onClick={() => setContractsOpen(false)}
        >
          <div
            className="flex h-[640px] w-[560px] flex-col overflow-hidden rounded-card border border-line bg-surface shadow-lg"
            onClick={(e) => e.stopPropagation()}
          >
            <header className="flex items-center justify-between border-b border-line px-3 py-2.5">
              <div>
                <div className="text-[10px] uppercase tracking-wider text-text-muted">Workflow</div>
                <div className="text-subheading text-text-primary">Contracts</div>
              </div>
              <button
                type="button"
                onClick={() => setContractsOpen(false)}
                className="rounded p-1 text-text-muted hover:text-accent"
                aria-label="Close"
              >
                ×
              </button>
            </header>
            <div className="flex-1 overflow-hidden px-3 py-3">
              <WorkflowContractsPanel
                inputContract={
                  (wf.graph as { inputContract?: WorkflowContractValue }).inputContract
                }
                outputContract={
                  (wf.graph as { outputContract?: WorkflowContractValue }).outputContract
                }
                onChange={({ inputContract, outputContract }) => {
                  const nextGraph = {
                    ...wf.graph,
                    inputContract,
                    outputContract,
                  };
                  setWf({ ...wf, graph: nextGraph });
                  queueSave();
                }}
              />
            </div>
          </div>
        </div>
      )}

      <NodeCommandPalette
        open={commandPaletteOpen}
        onClose={() => setCommandPaletteOpen(false)}
        subflows={reusableWorkflows}
        extensions={extensions}
        integrations={integrations}
        onPick={(nodeType, defaults) => {
          if (!wf) return;
          // Drop the picked node at the center of the canvas's logical
          // viewport. Cleaner than guessing screen coords from Cmd+K.
          const center = { x: 240, y: 160 };
          const newId = `${nodeType}-${Date.now().toString(36)}`;
          const label = (defaults?.label as string | undefined) ?? nodeType.replace(/_/g, ' ');
          setFlowNodes((nds) => [
            ...nds,
            {
              id: newId,
              type: 'agentis',
              position: center,
              data: { label, kind: nodeType, type: nodeType, ...(defaults ?? {}) },
            },
          ]);
          setWf(
            (prev) =>
              prev && {
                ...prev,
                graph: {
                  ...prev.graph,
                  nodes: [
                    ...prev.graph.nodes,
                    {
                      id: newId,
                      type: nodeType,
                      title: label,
                      position: center,
                      config: { kind: nodeType, ...(defaults ?? {}) },
                    },
                  ],
                },
              },
          );
          queueSave();
        }}
      />

      {tab === 'runs' && (
        <div className="flex min-h-0 flex-1 flex-col overflow-auto">
          <WorkflowRunsTab workflowId={wf.id} onRun={() => setRunDialogOpen(true)} />
        </div>
      )}
      {tab === 'output' && (
        <div className="flex min-h-0 flex-1 flex-col overflow-auto">
          <WorkflowOutputTab workflowId={wf.id} onRun={() => setRunDialogOpen(true)} />
        </div>
      )}

      <RunInputDialog
        open={runDialogOpen}
        onClose={() => setRunDialogOpen(false)}
        variables={wf.variables ?? []}
        onRun={(inputs) => void runWorkflow(inputs)}
        running={running}
      />

      <WorkflowSettingsDialog
        open={settingsOpen}
        wf={wf}
        spaces={spaces}
        onClose={() => setSettingsOpen(false)}
        onSave={async (fields) => {
          await handleSaveWorkflow(fields);
          setSettingsOpen(false);
        }}
      />

      <VariablesDialog
        open={variablesOpen}
        onClose={() => setVariablesOpen(false)}
        wf={wf}
        onSave={async (vars) => {
          if (!wf) return;
          try {
            await api(`/v1/workflows/${wf.id}`, {
              method: 'PATCH',
              body: JSON.stringify({ variables: vars }),
            });
            setWf({ ...wf, variables: vars });
            toast.success('Inputs saved');
            setVariablesOpen(false);
          } catch (e) {
            toast.error('Failed to save inputs', apiErrorMessage(e));
          }
        }}
      />
    </div>
  );
}

function SaveIndicator({ state }: { state: SaveState }) {
  if (state === 'saved') return <span className="text-[11px] text-text-muted">Saved ·</span>;
  if (state === 'saving') return <span className="text-[11px] text-text-muted">Saving…</span>;
  if (state === 'dirty')
    return (
      <span className="inline-flex items-center gap-1 text-[11px] text-warn">
        <span className="h-1.5 w-1.5 rounded-full bg-warn" /> Unsaved
      </span>
    );
  return (
    <span className="inline-flex items-center gap-1 text-[11px] text-danger">
      <span className="h-1.5 w-1.5 rounded-full bg-danger" /> Save failed
    </span>
  );
}

function graphFingerprint(graph: WorkflowDetail['graph'], title: string): string {
  return JSON.stringify({ title, graph });
}

/**
 * Project the live React Flow node/edge state back into a persistable workflow
 * graph. Node *config* (kind, extensionId, …) lives only in `prevGraph`, so we
 * merge each flow node onto its original config and take position/existence
 * from the flow state. Transient edge `data` such as the `onDelete` handle is
 * intentionally dropped so it never ends up in the persisted payload.
 */
function buildGraphFromFlow(
  prevGraph: WorkflowDetail['graph'],
  nodes: Node[],
  edges: Edge[],
): WorkflowDetail['graph'] {
  const byId = new Map(prevGraph.nodes.map((n) => [n.id, n] as const));
  const nextNodes: WorkflowDetail['graph']['nodes'] = nodes.map((fn) => {
    const orig = byId.get(fn.id);
    if (orig) {
      return { ...orig, position: fn.position };
    }
    // New node that hasn't been mirrored into prev.graph yet — synthesize a
    // minimal node from the flow data as a safety net.
    const data = (fn.data ?? {}) as { type?: string; kind?: string; label?: string };
    return {
      id: fn.id,
      type: data.type ?? 'task',
      title: data.label ?? fn.id,
      position: fn.position,
      config: { kind: data.kind ?? data.type ?? 'task' },
    };
  });
  const nextEdges = edges.map((fe) => {
    const data = (fe.data ?? {}) as {
      type?: 'default' | 'error' | 'condition';
      label?: string;
      condition?: string;
    };
    const e: {
      id: string;
      source: string;
      target: string;
      type?: 'default' | 'error' | 'condition';
      label?: string;
      condition?: string;
    } = {
      id: fe.id,
      source: fe.source,
      target: fe.target,
    };
    if (data.type && data.type !== 'default') e.type = data.type;
    if (data.label) e.label = data.label;
    if (data.condition) e.condition = data.condition;
    return e;
  });
  return { ...prevGraph, nodes: nextNodes, edges: nextEdges };
}

function MenuOption({
  icon,
  title,
  desc,
  onClick,
}: {
  icon: React.ReactNode;
  title: string;
  desc: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-start gap-2.5 px-3 py-2.5 text-left transition-colors hover:bg-surface-2 active:scale-[0.99]"
    >
      <span className="mt-0.5 shrink-0 text-text-muted">{icon}</span>
      <span className="min-w-0">
        <span className="block text-[13px] font-medium text-text-primary">{title}</span>
        <span className="block text-[11px] text-text-muted">{desc}</span>
      </span>
    </button>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-line bg-surface-2 px-2.5 py-2">
      <div className="text-[10px] uppercase tracking-wider text-text-muted">{label}</div>
      <div className="mt-0.5 text-[15px] font-semibold text-text-primary">{value}</div>
    </div>
  );
}

function DeploymentPanel({
  trigger,
  deployment,
  loading,
  busy,
  error,
  onPublish,
  onRefresh,
  onPause,
  onResume,
  onCopy,
}: {
  trigger: Record<string, unknown> | null;
  deployment: WorkflowDeployment | null;
  loading: boolean;
  busy: boolean;
  error: string | null;
  onPublish: () => void;
  onRefresh: () => void;
  onPause: () => void;
  onResume: () => void;
  onCopy: (value: string, label: string) => void;
}) {
  const triggerType = String(trigger?.triggerType ?? 'manual');
  const readiness = trigger ? evaluateNodeReadiness(trigger) : { ready: false, message: 'Add a trigger node.' };
  const meta = deploymentMeta(triggerType);
  const changed = Boolean(deployment && deploymentDiffersFromDraft(deployment, trigger));

  if (triggerType === 'manual') {
    return (
      <div className="p-3.5">
        <div className="flex items-start gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-line bg-surface-2 text-text-muted">
            <Play size={15} />
          </span>
          <div>
            <div className="text-[13px] font-semibold text-text-primary">Manual workflow</div>
            <p className="mt-0.5 text-[11px] leading-4 text-text-muted">
              This workflow runs from the Run button. Choose Schedule, Webhook, or Persistent listener on the trigger node to deploy it.
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="border-b border-line px-3.5 py-3">
        <div className="flex items-start gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-accent/25 bg-accent-soft text-accent">
            {meta.icon}
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="truncate text-[13px] font-semibold text-text-primary">{meta.title}</span>
              {deployment && (
                <span className={clsx(
                  'inline-flex items-center gap-1 rounded-pill border px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider',
                  deployment.status === 'active'
                    ? 'border-success/30 bg-success-soft text-success'
                    : deployment.status === 'error'
                      ? 'border-danger/30 bg-danger-soft text-danger'
                      : 'border-line bg-surface-2 text-text-muted',
                )}>
                  <span className={clsx(
                    'h-1.5 w-1.5 rounded-full',
                    deployment.status === 'active'
                      ? 'bg-success'
                      : deployment.status === 'error'
                        ? 'bg-danger'
                        : 'bg-text-muted',
                  )} />
                  {deployment.status}
                </span>
              )}
            </div>
            <p className="mt-0.5 text-[11px] leading-4 text-text-muted">{meta.description}</p>
          </div>
          <button
            type="button"
            onClick={onRefresh}
            disabled={loading}
            className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded text-text-muted transition hover:bg-surface-2 hover:text-text-primary active:scale-[0.96] disabled:opacity-50"
            aria-label="Refresh deployment status"
            title="Refresh deployment status"
          >
            <RefreshCw size={12} className={loading ? 'animate-spin' : undefined} />
          </button>
        </div>
      </div>

      <div className="space-y-3 px-3.5 py-3">
        {loading && !deployment ? (
          <div className="space-y-2" aria-label="Loading deployment">
            <div className="h-3 w-2/3 animate-pulse rounded bg-surface-3" />
            <div className="h-8 animate-pulse rounded bg-surface-2" />
          </div>
        ) : (
          <>
            {!readiness.ready && (
              <div className="rounded-input border border-warn/35 bg-warn/10 px-2.5 py-2 text-[11px] leading-4 text-warn">
                {readiness.message}
              </div>
            )}
            {changed && (
              <div className="rounded-input border border-accent/25 bg-accent-soft px-2.5 py-2 text-[11px] leading-4 text-text-secondary">
                The canvas trigger changed after the last deployment. Publish again to apply the draft.
              </div>
            )}
            {error && (
              <div className="rounded-input border border-danger/30 bg-danger-soft px-2.5 py-2 text-[11px] leading-4 text-danger">
                {error}
              </div>
            )}

            {deployment?.triggerType === 'cron' && (
              <DeploymentValue
                label="Schedule"
                value={`${String(deployment.config.expression ?? '')} · ${String(deployment.config.timezone ?? 'UTC')}`}
              />
            )}
            {deployment?.triggerType === 'webhook' && deployment.webhookUrl && (
              <DeploymentValue
                label="Webhook URL"
                value={deployment.webhookUrl}
                onCopy={() => onCopy(deployment.webhookUrl!, 'Webhook URL')}
              />
            )}
            {deployment?.webhookSecret && (
              <div className="rounded-input border border-warn/30 bg-warn/10 p-2.5">
                <div className="text-[9px] font-semibold uppercase tracking-wider text-warn">Secret shown once</div>
                <div className="mt-1 flex items-center gap-2">
                  <code className="min-w-0 flex-1 truncate text-[10px] text-text-primary">{deployment.webhookSecret}</code>
                  <button type="button" onClick={() => onCopy(deployment.webhookSecret!, 'Webhook secret')} className="text-text-muted hover:text-text-primary">
                    <Copy size={12} />
                  </button>
                </div>
              </div>
            )}
            {deployment?.triggerType === 'persistent_listener' && deployment.health && (
              <div className="grid grid-cols-3 divide-x divide-line rounded-input border border-line bg-surface-2">
                <MiniMetric
                  label="Connection"
                  value={
                    deployment.status === 'paused'
                      ? 'Paused'
                      : deployment.status === 'error'
                        ? 'Offline'
                        : deployment.health.status === 'error'
                          ? 'Error'
                        : deployment.health.connected
                          ? 'Live'
                          : 'Starting'
                  }
                />
                <MiniMetric label="Events" value={String(deployment.health.eventCount ?? 0)} />
                <MiniMetric label="Runs" value={String(deployment.health.fireCount ?? 0)} />
              </div>
            )}
            {deployment?.triggerType === 'persistent_listener' && deployment.health?.lastError && (
              <p className="text-[10px] leading-relaxed text-danger" role="alert">
                {deployment.health.lastError}
              </p>
            )}

            <div className="flex items-center gap-2">
              {(!deployment || deployment.status === 'error' || changed) && (
                <Button
                  variant="primary"
                  size="sm"
                  className="flex-1"
                  loading={busy}
                  disabled={!readiness.ready}
                  iconLeft={<Power size={13} />}
                  onClick={onPublish}
                >
                  {deployment ? 'Apply and activate' : meta.action}
                </Button>
              )}
              {deployment?.status === 'paused' && !changed && (
                <Button
                  variant="primary"
                  size="sm"
                  className="flex-1"
                  loading={busy}
                  iconLeft={<Power size={13} />}
                  onClick={onResume}
                >
                  Resume
                </Button>
              )}
              {deployment?.status === 'active' && !changed && (
                <>
                  <Button
                    variant="secondary"
                    size="sm"
                    className="flex-1"
                    loading={busy}
                    iconLeft={<Pause size={13} />}
                    onClick={onPause}
                  >
                    Pause
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    onClick={onPublish}
                  >
                    Redeploy
                  </Button>
                </>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function DeploymentValue({
  label,
  value,
  onCopy,
}: {
  label: string;
  value: string;
  onCopy?: () => void;
}) {
  return (
    <div>
      <div className="mb-1 text-[9px] font-semibold uppercase tracking-wider text-text-muted">{label}</div>
      <div className="flex items-center gap-2 rounded-input border border-line bg-canvas px-2.5 py-2">
        <code className="min-w-0 flex-1 truncate text-[10px] text-text-secondary">{value}</code>
        {onCopy && (
          <button type="button" onClick={onCopy} className="shrink-0 text-text-muted hover:text-text-primary" aria-label={`Copy ${label}`}>
            <Copy size={12} />
          </button>
        )}
      </div>
    </div>
  );
}

function MiniMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="px-2 py-2 text-center">
      <div className="font-mono text-[12px] font-semibold text-text-primary">{value}</div>
      <div className="mt-0.5 text-[9px] uppercase tracking-wider text-text-muted">{label}</div>
    </div>
  );
}

function workflowTriggerConfig(workflow: WorkflowDetail): Record<string, unknown> | null {
  const trigger = workflow.graph.nodes.find((node) => node.config.kind === 'trigger');
  return trigger?.config ?? null;
}

function deploymentMeta(triggerType: string): {
  title: string;
  description: string;
  action: string;
  icon: React.ReactNode;
} {
  if (triggerType === 'cron') {
    return {
      title: 'Scheduled automation',
      description: 'Agentis keeps the cron job active and restores it after a restart.',
      action: 'Activate schedule',
      icon: <ClockIcon size={15} />,
    };
  }
  if (triggerType === 'webhook') {
    return {
      title: 'Webhook endpoint',
      description: 'Accept signed inbound HTTP events and start one workflow run per delivery.',
      action: 'Create endpoint',
      icon: <Webhook size={15} />,
    };
  }
  return {
    title: 'Persistent listener',
    description: 'Keep a source connected 24/7 and start runs as matching events arrive.',
    action: 'Activate listener',
    icon: <RadioTower size={15} />,
  };
}

function deploymentDiffersFromDraft(
  deployment: WorkflowDeployment,
  trigger: Record<string, unknown> | null,
): boolean {
  const triggerType = String(trigger?.triggerType ?? 'manual');
  if (deployment.triggerType !== triggerType) return true;
  if (triggerType === 'cron') {
    return String(trigger?.schedule ?? '').trim() !== String(deployment.config.expression ?? '').trim()
      || String(trigger?.timezone ?? 'UTC').trim() !== String(deployment.config.timezone ?? 'UTC').trim();
  }
  if (triggerType === 'persistent_listener') {
    return JSON.stringify(trigger?.listenerConfig ?? null) !== JSON.stringify(deployment.config);
  }
  return false;
}

function deploymentSuccessMessage(triggerType: WorkflowDeployment['triggerType']): string {
  if (triggerType === 'cron') return 'Schedule activated';
  if (triggerType === 'webhook') return 'Webhook endpoint activated';
  return 'Persistent listener activated';
}

function RunInputDialog({
  open,
  onClose,
  variables,
  onRun,
  running,
}: {
  open: boolean;
  onClose: () => void;
  variables: Array<{ name: string; type: string; default?: unknown; label?: string }>;
  onRun: (inputs: Record<string, unknown>) => void;
  running: boolean;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  useEffect(() => {
    if (open) {
      const init: Record<string, string> = {};
      variables.forEach((v) => {
        init[v.name] = v.default != null ? String(v.default) : '';
      });
      setValues(init);
    }
  }, [open, variables]);

  if (!open) return null;
  return (
    <div
      className="animate-fade-in fixed inset-0 z-[60] flex items-center justify-center bg-overlay p-4"
      role="dialog"
      aria-modal="true"
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onRun(values);
        }}
        className="animate-scale-in w-full max-w-md rounded-modal border border-line bg-surface shadow-modal"
      >
        <header className="flex items-center justify-between border-b border-line px-5 py-4">
          <h3 className="text-heading text-text-primary">Run this workflow</h3>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="-m-1 rounded-md p-1 text-text-muted hover:bg-surface-2 hover:text-text-primary"
          >
            <X size={16} />
          </button>
        </header>
        <div className="space-y-4 px-5 py-5">
          {variables.length === 0 ? (
            <p className="text-[13px] text-text-secondary">
              Ready to run — this workflow doesn't need any inputs.
            </p>
          ) : (
            <>
              <p className="text-[13px] text-text-secondary">
                Fill in the inputs below to run this workflow.
              </p>
              {variables.map((v) => {
                const displayLabel =
                  v.label && v.label.trim() ? v.label : humanizeInputName(v.name);
                return (
                  <div key={v.name} className="space-y-1.5">
                    <label className="text-[12px] font-medium text-text-secondary">
                      {displayLabel}
                    </label>
                    <input
                      type="text"
                      value={values[v.name] ?? ''}
                      onChange={(e) => setValues((s) => ({ ...s, [v.name]: e.target.value }))}
                      placeholder={
                        v.default != null
                          ? String(v.default)
                          : `Enter ${displayLabel.toLowerCase()}…`
                      }
                      className="h-9 w-full rounded-input border border-line bg-surface-2 px-3 text-[13px] text-text-primary placeholder:text-text-muted focus:border-accent focus:outline-none"
                    />
                  </div>
                );
              })}
              <p className="text-[11px] text-text-muted">Leave blank to use defaults.</p>
            </>
          )}
        </div>
        <footer className="flex items-center justify-end gap-2 border-t border-line bg-surface-2 px-5 py-3">
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-9 items-center justify-center rounded-btn border border-line bg-transparent px-3 text-[13px] font-medium text-text-secondary hover:bg-surface-3 hover:text-text-primary"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={running}
            className="inline-flex h-9 items-center gap-1.5 rounded-btn bg-accent px-3 text-[13px] font-semibold text-canvas hover:bg-accent-hover disabled:opacity-60"
          >
            {running ? 'Starting…' : 'Run'}
          </button>
        </footer>
      </form>
    </div>
  );
}

function WorkflowSettingsDialog({
  open,
  wf,
  spaces,
  onClose,
  onSave,
}: {
  open: boolean;
  wf: WorkflowDetail;
  spaces: SpaceSummary[];
  onClose: () => void;
  onSave: (fields: {
    title: string;
    description: string | null;
    spaceId: string | null;
  }) => Promise<void>;
}) {
  const [title, setTitle] = useState(wf.title);
  const [description, setDescription] = useState(wf.description ?? '');
  const [spaceId, setSpaceId] = useState(wf.spaceId ?? '');
  const [saving, setSaving] = useState(false);
  const [showTooltip, setShowTooltip] = useState(false);
  const [isPinned, setIsPinned] = useState(false);

  useEffect(() => {
    if (!open) return;
    setTitle(wf.title);
    setDescription(wf.description ?? '');
    setSpaceId(wf.spaceId ?? '');
    setShowTooltip(false);
    setIsPinned(false);
  }, [open, wf]);

  async function submit(event: { preventDefault: () => void }) {
    event.preventDefault();
    const nextTitle = title.trim() || wf.title;
    setSaving(true);
    try {
      await onSave({
        title: nextTitle,
        description: description.trim() || null,
        spaceId: spaceId || null,
      });
    } finally {
      setSaving(false);
    }
  }

  if (!open) return null;
  return (
    <div
      className="animate-fade-in fixed inset-0 z-[60] flex items-center justify-center bg-overlay p-4"
      role="dialog"
      aria-modal="true"
    >
      <form
        onSubmit={(event) => void submit(event)}
        className="animate-scale-in w-full max-w-xl overflow-hidden rounded-modal border border-line bg-surface shadow-modal"
      >
        <header className="flex items-center justify-between border-b border-line px-5 py-4">
          <div>
            <h3 className="text-heading text-text-primary">Workflow settings</h3>
            <p className="mt-1 text-[12px] text-text-muted">Organize this workflow under the right domain.</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="-m-1 rounded-md p-1 text-text-muted hover:bg-surface-2 hover:text-text-primary"
          >
            <X size={16} />
          </button>
        </header>
        <div className="space-y-4 px-5 py-5">
          <div className="space-y-1.5">
            <label className="text-[12px] font-medium text-text-secondary">Title</label>
            <input
              type="text"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              className="h-10 w-full rounded-input border border-line bg-surface-2 px-3 text-[13px] text-text-primary focus:border-accent focus:outline-none"
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-[12px] font-medium text-text-secondary">Domain</label>
            <select
              value={spaceId}
              onChange={(event) => setSpaceId(event.target.value)}
              className="h-10 w-full rounded-input border border-line bg-surface-2 px-3 text-[13px] text-text-primary focus:border-accent focus:outline-none"
            >
              <option value="">Unassigned</option>
              {spaces.map((space) => (
                <option key={space.id} value={space.id}>
                  {space.name}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1.5">
            <div className="flex items-center gap-1.5">
              <label className="text-[12px] font-medium text-text-secondary">Description</label>
              <div className="relative inline-flex items-center">
                <button
                  type="button"
                  onMouseEnter={() => setShowTooltip(true)}
                  onMouseLeave={() => {
                    if (!isPinned) setShowTooltip(false);
                  }}
                  onClick={() => {
                    if (isPinned) {
                      setIsPinned(false);
                      setShowTooltip(false);
                    } else {
                      setIsPinned(true);
                      setShowTooltip(true);
                    }
                  }}
                  className={clsx(
                    "rounded-full transition-colors focus:outline-none",
                    isPinned ? "text-accent" : "text-text-muted hover:text-accent"
                  )}
                  aria-label="Description info"
                >
                  <AlertCircle size={13} />
                </button>
                {showTooltip && (
                  <div className="absolute bottom-full left-0 z-50 mb-2 w-72 rounded-lg border border-line bg-surface p-3 shadow-modal animate-fade-in text-[11px] leading-relaxed text-text-secondary normal-case font-normal">
                    <div className="font-semibold text-text-primary mb-1">Workflow Description</div>
                    Explain what this workflow accomplishes, the inputs it expects, and the results it produces. This is used for operator reference, package documentation, and cataloging when exposed as an MCP tool.
                    <div className="absolute left-[6px] top-full h-2 w-2 -translate-y-1 bg-surface border-r border-b border-line rotate-45" />
                  </div>
                )}
              </div>
            </div>
            <textarea
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              rows={5}
              className="w-full resize-y rounded-input border border-line bg-surface-2 px-3 py-2.5 text-[13px] leading-relaxed text-text-primary focus:border-accent focus:outline-none"
            />
          </div>
        </div>
        <footer className="flex items-center justify-end gap-2 border-t border-line bg-surface-2 px-5 py-3">
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-9 items-center justify-center rounded-btn border border-line bg-transparent px-3 text-[13px] font-medium text-text-secondary hover:bg-surface-3 hover:text-text-primary"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={saving}
            className="inline-flex h-9 items-center gap-1.5 rounded-btn bg-accent px-3 text-[13px] font-semibold text-canvas hover:bg-accent-hover disabled:opacity-60"
          >
            {saving ? 'Saving...' : 'Save settings'}
          </button>
        </footer>
      </form>
    </div>
  );
}

/** Convert a snake_case or camelCase identifier into a human-readable label. */
function humanizeInputName(name: string): string {
  if (!name) return name;
  // snake_case / kebab-case → spaces
  const spaced = name.replace(/[_-]+/g, ' ');
  // camelCase → spaces
  const split = spaced.replace(/([a-z0-9])([A-Z])/g, '$1 $2');
  // Capitalize first letter, leave the rest as-is so acronyms survive.
  return split.charAt(0).toUpperCase() + split.slice(1);
}

function VariablesDialog({
  open,
  onClose,
  wf,
  onSave,
}: {
  open: boolean;
  onClose: () => void;
  wf: WorkflowDetail;
  onSave: (
    vars: Array<{ name: string; type: string; default?: unknown; label?: string }>,
  ) => Promise<void>;
}) {
  const [vars, setVars] = useState<
    Array<{ name: string; type: string; default?: string; label?: string }>
  >(
    wf.variables?.map((v) => ({ ...v, default: v.default == null ? '' : String(v.default) })) ?? [],
  );

  useEffect(() => {
    if (open) {
      setVars(
        wf.variables?.map((v) => ({ ...v, default: v.default == null ? '' : String(v.default) })) ??
          [],
      );
    }
  }, [open, wf.variables]);

  if (!open) return null;
  return (
    <div
      className="animate-fade-in fixed inset-0 z-[60] flex items-center justify-center bg-overlay p-4"
      role="dialog"
      aria-modal="true"
    >
      <div className="animate-scale-in w-full max-w-2xl rounded-modal border border-line bg-surface shadow-modal">
        <header className="flex items-center justify-between border-b border-line px-5 py-4">
          <div>
            <h3 className="text-heading text-text-primary">Inputs</h3>
            <p className="mt-0.5 text-[12px] text-text-muted">
              Things this workflow asks for when it runs. Give each one a clear label so the run
              prompt makes sense.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="-m-1 rounded-md p-1 text-text-muted hover:bg-surface-2 hover:text-text-primary"
          >
            <X size={16} />
          </button>
        </header>
        <div className="space-y-3 px-5 py-5">
          {vars.length === 0 ? (
            <p className="text-[13px] text-text-muted">
              No inputs yet. Add one if your workflow needs information when it runs (like a company
              name or a URL).
            </p>
          ) : (
            <div className="space-y-2">
              <div className="grid grid-cols-[1fr_1fr_110px_1fr_28px] items-center gap-2 px-1 text-[10px] font-medium uppercase tracking-wider text-text-muted">
                <span>Label</span>
                <span>Key</span>
                <span>Type</span>
                <span>Default</span>
                <span></span>
              </div>
              {vars.map((v, i) => (
                <div key={i} className="grid grid-cols-[1fr_1fr_110px_1fr_28px] items-center gap-2">
                  <input
                    type="text"
                    value={v.label ?? ''}
                    onChange={(e) =>
                      setVars((arr) =>
                        arr.map((x, idx) => (idx === i ? { ...x, label: e.target.value } : x)),
                      )
                    }
                    placeholder="e.g. Company name"
                    className="h-9 rounded-input border border-line bg-surface-2 px-3 text-[13px] text-text-primary focus:border-accent focus:outline-none"
                  />
                  <input
                    type="text"
                    value={v.name}
                    onChange={(e) =>
                      setVars((arr) =>
                        arr.map((x, idx) => (idx === i ? { ...x, name: e.target.value } : x)),
                      )
                    }
                    placeholder="variable_name"
                    className="h-9 rounded-input border border-line bg-surface-2 px-3 font-mono text-[12px] text-text-secondary focus:border-accent focus:outline-none"
                  />
                  <select
                    value={v.type}
                    onChange={(e) =>
                      setVars((arr) =>
                        arr.map((x, idx) => (idx === i ? { ...x, type: e.target.value } : x)),
                      )
                    }
                    className="h-9 rounded-input border border-line bg-surface-2 px-2 text-[13px] text-text-primary focus:border-accent focus:outline-none"
                  >
                    <option value="string">Text</option>
                    <option value="number">Number</option>
                    <option value="boolean">Yes/No</option>
                    <option value="json">JSON</option>
                  </select>
                  <input
                    type="text"
                    value={v.default ?? ''}
                    onChange={(e) =>
                      setVars((arr) =>
                        arr.map((x, idx) => (idx === i ? { ...x, default: e.target.value } : x)),
                      )
                    }
                    placeholder="(optional)"
                    className="h-9 rounded-input border border-line bg-surface-2 px-3 text-[13px] text-text-primary focus:border-accent focus:outline-none"
                  />
                  <button
                    type="button"
                    onClick={() => setVars((arr) => arr.filter((_, idx) => idx !== i))}
                    aria-label="Remove"
                    className="-m-1 rounded-md p-1 text-text-muted hover:text-danger"
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              ))}
            </div>
          )}
          <button
            type="button"
            onClick={() =>
              setVars((arr) => [...arr, { name: '', type: 'string', default: '', label: '' }])
            }
            className="inline-flex h-8 items-center gap-1.5 rounded-btn border border-line bg-surface-2 px-2.5 text-[12px] font-medium text-text-secondary hover:bg-surface-3 hover:text-text-primary"
          >
            + Add input
          </button>
        </div>
        <footer className="flex items-center justify-end gap-2 border-t border-line bg-surface-2 px-5 py-3">
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-9 items-center rounded-btn border border-line bg-transparent px-3 text-[13px] font-medium text-text-secondary hover:bg-surface-3 hover:text-text-primary"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void onSave(vars.filter((v) => v.name.trim()))}
            className="inline-flex h-9 items-center rounded-btn bg-accent px-3 text-[13px] font-semibold text-canvas hover:bg-accent-hover"
          >
            Save
          </button>
        </footer>
      </div>
    </div>
  );
}

type LiveStatus = 'running' | 'completed' | 'failed' | 'retry' | 'waiting';
type LiveExtra = { progress?: { completed?: number; total?: number } };

interface WorkflowAnalytics {
  runs: number;
  byStatus: Record<string, number>;
  successRate: number | null;
  avgDurationMs: number | null;
  avgCostCents: number;
  totalCostCents: number;
  nodeFailures: Array<{ nodeId: string; title: string; failures: number; sampleError: string }>;
}

function readinessNodeData(config: unknown, integrations: readonly IntegrationManifestLite[]) {
  const readiness = evaluateNodeReadiness(config, { integrations });
  return {
    pendingConfig: !readiness.ready,
    readinessMessage: readiness.message ?? undefined,
  };
}

function agentCapabilityNodeData(
  config: { kind?: string; requires?: AgentRequirements } | unknown,
  agents: AgentCapabilityRow[],
): { requiredCapabilities?: string[]; agentMatches?: CanvasAgentMatch[] } {
  const c = config as { kind?: string; requires?: unknown } | null;
  if (!c || (c.kind !== 'agent_task' && c.kind !== 'agent_session')) {
    return { requiredCapabilities: undefined, agentMatches: undefined };
  }
  const requirements = normalizeAgentRequirements(c.requires);
  if (!hasAgentRequirements(requirements)) {
    return { requiredCapabilities: undefined, agentMatches: undefined };
  }
  return {
    requiredCapabilities: requiredAffordanceKeys(requirements).map(affordanceLabel),
    agentMatches: connectedAgentMatches(agents, requirements).map((match) => ({
      id: match.id,
      name: match.name,
      satisfied: match.satisfied,
      missing: match.missing,
    })),
  };
}

function AgentisNode({
  data,
}: {
  data: {
    label: string;
    kind: string;
    type: string;
    operationName?: string;
    toolPreview?: string;
    liveStatus?: LiveStatus;
    liveExtra?: LiveExtra;
    pendingConfig?: boolean;
    readinessMessage?: string;
    requiredCapabilities?: string[];
    agentMatches?: CanvasAgentMatch[];
  };
}) {
  const meta = nodeKindMeta(data.kind);
  const glyph = meta.glyph;
  const railColor = nodeKindColor(data.kind);
  const isTrigger = data.kind === 'trigger';
  const status = data.liveStatus;
  const progress = data.liveExtra?.progress;
  // Border + glow per live state. Idle nodes keep the original look so the
  // canvas doesn't twitch when no run is active. ORCHESTRATOR-CREATION §7:
  // an integration node missing its credential pulses amber (pending-config).
  const stateBorder =
    status === 'running'
      ? 'border-accent shadow-glow animate-pulse'
      : status === 'completed'
        ? 'border-success/60'
        : status === 'failed'
          ? 'border-danger shadow-[0_0_0_1px_var(--color-danger,#ef4444)]'
          : status === 'retry'
            ? 'border-warn border-dashed'
            : status === 'waiting'
              ? 'border-warn'
              : data.pendingConfig
                ? 'border-2 border-warn animate-pulse shadow-[0_0_12px_rgba(245,158,11,0.4)]'
                : isTrigger
                  ? 'border-accent/60 shadow-glow'
                  : 'border-line';
  return (
    <div
      className={clsx(
        'agentis-workflow-node relative flex w-[240px] flex-col gap-1.5 rounded-node border bg-surface-2 px-3 py-3 pl-4 shadow-card transition-colors',
        stateBorder,
      )}
    >
      {/* Category color rail — lets the eye group nodes by family at a glance. */}
      <span
        className="pointer-events-none absolute bottom-2 left-1 top-2 w-1 rounded-full"
        style={{ backgroundColor: railColor }}
        aria-hidden
      />
      {!isTrigger && (
        <Handle
          type="target"
          position={Position.Left}
          className="!h-2 !w-2 !border-line !bg-surface"
        />
      )}
      <Handle
        type="source"
        position={Position.Right}
        className="!h-2 !w-2 !border-line !bg-surface"
      />
      {/* Error handle on the bottom-right for nodes that can have catch
          branches. Visible always so users can wire an error edge to it. */}
      {!isTrigger && (
        <Handle
          type="source"
          position={Position.Bottom}
          id="error"
          style={{ left: 'auto', right: 14 }}
          className="!h-1.5 !w-1.5 !border-danger/60 !bg-surface"
        />
      )}
      <div className="flex items-center gap-2">
        <span
          className={clsx(
            'relative flex h-7 w-7 items-center justify-center rounded-md text-sm',
            isTrigger ? 'bg-accent-soft text-accent' : 'bg-surface text-text-muted',
          )}
        >
          {glyph}
          {status === 'completed' && (
            <span className="absolute -right-1 -top-1 flex h-3 w-3 items-center justify-center rounded-full bg-success text-[8px] text-canvas">
              ✓
            </span>
          )}
          {status === 'failed' && (
            <span className="absolute -right-1 -top-1 flex h-3 w-3 items-center justify-center rounded-full bg-danger text-[8px] text-canvas">
              ×
            </span>
          )}
          {status === 'retry' && (
            <span className="absolute -right-1 -top-1 flex h-3 w-3 items-center justify-center rounded-full bg-warn text-[8px] text-canvas">
              ↻
            </span>
          )}
        </span>
        <div className="min-w-0 leading-tight">
          <div className="truncate text-[13px] text-text-primary">{data.label}</div>
          {data.kind === 'extension_task' && data.operationName && (
            <div className="truncate font-mono text-[10px] text-accent">{data.operationName}</div>
          )}
          <div className="text-[10px] uppercase tracking-wide text-text-muted">{meta.label}</div>
        </div>
      </div>
      {data.pendingConfig && !status && (
        <div className="flex items-start gap-1 text-[10px] font-medium leading-tight text-warn" title={data.readinessMessage}>
          <span className="mt-0.5 inline-block h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-warn" />
          {data.readinessMessage ?? 'Finish setup'}
        </div>
      )}
      {data.toolPreview && (
        <Typewriter text={data.toolPreview} className="text-[10px] text-text-muted" />
      )}
      {data.requiredCapabilities && data.requiredCapabilities.length > 0 && (
        <div className="mt-0.5 space-y-1 rounded-md border border-line/70 bg-canvas/35 p-1.5">
          <div className="flex flex-wrap gap-1">
            {data.requiredCapabilities.map((label) => (
              <span key={label} className="rounded-sm bg-surface px-1.5 py-0.5 text-[9px] text-text-secondary">
                {label}
              </span>
            ))}
          </div>
          <div className="space-y-0.5">
            {(data.agentMatches ?? []).slice(0, 3).map((match) => (
              <div
                key={match.id}
                className={clsx(
                  'flex items-center justify-between gap-1 rounded-sm px-1 py-0.5 text-[9px]',
                  match.satisfied ? 'bg-success-soft text-success' : 'bg-danger-soft text-danger',
                )}
                title={match.satisfied ? 'Satisfies requirements' : `Missing ${match.missing.join(', ')}`}
              >
                <span className="truncate">{match.name}</span>
                <span className="shrink-0">{match.satisfied ? 'ready' : 'missing'}</span>
              </div>
            ))}
            {(data.agentMatches?.length ?? 0) === 0 && (
              <div className="text-[9px] text-warn">No connected agent advertises capabilities</div>
            )}
          </div>
        </div>
      )}
      {progress &&
        typeof progress.total === 'number' &&
        typeof progress.completed === 'number' &&
        progress.total > 0 && (
          <div className="mt-0.5">
            <div className="flex items-center justify-between text-[9px] text-text-muted">
              <span>
                {progress.completed} / {progress.total}
              </span>
            </div>
            <div className="mt-0.5 h-0.5 w-full overflow-hidden rounded-full bg-line">
              <div
                className="h-full bg-accent transition-all duration-300"
                style={{ width: `${Math.min(100, (progress.completed / progress.total) * 100)}%` }}
              />
            </div>
          </div>
        )}
    </div>
  );
}

function KnowledgeCanvasCallout({ onOpen }: { onOpen: () => void }) {
  return (
    <div className="pointer-events-auto w-full max-w-xs self-end rounded-card border border-line bg-surface p-3 shadow-card">
      <div className="flex items-start gap-2">
        <BookOpen size={15} className="mt-0.5 shrink-0 text-accent" />
        <div className="min-w-0">
          <div className="text-[12px] font-medium text-text-primary">Brain node needs content</div>
          <p className="mt-1 text-[11px] leading-relaxed text-text-muted">
            This workflow retrieves from the Brain, but it has no indexed content yet. Add documents
            so the node has something to return.
          </p>
          <button
            type="button"
            onClick={onOpen}
            className="mt-2 text-[11px] font-medium text-accent hover:text-accent-hover"
          >
            Open Brain
          </button>
        </div>
      </div>
    </div>
  );
}
