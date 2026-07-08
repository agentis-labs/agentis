/**
 * WorkflowCanvasPage — visual workflow editor.
 *
 * Phase-first workflow editor:
 *   - Slim workflow header with title, transient save feedback, Engine, and Activate
 *   - Canvas-owned controls for tidy, fit view, zoom, and situational minimap
 *   - Operations card for run activity, health, and analytics
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import {
  REALTIME_EVENTS,
  WORKFLOW_PHASE_COLORS,
  layoutWorkflowGraphByPhases,
  type ViewportContext,
  type WorkflowGraph,
  type WorkflowPhase,
} from '@agentis/core';
import {
  MarkerType,
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
  Puzzle,
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
  Settings,
  AlertCircle,
  Pause,
  Power,
  RadioTower,
  RefreshCw,
  LoaderCircle,
  CheckCircle2,
  Square,
} from 'lucide-react';
import clsx from 'clsx';
import { api, apiErrorMessage, workspace as workspaceStore } from '../lib/api';
import { useAgentisStore } from '../store/agentisStore';
import { nestedDomainOptions } from '../components/shared/DomainToolbar';
import { rtSubscribe, useRealtime, type RealtimeEnvelope } from '../lib/realtime';
import { REALTIME_ACTIVITY_EVENTS, describeRealtimeActivity, type RealtimeActivityTone } from '../lib/realtimeActivity';
import { refreshWorkspaceSnapshot, useWorkspaceData } from '../lib/workspaceData';
import {
  affordanceLabel,
  connectedAgentMatches,
  hasAgentRequirements,
  normalizeAgentRequirements,
  requiredAffordanceKeys,
  type AdapterCapabilitiesLite,
  type AgentRequirements,
} from '../lib/agentCapabilities';
import { CanvasLeftRail } from '../components/canvas/CanvasLeftRail';
import { PhaseLayer, stripPhasePrefix } from '../components/canvas/PhaseLayer';
import { AgentisEdge } from '../components/canvas/AgentisEdge';
import { NodeCommandPalette } from '../components/canvas/NodeCommandPalette';
import {
  WorkflowContractsPanel,
  type WorkflowContractValue,
} from '../components/canvas/WorkflowContractsPanel';
import { EventChainsPanel } from '../components/canvas/EventChainsPanel';
import { PhaseInspector } from '../components/canvas/PhaseInspector';
import { CanvasSelectionToolbar } from '../components/canvas/CanvasSelectionToolbar';
import { ContextInspector, type InspectorSelection } from '../components/canvas/ContextInspector';
import { WorkflowMonitorCard } from '../components/canvas/WorkflowMonitorCard';
import {
  evaluateNodeReadiness,
  type IntegrationManifestLite,
} from '../components/canvas/nodeConfigRegistry';
import { CanvasEngine } from '../components/canvas/CanvasEngine';
import { CanvasBuildComposer } from '../components/canvas/CanvasBuildComposer';
import { nodeKindMeta, nodeKindColor } from '../components/canvas/nodeKindMeta';
import { autoLayout } from '../components/canvas/autoLayout';
import { AgentFocusOverlayManager } from '../components/canvas/AgentFocusOverlayManager';
import {
  AgentisNode,
  type CanvasAgentMatch,
  type LiveExtra,
  type LiveStatus,
} from '../components/canvas/AgentisNode';
import { Button } from '../components/shared/Button';
import { SegmentedControl } from '../components/shared/SegmentedControl';
import { useToast } from '../components/shared/Toast';
import { useConfirm } from '../components/shared/ConfirmDialog';
import type { WorkflowRunSummary } from '../components/workflows/runFormat';
import { FOCUS_WORKFLOW_NODE_EVENT, openRunModal } from '../lib/runModal';
import { ScopedBrainMap } from '../components/brain/ScopedBrainMap';
import { InsightsTab } from '../components/brain/InsightsTab';
import { KnowledgeTab } from '../components/knowledge/KnowledgeTab';
import { ExtensionsModal } from '../components/extensions/ExtensionsModal';
import { BrainSectionNav, type BrainSection } from '../components/brain/BrainSectionNav';
import { ScopeVisibilityToggle } from '../components/brain/ScopeVisibilityToggle';

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
    edges: Array<{
      id: string;
      source: string;
      target: string;
      sourceHandle?: string;
      targetHandle?: string;
      condition?: string;
      type?: 'default' | 'error' | 'condition';
    }>;
    viewport: { x: number; y: number; zoom: number };
    phases?: WorkflowPhase[];
    inputContract?: WorkflowContractValue;
    outputContract?: WorkflowContractValue;
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
  triggerType: 'manual' | 'cron' | 'webhook' | 'persistent_listener';
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

type PhaseNodeData = {
  pendingConfig?: boolean;
  liveStatus?: 'running' | 'completed' | 'failed' | 'retry' | 'waiting';
};

interface SpaceSummary {
  id: string;
  name: string;
  colorHex?: string | null;
  parentDomainId?: string | null;
}

type SaveState = 'saved' | 'saving' | 'dirty' | 'error';
type EnginePage = 'overview' | 'inputs' | 'settings' | 'contracts' | 'chains' | 'activation';

/** Canvas tabs. UI surfaces moved to the Agentic App (AGENTIC-APPS-10X §4/§6). */
type WorkflowTab = 'canvas' | 'brain';

const WORKFLOW_TAB_SEGMENTS = [
  { value: 'canvas' as WorkflowTab, label: 'Canvas' },
  { value: 'brain' as WorkflowTab, label: 'Brain' },
] as const;


export function WorkflowCanvasPage({ embedded = false, workflowId }: { embedded?: boolean; workflowId?: string } = {}) {
  const routeParams = useParams<{ id: string }>();
  const id = workflowId ?? routeParams.id;
  const nav = useNavigate();
  const toast = useToast();
  const confirm = useConfirm();

  // Tabs: ?tab=canvas|brain. Canvas is the default and omits the param.
  const [searchParams, setSearchParams] = useSearchParams();
  const tabParam = searchParams.get('tab');
  // Embedded inside the App editor's Workflow facet: canvas only, no chrome.
  const tab: WorkflowTab = embedded ? 'canvas' : tabParam === 'brain' ? 'brain' : 'canvas';
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
  const [extManagerOpen, setExtManagerOpen] = useState(false);
  const [agents, setAgents] = useState<AgentCapabilityRow[]>([]);
  const [spaces, setSpaces] = useState<SpaceSummary[]>([]);
  const [titleDraft, setTitleDraft] = useState('');
  const [titleEditing, setTitleEditing] = useState(false);

  const [running, setRunning] = useState(false);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [activeRunFallbackStatus, setActiveRunFallbackStatus] = useState<WorkflowRunSummary['status'] | null>(null);
  const [runDialogOpen, setRunDialogOpen] = useState(false);
  const [runControlOpen, setRunControlOpen] = useState(false);
  const [runActionBusy, setRunActionBusy] = useState<'pause' | 'cancel' | 'resume' | null>(null);
  const [activateOpen, setActivateOpen] = useState(false);
  const [deployment, setDeployment] = useState<WorkflowDeployment | null>(null);
  const [deploymentLoading, setDeploymentLoading] = useState(false);
  const [deploymentBusy, setDeploymentBusy] = useState(false);
  const [deploymentError, setDeploymentError] = useState<string | null>(null);
  const [overflowOpen, setOverflowOpen] = useState(false);
  const [enginePage, setEnginePage] = useState<EnginePage>('overview');
  const [variablesOpen, setVariablesOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>('saved');
  const [knowledgeBaseCount, setKnowledgeBaseCount] = useState<number | null>(null);
  const [knowledgeChunkCount, setKnowledgeChunkCount] = useState<number | null>(null);

  const [selection, setSelection] = useState<InspectorSelection>({ kind: null });
  const [inspectorOpen, setInspectorOpen] = useState(true);
  const [selectedPhaseId, setSelectedPhaseId] = useState<string | null>(null);
  const [canvasReady, setCanvasReady] = useState(false);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [integrations, setIntegrations] = useState<IntegrationManifestLite[]>([]);
  const [credentialTypes, setCredentialTypes] = useState<string[]>([]);
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
  const { activeRuns } = useWorkspaceData();
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
      // Let id-only surfaces resolve this workflow's real name.
      useAgentisStore.getState().registerResourceName('workflow', d.workflow.id, d.workflow.title);
    }).catch(() => {
      // A brand-new build can mount this page a beat before its workflow row
      // is committed (e.g. a caller that reveals the canvas on the first build
      // phase rather than the first placed node). Retry once instead of
      // leaving `wf` null forever, which pins the page on "Loading workflow…"
      // with an unhandled rejection and no way to recover without a refresh.
      window.setTimeout(() => {
        void api<{ workflow: WorkflowDetail }>(`/v1/workflows/${id}`).then((d) => {
          setWf(d.workflow);
          setTitleDraft(d.workflow.title);
          lastSavedFingerprintRef.current = graphFingerprint(d.workflow.graph, d.workflow.title);
          useAgentisStore.getState().registerResourceName('workflow', d.workflow.id, d.workflow.title);
        }).catch(() => {});
      }, 800);
    });
    void api<{ extensions: ExtensionRow[] }>('/v1/extensions').then((d) => {
      setExtensions(d.extensions);
      const { registerResourceName } = useAgentisStore.getState();
      for (const ext of d.extensions) registerResourceName('extension', ext.id, ext.name);
    });
    void api<{ agents: AgentCapabilityRow[] }>('/v1/agents')
      .then((d) => setAgents(d.agents ?? []))
      .catch(() => setAgents([]));
    void api<{ data: SpaceSummary[] }>('/v1/domains')
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
  // emitted to the RUN room, not the workspace room. Without subscribing to
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
        setActiveRunFallbackStatus(active?.status ?? null);
      })
      .catch(() => {
        if (!cancelled) {
          setActiveRunId(null);
          setActiveRunFallbackStatus(null);
        }
      });
    return () => { cancelled = true; };
  }, [id]);

  // ROBUST continuous resolution — the workspace's LIVE active-run list (kept fresh
  // by the workspace room on EVERY RUN_* lifecycle event) is the source of truth,
  // so a run of THIS workflow started by ANY path (the App, the orchestrator,
  // deliver, a schedule — not only a RUN_CREATED event that happens to reach the
  // canvas with a matching workflowId) resolves the run room and paints node/phase
  // status live. The mount fetch only catches runs active at open; RUN_CREATED only
  // catches events it directly hears — this covers the rest (the "black canvas
  // during an App/orchestrator run" gap). Never CLEARS here: RUN_END owns clearing,
  // so a transient snapshot gap can't drop a live subscription mid-run.
  useEffect(() => {
    if (!id) return;
    const mine = activeRuns.find(
      (r) => r.workflowId === id && ACTIVE_RUN_SUMMARY_STATUSES.has((r.status ?? '').toLowerCase()),
    );
    if (mine) {
      setActiveRunId((prev) => (prev === mine.id ? prev : mine.id));
      setActiveRunFallbackStatus(mine.status as WorkflowRunSummary['status']);
    }
  }, [activeRuns, id]);

  const runStartEvents = useMemo(
    () => [REALTIME_EVENTS.RUN_CREATED, REALTIME_EVENTS.RUN_RUNNING],
    [],
  );
  useRealtime(runStartEvents, (env: RealtimeEnvelope) => {
    const payload = (env.payload ?? {}) as { runId?: string; workflowId?: string };
    if (!id || payload.workflowId !== id || !payload.runId) return;
    setActiveRunId(payload.runId);
    setActiveRunFallbackStatus(env.event === REALTIME_EVENTS.RUN_CREATED ? 'pending' : 'running');
  });

  const runEndEvents = useMemo(
    () => [REALTIME_EVENTS.RUN_COMPLETED, REALTIME_EVENTS.RUN_FAILED, REALTIME_EVENTS.RUN_CANCELLED],
    [],
  );
  useRealtime(runEndEvents, (env: RealtimeEnvelope) => {
    const payload = (env.payload ?? {}) as { runId?: string };
    if (!activeRunId || payload.runId !== activeRunId) return;
    // Run finished; results stay available via explicit inspect actions.
    setActiveRunId(null);
    setActiveRunFallbackStatus(null);
    setRunControlOpen(false);
  });

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
  // the palette still surfaces built-in nodes.
  useEffect(() => {
    void api<{
      integrations: IntegrationManifestLite[];
    }>('/v1/integrations')
      .then((d) => setIntegrations(d.integrations ?? []))
      .catch(() => setIntegrations([]));
    void api<{ credentials: Array<{ credentialType: string }> }>('/v1/credentials')
      .then((d) => setCredentialTypes((d.credentials ?? []).map((credential) => credential.credentialType)))
      .catch(() => setCredentialTypes([]));
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
  // wf.graph (for saves) inside the change handlers.
  const [flowNodes, setFlowNodes, onFlowNodesChange] = useNodesState<Node>([]);
  const [flowEdges, setFlowEdges, onFlowEdgesChange] = useEdgesState<Edge>([]);
  const selectedFlowNodes = useMemo(() => flowNodes.filter((node) => node.selected), [flowNodes]);
  const workflowPhases = wf?.graph.phases ?? [];
  const selectedPhase = selectedPhaseId
    ? workflowPhases.find((phase) => phase.id === selectedPhaseId) ?? null
    : null;
  const resolveSelectionNodes = useCallback((selectionIds?: string[]) => {
    if (!selectionIds?.length) return selectedFlowNodes;
    const ids = new Set(selectionIds);
    return flowNodesRef.current.filter((node) => ids.has(node.id));
  }, [selectedFlowNodes]);
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
  useEffect(() => {
    function onFocusNode(event: Event) {
      const nodeId = (event as CustomEvent<{ nodeId?: string }>).detail?.nodeId;
      if (nodeId) focusMonitorNode(nodeId);
    }
    window.addEventListener(FOCUS_WORKFLOW_NODE_EVENT, onFocusNode);
    return () => window.removeEventListener(FOCUS_WORKFLOW_NODE_EVENT, onFocusNode);
  }, [focusMonitorNode]);

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
      // Light up the edges feeding the running node so the flow is visible in
      // motion — the connection lights up and its dashes march toward the step.
      const active = status === 'running';
      setFlowEdges((prev) =>
        prev.map((e) => {
          if (e.target !== nodeId) return e;
          const nextClass = active ? 'agentis-edge-active' : undefined;
          return e.className === nextClass ? e : { ...e, className: nextClass };
        }),
      );
    },
    [setFlowNodes, setFlowEdges],
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
      setFlowEdges((prev) => prev.map((e) => (e.className ? { ...e, className: undefined } : e)));
    }, 3500);
  }, [setFlowNodes, setFlowEdges]);
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
  const runtimeActivityEvents = useMemo(() => [...REALTIME_ACTIVITY_EVENTS], []);
  const updateNodeRuntimeActivity = useCallback(
    (
      nodeId: string,
      activity: { kind: string; title: string; detail: string; tone: RealtimeActivityTone },
    ) => {
      setFlowNodes((prev) =>
        prev.map((n) => {
          if (n.id !== nodeId) return n;
          const data = (n.data ?? {}) as Record<string, unknown>;
          const liveExtra = (data.liveExtra && typeof data.liveExtra === 'object' ? data.liveExtra : {}) as Record<string, unknown>;
          return {
            ...n,
            data: {
              ...data,
              liveExtra: {
                ...liveExtra,
                runtimeActivity: activity,
              },
            },
          };
        }),
      );
    },
    [setFlowNodes],
  );
  useRealtime(runtimeActivityEvents, (env: RealtimeEnvelope) => {
    if (!activeRunId) return;
    const activity = describeRealtimeActivity(env, {
      nodeTitle: (nodeId) => monitorNodeTitles.get(nodeId),
    });
    if (!activity || activity.runId !== activeRunId || !activity.nodeId) return;
    if (!['node', 'agent', 'tool', 'progress'].includes(activity.kind)) return;
    updateNodeRuntimeActivity(activity.nodeId, {
      kind: activity.kind,
      title: activity.title,
      detail: activity.detail,
      tone: activity.tone,
    });
  });

  // Canvas cards receive their latest execution metadata in one projection,
  // rather than each node issuing its own history request.
  useEffect(() => {
    if (!wf?.id) return;
    let cancelled = false;
    void api<{ nodes: Record<string, { startedAt?: string; completedAt?: string; durationMs?: number }> }>(`/v1/workflows/${wf.id}/node-activity`)
      .then((result) => {
        if (cancelled) return;
        setFlowNodes((nodes) => nodes.map((node) => {
          const activity = result.nodes[node.id];
          if (!activity) return node;
          return { ...node, data: { ...(node.data ?? {}), lastRunAt: activity.completedAt ?? activity.startedAt, lastDurationMs: activity.durationMs } };
        }));
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [wf?.id, setFlowNodes]);

  // Hydrate RF state once when the workflow loads (and on workflow ID change).
  // We compare by ID to avoid clobbering local edits on re-renders.
  const hydratedIdRef = useRef<string | null>(null);
  const buildCanvasEvents = useMemo(
    () => [
      REALTIME_EVENTS.CANVAS_NODE_PLACED,
      REALTIME_EVENTS.CANVAS_EDGE_CONNECTED,
      REALTIME_EVENTS.CANVAS_BUILD_COMPLETE,
      REALTIME_EVENTS.WORKFLOW_GRAPH_PATCHED,
    ],
    [],
  );
  useRealtime(buildCanvasEvents, (env: RealtimeEnvelope) => {
    const payload = (env.payload ?? {}) as {
      workflowId?: string;
      runId?: string;
      node?: { id?: string; type?: string; position?: { x: number; y: number }; data?: { label?: string; kind?: string } };
      edge?: { id?: string; source?: string; target?: string };
      phase?: Pick<WorkflowPhase, 'id' | 'name' | 'color' | 'nodeIds'>;
    };
    if (env.event === REALTIME_EVENTS.WORKFLOW_GRAPH_PATCHED) {
      // Mid-run self-evolution (evolve_plan / evolveGraph) merges nodes straight
      // into the persisted graph with no per-node stream — refetch and briefly
      // patch land instead of the canvas silently going stale.
      if (!id || payload.workflowId !== id) return;
      const previousNodeIds = new Set((wfRef.current?.graph.nodes ?? []).map((n) => n.id));
      void api<{ workflow: WorkflowDetail }>(`/v1/workflows/${id}`).then((d) => {
        const addedIds = d.workflow.graph.nodes.map((n) => n.id).filter((nid) => !previousNodeIds.has(nid));
        hydratedIdRef.current = null;
        wfRef.current = d.workflow;
        setWf(d.workflow);
        setTitleDraft(d.workflow.title);
        lastSavedFingerprintRef.current = graphFingerprint(d.workflow.graph, d.workflow.title);
        if (addedIds.length === 0) return;
        window.setTimeout(() => {
          setFlowNodes((nodes) => nodes.map((node) =>
            addedIds.includes(node.id) ? { ...node, data: { ...(node.data ?? {}), liveStatus: 'running' } } : node,
          ));
        }, 50);
        window.setTimeout(() => {
          setFlowNodes((nodes) => nodes.map((node) =>
            addedIds.includes(node.id) ? { ...node, data: { ...(node.data ?? {}), liveStatus: undefined } } : node,
          ));
        }, 2500);
      });
      return;
    }
    if (!id || payload.workflowId !== id) return;
    setTab('canvas');
    if (payload.runId) setActiveRunId(payload.runId);
    if (env.event === REALTIME_EVENTS.CANVAS_NODE_PLACED && payload.node?.id) {
      const node = payload.node;
      // Build events arrive before the final graph is persisted.  Merge the
      // node's phase into workflow state now so PhaseLayer grows in lockstep
      // with the streamed nodes instead of appearing only after a refresh.
      if (payload.phase?.id) {
        setWf((current) => {
          if (!current) return current;
          const incoming = payload.phase!;
          const phases = current.graph.phases ?? [];
          const index = phases.findIndex((phase) => phase.id === incoming.id);
          const existing = index >= 0 ? phases[index]! : undefined;
          const nodeIds = Array.from(new Set([
            ...(existing?.nodeIds ?? []),
            ...(incoming.nodeIds ?? []),
            node.id!,
          ]));
          const nextPhase: WorkflowPhase = {
            ...(existing ?? incoming),
            ...incoming,
            nodeIds,
          };
          const nextPhases = index >= 0
            ? phases.map((phase, phaseIndex) => phaseIndex === index ? nextPhase : phase)
            : [...phases, nextPhase];
          const next = { ...current, graph: { ...current.graph, phases: nextPhases } };
          // Keep an in-flight inspector/autosave operation from using the
          // pre-stream graph and accidentally dropping the freshly-arrived lane.
          wfRef.current = next;
          return next;
        });
      }
      setFlowNodes((prev) => {
        const kind = node.data?.kind ?? node.type ?? 'transform';
        if (prev.some((existing) => existing.id === node.id)) {
          // A rebuild that edits an existing node (not just adds a new one)
          // republishes CANVAS_NODE_PLACED for it too — re-halo it instead of
          // silently no-op'ing, otherwise "touch/edit" never shows a reveal.
          return prev.map((existing) =>
            existing.id === node.id
              ? { ...existing, data: { ...(existing.data ?? {}), liveStatus: 'running' } }
              : existing,
          );
        }
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
          // Provider identity for the card subtitle (reference-builder parity):
          // an mcp node names its server·tool, an integration its service·op.
          toolId: (n.config as { toolId?: string }).toolId,
          integrationId: (n.config as { integrationId?: string }).integrationId,
          operationId: (n.config as { operationId?: string }).operationId,
          ...readinessNodeData(n.config, integrations, credentialTypes),
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
  }, [wf, agents, integrations, credentialTypes, setFlowNodes, setFlowEdges, handleEdgeDelete]);

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
            ...readinessNodeData(workflowNode.config, integrations, credentialTypes),
            ...agentCapabilityNodeData(workflowNode.config, agents),
          },
        };
      }),
    );
  }, [wf?.graph.nodes, agents, integrations, credentialTypes, setFlowNodes]);

  useEffect(() => {
    const focusedIds = selectedPhaseId
      ? new Set(wf?.graph.phases?.find((phase) => phase.id === selectedPhaseId)?.nodeIds ?? [])
      : null;
    setFlowNodes((nodes) =>
      nodes.map((node) => ({
        ...node,
        data: {
          ...(node.data ?? {}),
          phaseDimmed: Boolean(focusedIds && !focusedIds.has(node.id)),
        },
      })),
    );
  }, [selectedPhaseId, wf?.graph.phases, setFlowNodes]);

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
    const current = wfRef.current;
    if (!inst || !current) return;
    const liveGraph = buildGraphFromFlow(current.graph, inst.getNodes(), inst.getEdges());
    const byId = liveGraph.phases?.length
      ? new Map(layoutWorkflowGraphByPhases(liveGraph as WorkflowGraph).nodes.map((node) => [node.id, node.position] as const))
      : new Map(autoLayout(inst.getNodes(), inst.getEdges()).map((node) => [node.id, node.position] as const));
    if (byId.size === 0) return;
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
    // Fit after the new positions have painted — same legibility floor as the
    // entry framing so Tidy never lands on an unreadable whole-graph view.
    window.setTimeout(() => flowInstanceRef.current?.fitView({ padding: 0.1, duration: 400, maxZoom: 1, minZoom: 0.55 }), 60);
  }, [queueSave, setFlowNodes]);

  // Phase rail navigation: focus a phase (dim others) and frame just its nodes
  // at a readable zoom, so clicking a phase actually takes you there. Clearing
  // refits the whole graph.
  const focusPhase = useCallback((phaseId: string) => {
    setSelectedPhaseId(phaseId);
    setSelection({ kind: null });
    setInspectorOpen(true);
    const phase = wfRef.current?.graph.phases?.find((item) => item.id === phaseId);
    const ids = new Set(phase?.nodeIds ?? []);
    if (ids.size === 0) return;
    // Defer so the fit runs after the focus re-render settles (matches Tidy /
    // applyPhaseLayout). maxZoom is generous so a small phase genuinely zooms IN
    // rather than staying at the whole-graph fit.
    window.setTimeout(() => {
      const inst = flowInstanceRef.current;
      if (!inst) return;
      const target = inst.getNodes().filter((node) => ids.has(node.id)).map((node) => ({ id: node.id }));
      if (target.length > 0) inst.fitView({ nodes: target, padding: 0.24, duration: 450, maxZoom: 1.6 });
    }, 60);
  }, []);

  const clearPhaseFocus = useCallback(() => {
    setSelectedPhaseId(null);
    // Frame the whole flow, but never below a legible floor — a wide multi-phase
    // graph stays readable (centered, pan for the edges) instead of collapsing to
    // illegible slivers. The minimap/rail carry the bird's-eye view.
    flowInstanceRef.current?.fitView({ padding: 0.16, duration: 420, maxZoom: 1, minZoom: 0.5 });
  }, []);

  // ── Initial framing ───────────────────────────────────────────────────
  // shape at a glance, then zooms in where they want. We still own the framing
  // (rather than React Flow's auto-fit) because the embedded App facet mounts the
  // canvas on tab select, and auto-fit runs after node measurement — without this
  // the first frame lands at the default viewport instead of fit-to-graph.
  const frameWorkflowEntry = useCallback((animate = true) => {
    const inst = flowInstanceRef.current;
    if (!inst) return;
    if (inst.getNodes().length === 0) return;
    // Readable-first framing: never open below the legibility floor. A big
    // workflow opens on its first phases at a zoom where cards can be read,
    // framing everything as illegible confetti.
    inst.fitView({ padding: 0.1, duration: animate ? 460 : 0, maxZoom: 1, minZoom: 0.55 });
  }, []);

  // Run the entry framing once per workflow — but only after the canvas is
  // actually visible (the embedded App facet mounts it on tab select) AND React
  // Flow has measured node sizes. Framing earlier would either no-op (zero-size
  // host) or be computed against unmeasured nodes. We mark the workflow framed
  // only after a real, sized frame so a premature attempt can't lock it out.
  const framedWorkflowIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (!canvasReady || !wf) return;
    const host = overlayHostRef.current;
    if (!host) return;
    const wfId = wf.id;
    if (framedWorkflowIdRef.current === wfId) return;
    let raf = 0;
    let tries = 0;
    let cancelled = false;

    const attempt = () => {
      if (cancelled || framedWorkflowIdRef.current === wfId) return;
      const inst = flowInstanceRef.current;
      const visible = host.clientWidth > 60 && host.clientHeight > 60;
      const nodes = inst?.getNodes() ?? [];
      const measured = nodes.some((node) => (node.measured?.width ?? node.width ?? 0) > 0);
      if (inst && visible && measured) {
        framedWorkflowIdRef.current = wfId;
        frameWorkflowEntry(true);
        return;
      }
      if (tries++ < 90) raf = window.requestAnimationFrame(attempt); // ~1.5s of retries
    };

    raf = window.requestAnimationFrame(attempt);
    // A tab reveal resizes the host from 0 → full; retry framing when that happens.
    const observer = new ResizeObserver(() => {
      if (cancelled || framedWorkflowIdRef.current === wfId) return;
      tries = 0;
      window.cancelAnimationFrame(raf);
      raf = window.requestAnimationFrame(attempt);
    });
    observer.observe(host);
    return () => {
      cancelled = true;
      window.cancelAnimationFrame(raf);
      observer.disconnect();
    };
  }, [canvasReady, wf, flowNodes.length, frameWorkflowEntry]);

  const updatePhases = useCallback((phases: WorkflowPhase[]) => {
    const current = wfRef.current;
    if (!current) return;
    const nextGraph = { ...current.graph, phases };
    const nextWorkflow = { ...current, graph: nextGraph };
    wfRef.current = nextWorkflow;
    setWf(nextWorkflow);
    queueSave();
  }, [queueSave]);

  const applyPhaseLayout = useCallback((phases: WorkflowPhase[]) => {
    const current = wfRef.current;
    if (!current) return;
    const liveGraph = buildGraphFromFlow(current.graph, flowNodesRef.current, flowEdgesRef.current);
    const nextGraph = layoutWorkflowGraphByPhases({ ...liveGraph, phases } as WorkflowGraph) as WorkflowDetail['graph'];
    const positions = new Map(nextGraph.nodes.map((node) => [node.id, node.position] as const));
    setFlowNodes((nodes) => nodes.map((node) => ({ ...node, position: positions.get(node.id) ?? node.position })));
    const nextWorkflow = { ...current, graph: nextGraph };
    wfRef.current = nextWorkflow;
    setWf(nextWorkflow);
    queueSave();
    window.setTimeout(() => flowInstanceRef.current?.fitView({ padding: 0.1, duration: 320, maxZoom: 1, minZoom: 0.55 }), 60);
  }, [queueSave, setFlowNodes]);

  const createPhaseFromSelection = useCallback((selectionIds?: string[]) => {
    const current = wfRef.current;
    if (!current) return;
    const selectedIds = resolveSelectionNodes(selectionIds).map((node) => node.id);
    const assigned = new Set((current.graph.phases ?? []).flatMap((phase) => phase.nodeIds));
    if (selectedIds.length < 2 || selectedIds.some((id) => assigned.has(id))) return;
    const index = (current.graph.phases?.length ?? 0);
    const phase: WorkflowPhase = {
      id: `phase-${Date.now().toString(36)}`,
      name: `Phase ${index + 1}`,
      description: 'Describe what this phase accomplishes.',
      color: WORKFLOW_PHASE_COLORS[index % WORKFLOW_PHASE_COLORS.length]!,
      nodeIds: selectedIds,
    };
    applyPhaseLayout([...(current.graph.phases ?? []), phase]);
    setSelectedPhaseId(phase.id);
    setSelection({ kind: null });
    setInspectorOpen(true);
  }, [applyPhaseLayout, resolveSelectionNodes]);

  const moveSelectionToPhase = useCallback((phaseId: string, selectionIds?: string[]) => {
    const current = wfRef.current;
    if (!current) return;
    const selectedIds = new Set(resolveSelectionNodes(selectionIds).map((node) => node.id));
    const phases = (current.graph.phases ?? []).map((phase) => ({
      ...phase,
      nodeIds: [
        ...phase.nodeIds.filter((id) => !selectedIds.has(id)),
        ...(phase.id === phaseId ? [...selectedIds].filter((id) => !phase.nodeIds.includes(id)) : []),
      ],
    })).filter((phase) => phase.nodeIds.length > 0);
    applyPhaseLayout(phases);
  }, [applyPhaseLayout, resolveSelectionNodes]);

  const tidySelection = useCallback((selectionIds?: string[]) => {
    const selectionNodes = resolveSelectionNodes(selectionIds);
    if (selectionNodes.length < 2) return;
    const selectedIds = new Set(selectionNodes.map((node) => node.id));
    const selectedEdges = flowEdgesRef.current.filter((edge) => selectedIds.has(edge.source) && selectedIds.has(edge.target));
    const laid = autoLayout(selectionNodes, selectedEdges, { originX: 0, originY: 0 });
    const oldMinX = Math.min(...selectionNodes.map((node) => node.position.x));
    const oldMinY = Math.min(...selectionNodes.map((node) => node.position.y));
    const newMinX = Math.min(...laid.map((node) => node.position.x));
    const newMinY = Math.min(...laid.map((node) => node.position.y));
    const positions = new Map(laid.map((node) => [
      node.id,
      { x: node.position.x - newMinX + oldMinX, y: node.position.y - newMinY + oldMinY },
    ] as const));
    setFlowNodes((nodes) => nodes.map((node) => positions.has(node.id) ? { ...node, position: positions.get(node.id)! } : node));
    queueSave();
  }, [queueSave, resolveSelectionNodes, setFlowNodes]);

  const deleteSelection = useCallback((selectionIds?: string[]) => {
    const ids = new Set(resolveSelectionNodes(selectionIds).map((node) => node.id));
    if (ids.size === 0) return;
    setFlowNodes((nodes) => nodes.filter((node) => !ids.has(node.id)));
    setFlowEdges((edges) => edges.filter((edge) => !ids.has(edge.source) && !ids.has(edge.target)));
    const current = wfRef.current;
    if (current) {
      const phases = (current.graph.phases ?? [])
        .map((phase) => ({ ...phase, nodeIds: phase.nodeIds.filter((id) => !ids.has(id)) }))
        .filter((phase) => phase.nodeIds.length > 0);
      const nextWorkflow = { ...current, graph: { ...current.graph, phases } };
      wfRef.current = nextWorkflow;
      setWf(nextWorkflow);
    }
    setSelection({ kind: null });
    queueSave();
  }, [queueSave, resolveSelectionNodes, setFlowEdges, setFlowNodes]);

  const askAgentForPhases = useCallback(() => {
    if (!wf) return;
    const selectedIds = selectedFlowNodes.map((node) => node.id);
    const viewportOverride: ViewportContext = {
      surface: 'workflow_detail',
      route: `${window.location.pathname}${window.location.search}${window.location.hash}`,
      title: 'Workflow canvas',
      workspaceId: workspaceStore.get() ?? undefined,
      resourceId: wf.id,
      resourceKind: 'workflow',
      selection: selectedIds.length
        ? {
            ids: selectedIds,
            label: `${selectedIds.length} selected ${selectedIds.length === 1 ? 'node' : 'nodes'}`,
            kind: 'workflow_nodes',
          }
        : null,
      metadata: {
        workflowId: wf.id,
        workflowTitle: wf.title,
        phaseAssist: true,
      },
    };
    window.dispatchEvent(new CustomEvent('agentis:chat-panel-open', {
      detail: {
        mode: 'docked',
        initialDraft: selectedIds.length
          ? 'Organize the selected workflow nodes into clear phases. Suggest a minimal phase structure, name each phase, and explain which nodes belong in each one.'
          : 'Review this workflow canvas and propose a clean phase structure. Suggest a minimal set of phases, name them, and explain which nodes belong in each one.',
        initialViewportOverride: viewportOverride,
      },
    }));
  }, [selectedFlowNodes, wf]);

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
      const current = wfRef.current;
      if (current) {
        const phases = (current.graph.phases ?? [])
          .map((phase) => ({ ...phase, nodeIds: phase.nodeIds.filter((id) => id !== nodeId) }))
          .filter((phase) => phase.nodeIds.length > 0);
        const nextWorkflow = { ...current, graph: { ...current.graph, phases } };
        wfRef.current = nextWorkflow;
        setWf(nextWorkflow);
      }
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

  // Close activate dropdown on global click outside.
  useEffect(() => {
    if (!activateOpen) return;
    const onClick = () => {
      setActivateOpen(false);
    };
    window.addEventListener('click', onClick);
    return () => window.removeEventListener('click', onClick);
  }, [activateOpen]);

  useEffect(() => {
    if (!runControlOpen) return;
    const onClick = () => {
      setRunControlOpen(false);
    };
    window.addEventListener('click', onClick);
    return () => window.removeEventListener('click', onClick);
  }, [runControlOpen]);

  useEffect(() => {
    if (!activateOpen || !wf) return;
    void refreshDeployment();
    // The workflow id is the activation identity; graph edits are compared in the panel.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activateOpen, wf?.id]);

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
      setActiveRunFallbackStatus('pending');
      setRunDialogOpen(false);
      setRunControlOpen(false);
      setTab('canvas');
      toast.success('Run started');
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

  async function handleActivate() {
    if (!wf) return;
    if (openFirstIncompleteNode()) {
      setActivateOpen(false);
      return;
    }
    setDeploymentBusy(true);
    setDeploymentError(null);
    try {
      await saveNow();
      const result = await api<{ deployment: WorkflowDeployment }>(`/v1/workflows/${wf.id}/activate`, {
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
      toast.success(activationSuccessMessage(result.deployment.triggerType));
    } catch (e) {
      const message = apiErrorMessage(e);
      setDeploymentError(message);
      toast.error('Activation failed', message);
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
      toast.error('Activation update failed', message);
    } finally {
      setDeploymentBusy(false);
    }
  }

  async function pauseActiveRun() {
    if (!activeRunId || runActionBusy) return;
    setRunActionBusy('pause');
    try {
      await api(`/v1/runs/${activeRunId}/pause`, { method: 'POST' });
      setActiveRunFallbackStatus('paused');
      await refreshWorkspaceSnapshot();
      setRunControlOpen(false);
      toast.success('Run paused');
    } catch (error) {
      toast.error('Failed to pause run', apiErrorMessage(error));
    } finally {
      setRunActionBusy(null);
    }
  }

  async function cancelActiveRun() {
    if (!activeRunId || runActionBusy) return;
    if (!window.confirm('Cancel this run permanently? It cannot be resumed.')) return;
    setRunActionBusy('cancel');
    try {
      await api(`/v1/runs/${activeRunId}/cancel`, { method: 'POST' });
      await refreshWorkspaceSnapshot();
      setRunControlOpen(false);
      toast.success('Run cancelled');
    } catch (error) {
      toast.error('Failed to cancel run', apiErrorMessage(error));
    } finally {
      setRunActionBusy(null);
    }
  }

  async function resumeActiveRun() {
    if (!activeRunId || runActionBusy) return;
    setRunActionBusy('resume');
    try {
      await api(`/v1/runs/${activeRunId}/resume`, { method: 'POST', body: JSON.stringify({}) });
      setActiveRunFallbackStatus('running');
      await refreshWorkspaceSnapshot();
      setRunControlOpen(false);
      toast.success('Run resumed');
    } catch (error) {
      toast.error('Failed to resume run', apiErrorMessage(error));
    } finally {
      setRunActionBusy(null);
    }
  }

  if (!wf) return <div className="p-6 text-[13px] text-text-muted">Loading workflow…</div>;

  const headerTrigger = workflowTriggerConfig(wf);
  const headerIsManualRun = headerTrigger?.triggerType === 'manual';
  const workspaceActiveRun = activeRuns.find((run) => (
    activeRunId ? run.id === activeRunId : run.workflowId === wf.id
  )) ?? null;
  const activeRunStatus = normalizeWorkflowRunStatus(workspaceActiveRun?.status) ?? activeRunFallbackStatus;
  const hasLiveManualRun = headerIsManualRun
    && Boolean(activeRunId)
    && activeRunStatus !== null
    && ['pending', 'running', 'waiting', 'paused'].includes(activeRunStatus);

  return (
    <div className="workflow-scope relative flex h-full flex-col">
      {/* Embedded (App Workflow facet) hides the header below, which is where Run
          lives — so surface a first-class Run control on the canvas itself. It
          opens the same inputs-aware run dialog and live run inspector. */}
      {embedded && wf ? (
        <button
          type="button"
          onClick={() => setRunDialogOpen(true)}
          disabled={running}
          className="absolute bottom-4 right-4 z-30 inline-flex items-center gap-1.5 rounded-full bg-accent px-4 py-2 text-[12px] font-semibold text-white shadow-lg transition-colors hover:bg-accent/90 disabled:opacity-60"
          title="Run this workflow"
        >
          <Play size={14} /> {running ? 'Running…' : 'Run workflow'}
        </button>
      ) : null}
      {/* Header — one slim command strip above the canvas. Hidden when embedded
          in the App editor, which provides its own header + facet tabs. */}
      <div className={clsx('flex shrink-0 items-center gap-2 border-b border-line bg-surface px-4 py-2', embedded && 'hidden')}>
        <button
          onClick={() => nav('/apps')}
          className="inline-flex items-center gap-1 text-[12px] text-text-muted transition-colors hover:text-text-primary"
        >
          <ArrowLeft size={12} /> Apps
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
        <div className="flex items-center gap-1">
          <SaveIndicator state={saveState} onRetry={() => void saveNow()} />
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setOverflowOpen(true);
            }}
            className={clsx(
              'inline-flex h-7 w-7 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-surface-2 hover:text-text-primary',
              overflowOpen && 'bg-surface-2 text-text-primary',
            )}
            title="Workflow engine"
            aria-label="Workflow engine"
          >
            <Settings size={13} />
          </button>
        </div>

        <div className="ml-auto flex items-center gap-2">
          <SegmentedControl
            segments={WORKFLOW_TAB_SEGMENTS}
            value={tab}
            onChange={setTab}
            size="sm"
            className="whitespace-nowrap"
          />

          <Button
            variant="secondary"
            size="sm"
            iconLeft={<Puzzle size={13} />}
            className="whitespace-nowrap"
            onClick={() => setExtManagerOpen(true)}
          >
            Extensions
          </Button>

          <div className="relative">
            {headerIsManualRun ? (
              hasLiveManualRun ? (
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      setRunControlOpen((open) => !open);
                    }}
                    className={clsx(
                      'inline-flex h-8 items-center gap-1.5 rounded-btn border px-3 text-[13px] font-medium transition-colors',
                      activeRunStatus === 'paused'
                        ? 'border-warn/30 bg-warn/10 text-warn hover:bg-warn/15'
                        : activeRunStatus === 'waiting'
                          ? 'border-line bg-surface-2 text-text-primary hover:bg-surface-3'
                          : 'border-line bg-surface-2 text-text-primary hover:bg-surface-3',
                    )}
                  >
                    {headerRunStatusIcon(activeRunStatus)}
                    {headerRunStatusLabel(activeRunStatus)}
                    <ChevronDown size={12} />
                  </button>
                  {activeRunStatus === 'paused' ? (
                    <Button
                      variant="primary"
                      size="sm"
                      iconLeft={<Play size={12} />}
                      loading={runActionBusy === 'resume'}
                      onClick={() => void resumeActiveRun()}
                    >
                      Resume
                    </Button>
                  ) : (
                    <Button
                      variant="danger"
                      size="sm"
                      iconLeft={<Square size={12} />}
                      loading={runActionBusy === 'pause'}
                      onClick={() => void pauseActiveRun()}
                    >
                      Pause
                    </Button>
                  )}
                </div>
              ) : (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    if (openFirstIncompleteNode()) return;
                    setRunDialogOpen(true);
                  }}
                  className="inline-flex h-8 items-center gap-1.5 rounded-btn bg-accent px-3 text-[13px] font-semibold text-canvas transition-colors hover:bg-accent-hover"
                >
                  <Play size={12} />
                  Run
                </button>
              )
            ) : (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setActivateOpen((v) => !v);
                }}
                className="inline-flex h-8 items-center gap-1.5 rounded-btn bg-accent px-3 text-[13px] font-semibold text-canvas transition-colors hover:bg-accent-hover"
              >
                <Upload size={12} />
                Activate
                <ChevronDown size={12} />
              </button>
            )}
            {headerIsManualRun && runControlOpen && hasLiveManualRun && (
              <div
                className="absolute right-0 z-50 mt-1.5 w-[220px] overflow-hidden rounded-card border border-line bg-surface shadow-dropdown"
                onClick={(event) => event.stopPropagation()}
              >
                <div className="border-b border-line px-3 py-2">
                  <div className="text-[11px] font-medium text-text-primary">{headerRunStatusLabel(activeRunStatus)}</div>
                  <div className="text-[10px] text-text-muted">
                    {activeRunId ? activeRunId.slice(0, 8) : 'run'}
                  </div>
                </div>
                <div className="p-1.5">
                  {activeRunStatus === 'paused' ? (
                    <button
                      type="button"
                      onClick={() => void resumeActiveRun()}
                      disabled={runActionBusy !== null}
                      className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-[12px] text-text-primary transition hover:bg-surface-2 disabled:opacity-50"
                    >
                      <Play size={12} /> Resume run
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => void pauseActiveRun()}
                      disabled={runActionBusy !== null}
                      className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-[12px] text-danger transition hover:bg-danger-soft disabled:opacity-50"
                    >
                      <Square size={12} /> Pause run
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => void cancelActiveRun()}
                    disabled={runActionBusy !== null}
                    className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-[12px] text-danger transition hover:bg-danger-soft disabled:opacity-50"
                  >
                    <Square size={12} /> Cancel run
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setRunControlOpen(false);
                      openRunModal({ runId: activeRunId, workflowId: wf.id, source: 'workflow-header' });
                    }}
                    className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-[12px] text-text-primary transition hover:bg-surface-2"
                  >
                    <ExternalLink size={12} /> Open run details
                  </button>
                </div>
              </div>
            )}
            {!headerIsManualRun && activateOpen && (
              <div
                className="absolute right-0 z-50 mt-1.5 w-[340px] overflow-hidden rounded-card border border-line bg-surface shadow-dropdown"
                onClick={(event) => event.stopPropagation()}
              >
                <DeploymentPanel
                  trigger={headerTrigger}
                  deployment={deployment}
                  loading={deploymentLoading}
                  busy={deploymentBusy}
                  error={deploymentError}
                  onActivate={() => void handleActivate()}
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
      </div>

      {/* Canvas + side panels — kept mounted across tab switches so React
          Flow state and the agent-focus overlay survive. */}
      <div className={clsx('flex min-h-0 flex-1 overflow-hidden', tab !== 'canvas' && 'hidden')}>
        <CanvasLeftRail
          phases={workflowPhases}
          nodes={flowNodes.map((node) => ({
            id: node.id,
            position: node.position,
            width: node.width,
            height: node.height,
            data: node.data as PhaseNodeData,
          }))}
          focusedPhaseId={selectedPhaseId}
          onFocusPhase={focusPhase}
          onClearFocus={clearPhaseFocus}
          onAskAgentForPhases={askAgentForPhases}
        />
        <div ref={overlayHostRef} className="relative min-h-0 flex-1">
          <CanvasEngine
            nodes={flowNodes}
            edges={flowEdges}
            // Initial framing is owned by frameWorkflowEntry (see the canvasReady
            // effect), NOT React Flow's auto-fit. Auto-fit frames the whole wide
            // multi-phase graph at an illegible zoom and — because it runs after
            // node measurement — would override our readable entry framing.
            minZoom={0.12}
            maxZoom={1.75}
            minimapNodeColor={(n) => nodeKindColor((n.data as { kind?: string } | undefined)?.kind)}
            onReady={(instance) => { flowInstanceRef.current = instance; setCanvasReady(true); }}
            nodeTypes={{ agentis: AgentisNode }}
            edgeTypes={edgeTypes}
            // Directional arrowheads so the flow reads left-to-right at a glance,
            // like the reference builder. Color tracks the edge stroke token.
            defaultEdgeOptions={{
              markerEnd: { type: MarkerType.ArrowClosed, width: 13, height: 13, color: 'var(--color-line-strong)' },
            }}
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
                    ...readinessNodeData({ kind: nodeType, ...extra }, integrations, credentialTypes),
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
              setSelectedPhaseId(null);
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
              setSelectedPhaseId(null);
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
            selectionOnDrag
            panOnDrag={[1]}
            panOnScroll
            zoomOnScroll={false}
            zoomActivationKeyCode={['Meta', 'Control']}
            panActivationKeyCode={[' ', 'Control']}
            minimapPosition="bottom-left"
            onTidy={handleTidy}
            backgroundGap={20}
            backgroundColor="var(--color-canvas-grid)"
          >
            {/* Soft, decorative phase bands behind the graph (no pills, no pointer
                capture). Navigation lives in the left rail; focusing a phase there
                dims the rest of the graph (node.data.phaseDimmed). */}
            {workflowPhases.length > 0 && (
              <PhaseLayer
                phases={workflowPhases}
                focusedPhaseId={selectedPhaseId}
                nodes={flowNodes.map((node) => ({
                  id: node.id,
                  position: node.position,
                  width: node.measured?.width ?? node.width,
                  height: node.measured?.height ?? node.height,
                  data: node.data as PhaseNodeData,
                }))}
              />
            )}
            <CanvasSelectionToolbar
              nodes={selectedFlowNodes}
              phases={workflowPhases}
              canCreatePhase={
                selectedFlowNodes.length >= 2
                && selectedFlowNodes.every((node) => !workflowPhases.some((phase) => phase.nodeIds.includes(node.id)))
              }
              onCreatePhase={createPhaseFromSelection}
              onMoveToPhase={moveSelectionToPhase}
              onTidy={tidySelection}
              onDelete={deleteSelection}
            />
          </CanvasEngine>
          {flowNodes.length === 0 && wf && (
            <div className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center">
              <CanvasBuildComposer workflowId={wf.id} workflowTitle={wf.title} variant="empty" />
            </div>
          )}
          <div className="pointer-events-none absolute right-4 top-4 z-40 flex flex-col items-end gap-3">
            <div className="pointer-events-auto flex flex-col items-stretch gap-3">
              <WorkflowMonitorCard
                workflowId={wf.id}
                workflowTitle={wf.title}
                activeRunId={activeRunId}
                activeRunStatus={activeRunStatus}
                nodeTitles={monitorNodeTitles}
                revision={graphFingerprint(wf.graph, wf.title)}
                onFocusNode={focusMonitorNode}
                onOpenRun={(runId) => openRunModal({ runId: runId ?? activeRunId, workflowId: wf.id, source: 'workflow-operations' })}
                onRunStarted={(runId) => {
                  setActiveRunId(runId);
                  setActiveRunFallbackStatus('pending');
                }}
                onOpenHistory={() => openRunModal({ workflowId: wf.id, source: 'workflow-history' })}
              />
              {hasKnowledgeNode && (knowledgeBaseCount === 0 || knowledgeChunkCount === 0) && (
                <KnowledgeCanvasCallout onOpen={() => nav('/brain')} />
              )}
            </div>
          </div>
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
        {inspectorOpen && selectedPhase ? (
          <PhaseInspector
            phase={selectedPhase}
            nodeTitles={monitorNodeTitles}
            onClose={() => {
              setSelectedPhaseId(null);
              setInspectorOpen(false);
            }}
            onChange={(phase) => {
              updatePhases(workflowPhases.map((item) => item.id === phase.id ? phase : item));
            }}
            onDelete={() => {
              updatePhases(workflowPhases.filter((item) => item.id !== selectedPhase.id));
              setSelectedPhaseId(null);
              setInspectorOpen(false);
            }}
          />
        ) : inspectorOpen && (
          <ContextInspector
            selection={selection}
            workflowId={wf?.id ?? null}
            activeRunId={activeRunId}
            onOpenRun={(runId) => {
              setActiveRunId(runId);
              openRunModal({ runId, workflowId: wf?.id, source: 'node-inspector' });
            }}
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
                            ...readinessNodeData(savedNode.config, integrations, credentialTypes),
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

      <EngineModal
        open={overflowOpen}
        page={enginePage}
        onPageChange={setEnginePage}
        onClose={() => setOverflowOpen(false)}
        workflow={wf}
        spaces={spaces}
        trigger={workflowTriggerConfig(wf)}
        deployment={deployment}
        deploymentLoading={deploymentLoading}
        deploymentBusy={deploymentBusy}
        deploymentError={deploymentError}
        onOpenInputs={() => setVariablesOpen(true)}
        onOpenSettings={() => setSettingsOpen(true)}
        onManualRun={() => {
          if (openFirstIncompleteNode()) return;
          setRunDialogOpen(true);
        }}
        onActivate={() => void handleActivate()}
        onRefreshDeployment={() => void refreshDeployment()}
        onPauseDeployment={() => void setDeploymentStatus('paused')}
        onResumeDeployment={() => void setDeploymentStatus('active')}
        onCopyDeployment={(value, label) => {
          void navigator.clipboard.writeText(value).then(() => toast.success(`${label} copied`));
        }}
        onContractsChange={({ inputContract, outputContract }) => {
          const nextGraph = { ...wf.graph, inputContract, outputContract };
          setWf({ ...wf, graph: nextGraph });
          queueSave();
        }}
      />

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

      {tab === 'brain' && (
        <WorkflowBrainTab
          workflow={wf}
        />
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

      {extManagerOpen && <ExtensionsModal onClose={() => setExtManagerOpen(false)} />}
    </div>
  );
}

function normalizeWorkflowRunStatus(status?: string | null): WorkflowRunSummary['status'] | null {
  if (!status) return null;
  const value = status.trim().toLowerCase();
  if (value === 'running') return 'running';
  if (value === 'waiting') return 'waiting';
  if (value === 'paused') return 'paused';
  if (value === 'pending' || value === 'created' || value === 'planning') return 'pending';
  if (value === 'failed') return 'failed';
  if (value === 'completed') return 'completed';
  if (value === 'cancelled') return 'cancelled';
  return null;
}

function headerRunStatusLabel(status: WorkflowRunSummary['status'] | null): string {
  if (status === 'paused') return 'Paused';
  if (status === 'waiting') return 'Waiting';
  if (status === 'pending') return 'Preparing';
  if (status === 'running') return 'Running';
  if (status === 'failed') return 'Failed';
  if (status === 'completed') return 'Completed';
  return 'Run';
}

function headerRunStatusIcon(status: WorkflowRunSummary['status'] | null): ReactNode {
  if (status === 'paused') return <Pause size={12} />;
  if (status === 'waiting') return <RadioTower size={12} />;
  if (status === 'pending' || status === 'running') return <LoaderCircle size={12} className="animate-spin" />;
  if (status === 'failed') return <AlertCircle size={12} />;
  if (status === 'completed') return <CheckCircle2 size={12} />;
  return <Play size={12} />;
}

function SaveIndicator({ state, onRetry }: { state: SaveState; onRetry: () => void }) {
  const previous = useRef<SaveState>(state);
  const [showSaved, setShowSaved] = useState(false);
  const [showError, setShowError] = useState(false);

  useEffect(() => {
    if (state === 'saved' && previous.current !== 'saved') {
      setShowSaved(true);
      const timer = window.setTimeout(() => setShowSaved(false), 1200);
      setShowError(false);
      previous.current = state;
      return () => window.clearTimeout(timer);
    }
    if (state === 'error' && previous.current !== 'error') {
      setShowError(true);
      const timer = window.setTimeout(() => setShowError(false), 2200);
      setShowSaved(false);
      previous.current = state;
      return () => window.clearTimeout(timer);
    }
    if (state !== 'saved') setShowSaved(false);
    if (state !== 'error') setShowError(false);
    previous.current = state;
    return undefined;
  }, [state]);

  if (state === 'saved') {
    if (!showSaved) return null;
    return <CheckCircle2 size={13} className="text-success" aria-label="Saved" />;
  }
  if (state === 'saving') return <LoaderCircle size={13} className="animate-spin text-text-muted" aria-label="Saving" />;
  if (state === 'dirty')
    return (
      <span className="h-1.5 w-1.5 rounded-full bg-text-muted" aria-label="Unsaved changes" />
    );
  if (!showError) return null;
  return (
    <button
      type="button"
      onClick={onRetry}
      className="inline-flex h-6 w-6 items-center justify-center rounded text-danger transition-colors hover:bg-danger-soft"
      title="Auto-save failed. Retry"
      aria-label="Auto-save failed"
    >
      <AlertCircle size={12} />
    </button>
  );
}

function graphFingerprint(graph: WorkflowDetail['graph'], title: string): string {
  return JSON.stringify({ title, graph });
}

export function WorkflowBrainTab({
  workflow,
  kind = 'workflow',
}: {
  // Narrowed from WorkflowDetail to the fields the brain view reads, so the App
  // editor's Brain facet can reuse it (scoped to the App) without loading the
  // full workflow detail.
  workflow: { id: string; title: string };
  kind?: 'workflow' | 'app';
}) {
  const [view, setView] = useState<BrainSection>('map');
  const endpoint = `/v1/brain/graph?scope=scoped&scopeId=${workflow.id}&includeWorkspace=false`;
  const detailEndpoint = `/v1/brain/graph/node/:id?scope=scoped&scopeId=${workflow.id}&includeWorkspace=false`;

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-canvas">
      <div className="flex h-11 shrink-0 items-center justify-between gap-3 border-b border-line bg-surface px-6">
        <span className="text-[12px] font-semibold text-text-muted">{kind === 'app' ? 'App intelligence' : 'Workflow intelligence'}</span>
        <div className="flex items-center gap-2">
          <ScopeVisibilityToggle scopeId={workflow.id} />
          <BrainSectionNav value={view} onChange={setView} />
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        {view === 'map' ? (
          <ScopedBrainMap
            endpoint={endpoint}
            detailEndpoint={detailEndpoint}
            layoutKey={`${kind}-${workflow.id}`}
            scopeName={workflow.title}
            scopeId={workflow.id}
            emptyMessage={kind === 'app'
              ? 'This App has not formed Brain knowledge yet. Promote a record to memory (the agent\'s data_promote_memory tool) or have the operator run its logic to build its map.'
              : 'This workflow has not produced scoped Brain knowledge yet. Add knowledge, save memory, or run it once to form its map.'}
          />
        ) : view === 'knowledge' ? (
          <KnowledgeTab scopeId={workflow.id} scopeName={workflow.title} />
        ) : (
          // Episodes are written scoped to the owning App's id (kind='app', where
          // workflow.id IS the app id — scopeId already matches). A plain workflow's
          // runs are written scoped to the executing agent instead, but every episode
          // still records its own workflowId column — filter on that instead of the
          // (never-matching) scopeId so this tab isn't structurally always empty.
          <InsightsTab scopeId={workflow.id} episodeWorkflowId={kind === 'workflow' ? workflow.id : undefined} />
        )}
      </div>
    </div>
  );
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
  const liveNodeIds = new Set(nextNodes.map((node) => node.id));
  const phases = sanitizeWorkflowPhases(prevGraph.phases, liveNodeIds);
  const { phases: _discardedPhases, viewport, ...graphRest } = prevGraph;
  return {
    ...graphRest,
    viewport: viewport ?? { x: 0, y: 0, zoom: 1 },
    nodes: nextNodes,
    edges: nextEdges,
    ...(phases ? { phases } : {}),
  };
}

function sanitizeWorkflowPhases(
  phases: WorkflowDetail['graph']['phases'],
  liveNodeIds: Set<string>,
): WorkflowPhase[] | undefined {
  if (!phases?.length) return undefined;
  const phaseIds = new Set<string>();
  const assignedNodes = new Set<string>();
  const sanitized: WorkflowPhase[] = [];

  phases.forEach((phase, index) => {
    const baseId = phase.id?.trim() || `phase-${index + 1}`;
    let id = baseId;
    let suffix = 2;
    while (phaseIds.has(id)) {
      id = `${baseId}-${suffix}`;
      suffix += 1;
    }
    phaseIds.add(id);

    const nodeIds = phase.nodeIds.filter((nodeId) => {
      if (!liveNodeIds.has(nodeId) || assignedNodes.has(nodeId)) return false;
      assignedNodes.add(nodeId);
      return true;
    });
    if (nodeIds.length === 0) return;

    sanitized.push({
      ...phase,
      id,
      name: phase.name?.trim() || `Phase ${index + 1}`,
      color: /^#[0-9a-fA-F]{6}$/.test(phase.color)
        ? phase.color
        : WORKFLOW_PHASE_COLORS[index % WORKFLOW_PHASE_COLORS.length]!,
      nodeIds,
    });
  });

  return sanitized.length > 0 ? sanitized : undefined;
}

function EngineModal({
  open,
  page,
  onPageChange,
  onClose,
  workflow,
  spaces,
  trigger,
  deployment,
  deploymentLoading,
  deploymentBusy,
  deploymentError,
  onOpenInputs,
  onOpenSettings,
  onManualRun,
  onActivate,
  onRefreshDeployment,
  onPauseDeployment,
  onResumeDeployment,
  onCopyDeployment,
  onContractsChange,
}: {
  open: boolean;
  page: EnginePage;
  onPageChange: (page: EnginePage) => void;
  onClose: () => void;
  workflow: WorkflowDetail;
  spaces: SpaceSummary[];
  trigger: Record<string, unknown> | null;
  deployment: WorkflowDeployment | null;
  deploymentLoading: boolean;
  deploymentBusy: boolean;
  deploymentError: string | null;
  onOpenInputs: () => void;
  onOpenSettings: () => void;
  onManualRun: () => void;
  onActivate: () => void;
  onRefreshDeployment: () => void;
  onPauseDeployment: () => void;
  onResumeDeployment: () => void;
  onCopyDeployment: (value: string, label: string) => void;
  onContractsChange: (contracts: {
    inputContract?: WorkflowContractValue;
    outputContract?: WorkflowContractValue;
  }) => void;
}) {
  if (!open) return null;
  const phaseCount = workflow.graph.phases?.length ?? 0;
  const inputCount = workflow.variables?.length ?? 0;
  const spaceName = spaces.find((space) => space.id === workflow.spaceId)?.name ?? 'Unassigned';
  const pages: Array<{ id: EnginePage; label: string; icon: ReactNode }> = [
    { id: 'overview', label: 'Overview', icon: <Settings size={13} /> },
    { id: 'inputs', label: 'Inputs', icon: <Variable size={13} /> },
    { id: 'settings', label: 'Settings', icon: <Settings size={13} /> },
    { id: 'contracts', label: 'I/O contracts', icon: <FileSignature size={13} /> },
    { id: 'chains', label: 'Event chains', icon: <GitBranch size={13} /> },
    { id: 'activation', label: 'Activation', icon: <Upload size={13} /> },
  ];

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-canvas/60 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label="Workflow engine"
      onClick={onClose}
    >
      <div
        className="flex h-[min(720px,86vh)] w-[min(920px,94vw)] overflow-hidden rounded-2xl border border-line bg-surface shadow-modal"
        onClick={(event) => event.stopPropagation()}
      >
        <aside className="w-48 shrink-0 border-r border-line bg-canvas/55 p-2">
          <div className="px-2 py-2">
            <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-accent">Engine</div>
            <div className="mt-1 truncate text-[13px] font-semibold text-text-primary">{workflow.title}</div>
          </div>
          <nav className="mt-2 space-y-1">
            {pages.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => onPageChange(item.id)}
                className={clsx(
                  'flex h-9 w-full items-center gap-2 rounded-lg px-2 text-left text-[12px] font-medium transition-colors',
                  page === item.id
                    ? 'bg-surface-2 text-text-primary'
                    : 'text-text-muted hover:bg-surface hover:text-text-secondary',
                )}
              >
                {item.icon}
                {item.label}
              </button>
            ))}
          </nav>
        </aside>
        <section className="flex min-w-0 flex-1 flex-col">
          <header className="flex h-12 shrink-0 items-center justify-between border-b border-line px-4">
            <div>
              <div className="text-[10px] uppercase tracking-wider text-text-muted">Workflow engine</div>
              <div className="text-[13px] font-semibold text-text-primary">{pages.find((item) => item.id === page)?.label}</div>
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close engine"
              className="-m-1 rounded-md p-1 text-text-muted hover:bg-surface-2 hover:text-text-primary"
            >
              <X size={16} />
            </button>
          </header>
          <div className="min-h-0 flex-1 overflow-auto p-4">
            {page === 'overview' && (
              <div className="grid gap-3 md:grid-cols-2">
                <EngineStat label="Nodes" value={String(workflow.graph.nodes.length)} />
                <EngineStat label="Phases" value={String(phaseCount)} />
                <EngineStat label="Inputs" value={String(inputCount)} />
                <EngineStat label="Domain" value={spaceName} />
                <div className="md:col-span-2 rounded-xl border border-line bg-canvas/45 p-3">
                  <div className="text-[12px] font-semibold text-text-primary">Description</div>
                  <p className="mt-1 text-[12px] leading-relaxed text-text-secondary">
                    {workflow.description || 'No description yet. Add one in Settings so operators understand what this workflow does.'}
                  </p>
                </div>
              </div>
            )}
            {page === 'inputs' && (
              <div className="space-y-3">
                <div className="rounded-xl border border-line bg-canvas/45 p-3">
                  <div className="text-[12px] font-semibold text-text-primary">Run inputs</div>
                  <p className="mt-1 text-[12px] text-text-secondary">
                    {inputCount === 0 ? 'This workflow does not request inputs yet.' : `${inputCount} input${inputCount === 1 ? '' : 's'} configured.`}
                  </p>
                </div>
                <Button variant="secondary" size="sm" iconLeft={<Variable size={13} />} onClick={onOpenInputs}>
                  Edit inputs
                </Button>
              </div>
            )}
            {page === 'settings' && (
              <div className="space-y-3">
                <EngineStat label="Title" value={workflow.title} />
                <EngineStat label="Domain" value={spaceName} />
                <Button variant="secondary" size="sm" iconLeft={<Settings size={13} />} onClick={onOpenSettings}>
                  Edit workflow settings
                </Button>
              </div>
            )}
            {page === 'contracts' && (
              <WorkflowContractsPanel
                inputContract={(workflow.graph as { inputContract?: WorkflowContractValue }).inputContract}
                outputContract={(workflow.graph as { outputContract?: WorkflowContractValue }).outputContract}
                onChange={onContractsChange}
              />
            )}
            {page === 'chains' && <EventChainsPanel workflowId={workflow.id} />}
            {page === 'activation' && (
              <div className="space-y-3">
                <Button variant="secondary" size="sm" iconLeft={<Play size={13} />} onClick={onManualRun}>
                  Run manually
                </Button>
                <div className="overflow-hidden rounded-xl border border-line">
                  <DeploymentPanel
                    trigger={trigger}
                    deployment={deployment}
                    loading={deploymentLoading}
                    busy={deploymentBusy}
                    error={deploymentError}
                    onActivate={onActivate}
                    onRefresh={onRefreshDeployment}
                    onPause={onPauseDeployment}
                    onResume={onResumeDeployment}
                    onCopy={onCopyDeployment}
                  />
                </div>
              </div>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}

function EngineStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-line bg-canvas/45 p-3">
      <div className="text-[10px] uppercase tracking-wider text-text-muted">{label}</div>
      <div className="mt-1 truncate text-[13px] font-semibold text-text-primary">{value}</div>
    </div>
  );
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

function DeploymentPanel({
  trigger,
  deployment,
  loading,
  busy,
  error,
  onActivate,
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
  onActivate: () => void;
  onRefresh: () => void;
  onPause: () => void;
  onResume: () => void;
  onCopy: (value: string, label: string) => void;
}) {
  const triggerType = String(trigger?.triggerType ?? 'manual');
  const readiness = trigger ? evaluateNodeReadiness(trigger) : { ready: false, message: 'Add a trigger node.' };
  const meta = deploymentMeta(triggerType);
  const changed = Boolean(deployment && deploymentDiffersFromDraft(deployment, trigger));

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
            aria-label="Refresh activation status"
            title="Refresh activation status"
          >
            <RefreshCw size={12} className={loading ? 'animate-spin' : undefined} />
          </button>
        </div>
      </div>

      <div className="space-y-3 px-3.5 py-3">
        {loading && !deployment ? (
          <div className="space-y-2" aria-label="Loading activation">
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
                The canvas trigger changed after the last activation. Activate again to apply the draft.
              </div>
            )}
            {error && (
              <div className="rounded-input border border-danger/30 bg-danger-soft px-2.5 py-2 text-[11px] leading-4 text-danger">
                {error}
              </div>
            )}

            {deployment?.triggerType === 'manual' && (
              <DeploymentValue
                label="Manual run"
                value={deployment.status === 'active' ? 'Ready to run manually' : 'Paused'}
              />
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
                  onClick={onActivate}
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
                    onClick={onActivate}
                  >
                    Reactivate
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
  if (triggerType === 'manual') {
    return {
      title: 'Manual run',
      description: 'Activate the current graph as the version used by manual runs.',
      action: 'Activate manual run',
      icon: <Play size={15} />,
    };
  }
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

function activationSuccessMessage(triggerType: WorkflowDeployment['triggerType']): string {
  if (triggerType === 'manual') return 'Manual run activated';
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
              {nestedDomainOptions(spaces).map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label}
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

function readinessNodeData(
  config: unknown,
  integrations: readonly IntegrationManifestLite[],
  credentialTypes: readonly string[],
) {
  const readiness = evaluateNodeReadiness(config, { integrations, credentialTypes });
  return {
    pendingConfig: !readiness.ready,
    readinessMessage: readiness.message ?? undefined,
  };
}

function agentCapabilityNodeData(
  config: { kind?: string; requires?: AgentRequirements } | unknown,
  agents: AgentCapabilityRow[],
): { requiredCapabilities?: string[]; agentMatches?: CanvasAgentMatch[]; runtimeLabel?: string } {
  const c = config as { kind?: string; requires?: unknown; agentId?: unknown; agentRole?: unknown } | null;
  if (!c || (c.kind !== 'agent_task' && c.kind !== 'agent_session')) {
    return { requiredCapabilities: undefined, agentMatches: undefined, runtimeLabel: undefined };
  }
  const boundAgent = typeof c.agentId === 'string'
    ? agents.find((agent) => agent.id === c.agentId)
    : undefined;
  const connectedAgent = agents.find((agent) => ['online', 'busy', 'active', 'running'].includes(String(agent.status ?? '').toLowerCase()));
  const role = typeof c.agentRole === 'string' && c.agentRole.trim() ? c.agentRole.trim() : '';
  const runtimeLabel = boundAgent?.name ?? (role ? `${role} specialist` : connectedAgent ? `Auto: ${connectedAgent.name}` : 'Auto runtime');
  const requirements = normalizeAgentRequirements(c.requires);
  if (!hasAgentRequirements(requirements)) {
    return { requiredCapabilities: undefined, agentMatches: undefined, runtimeLabel };
  }
  return {
    runtimeLabel,
    requiredCapabilities: requiredAffordanceKeys(requirements).map(affordanceLabel),
    agentMatches: connectedAgentMatches(agents, requirements).map((match) => ({
      id: match.id,
      name: match.name,
      satisfied: match.satisfied,
      provided: match.provided,
      missing: match.missing,
    })),
  };
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



