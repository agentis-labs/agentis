import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type SetStateAction,
  type WheelEvent as ReactWheelEvent,
} from 'react';
import { useNavigate } from 'react-router-dom';
import { REALTIME_EVENTS } from '@agentis/core';
import {
  AlertTriangle,
  Bot,
  Boxes,
  BrainCircuit,
  BookOpen,
  CheckCircle2,
  Clock,
  Database,
  FileText,
  Layers,
  PackageOpen,
  ShieldCheck,
  Workflow,
  X,
  Square,
  Wrench,
  Loader2,
  Zap,
  RefreshCw,
  Sparkles,
  Activity as ActivityIcon,
  MessageSquare,
} from 'lucide-react';
import clsx from 'clsx';
import { api, workspace as workspaceStore } from '../../lib/api';
import { useRealtime } from '../../lib/realtime';
import { useRunActivity } from '../../lib/useRunActivity';
import {
  useWorkspaceActivity,
  useLiveNodeIds,
  workspaceRequestStatus,
  isWorkActivity,
  type WorkspaceRequestStatus,
} from '../../lib/useWorkspaceActivity';
import type { RealtimeActivity } from '../../lib/realtimeActivity';
import type {
  WorkspaceActiveRun,
  WorkspaceAgent,
  WorkspaceApproval,
  WorkspaceArtifact,
  WorkspaceFailedRun,
  WorkspaceFleetOverview,
  WorkspaceUser,
} from '../../lib/workspaceData';
import { useChatPanelStore, type ChatPanelState } from '../chat/ChatPanelStore';
import { AgentCreateWizard } from '../agents/AgentCreateWizard';
import { captureFlip, type FlipSnapshot } from '../shared/flip';
import { CanvasActivityPopover } from './CanvasActivityPopover';
import { CanvasApprovalNodeBadge } from './CanvasApprovalNode';
import { CanvasBackground, type CanvasBackgroundHandle } from './CanvasBackground';
import { CanvasComposerOverlay } from './CanvasComposerOverlay';
import { CanvasHudBar } from './CanvasHudBar';
import { CanvasNodeDetailPanel } from './CanvasNodeDetailPanel';
import { CanvasRadialLight } from './CanvasRadialLight';
import type {
  CanvasEdge,
  CanvasModel,
  CanvasNode,
  CanvasOperationalState,
  ComposerRecentCompletion,
  EcosystemData,
  EdgeAnimation,
  FleetCounts,
  HomeKnowledgeBase,
  HomeSpace,
  HomeWorkflow,
  Vec2,
} from './homeCanvasTypes';

interface WorkspaceEcosystemCanvasProps {
  agents: WorkspaceAgent[];
  activeRuns: WorkspaceActiveRun[];
  artifacts: WorkspaceArtifact[];
  snapshotLoading: boolean;
  approvals?: WorkspaceApproval[];
  failedRuns?: WorkspaceFailedRun[];
  me?: WorkspaceUser | null;
  fleet?: WorkspaceFleetOverview | null;
  counts?: { liveAgents: number; activeRuns: number };
}

interface CanvasViewport {
  pan: Vec2;
  zoom: number;
}

interface DragState {
  pointerId: number;
  start: Vec2;
  origin: Vec2;
  dragged: boolean;
  surface: HTMLDivElement;
  cleanup: () => void;
}

interface VirtualCanvasSize {
  width: number;
  height: number;
}

interface CanvasInsets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

interface CanvasBounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

interface TriagePanelFrame {
  x: number;
  y: number;
  width: number;
  height: number;
}

type EntrancePhase = 'idle' | 'background' | 'orchestrator' | 'managers' | 'workers' | 'resources' | 'complete';

const EMPTY_DATA: EcosystemData = {
  workflows: [],
  knowledgeBases: [],
  spaces: [],
  loading: true,
};
const EMPTY_APPROVALS: WorkspaceApproval[] = [];
const EMPTY_FAILED_RUNS: WorkspaceFailedRun[] = [];

const ECOSYSTEM_REFRESH_EVENTS = [
  REALTIME_EVENTS.WORKFLOW_CREATED,
  REALTIME_EVENTS.WORKFLOW_UPDATED,
  REALTIME_EVENTS.WORKFLOW_DELETED,
  REALTIME_EVENTS.RUN_CREATED,
  REALTIME_EVENTS.RUN_RUNNING,
  REALTIME_EVENTS.RUN_COMPLETED,
  REALTIME_EVENTS.RUN_FAILED,
  REALTIME_EVENTS.AGENT_CREATED,
  REALTIME_EVENTS.AGENT_UPDATED,
  REALTIME_EVENTS.AGENT_STATUS_CHANGED,
  REALTIME_EVENTS.AGENT_HEARTBEAT,
  REALTIME_EVENTS.ARTIFACT_CREATED,
  REALTIME_EVENTS.ARTIFACT_UPDATED,
  REALTIME_EVENTS.ARTIFACT_DELETED,
  REALTIME_EVENTS.SPACE_CREATED,
  REALTIME_EVENTS.SPACE_UPDATED,
  REALTIME_EVENTS.SPACE_DELETED,
] as const;

const NODE = {
  orchestrator: { width: 252, height: 88 },
  manager: { width: 224, height: 84 },
  worker: { width: 178, height: 66 },
  workflow: { width: 196, height: 68 },
  knowledge: { width: 176, height: 62 },
  approval: { width: 190, height: 68 },
  artifact: { width: 150, height: 48 },
  resource: { width: 190, height: 70 },
};

const VIEWPORT_MIN = 0.36;
const VIEWPORT_MAX = 2.25;
const TRIAGE_PANEL_MARGIN = 12;
const TRIAGE_PANEL_MIN_WIDTH = 296;
const TRIAGE_PANEL_MIN_HEIGHT = 272;
const TRIAGE_PANEL_DEFAULT_FRAME: TriagePanelFrame = {
  x: 14,
  y: 14,
  width: 332,
  height: 286,
};

export function WorkspaceEcosystemCanvas({
  agents,
  activeRuns,
  artifacts,
  snapshotLoading,
  approvals: approvalsProp,
  failedRuns: failedRunsProp,
  me = null,
  fleet = null,
  counts,
}: WorkspaceEcosystemCanvasProps) {
  const approvals = approvalsProp ?? EMPTY_APPROVALS;
  const failedRuns = failedRunsProp ?? EMPTY_FAILED_RUNS;
  const nav = useNavigate();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const viewportRef = useRef<CanvasViewport>({ pan: { x: 0, y: 0 }, zoom: 1 });
  const dragRef = useRef<DragState | null>(null);
  const rafRef = useRef<number | null>(null);
  const wheelCommitRef = useRef<number | null>(null);
  const initialCenteredRef = useRef(false);
  const userMovedRef = useRef(false);
  const responsiveFitKeyRef = useRef('');
  const entranceTimersRef = useRef<number[]>([]);
  const svgLayerRef = useRef<SVGGElement | null>(null);
  const nodeLayerRef = useRef<HTMLDivElement | null>(null);
  const bgRef = useRef<CanvasBackgroundHandle | null>(null);

  const [containerSize, setContainerSize] = useState<VirtualCanvasSize>({ width: 1200, height: 760 });
  const [data, setData] = useState<EcosystemData>(EMPTY_DATA);
  const [viewport, setViewportState] = useState<CanvasViewport>({ pan: { x: 0, y: 0 }, zoom: 1 });
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);
  const [triageOpen, setTriageOpen] = useState(false);
  /** Domains the operator expanded past their one-band idle cap ("+N more"). */
  const [expandedDomains, setExpandedDomains] = useState<ReadonlySet<string>>(new Set<string>());
  const [triageFrame, setTriageFrame] = useState<TriagePanelFrame>(() => ({ ...TRIAGE_PANEL_DEFAULT_FRAME }));
  const [isPanning, setIsPanning] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [entrancePhase, setEntrancePhase] = useState<EntrancePhase>('idle');
  const [createPreset, setCreatePreset] = useState<{ role: 'orchestrator' | 'manager' | 'worker'; flipFrom: FlipSnapshot | null; lock: boolean } | null>(null);
  const chatState = useChatPanelStore((state) => state.state);
  const dockedWidth = useChatPanelStore((state) => state.dockedWidth);

  const refresh = useCallback(async () => {
    setData((current) => ({ ...current, loading: true }));
    const [workflowsRes, knowledgeRes, spacesRes] = await Promise.allSettled([
      api<{ workflows: HomeWorkflow[] }>('/v1/workflows'),
      api<{ knowledgeBases: HomeKnowledgeBase[] }>('/v1/knowledge-bases'),
      api<{ data: HomeSpace[] }>('/v1/spaces'),
    ]);
    setData({
      workflows: workflowsRes.status === 'fulfilled' ? workflowsRes.value.workflows ?? [] : [],
      knowledgeBases: knowledgeRes.status === 'fulfilled' ? knowledgeRes.value.knowledgeBases ?? [] : [],
      spaces: spacesRes.status === 'fulfilled' ? spacesRes.value.data ?? [] : [],
      loading: false,
    });
  }, []);

  useEffect(() => {
    void refresh();
    window.addEventListener('agentis:workspace-changed', refresh);
    return () => window.removeEventListener('agentis:workspace-changed', refresh);
  }, [refresh]);

  useRealtime([...ECOSYSTEM_REFRESH_EVENTS], () => {
    void refresh();
  });

  useEffect(() => {
    const node = containerRef.current;
    if (!node) return undefined;
    const observer = new ResizeObserver(([entry]) => {
      const rect = entry?.contentRect;
      if (!rect) return;
      setContainerSize({ width: Math.max(360, rect.width), height: Math.max(360, rect.height) });
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => () => {
    stopAnimation();
    if (wheelCommitRef.current !== null) {
      window.clearTimeout(wheelCommitRef.current);
      wheelCommitRef.current = null;
    }
  }, []);

  useEffect(() => {
    const onFullscreenChange = () => {
      const active = Boolean(document.fullscreenElement);
      setIsFullscreen(active);
      document.body.classList.toggle('agentis-canvas-fullscreen', active);
      if (!active) document.body.classList.remove('agentis-canvas-fullscreen');
    };
    document.addEventListener('fullscreenchange', onFullscreenChange);
    return () => {
      document.removeEventListener('fullscreenchange', onFullscreenChange);
      document.body.classList.remove('agentis-canvas-fullscreen');
    };
  }, []);

  const artifactFocusWorkflowId = useMemo(() => {
    if (selectedNodeId?.startsWith('workflow-')) return selectedNodeId.slice('workflow-'.length);
    if (selectedNodeId?.startsWith('artifact-')) {
      const artifactId = selectedNodeId.slice('artifact-'.length);
      return artifacts.find((artifact) => artifact.id === artifactId)?.workflowId ?? null;
    }
    return null;
  }, [artifacts, selectedNodeId]);
  const revealKnowledgeNodes = shouldRevealKnowledgeNodes(selectedNodeId, agents);
  const canvasData = useMemo<EcosystemData>(
    () => revealKnowledgeNodes ? data : { ...data, knowledgeBases: [] },
    [data, revealKnowledgeNodes],
  );
  const canvasArtifacts = useMemo(
    () => selectCanvasArtifacts(artifacts, artifactFocusWorkflowId),
    [artifactFocusWorkflowId, artifacts],
  );

  const virtualSize = useMemo(
    () => computeVirtualCanvasSize(canvasData, agents, activeRuns, canvasArtifacts, approvals, containerSize),
    [canvasData, agents, activeRuns, canvasArtifacts, approvals, containerSize],
  );

  const model = useMemo(
    () => buildCanvasModel(canvasData, agents, activeRuns, canvasArtifacts, approvals, failedRuns, virtualSize, selectedNodeId, expandedDomains),
    [canvasData, agents, activeRuns, canvasArtifacts, approvals, failedRuns, selectedNodeId, virtualSize, expandedDomains],
  );
  const contentBounds = useMemo(() => computeCanvasContentBounds(model.nodes), [model.nodes]);

  const selectedNode = useMemo(
    () => model.nodes.find((node) => node.id === selectedNodeId) ?? null,
    [model.nodes, selectedNodeId],
  );

  // Workspace-wide live activity spine — powers Mission Control's stream and the
  // canvas's "orchestrator is working right now" liveness (nodes/edges pulse).
  const activeRunIds = useMemo(
    () => activeRuns.filter(isActiveRun).map((run) => run.id),
    [activeRuns],
  );
  const nodeTitleFor = useCallback(
    (id: string) => model.nodes.find((n) => n.id === `workflow-${id}` || n.id === id)?.title,
    [model.nodes],
  );
  const workspaceActivity = useWorkspaceActivity(activeRunIds, { nodeTitle: nodeTitleFor });
  const requestStatus = useMemo(() => workspaceRequestStatus(workspaceActivity), [workspaceActivity]);
  const liveIds = useLiveNodeIds(workspaceActivity);

  // Canvas node ids currently working (agent-/workflow- prefixed), plus the
  // orchestrator while it processes a request — drives node/edge pulse.
  const liveNodeIds = useMemo(() => {
    const set = new Set<string>();
    for (const a of liveIds.agentIds) set.add(`agent-${a}`);
    for (const w of liveIds.workflowIds) set.add(`workflow-${w}`);
    if (requestStatus.busy && model.orchestratorId) set.add(model.orchestratorId);
    return set;
  }, [liveIds, requestStatus.busy, model.orchestratorId]);

  // nodeId → its current step/thought, for the on-canvas live caption.
  // Work events only (runs/nodes/tools) — ambient agent chatter (status pings,
  // chat-memory capture) must never caption a node.
  const liveCaptions = useMemo(() => {
    const map = new Map<string, string>();
    for (const item of workspaceActivity) {
      if (!isWorkActivity(item)) continue;
      const text = item.detail || item.title;
      if (!text) continue;
      if (item.agentId) { const k = `agent-${item.agentId}`; if (!map.has(k)) map.set(k, text); }
      if (item.workflowId) { const k = `workflow-${item.workflowId}`; if (!map.has(k)) map.set(k, text); }
    }
    if (requestStatus.busy && model.orchestratorId && requestStatus.label && !map.has(model.orchestratorId)) {
      map.set(model.orchestratorId, requestStatus.label);
    }
    return map;
  }, [workspaceActivity, requestStatus.busy, requestStatus.label, model.orchestratorId]);

  // Select a workflow's canvas node (opens its detail card) — used by Mission
  // Control's failed/active rows so triage stays on the canvas.
  const selectWorkflowNode = useCallback((workflowId: string) => {
    setSelectedNodeId(`workflow-${workflowId}`);
  }, []);

  // When the orchestrator/agents start working on a request, surface Mission
  // Control automatically (open-only; never force-closes what the user opened).
  const wasBusyRef = useRef(false);
  useEffect(() => {
    if (requestStatus.busy && !wasBusyRef.current) setTriageOpen(true);
    wasBusyRef.current = requestStatus.busy;
  }, [requestStatus.busy]);
  const hoveredNode = useMemo(
    () => model.nodes.find((node) => node.id === hoveredNodeId) ?? null,
    [model.nodes, hoveredNodeId],
  );
  const orchestratorNode = model.orchestratorId
    ? model.nodes.find((node) => node.id === model.orchestratorId) ?? null
    : null;
  const nodeMap = useMemo(() => new Map(model.nodes.map((node) => [node.id, node])), [model.nodes]);
  const focusedNodeIds = useMemo(() => {
    if (!selectedNodeId) return null;
    const ids = new Set<string>([selectedNodeId]);
    const descendants = [selectedNodeId];
    while (descendants.length > 0) {
      const current = descendants.shift()!;
      for (const edge of model.edges) {
        if (edge.from !== current || ids.has(edge.to)) continue;
        ids.add(edge.to);
        descendants.push(edge.to);
      }
    }
    const ancestors = [selectedNodeId];
    while (ancestors.length > 0) {
      const current = ancestors.shift()!;
      for (const edge of model.edges) {
        if (edge.to !== current || ids.has(edge.from)) continue;
        ids.add(edge.from);
        ancestors.push(edge.from);
      }
    }
    return ids;
  }, [model.edges, selectedNodeId]);

  useEffect(() => {
    if (selectedNodeId && !model.nodes.some((node) => node.id === selectedNodeId)) setSelectedNodeId(null);
  }, [model.nodes, selectedNodeId]);

  useEffect(() => {
    const fitKey = [
      Math.round(containerSize.width),
      Math.round(containerSize.height),
      chatState,
      Math.round(dockedWidth),
      model.nodes.length,
    ].join(':');
    const responsiveLayoutChanged = responsiveFitKeyRef.current !== fitKey;
    if (initialCenteredRef.current && userMovedRef.current && !responsiveLayoutChanged) return;
    if (containerSize.width <= 0 || model.nodes.length === 0) return;
    const next = computeHomeViewport(containerSize, contentBounds, chatState, dockedWidth, orchestratorNode);
    setViewport(next);
    responsiveFitKeyRef.current = fitKey;
    initialCenteredRef.current = true;
  }, [chatState, containerSize, contentBounds, dockedWidth, model.nodes.length, orchestratorNode]);

  const orchestratorScreen = orchestratorNode ? canvasToScreen(orchestratorNode, viewport) : null;
  const hoverScreen = hoveredNode ? canvasToScreen(hoveredNode, viewport) : null;
  const loading = (data.loading || snapshotLoading) && model.nodes.every((node) => node.ghost);
  const runningCount = counts?.activeRuns ?? activeRuns.filter(isActiveRun).length;
  const fleetCounts: FleetCounts = {
    activeAgents: runningCount,
    runningAgents: runningCount,
    idleAgents: Math.max(0, agents.length - runningCount),
    attentionCount: approvals.length + failedRuns.length,
    approvalCount: approvals.length,
    failedRunCount: failedRuns.length,
    workflows: data.workflows.length || activeRuns.length || fleet?.runs.active || 0,
    artifactsToday: artifactsProducedToday(artifacts),
  };
  const recentCompletions = useMemo<ComposerRecentCompletion[]>(
    () => artifacts.map((artifact) => ({
      workflowName: artifact.title,
      completedAt: new Date(artifact.createdAt).getTime() || Date.now(),
    })),
    [artifacts],
  );

  useEffect(() => {
    if (loading || entrancePhase !== 'idle') return;
    const schedule = (delayMs: number, phase: EntrancePhase) => {
      const timer = window.setTimeout(() => setEntrancePhase(phase), delayMs);
      entranceTimersRef.current.push(timer);
    };
    setEntrancePhase('background');
    schedule(150, 'orchestrator');
    schedule(600, 'managers');
    schedule(1000, 'workers');
    schedule(1300, 'resources');
    schedule(1600, 'complete');
  }, [entrancePhase, loading]);

  useEffect(() => () => {
    for (const timer of entranceTimersRef.current) window.clearTimeout(timer);
    entranceTimersRef.current = [];
    dragRef.current?.cleanup();
    dragRef.current = null;
  }, []);

  // The transform is driven imperatively (applyViewportToDOM) so high-frequency
  // pan/zoom never pays a React render. But unrelated re-renders (the 1s clock,
  // realtime agent updates) would otherwise reconcile the JSX transform back to
  // the last committed `viewport` state — snapping the canvas mid-drag. This
  // layout effect runs after every render and re-asserts the live viewport.
  useLayoutEffect(() => {
    applyViewportToDOM(viewportRef.current);
  });

  function setViewport(next: CanvasViewport) {
    viewportRef.current = next;
    applyViewportToDOM(next);
    setViewportState(next);
  }

  function stopAnimation() {
    if (rafRef.current !== null) {
      window.cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
  }

  function animateViewportTo(target: CanvasViewport, duration = 280) {
    stopAnimation();
    const start = viewportRef.current;
    const startedAt = performance.now();
    const tick = (frameNow: number) => {
      const t = clamp((frameNow - startedAt) / duration, 0, 1);
      const eased = 1 - Math.pow(1 - t, 3);
      const vp: CanvasViewport = {
        zoom: lerp(start.zoom, target.zoom, eased),
        pan: {
          x: lerp(start.pan.x, target.pan.x, eased),
          y: lerp(start.pan.y, target.pan.y, eased),
        },
      };
      viewportRef.current = vp;
      applyViewportToDOM(vp);
      if (t < 1) {
        rafRef.current = window.requestAnimationFrame(tick);
      } else {
        rafRef.current = null;
        setViewportState(vp);
      }
    };
    rafRef.current = window.requestAnimationFrame(tick);
  }

  function centerOnNode(node: CanvasNode) {
    const insets = computeViewportInsets(containerSize, chatState, dockedWidth);
    const safeWidth = Math.max(1, containerSize.width - insets.left - insets.right);
    const safeHeight = Math.max(1, containerSize.height - insets.top - insets.bottom);
    const safeCenter = {
      x: insets.left + safeWidth / 2,
      y: insets.top + safeHeight / 2,
    };
    const targetZoom = clamp(Math.max(viewportRef.current.zoom, node.kind === 'orchestrator' ? 1.08 : 1.22), VIEWPORT_MIN, VIEWPORT_MAX);
    animateViewportTo({
      zoom: targetZoom,
      pan: {
        x: safeCenter.x - node.x * targetZoom,
        y: safeCenter.y - node.y * targetZoom,
      },
    });
  }

  const resetViewport = useCallback(() => {
    userMovedRef.current = false;
    setSelectedNodeId(null);
    animateViewportTo(computeHomeViewport(containerSize, contentBounds, chatState, dockedWidth, orchestratorNode), 340);
  }, [chatState, containerSize, contentBounds, dockedWidth, orchestratorNode]);

  const toggleFullscreen = useCallback(async () => {
    if (isFullscreen || document.fullscreenElement) {
      if (document.fullscreenElement) {
        await document.exitFullscreen().catch(() => undefined);
      } else {
        document.body.classList.remove('agentis-canvas-fullscreen');
        setIsFullscreen(false);
      }
      return;
    }
    document.body.classList.add('agentis-canvas-fullscreen');
    setIsFullscreen(true);
    await document.documentElement.requestFullscreen().catch(() => undefined);
  }, [isFullscreen]);

  useEffect(() => {
    if (!isFullscreen) return;
    userMovedRef.current = false;
    const timer = window.setTimeout(() => {
      animateViewportTo(computeHomeViewport(containerSize, contentBounds, chatState, dockedWidth, orchestratorNode), 280);
    }, 80);
    return () => window.clearTimeout(timer);
  }, [isFullscreen, chatState, containerSize, contentBounds, dockedWidth, orchestratorNode]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable)) return;
      if (event.key === 'Home') {
        event.preventDefault();
        resetViewport();
        return;
      }
      if (event.key.toLowerCase() === 'f') {
        event.preventDefault();
        void toggleFullscreen();
        return;
      }
      if (event.key.toLowerCase() === 'c') {
        event.preventDefault();
        useChatPanelStore.getState().toggle();
        return;
      }
      if (event.key === 'Escape') {
        if (selectedNodeId) {
          event.preventDefault();
          setSelectedNodeId(null);
          return;
        }
        if (isFullscreen || document.fullscreenElement) {
          event.preventDefault();
          void toggleFullscreen();
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isFullscreen, resetViewport, selectedNodeId, toggleFullscreen]);

  function handleCanvasPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    const target = event.target as HTMLElement;
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    if (target.closest('[data-canvas-control], [data-node-id]')) return;
    event.preventDefault();
    stopAnimation();
    userMovedRef.current = true;
    setHoveredNodeId(null);
    const surface = event.currentTarget;
    const cleanup = () => {
      window.removeEventListener('pointermove', handleWindowPointerMove);
      window.removeEventListener('pointerup', handleWindowPointerUp);
      window.removeEventListener('pointercancel', handleWindowPointerCancel);
      window.removeEventListener('blur', handleWindowBlur);
    };
    dragRef.current = {
      pointerId: event.pointerId,
      start: { x: event.clientX, y: event.clientY },
      origin: { ...viewportRef.current.pan },
      dragged: false,
      surface,
      cleanup,
    };
    setIsPanning(true);
    window.addEventListener('pointermove', handleWindowPointerMove, { passive: false });
    window.addEventListener('pointerup', handleWindowPointerUp);
    window.addEventListener('pointercancel', handleWindowPointerCancel);
    window.addEventListener('blur', handleWindowBlur);
    try { surface.setPointerCapture(event.pointerId); } catch { /* unavailable in tests or already captured elsewhere */ }
  }

  function applyViewportToDOM(vp: CanvasViewport) {
    if (svgLayerRef.current) {
      svgLayerRef.current.setAttribute('transform', `translate(${vp.pan.x} ${vp.pan.y}) scale(${vp.zoom})`);
    }
    if (nodeLayerRef.current) {
      nodeLayerRef.current.style.transform = `translate3d(${vp.pan.x}px, ${vp.pan.y}px, 0) scale(${vp.zoom})`;
    }
    const bg = bgRef.current;
    if (bg?.farPattern) {
      bg.farPattern.setAttribute('patternTransform', `translate(${vp.pan.x * 0.65} ${vp.pan.y * 0.65}) scale(${vp.zoom * 0.75})`);
    }
    if (bg?.nearPattern) {
      bg.nearPattern.setAttribute('patternTransform', `translate(${vp.pan.x} ${vp.pan.y}) scale(${vp.zoom})`);
    }
  }

  function updateCanvasPan(pointerId: number, clientX: number, clientY: number) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== pointerId) return;
    const dx = clientX - drag.start.x;
    const dy = clientY - drag.start.y;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) drag.dragged = true;
    const next = { ...viewportRef.current, pan: { x: drag.origin.x + dx, y: drag.origin.y + dy } };
    viewportRef.current = next;
    applyViewportToDOM(next);
  }

  function finishCanvasPan(pointerId: number, clearSelection = true) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== pointerId) return;
    if (clearSelection && !drag.dragged) setSelectedNodeId(null);
    drag.cleanup();
    dragRef.current = null;
    setIsPanning(false);
    setViewportState(viewportRef.current);
    try { drag.surface.releasePointerCapture(pointerId); } catch { /* already released */ }
  }

  function handleCanvasPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    updateCanvasPan(event.pointerId, event.clientX, event.clientY);
  }

  function handleCanvasPointerUp(event: ReactPointerEvent<HTMLDivElement>) {
    finishCanvasPan(event.pointerId);
  }

  function handleCanvasPointerCancel(event: ReactPointerEvent<HTMLDivElement>) {
    finishCanvasPan(event.pointerId, false);
  }

  function handleCanvasLostPointerCapture(event: ReactPointerEvent<HTMLDivElement>) {
    finishCanvasPan(event.pointerId, false);
  }

  function handleWindowPointerMove(event: PointerEvent) {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    event.preventDefault();
    updateCanvasPan(event.pointerId, event.clientX, event.clientY);
  }

  function handleWindowPointerUp(event: PointerEvent) {
    finishCanvasPan(event.pointerId);
  }

  function handleWindowPointerCancel(event: PointerEvent) {
    finishCanvasPan(event.pointerId, false);
  }

  function handleWindowBlur() {
    const drag = dragRef.current;
    if (!drag) return;
    finishCanvasPan(drag.pointerId, false);
  }

  // Wheel pan/zoom is applied imperatively for the same reason drag is — the
  // React state commit is debounced so a burst of wheel events stays at 60fps.
  function commitWheelViewport() {
    if (wheelCommitRef.current !== null) window.clearTimeout(wheelCommitRef.current);
    wheelCommitRef.current = window.setTimeout(() => {
      wheelCommitRef.current = null;
      setViewportState(viewportRef.current);
    }, 160);
  }

  function handleCanvasWheel(event: ReactWheelEvent<HTMLDivElement>) {
    event.preventDefault();
    event.stopPropagation();
    stopAnimation();
    userMovedRef.current = true;
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const current = viewportRef.current;
    const horizontalPanIntent = event.shiftKey || Math.abs(event.deltaX) > Math.abs(event.deltaY) * 1.15;
    if (horizontalPanIntent) {
      const next: CanvasViewport = {
        ...current,
        pan: { x: current.pan.x - event.deltaX * 0.9, y: current.pan.y - event.deltaY * 0.35 },
      };
      viewportRef.current = next;
      applyViewportToDOM(next);
      commitWheelViewport();
      return;
    }
    const zoomDelta = clamp(-event.deltaY * (event.ctrlKey || event.metaKey ? 0.003 : 0.0018), -0.42, 0.42);
    const nextZoom = clamp(current.zoom * (1 + zoomDelta), VIEWPORT_MIN, VIEWPORT_MAX);
    const cursor = { x: event.clientX - rect.left, y: event.clientY - rect.top };
    const world = {
      x: (cursor.x - current.pan.x) / current.zoom,
      y: (cursor.y - current.pan.y) / current.zoom,
    };
    const next: CanvasViewport = {
      zoom: nextZoom,
      pan: { x: cursor.x - world.x * nextZoom, y: cursor.y - world.y * nextZoom },
    };
    viewportRef.current = next;
    applyViewportToDOM(next);
    commitWheelViewport();
  }

  function handleNodeClick(node: CanvasNode) {
    // "+N more" domain expander: toggle the band open/closed in place.
    if (node.id.startsWith('workflow-more:')) {
      const groupKey = decodeURIComponent(node.id.slice('workflow-more:'.length));
      setExpandedDomains((current) => {
        const next = new Set(current);
        if (next.has(groupKey)) next.delete(groupKey);
        else next.add(groupKey);
        return next;
      });
      return;
    }
    if (node.ghost && node.role) {
      const el = document.querySelector<HTMLElement>(`[data-node-id="${node.id}"]`);
      setCreatePreset({ role: node.role, flipFrom: captureFlip(el), lock: true });
      setSelectedNodeId(null);
      return;
    }
    userMovedRef.current = true;
    setSelectedNodeId((current) => (current === node.id ? null : node.id));
    centerOnNode(node);
  }

  function openNodeChat(node: CanvasNode) {
    if (!node.agent) return;
    const store = useChatPanelStore.getState();
    store.selectThread({ kind: 'agent', id: node.agent.id, name: node.agent.name });
    store.setState('docked');
    window.dispatchEvent(new CustomEvent('agentis:chat-panel-open', { detail: { agentId: node.agent.id, name: node.agent.name } }));
  }

  return (
    <section
      ref={containerRef}
      data-agentis-workspace-canvas
      className={clsx(
        'relative h-full min-h-0 touch-none overflow-hidden bg-canvas text-text-primary outline-none',
        isFullscreen ? 'agentis-workspace-canvas--fullscreen h-screen w-screen' : 'h-full w-full',
        isPanning ? 'cursor-grabbing' : 'cursor-grab',
      )}
      tabIndex={0}
      onWheelCapture={handleCanvasWheel}
      onWheel={handleCanvasWheel}
      onPointerDown={handleCanvasPointerDown}
      onPointerMove={handleCanvasPointerMove}
      onPointerUp={handleCanvasPointerUp}
      onPointerCancel={handleCanvasPointerCancel}
      onLostPointerCapture={handleCanvasLostPointerCapture}
      onDoubleClick={(event) => {
        if ((event.target as HTMLElement).closest('[data-canvas-control], [data-node-id]')) return;
        resetViewport();
      }}
      aria-label="Workspace authority canvas"
    >
      <style>{CANVAS_STYLE}</style>
      <div className={clsx('absolute inset-0 transition-opacity duration-300', entrancePhase === 'idle' && 'opacity-0')}>
        <CanvasBackground ref={bgRef} pan={viewport.pan} zoom={viewport.zoom} />
        <CanvasRadialLight orchestratorCanvasPos={orchestratorScreen} isActive={Boolean(orchestratorNode?.active)} />
      </div>

      <svg className="pointer-events-none absolute inset-0 z-10 h-full w-full" aria-hidden="true">
        <g ref={svgLayerRef} transform={`translate(${viewport.pan.x} ${viewport.pan.y}) scale(${viewport.zoom})`}>
          {model.edges.map((edge, index) => {
            const from = nodeMap.get(edge.from);
            const to = nodeMap.get(edge.to);
            if (!from || !to) return null;
            const path = edgePath(from, to, edge.type);
            // An edge animates only when its TARGET is doing real work — the
            // orchestrator is `from` on every command edge, so keying off the
            // source would light the whole tree whenever it's merely chatting.
            const liveEdge = liveNodeIds.has(edge.to) && edge.to !== model.orchestratorId;
            const animation = computeEdgeAnimation(Math.max(edge.activeRunCount, liveEdge ? 1 : 0), edge.type);
            const focused = !focusedNodeIds || (focusedNodeIds.has(edge.from) && focusedNodeIds.has(edge.to));
            const revealed = phaseReached(entrancePhase, edgeRevealPhase(edge, nodeMap));
            return (
              <g key={edge.id} className={clsx(focused ? undefined : 'opacity-[0.14]', !revealed && 'invisible')}>
                <path
                  className={clsx('home-edge-enter', (edge.busy || liveEdge) && edge.type === 'command' && 'home-command-edge-busy')}
                  d={path}
                  fill="none"
                  stroke={animation.strokeColor}
                  strokeWidth={animation.strokeWidth}
                  strokeLinecap="round"
                  vectorEffect="non-scaling-stroke"
                  pathLength={1}
                  style={{ animationDelay: `${index * 50}ms` }}
                />
                {focused && Array.from({ length: animation.count }).map((_, particleIndex) => (
                  <circle
                    key={`${edge.id}-particle-${particleIndex}`}
                    r={edge.type === 'command' ? 3.6 : 2.3}
                    fill={animation.strokeColor}
                    opacity={animation.opacity}
                  >
                    <animateMotion
                      dur={`${animation.dur}s`}
                      begin={`${particleIndex * (animation.dur / Math.max(1, animation.count))}s`}
                      repeatCount="indefinite"
                      path={path}
                    />
                  </circle>
                ))}
              </g>
            );
          })}
        </g>
      </svg>

      <div
        ref={nodeLayerRef}
        className="absolute inset-0 z-20 origin-top-left"
        style={{
          transform: `translate3d(${viewport.pan.x}px, ${viewport.pan.y}px, 0) scale(${viewport.zoom})`,
          willChange: isPanning ? 'transform' : undefined,
        }}
      >
        {model.nodes.map((node, index) => (
          <CanvasNodeCard
            key={node.id}
            node={node}
            now={now}
            index={index}
            revealed={phaseReached(entrancePhase, nodeRevealPhase(node))}
            selected={selectedNodeId === node.id}
            dimmed={Boolean(focusedNodeIds && !focusedNodeIds.has(node.id))}
            live={liveNodeIds.has(node.id)}
            liveCaption={liveCaptions.get(node.id)}
            onClick={() => handleNodeClick(node)}
            onOpen={() => !node.ghost && node.route && nav(node.route)}
            onHover={() => setHoveredNodeId(node.id)}
            onLeave={() => setHoveredNodeId((current) => (current === node.id ? null : current))}
          />
        ))}
      </div>

      {loading && (
        <div data-canvas-control className="absolute left-4 top-4 z-40 rounded-pill border border-line bg-surface/90 px-3 py-1.5 text-[12px] text-text-muted shadow-card backdrop-blur">
          Syncing workspace...
        </div>
      )}

      {agents.length === 0 && !loading && (
        <GhostEmptyState onCreateOrchestrator={() => setCreatePreset({ role: 'orchestrator', flipFrom: null, lock: false })} />
      )}

      {chatState !== 'docked' && (
        <CanvasComposerOverlay
          agents={agents}
          activeRuns={activeRuns}
          approvals={approvals}
          recentCompletions={recentCompletions}
          user={me}
          dimmed={Boolean(selectedNode)}
          onOpenAgents={() => nav('/agents')}
        />
      )}

      <CanvasActivityPopover node={isPanning ? null : hoveredNode} screenPos={isPanning ? null : hoverScreen} />

      <CanvasNodeDetailPanel
        node={selectedNode}
        onClose={() => setSelectedNodeId(null)}
        onNavigate={nav}
        onOpenChat={openNodeChat}
        onRefresh={refresh}
      />

      <CanvasTriagePanel
        open={triageOpen}
        activeRuns={activeRuns.filter(isActiveRun)}
        approvals={approvals}
        failedRuns={failedRuns}
        activity={workspaceActivity}
        requestStatus={requestStatus}
        frame={triageFrame}
        onFrameChange={setTriageFrame}
        containerSize={containerSize}
        onClose={() => setTriageOpen(false)}
        onSelectWorkflow={(workflowId) => selectWorkflowNode(workflowId)}
        onNavigate={(route) => {
          setTriageOpen(false);
          nav(route);
        }}
        onRefresh={refresh}
      />

      {/* The HUD controls a populated canvas; in the ghost empty state (no agents)
          there's nothing to triage, reset, or expand — keep it clean. */}
      {agents.length > 0 && (
        <CanvasHudBar
          counts={fleetCounts}
          connected={fleet?.gateways.connected ? fleet.gateways.connected > 0 : true}
          isFullscreen={isFullscreen}
          onOpenTriage={() => setTriageOpen(true)}
          onToggleFullscreen={() => void toggleFullscreen()}
          onResetView={resetViewport}
        />
      )}

      <AgentCreateWizard
        open={Boolean(createPreset)}
        initialRole={createPreset?.role}
        lockInitialRole={createPreset?.lock ?? false}
        flipFrom={createPreset?.flipFrom ?? null}
        onClose={() => setCreatePreset(null)}
        onCreated={(agent) => {
          setCreatePreset(null);
          void refresh().then(() => {
            window.requestAnimationFrame(() => {
              const el = document.querySelector<HTMLElement>(`[data-node-id="agent-${agent.id}"]`);
              if (el && createPreset?.flipFrom) {
                el.animate(
                  [{ opacity: '0', transform: 'scale(0.7)' }, { opacity: '1', transform: 'scale(1)' }],
                  { duration: 380, easing: 'cubic-bezier(0.22, 1, 0.36, 1)', fill: 'both' },
                );
              }
            });
          });
        }}
      />
    </section>
  );
}

export function buildCanvasModel(
  data: EcosystemData,
  agents: WorkspaceAgent[],
  activeRuns: WorkspaceActiveRun[],
  artifacts: WorkspaceArtifact[],
  approvals: WorkspaceApproval[],
  failedRuns: WorkspaceFailedRun[],
  canvasSize: VirtualCanvasSize,
  expandedNodeId: string | null = null,
  expandedDomains: ReadonlySet<string> = new Set<string>(),
): CanvasModel {
  const nodes: CanvasNode[] = [];
  const edges: CanvasEdge[] = [];
  const managerActiveWorkers = new Map<string, number>();
  const activeWorkflowIds = new Set(activeRuns.map((run) => run.workflowId));
  const availableAgentIds = new Set(agents.filter((agent) => isAvailableAgent(agent.status)).map((agent) => agent.id));
  const workingAgentIds = new Set(activeRuns.flatMap((run) => run.agents?.map((agent) => agent.id) ?? []));
  for (const agent of agents) if (isWorkingAgent(agent)) workingAgentIds.add(agent.id);

  const roles = classifyAgents(agents);
  const spaces = data.spaces ?? [];
  const plannedSpaceCount = Math.max(2, spaces.length);
  const managerCount = Math.max(roles.managers.length, agents.length === 0 ? plannedSpaceCount : roles.workers.length > 0 && roles.managers.length === 0 ? 1 : 0);
  const managerPositions = distributeRow(managerCount, canvasSize.width, 350, NODE.manager.width);
  const availableCommandSourceIds = new Set<string>();
  const spaceSourceIds = new Map<string, string>();

  const orchestratorId = roles.orchestrator ? `agent-${roles.orchestrator.id}` : 'ghost-orchestrator';
  if (roles.orchestrator) {
    nodes.push(agentNode(roles.orchestrator, 'orchestrator', { x: canvasSize.width / 2, y: 170 }, workingAgentIds, approvals, activeRuns));
    if (availableAgentIds.has(roles.orchestrator.id)) availableCommandSourceIds.add(orchestratorId);
  } else {
    nodes.push(ghostNode('ghost-orchestrator', 'orchestrator', 'Orchestrator', 'commission your workspace orchestrator', { x: canvasSize.width / 2, y: 170 }, NODE.orchestrator));
  }

  const managerNodeIds: string[] = [];
  roles.managers.forEach((agent, index) => {
    const pos = managerPositions[index] ?? { x: canvasSize.width / 2, y: 350 };
    const node = agentNode(agent, 'manager', pos, workingAgentIds, approvals, activeRuns);
    nodes.push(node);
    managerNodeIds.push(node.id);
    if (node.spaceId) spaceSourceIds.set(node.spaceId, node.id);
    if (availableAgentIds.has(agent.id)) availableCommandSourceIds.add(node.id);
    edges.push(commandEdge(orchestratorId, node.id, workingAgentIds.has(agent.id) && availableCommandSourceIds.has(orchestratorId)));
  });
  for (let index = roles.managers.length; index < managerCount; index += 1) {
    const id = `ghost-manager-${index}`;
    const pos = managerPositions[index] ?? { x: canvasSize.width / 2, y: 350 };
    const space = spaces[index - roles.managers.length] ?? null;
    const ghost = ghostNode(
      id,
      'manager',
      space ? `${space.name} manager` : index === 0 ? 'Manager layer' : `Manager ${index + 1}`,
      space ? 'domain owner' : 'assign a team or domain',
      pos,
      NODE.manager,
    );
    ghost.spaceId = space?.id ?? null;
    ghost.spaceName = space?.name ?? null;
    ghost.accent = space?.colorHex ?? ghost.accent;
    nodes.push(ghost);
    managerNodeIds.push(id);
    if (space) spaceSourceIds.set(space.id, id);
    edges.push(commandEdge(orchestratorId, id, false));
  }

  const expandedManagerId = expandedNodeId && managerNodeIds.includes(expandedNodeId) ? expandedNodeId : null;
  const visibleWorkers = expandedManagerId
    ? roles.workers.filter((agent, index) => findParentManager(agent, managerNodeIds, roles.managers, index) === expandedManagerId)
    : [];
  const workerCount = visibleWorkers.length;
  const workerSize = computeWorkerNodeSize(workerCount);
  const workerColumns = computeWorkerColumns(workerCount);
  const workerRows = workerCount > 0 ? Math.ceil(workerCount / Math.max(1, workerColumns)) : 0;
  const workerPositions = workerCount > 0 ? distributeLayer(workerCount, canvasSize.width, 530, workerSize.width, workerSize.height + 42, workerColumns) : [];
  const resourceStartY = workerRows > 0 ? 530 + workerRows * (workerSize.height + 42) + 68 : 520;

  visibleWorkers.forEach((agent, index) => {
    const pos = workerPositions[index] ?? { x: canvasSize.width / 2, y: 530 };
    const node = agentNode(agent, 'worker', pos, workingAgentIds, approvals, activeRuns, workerSize);
    nodes.push(node);
    const parentId = expandedManagerId ?? findParentManager(agent, managerNodeIds, roles.managers, index) ?? orchestratorId;
    if (workingAgentIds.has(agent.id)) managerActiveWorkers.set(parentId, (managerActiveWorkers.get(parentId) ?? 0) + 1);
    edges.push(commandEdge(parentId, node.id, workingAgentIds.has(agent.id) && availableCommandSourceIds.has(parentId)));
  });

  for (const edge of edges) {
    if (edge.type === 'command' && edge.from === orchestratorId && edge.active && (managerActiveWorkers.get(edge.to) ?? 0) >= 2) {
      edge.busy = true;
    }
  }

  const sourceXById = new Map(nodes.map((node) => [node.id, node.x]));
  const sourceNodeById = new Map(nodes.map((node) => [node.id, node]));
  const resourceNodes = buildResourceNodes(
    data,
    activeRuns,
    artifacts,
    approvals,
    failedRuns,
    canvasSize,
    activeWorkflowIds,
    resourceStartY,
    spaceSourceIds,
    sourceXById,
    sourceNodeById,
    expandedDomains,
  );
  nodes.push(...resourceNodes);
  for (const resource of resourceNodes) {
    for (const from of resolveResourceSourceIds(resource, nodes, orchestratorId)) {
      edges.push({
        id: `resource-${from}-${resource.id}`,
        from,
        to: resource.id,
        type: 'resource',
        activeRunCount: resource.active ? Math.max(1, resource.connectedAgentIds?.length ?? 1) : 0,
        active: resource.active,
        busy: resource.warn,
      });
    }
  }

  return {
    nodes,
    edges: dedupeEdges(edges),
    orchestratorId,
    activeAgentIds: availableAgentIds,
  };
}

export function computeEdgeAnimation(activeLoad: number, type: 'command' | 'resource'): EdgeAnimation {
  const count = Math.max(0, Math.min(3, Math.ceil(activeLoad)));
  if (type === 'command') {
    return {
      count,
      dur: activeLoad > 1 ? 2.0 : 2.9,
      opacity: activeLoad > 0 ? 0.82 : 0,
      strokeColor: activeLoad > 0 ? 'rgba(167,139,250,0.74)' : 'rgba(88,93,105,0.52)',
      strokeWidth: activeLoad > 0 ? 2.8 : 1.8,
    };
  }
  return {
    count,
    dur: activeLoad > 1 ? 2.3 : 3.2,
    opacity: activeLoad > 0 ? 0.72 : 0,
    strokeColor: activeLoad > 0 ? 'rgba(74,222,128,0.64)' : 'rgba(64,70,82,0.44)',
    strokeWidth: activeLoad > 0 ? 1.8 : 1.2,
  };
}

function CanvasNodeCard({
  node,
  now,
  index,
  revealed,
  selected,
  dimmed,
  live = false,
  liveCaption,
  onClick,
  onOpen,
  onHover,
  onLeave,
}: {
  node: CanvasNode;
  now: number;
  index: number;
  revealed: boolean;
  selected: boolean;
  dimmed: boolean;
  /** True while this node is emitting live activity (chat-driven work, not just formal runs). */
  live?: boolean;
  /** The node's current step/thought, from the workspace activity spine. */
  liveCaption?: string;
  onClick: () => void;
  onOpen: () => void;
  onHover: () => void;
  onLeave: () => void;
}) {
  const elapsed = node.startedAt ? formatElapsed(node.startedAt, now) : null;
  const isAgentNode = node.kind === 'orchestrator' || node.kind === 'manager' || node.kind === 'worker';
  const isOperationalWarning = Boolean(node.outOfCredits || node.warn);
  // Liveness = a formal active run OR live workspace activity for this node.
  const isLive = Boolean(node.active) || live;
  const compact = node.height <= 60 || node.kind === 'artifact';
  const showSubtitle = !compact || node.kind !== 'worker';
  const titleClass = node.kind === 'orchestrator'
    ? 'text-[14px]'
    : compact
      ? 'text-[11px]'
      : 'text-[12px]';
  const avatarClass = node.kind === 'orchestrator'
    ? 'h-12 w-12'
    : node.kind === 'manager'
      ? 'h-10 w-10'
      : node.kind === 'worker' || node.kind === 'workflow'
        ? compact ? 'h-7 w-7 rounded-[8px]' : 'h-9 w-9 rounded-[10px]'
        : node.kind === 'artifact'
          ? 'h-7 w-7 rounded-[8px]'
          : 'h-9 w-9';
  const statusLabelText = node.warn
    ? node.status === 'offline'
      ? 'offline'
      : 'needs attention'
    : node.online
      ? 'online'
      : 'idle';
  const style = {
    left: node.x,
    top: node.y,
    width: node.width,
    height: node.height,
    '--node-accent': node.accent ?? 'rgba(167,139,250,0.85)',
    animationDelay: `${index * 34}ms`,
  } as CSSProperties;

  return (
    <button
      type="button"
      data-node-id={node.id}
      onClick={(event) => { event.stopPropagation(); onClick(); }}
      onDoubleClick={(event) => { event.stopPropagation(); onOpen(); }}
      onMouseEnter={onHover}
      onMouseLeave={onLeave}
      className={clsx(
        'home-node-enter absolute -translate-x-1/2 -translate-y-1/2 rounded-xl border text-left shadow-card transition duration-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-muted focus-visible:ring-offset-2 focus-visible:ring-offset-canvas',
        compact ? 'px-2' : 'px-3',
        node.kind === 'orchestrator' && node.status !== 'offline' && node.status !== 'error' && 'home-orchestrator-aura',
        node.ghost && 'home-ghost-breathe',
        node.outOfCredits
          ? 'border-warn bg-warn/5 shadow-[0_0_12px_rgba(245,158,11,0.25)]'
          : node.warn
            ? 'border-warn/40 bg-warn-soft'
            : isLive
              ? 'border-accent/35 bg-accent-soft'
              : node.ghost
                ? 'border-dashed border-line bg-surface/45 text-text-muted'
                : 'border-line bg-surface/90 hover:border-line-strong hover:bg-surface',
        isLive && !node.warn && !node.outOfCredits && 'home-orchestrator-aura',
        selected && 'ring-2 ring-violet-300/55',
        // Visual hierarchy at scale: idle workflows recede so the ones that are
        // running or failing carry the eye. (Focus-dimming below still wins.)
        node.kind === 'workflow' && !isLive && !node.warn && !node.ghost && !selected && 'opacity-75 saturate-[0.85]',
        dimmed && 'opacity-[0.32] saturate-[0.6]',
      )}
      style={{ ...style, visibility: revealed ? 'visible' : 'hidden' }}
    >
      {node.spaceId && node.accent && !node.ghost && (
        <span
          aria-hidden="true"
          className="absolute inset-x-4 top-0 h-px rounded-full opacity-80"
          style={{ background: `linear-gradient(90deg, transparent, ${node.accent}, transparent)` }}
        />
      )}
      <div className={clsx('flex h-full items-center', compact ? 'gap-2' : 'gap-3')}>
        <span
          className={clsx(
            'relative flex shrink-0 items-center justify-center overflow-hidden rounded-card border',
            avatarClass,
            node.outOfCredits
              ? 'border-warn/50 bg-warn/10 text-warn shadow-[0_0_8px_rgba(245,158,11,0.2)]'
              : node.warn
                ? 'border-warn/35 bg-warn-soft text-warn'
                : isLive
                  ? 'border-accent/35 bg-accent-soft text-accent'
                  : node.ghost
                    ? 'border-line bg-canvas/50 text-text-muted'
                    : 'border-line bg-surface-2 text-text-secondary',
          )}
          style={{ color: isOperationalWarning ? undefined : node.accent ?? undefined }}
        >
          {node.imageUrl ? <img src={node.imageUrl} alt="" className="h-full w-full object-cover" /> : node.icon}
          {isAgentNode && !isOperationalWarning && (
            <span
              role="status"
              aria-label={`${node.title} ${statusLabelText}`}
              title={`${node.title} ${statusLabelText}`}
              className={clsx(
                'absolute right-0.5 top-0.5 h-2.5 w-2.5 rounded-full border border-canvas',
                node.online
                  ? 'bg-success shadow-[0_0_12px_rgba(74,222,128,0.75)]'
                  : 'bg-text-muted',
                isLive && 'animate-pulse-dot',
              )}
            >
              <span className="sr-only">{node.title} {statusLabelText}</span>
            </span>
          )}
          {node.progress != null && node.active && <ProgressRing progress={node.progress} />}
          {isOperationalWarning && (
            <span
              role={isAgentNode ? 'status' : undefined}
              aria-label={isAgentNode ? `${node.title} ${statusLabelText}` : undefined}
              title={isAgentNode ? `${node.title} ${statusLabelText}` : undefined}
              className={clsx(
                'absolute bottom-1 left-1 h-2 w-2 animate-pulse-dot rounded-full',
                node.status === 'offline' ? 'bg-danger' : 'bg-warn',
              )}
            />
          )}
        </span>
        <span className="min-w-0 flex-1">
          <span className={clsx('block truncate font-semibold text-text-primary', titleClass)}>{node.title}</span>
          {showSubtitle && <span className="mt-0.5 block truncate text-[10px] text-text-muted">{node.subtitle}</span>}
          {elapsed && <span className="mt-1 block text-[10px] font-semibold text-accent">{elapsed}</span>}
        </span>
      </div>
      <CanvasNodeThought node={node} isAgentNode={isAgentNode} isLive={isLive} liveCaption={liveCaption} />
    </button>
  );
}

/**
 * Always-on "thought bubble" under an actively-working agent node: its current
 * tool call or latest streamed reasoning, so the canvas shows what each agent is
 * thinking right now without hovering or opening a panel. Pointer-transparent and
 * decorative; fed by the node's live fields (no extra subscription).
 */
function CanvasNodeThought({
  node,
  isAgentNode,
  isLive,
  liveCaption,
}: {
  node: CanvasNode;
  isAgentNode: boolean;
  isLive: boolean;
  liveCaption?: string;
}) {
  if (!isLive) return null;
  // Prefer the node's own live fields (agent runtime); fall back to the
  // workspace activity caption (chat-driven orchestrator/workflow work).
  const thought = node.currentTool ?? node.outputLines?.at(-1) ?? node.currentTask ?? liveCaption;
  if (!thought) return null;
  return (
    <span
      aria-hidden="true"
      className="pointer-events-none absolute left-1/2 top-[calc(100%+7px)] z-30 w-[190px] -translate-x-1/2 animate-in fade-in slide-in-from-top-1 rounded-lg border border-accent/25 bg-canvas/92 px-2 py-1.5 shadow-floating backdrop-blur-md duration-200"
    >
      <span className="flex items-start gap-1.5">
        <span className="mt-[3px] h-1 w-1 shrink-0 animate-pulse rounded-full bg-accent" />
        <span className="block max-h-8 overflow-hidden font-mono text-[9.5px] leading-snug text-text-secondary">
          {node.currentTool ? `↳ ${node.currentTool}` : thought}
        </span>
      </span>
    </span>
  );
}

/** Tone → text color for the live activity stream. */
const ACTIVITY_TONE_CLASS: Record<RealtimeActivity['tone'], string> = {
  accent: 'text-accent',
  success: 'text-emerald-400',
  warn: 'text-warn',
  danger: 'text-danger',
  muted: 'text-text-muted',
};

function activityIcon(kind: RealtimeActivity['kind']) {
  switch (kind) {
    case 'tool': return <Wrench size={11} />;
    case 'message': return <MessageSquare size={11} />;
    case 'agent': return <Sparkles size={11} />;
    case 'approval': return <AlertTriangle size={11} />;
    case 'run':
    case 'node':
    case 'progress':
    default: return <ActivityIcon size={11} />;
  }
}

/**
 * The live mission-control stream — every meaningful thing happening across the
 * workspace right now: the orchestrator's thinking, tool calls, run/node
 * transitions, agent messages. This is what turns Mission Control from a static
 * failed-runs list into "watch the work happen." Newest-first, auto-scrolls.
 */
function LiveActivityStream({
  activity,
  onSelectWorkflow,
}: {
  activity: RealtimeActivity[];
  onSelectWorkflow: (workflowId: string) => void;
}) {
  const items = activity.slice(0, 40);
  return (
    <section className="mb-5">
      <div className="mb-2 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wide text-text-muted">
        <span className="relative flex h-1.5 w-1.5">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent/60" />
          <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-accent" />
        </span>
        Live activity
      </div>
      <div className="space-y-1 rounded-card border border-line bg-canvas/45 p-2">
        {items.map((item) => {
          const clickable = Boolean(item.workflowId);
          const Wrapper: 'button' | 'div' = clickable ? 'button' : 'div';
          return (
            <Wrapper
              key={item.id}
              {...(clickable
                ? { type: 'button' as const, onClick: () => onSelectWorkflow(item.workflowId!) }
                : {})}
              className={clsx(
                'flex w-full items-start gap-2 rounded-md px-1.5 py-1 text-left',
                clickable && 'hover:bg-surface-2',
              )}
            >
              <span className={clsx('mt-0.5 shrink-0', ACTIVITY_TONE_CLASS[item.tone])}>
                {activityIcon(item.kind)}
              </span>
              <span className="min-w-0 flex-1 leading-snug">
                <span className="truncate text-[12px] text-text-primary">
                  {item.agentName ? `${item.agentName} · ` : ''}{item.title}
                </span>
                {item.detail && item.detail !== item.title && (
                  <span className="mt-0.5 block line-clamp-2 font-mono text-[11px] text-text-secondary">{item.detail}</span>
                )}
              </span>
            </Wrapper>
          );
        })}
      </div>
    </section>
  );
}

function CanvasTriagePanel({
  open,
  activeRuns,
  approvals,
  failedRuns,
  activity,
  requestStatus,
  frame,
  onFrameChange,
  containerSize,
  onClose,
  onSelectWorkflow,
  onNavigate,
  onRefresh,
}: {
  open: boolean;
  activeRuns: WorkspaceActiveRun[];
  approvals: WorkspaceApproval[];
  failedRuns: WorkspaceFailedRun[];
  activity: RealtimeActivity[];
  requestStatus: WorkspaceRequestStatus;
  frame: TriagePanelFrame;
  onFrameChange: Dispatch<SetStateAction<TriagePanelFrame>>;
  containerSize: VirtualCanvasSize;
  onClose: () => void;
  onSelectWorkflow: (workflowId: string) => void;
  onNavigate: (route: string) => void;
  onRefresh: () => void;
}) {
  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    originX: number;
    originY: number;
    handle: HTMLElement;
  } | null>(null);
  const resizeRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    originWidth: number;
    originHeight: number;
    handle: HTMLElement;
  } | null>(null);

  useEffect(() => {
    onFrameChange((current) => {
      const next = clampTriagePanelFrame(current, containerSize);
      return triageFramesEqual(current, next) ? current : next;
    });
  }, [containerSize, onFrameChange]);

  useEffect(() => () => {
    stopDrag();
    stopResize();
  }, []);

  if (!open) return null;
  const hasLiveTriage = activeRuns.length > 0 || approvals.length > 0 || failedRuns.length > 0;
  const showStream = activity.length > 0;
  const showBeacon = hasLiveTriage || requestStatus.busy || showStream;

  async function resolveApproval(approval: WorkspaceApproval, decision: 'approve' | 'reject') {
    await api(`/v1/approvals/${approval.id}/resolve`, {
      method: 'POST',
      body: JSON.stringify({ decision }),
    }).catch(() => undefined);
    onRefresh();
  }

  function stopDrag(pointerId?: number) {
    const drag = dragRef.current;
    if (!drag) return;
    window.removeEventListener('pointermove', handleWindowDragMove);
    window.removeEventListener('pointerup', handleWindowDragUp);
    window.removeEventListener('pointercancel', handleWindowDragCancel);
    window.removeEventListener('blur', handleWindowDragBlur);
    if (pointerId != null) {
      try { drag.handle.releasePointerCapture(pointerId); } catch { /* already released */ }
    }
    dragRef.current = null;
  }

  function stopResize(pointerId?: number) {
    const resize = resizeRef.current;
    if (!resize) return;
    window.removeEventListener('pointermove', handleWindowResizeMove);
    window.removeEventListener('pointerup', handleWindowResizeUp);
    window.removeEventListener('pointercancel', handleWindowResizeCancel);
    window.removeEventListener('blur', handleWindowResizeBlur);
    if (pointerId != null) {
      try { resize.handle.releasePointerCapture(pointerId); } catch { /* already released */ }
    }
    resizeRef.current = null;
  }

  function handleWindowDragMove(event: PointerEvent) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    event.preventDefault();
    onFrameChange((current) => clampTriagePanelFrame({
      ...current,
      x: drag.originX + (event.clientX - drag.startX),
      y: drag.originY + (event.clientY - drag.startY),
    }, containerSize));
  }

  function handleWindowDragUp(event: PointerEvent) {
    stopDrag(event.pointerId);
  }

  function handleWindowDragCancel(event: PointerEvent) {
    stopDrag(event.pointerId);
  }

  function handleWindowDragBlur() {
    const drag = dragRef.current;
    if (!drag) return;
    stopDrag(drag.pointerId);
  }

  function handleWindowResizeMove(event: PointerEvent) {
    const resize = resizeRef.current;
    if (!resize || resize.pointerId !== event.pointerId) return;
    event.preventDefault();
    onFrameChange((current) => clampTriagePanelFrame({
      ...current,
      width: resize.originWidth + (event.clientX - resize.startX),
      height: resize.originHeight + (event.clientY - resize.startY),
    }, containerSize));
  }

  function handleWindowResizeUp(event: PointerEvent) {
    stopResize(event.pointerId);
  }

  function handleWindowResizeCancel(event: PointerEvent) {
    stopResize(event.pointerId);
  }

  function handleWindowResizeBlur() {
    const resize = resizeRef.current;
    if (!resize) return;
    stopResize(resize.pointerId);
  }

  function handleHeaderPointerDown(event: ReactPointerEvent<HTMLElement>) {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    const target = event.target as HTMLElement;
    if (target.closest('button, a, input, select, textarea')) return;
    event.preventDefault();
    event.stopPropagation();
    const handle = event.currentTarget;
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: frame.x,
      originY: frame.y,
      handle,
    };
    window.addEventListener('pointermove', handleWindowDragMove, { passive: false });
    window.addEventListener('pointerup', handleWindowDragUp);
    window.addEventListener('pointercancel', handleWindowDragCancel);
    window.addEventListener('blur', handleWindowDragBlur);
    try { handle.setPointerCapture(event.pointerId); } catch { /* unavailable */ }
  }

  function handleResizePointerDown(event: ReactPointerEvent<HTMLButtonElement>) {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const handle = event.currentTarget;
    resizeRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originWidth: frame.width,
      originHeight: frame.height,
      handle,
    };
    window.addEventListener('pointermove', handleWindowResizeMove, { passive: false });
    window.addEventListener('pointerup', handleWindowResizeUp);
    window.addEventListener('pointercancel', handleWindowResizeCancel);
    window.addEventListener('blur', handleWindowResizeBlur);
    try { handle.setPointerCapture(event.pointerId); } catch { /* unavailable */ }
  }

  return (
    <div
      data-canvas-control
      role="dialog"
      aria-label="Workspace triage"
      className="absolute z-50 flex flex-col rounded-2xl border border-line bg-surface/96 shadow-2xl backdrop-blur-xl"
      style={{
        left: frame.x,
        top: frame.y,
        width: frame.width,
        height: frame.height,
        maxWidth: containerSize.width - TRIAGE_PANEL_MARGIN * 2,
        maxHeight: containerSize.height - TRIAGE_PANEL_MARGIN * 2,
      }}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <header
        className="flex items-center justify-between gap-3 border-b border-line px-4 py-3 cursor-grab active:cursor-grabbing"
        onPointerDown={handleHeaderPointerDown}
      >
        <div className="flex min-w-0 items-center gap-2.5">
          {showBeacon && (
            <span className="relative flex h-2 w-2 shrink-0">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent/60" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-accent" />
            </span>
          )}
          <div className="min-w-0">
            <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-accent">Mission Control</div>
            <h2 className="mt-0.5 truncate text-heading text-text-primary">
              {requestStatus.busy
                ? 'Working…'
                : activeRuns.length > 0
                  ? `${activeRuns.length} agent run${activeRuns.length === 1 ? '' : 's'} live`
                  : 'Live workspace'}
            </h2>
            {requestStatus.busy && requestStatus.label && (
              <div className="mt-0.5 truncate text-[11px] text-text-secondary">{requestStatus.label}</div>
            )}
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close triage"
          className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-btn text-text-muted hover:bg-surface-2 hover:text-text-primary"
        >
          <X size={14} />
        </button>
      </header>

      <div className={clsx('min-h-0 flex-1 px-4 py-4', hasLiveTriage || showStream ? 'overflow-y-auto' : 'overflow-hidden')}>
        {!hasLiveTriage && !showStream && (
          <div className="flex h-full flex-col items-center justify-center rounded-card border border-line bg-canvas/45 px-4 py-4 text-center">
            <CheckCircle2 size={28} className="mx-auto text-accent" />
            <div className="mt-3 text-subheading text-text-primary">Nothing needs live triage.</div>
            <p className="mt-1 text-[12px] leading-relaxed text-text-secondary">
              No runs are executing and there are no pending approvals. Send a request and watch the work stream here.
            </p>
          </div>
        )}

        {showStream && <LiveActivityStream activity={activity} onSelectWorkflow={onSelectWorkflow} />}

        {activeRuns.length > 0 && (
          <section className="space-y-2">
            <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wide text-text-muted">
              <Clock size={13} />
              Running now
            </div>
            {activeRuns.map((run) => (
              <TriageRunRow key={run.id} run={run} onOpen={() => onNavigate(`/runs/${run.id}`)} />
            ))}
          </section>
        )}

        {approvals.length > 0 && (
          <section className={clsx('space-y-2', activeRuns.length > 0 && 'mt-5')}>
            <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wide text-text-muted">
              <AlertTriangle size={13} className="text-warn" />
              Pending approvals
            </div>
            {approvals.map((approval) => (
              <div key={approval.id} className="rounded-card border border-warn/25 bg-warn-soft px-3 py-2">
                <div className="truncate text-[13px] font-medium text-text-primary">{approval.workflowName ?? 'Approval needed'}</div>
                <div className="mt-1 text-[12px] leading-relaxed text-text-secondary">{approval.summary ?? approval.agentName ?? 'Waiting for an operator decision.'}</div>
                <div className="mt-3 flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => void resolveApproval(approval, 'approve')}
                    className="inline-flex h-7 items-center rounded-btn bg-text-primary px-2.5 text-[11px] font-medium text-canvas hover:bg-white"
                  >
                    Approve
                  </button>
                  <button
                    type="button"
                    onClick={() => void resolveApproval(approval, 'reject')}
                    className="inline-flex h-7 items-center rounded-btn border border-line bg-surface-2 px-2.5 text-[11px] font-medium text-text-secondary hover:bg-surface-3 hover:text-text-primary"
                  >
                    Reject
                  </button>
                </div>
              </div>
            ))}
          </section>
        )}

        {failedRuns.length > 0 && (
          <section className={clsx('space-y-2', (activeRuns.length > 0 || approvals.length > 0) && 'mt-5')}>
            <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wide text-text-muted">
              <AlertTriangle size={13} className="text-danger" />
              Failed workflows
            </div>
            {failedRuns.map((run) => (
              <div
                key={run.id}
                className="rounded-card border border-danger/20 bg-danger-soft/50 px-3 py-2 hover:border-danger/40 hover:bg-danger-soft"
              >
                <button
                  type="button"
                  onClick={() => (run.workflowId ? onSelectWorkflow(run.workflowId) : onNavigate('/history?tab=runs'))}
                  className="block w-full text-left"
                  title="Inspect this workflow on the canvas"
                >
                  <div className="truncate text-[13px] font-medium text-text-primary">{run.workflowName}</div>
                  <div className="mt-0.5 truncate text-[11px] text-text-muted">
                    {run.failedNode ? `Failed at ${run.failedNode}` : 'Needs operator review'}
                  </div>
                </button>
                <div className="mt-2 flex gap-2">
                  {run.workflowId && (
                    <button
                      type="button"
                      onClick={() => { void api(`/v1/workflows/${run.workflowId}/run`, { method: 'POST' }).catch(() => undefined).finally(onRefresh); }}
                      className="inline-flex h-6 items-center gap-1 rounded-btn border border-line bg-surface-2 px-2 text-[11px] font-medium text-text-secondary hover:bg-surface-3 hover:text-text-primary"
                    >
                      <RefreshCw size={11} /> Retry
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => onNavigate(`/runs/${run.id}`)}
                    className="inline-flex h-6 items-center gap-1 rounded-btn border border-line bg-surface-2 px-2 text-[11px] font-medium text-text-secondary hover:bg-surface-3 hover:text-text-primary"
                  >
                    Details
                  </button>
                </div>
              </div>
            ))}
          </section>
        )}
      </div>
      <button
        type="button"
        aria-label="Resize triage panel"
        title="Resize triage panel"
        className="absolute bottom-1.5 right-1.5 flex h-4 w-4 items-end justify-end rounded-sm text-text-muted/80 hover:bg-surface-2 hover:text-text-primary cursor-se-resize"
        onPointerDown={handleResizePointerDown}
      >
        <span className="pointer-events-none block h-2.5 w-2.5 border-b border-r border-current" />
      </button>
    </div>
  );
}

function clampTriagePanelFrame(frame: TriagePanelFrame, containerSize: VirtualCanvasSize): TriagePanelFrame {
  const maxWidth = Math.max(TRIAGE_PANEL_MIN_WIDTH, containerSize.width - TRIAGE_PANEL_MARGIN * 2);
  const maxHeight = Math.max(TRIAGE_PANEL_MIN_HEIGHT, containerSize.height - TRIAGE_PANEL_MARGIN * 2);
  const width = clamp(frame.width, TRIAGE_PANEL_MIN_WIDTH, maxWidth);
  const height = clamp(frame.height, TRIAGE_PANEL_MIN_HEIGHT, maxHeight);
  const maxX = Math.max(TRIAGE_PANEL_MARGIN, containerSize.width - width - TRIAGE_PANEL_MARGIN);
  const maxY = Math.max(TRIAGE_PANEL_MARGIN, containerSize.height - height - TRIAGE_PANEL_MARGIN);
  const x = clamp(frame.x, TRIAGE_PANEL_MARGIN, maxX);
  const y = clamp(frame.y, TRIAGE_PANEL_MARGIN, maxY);
  return { ...frame, x, y, width, height };
}

function triageFramesEqual(a: TriagePanelFrame, b: TriagePanelFrame): boolean {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

function GhostEmptyState({ onCreateOrchestrator }: { onCreateOrchestrator: () => void }) {
  return (
    <div data-canvas-control className="absolute left-1/2 top-[58%] z-30 w-[min(420px,calc(100%-40px))] -translate-x-1/2 rounded-2xl border border-dashed border-line bg-surface/72 px-5 py-4 text-center shadow-card backdrop-blur-md">
      <PackageOpen size={32} className="mx-auto text-text-muted" />
      <h2 className="mt-3 text-heading text-text-primary">Your AI organization will appear here.</h2>
      <p className="mt-2 text-[13px] leading-relaxed text-text-secondary">
        Start with the orchestrator. Once the workspace orchestrator is commissioned, managers and workers can branch beneath it.
      </p>
      <button
        type="button"
        onClick={onCreateOrchestrator}
        className="mt-4 inline-flex h-9 items-center rounded-btn bg-accent px-3 text-[12px] font-medium text-canvas hover:bg-accent-hover"
      >
        Add orchestrator
      </button>
    </div>
  );
}

function ProgressRing({ progress }: { progress: number }) {
  const radius = 18;
  const circumference = 2 * Math.PI * radius;
  const dashOffset = circumference * (1 - clamp(progress, 0, 1));
  return (
    <svg className="pointer-events-none absolute -inset-1 h-13 w-13" viewBox="0 0 44 44" aria-hidden="true">
      <circle cx="22" cy="22" r={radius} fill="none" stroke="rgba(74,222,128,0.16)" strokeWidth="2" />
      <circle
        cx="22"
        cy="22"
        r={radius}
        fill="none"
        stroke="rgba(74,222,128,0.9)"
        strokeWidth="2"
        strokeLinecap="round"
        strokeDasharray={circumference}
        strokeDashoffset={dashOffset}
        transform="rotate(-90 22 22)"
      />
    </svg>
  );
}

function computeVirtualCanvasSize(
  data: EcosystemData,
  agents: WorkspaceAgent[],
  activeRuns: WorkspaceActiveRun[],
  artifacts: WorkspaceArtifact[],
  approvals: WorkspaceApproval[],
  containerSize: VirtualCanvasSize,
): VirtualCanvasSize {
  const roles = classifyAgents(agents);
  const resources = data.workflows.length + data.knowledgeBases.length + artifacts.length + approvals.length;
  const managerCount = Math.max(roles.managers.length, agents.length === 0 ? 2 : roles.workers.length > 0 && roles.managers.length === 0 ? 1 : 0);
  const workerCount = Math.max(roles.workers.length, agents.length === 0 ? 4 : roles.workers.length === 0 ? Math.max(2, roles.managers.length) : 0);
  const workerSize = computeWorkerNodeSize(workerCount);
  const workerColumns = computeWorkerColumns(workerCount);
  const workerRows = Math.max(1, Math.ceil(workerCount / Math.max(1, workerColumns)));
  const width = Math.max(
    containerSize.width,
    1040,
    managerCount * (NODE.manager.width + 62) + 320,
    Math.min(workerCount, workerColumns) * (workerSize.width + 48) + 320,
    Math.min(resources, 4) * 220 + 260,
  );
  const resourceRows = Math.max(1, Math.ceil(Math.max(resources, 3) / Math.max(3, Math.floor(width / 260))));
  const resourceStartY = 530 + workerRows * (workerSize.height + 42) + 68;
  const height = Math.max(containerSize.height, 780, resourceStartY + resourceRows * 112, activeRuns.length > 4 ? 900 : 780);
  return { width, height };
}

function computeCanvasContentBounds(nodes: CanvasNode[]): CanvasBounds {
  if (nodes.length === 0) {
    return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
  }
  let left = Number.POSITIVE_INFINITY;
  let top = Number.POSITIVE_INFINITY;
  let right = Number.NEGATIVE_INFINITY;
  let bottom = Number.NEGATIVE_INFINITY;
  for (const node of nodes) {
    left = Math.min(left, node.x - node.width / 2);
    top = Math.min(top, node.y - node.height / 2);
    right = Math.max(right, node.x + node.width / 2);
    bottom = Math.max(bottom, node.y + node.height / 2);
  }
  return {
    left,
    top,
    right,
    bottom,
    width: Math.max(1, right - left),
    height: Math.max(1, bottom - top),
  };
}

function computeViewportInsets(containerSize: VirtualCanvasSize, chatState: ChatPanelState = 'hidden', _dockedWidth = 0): CanvasInsets {
  const baseSideInset = clamp(containerSize.width * 0.035, 24, 52);
  return {
    top: clamp(containerSize.height * (chatState === 'docked' ? 0.14 : 0.16), 96, 138),
    right: baseSideInset,
    bottom: clamp(containerSize.height * 0.14, 96, 126),
    left: baseSideInset,
  };
}

function computeHomeViewport(containerSize: VirtualCanvasSize, bounds: CanvasBounds, chatState: ChatPanelState = 'hidden', dockedWidth = 0, anchor?: Vec2 | null): CanvasViewport {
  const insets = computeViewportInsets(containerSize, chatState, dockedWidth);
  const safeWidth = Math.max(1, containerSize.width - insets.left - insets.right);
  const safeHeight = Math.max(1, containerSize.height - insets.top - insets.bottom);
  const zoom = clamp(Math.min(safeWidth / bounds.width, safeHeight / bounds.height, 1) * 0.98, VIEWPORT_MIN, 1);
  const safeCenterX = insets.left + safeWidth / 2;
  const anchorX = anchor?.x ?? bounds.left + bounds.width / 2;
  return {
    zoom,
    pan: {
      x: safeCenterX - anchorX * zoom,
      y: insets.top + (safeHeight - bounds.height * zoom) / 2 - bounds.top * zoom,
    },
  };
}

function classifyAgents(agents: WorkspaceAgent[]) {
  const orchestrator = agents.find((agent) => normalizeRole(agent) === 'orchestrator')
    ?? agents.find((agent) => /orchestrator/i.test(agent.name))
    ?? null;
  const managers = agents
    .filter((agent) => agent.id !== orchestrator?.id && normalizeRole(agent) === 'manager')
    .sort(rankAgentByStatus);
  const workers = agents
    .filter((agent) => agent.id !== orchestrator?.id && !managers.some((manager) => manager.id === agent.id))
    .sort(rankAgentByStatus);
  return { orchestrator, managers, workers };
}

function agentNode(
  agent: WorkspaceAgent,
  role: 'orchestrator' | 'manager' | 'worker',
  pos: Vec2,
  workingAgentIds: Set<string>,
  approvals: WorkspaceApproval[],
  activeRuns: WorkspaceActiveRun[],
  sizeOverride?: { width: number; height: number },
): CanvasNode {
  const record = agent as unknown as Record<string, unknown>;
  const activeRun = activeRuns.find((run) => run.agents?.some((runAgent) => runAgent.id === agent.id));
  const active = workingAgentIds.has(agent.id);
  const online = isAvailableAgent(agent.status);
  const approval = approvals.find((item) => item.agentName === agent.name);
  const size = sizeOverride ?? (role === 'orchestrator' ? NODE.orchestrator : role === 'manager' ? NODE.manager : NODE.worker);
  const status = statusLabel(agent.status, active ? 'working' : online ? 'online' : 'idle');
  const spaceName = stringField(record, ['spaceName', 'spaceTag']);
  const managerLabel = spaceName ? `${labelize(spaceName)} manager` : 'manager';
  const domainAccent = stringField(record, ['spaceColorHex', 'domainColor', 'colorHex']);
  const monthlyBudgetCents = agent.monthlyBudgetCents;
  const currentMonthSpendCents = agent.currentMonthSpendCents;
  const outOfCredits = monthlyBudgetCents !== undefined && monthlyBudgetCents !== null && currentMonthSpendCents !== undefined && currentMonthSpendCents >= monthlyBudgetCents;
  const operationalState: CanvasOperationalState = outOfCredits || agent.status === 'error'
    ? 'error'
    : agent.status === 'offline'
      ? 'offline'
      : approval
        ? 'attention'
        : active
          ? 'active'
          : 'idle';
  return {
    id: `agent-${agent.id}`,
    kind: role,
    tier: role === 'orchestrator' ? 0 : role === 'manager' ? 1 : 2,
    title: agent.name,
    subtitle: role === 'orchestrator' ? `orchestrator - ${status}` : role === 'manager' ? `${managerLabel} - ${status}` : `worker - ${status}`,
    x: pos.x,
    y: pos.y,
    width: size.width,
    height: size.height,
    role,
    spaceId: stringField(record, ['spaceId']) ?? null,
    spaceName: spaceName ?? null,
    active,
    online,
    warn: Boolean(approval) || agent.status === 'error' || agent.status === 'offline' || outOfCredits,
    outOfCredits,
    status: agent.status,
    operationalState,
    route: `/agents/${agent.id}`,
    accent: role === 'manager'
      ? domainAccent ?? '#06b6d4'
      : stringField(record, ['colorHex', 'accentColor']) ?? (role === 'orchestrator' ? '#a78bfa' : undefined),
    imageUrl: imageFromRecord(record, ['avatarUrl', 'avatarDataUrl', 'imageUrl', 'imageDataUrl', 'iconUrl', 'photoUrl', 'pictureUrl']),
    icon: role === 'orchestrator' ? <BrainCircuit size={20} /> : role === 'manager' ? <ShieldCheck size={18} /> : <Bot size={18} />,
    currentTask: activeRun?.currentStep ?? stringField(record, ['currentTask', 'currentTaskId']),
    startedAt: activeRun?.startedAt,
    progress: runProgress(activeRun),
    tooltipLines: compactStrings([
      `Status: ${status}`,
      stringField(record, ['description']),
      activeRun?.workflowName ? `Run: ${activeRun.workflowName}` : undefined,
      activeRun?.currentStep ? `Step: ${activeRun.currentStep}` : undefined,
      role === 'manager' && spaceName ? `Domain: ${labelize(spaceName)}` : undefined,
      stringField(record, ['runtimeModel']) ? `Model: ${stringField(record, ['runtimeModel'])}` : undefined,
      stringField(record, ['adapterType']) ? `Adapter: ${stringField(record, ['adapterType'])}` : undefined,
      approval ? 'Approval pending' : undefined,
      outOfCredits ? 'Out of credits' : undefined,
    ]),
    agent,
  };
}

function ghostNode(
  id: string,
  kind: 'orchestrator' | 'manager' | 'worker',
  title: string,
  subtitle: string,
  pos: Vec2,
  size: { width: number; height: number },
): CanvasNode {
  return {
    id,
    kind: 'ghost',
    tier: kind === 'orchestrator' ? 0 : kind === 'manager' ? 1 : 2,
    title,
    subtitle,
    x: pos.x,
    y: pos.y,
    width: size.width,
    height: size.height,
    ghost: true,
    role: kind,
    route: '/agents',
    icon: kind === 'orchestrator' ? <BrainCircuit size={18} /> : kind === 'manager' ? <ShieldCheck size={18} /> : <Bot size={18} />,
    tooltipLines: kind === 'orchestrator'
      ? ['Your orchestrator goes here - it directs the workspace hierarchy.']
      : kind === 'manager'
        ? ['Managers coordinate workers inside a space.']
        : ['Workers execute tasks, research, writing, and automations.'],
  };
}

function buildResourceNodes(
  data: EcosystemData,
  activeRuns: WorkspaceActiveRun[],
  artifacts: WorkspaceArtifact[],
  approvals: WorkspaceApproval[],
  failedRuns: WorkspaceFailedRun[],
  canvasSize: VirtualCanvasSize,
  activeWorkflowIds: Set<string>,
  resourceStartY: number,
  spaceSourceIds: Map<string, string>,
  sourceXById: Map<string, number>,
  sourceNodeById: Map<string, CanvasNode>,
  expandedDomains: ReadonlySet<string> = new Set<string>(),
): CanvasNode[] {
  const resources: CanvasNode[] = [];
  const workflowPositions = new Map<string, Vec2>();
  const workflowDomainById = new Map<string, { spaceId?: string | null; spaceName?: string | null; accent?: string }>();
  const workflowArtifactIndex = new Map<string, number>();
  const artifactCountsByWorkflow = countArtifactsByWorkflow(artifacts);
  const resourceCountEstimate = Math.max(
    data.workflows.length + data.knowledgeBases.length + artifacts.length + approvals.length,
    3,
  );
  const columns = Math.max(1, Math.min(resourceCountEstimate, Math.max(3, Math.floor(canvasSize.width / 250))));
  const anchoredSlots = new Map<string, number>();
  const gridPosAt = (row: number, col: number): Vec2 => {
    const margin = 120;
    const available = canvasSize.width - margin * 2;
    const gridWidth = Math.min(available, Math.max(1, columns - 1) * 260);
    const start = canvasSize.width / 2 - gridWidth / 2;
    const x = columns === 1 ? canvasSize.width / 2 : start + (gridWidth * col) / Math.max(1, columns - 1);
    return { x, y: resourceStartY + row * 104 };
  };
  const positions = (index: number): Vec2 => gridPosAt(Math.floor(index / columns), index % columns);
  const anchoredPosition = (sourceId: string): Vec2 => {
    const slot = anchoredSlots.get(sourceId) ?? 0;
    anchoredSlots.set(sourceId, slot + 1);
    const row = Math.floor(slot / 3);
    const col = slot % 3;
    const offsets = [0, -190, 190];
    const sourceX = sourceXById.get(sourceId) ?? canvasSize.width / 2;
    return {
      x: clamp(sourceX + (offsets[col] ?? 0), 130, canvasSize.width - 130),
      y: resourceStartY + row * 104,
    };
  };

  let index = 0;

  // ── Phase 1: resolve each workflow's domain + state (no placement yet) ──
  interface WorkflowEntry {
    workflow: HomeWorkflow;
    wfLabel: string;
    run: WorkspaceActiveRun | undefined;
    connectedAgentIds: string[] | undefined;
    workflowSpaceId: string | null;
    workflowSpaceName: string | null;
    workflowAccent: string | undefined;
    anchoredSourceId: string | undefined;
    failed: WorkspaceFailedRun | undefined;
    groupKey: string;
    /** 0 = needs attention (failed), 1 = active/running, 2 = idle — floats problems up. */
    statePriority: number;
  }
  const entries: WorkflowEntry[] = data.workflows.map((workflow) => {
    const run = activeRuns.find((item) => item.workflowId === workflow.id);
    const wfLabel = workflowLabel(workflow);
    let connectedAgentIds = run?.agents?.map((agent) => `agent-${agent.id}`);
    if ((!connectedAgentIds || connectedAgentIds.length === 0) && workflow?.graph?.nodes) {
      connectedAgentIds = workflow.graph.nodes
        .filter((node: any) => node.config?.kind === 'agent_task' && node.config?.agentId)
        .map((node: any) => `agent-${node.config.agentId}`);
    }
    if ((!connectedAgentIds || connectedAgentIds.length === 0) && workflow.spaceId) {
      const sourceId = spaceSourceIds.get(workflow.spaceId);
      if (sourceId) connectedAgentIds = [sourceId];
    }
    let workflowSpaceId = workflow.spaceId ?? null;
    let workflowSpaceName: string | null = null;
    let workflowAccent: string | undefined;
    const linkedDomain = resolveDomainFromSources(connectedAgentIds, sourceNodeById);
    if (!workflowSpaceId && linkedDomain.spaceId) workflowSpaceId = linkedDomain.spaceId;
    if (linkedDomain.spaceName) workflowSpaceName = linkedDomain.spaceName;
    if (linkedDomain.accent) workflowAccent = linkedDomain.accent;
    if (workflowSpaceId) {
      const sourceId = spaceSourceIds.get(workflowSpaceId);
      if (sourceId && (!connectedAgentIds || connectedAgentIds.length === 0)) connectedAgentIds = [sourceId];
      const sourceNode = sourceId ? sourceNodeById.get(sourceId) : undefined;
      if (!workflowSpaceName) workflowSpaceName = sourceNode?.spaceName ?? null;
      if (!workflowAccent) workflowAccent = sourceNode?.accent;
    }
    const anchoredSourceId = connectedAgentIds?.find((sourceId) => sourceXById.has(sourceId));
    const failed = failedRuns.find((item) => item.workflowId === workflow.id || item.workflowName === wfLabel);
    const isActive = Boolean(run) || activeWorkflowIds.has(workflow.id);
    const statePriority = failed ? 0 : isActive ? 1 : 2;
    const groupKey = workflowSpaceName ?? workflowSpaceId ?? '~ungrouped';
    return { workflow, wfLabel, run, connectedAgentIds, workflowSpaceId, workflowSpaceName, workflowAccent, anchoredSourceId, failed, groupKey, statePriority };
  });

  // ── Phase 2: group non-anchored workflows into domain bands; within a band,
  // order attention-first. Anchored workflows stay clustered under their source.
  const banded = entries.filter((e) => !e.anchoredSourceId);
  const groups = new Map<string, WorkflowEntry[]>();
  for (const e of banded) {
    const list = groups.get(e.groupKey) ?? [];
    list.push(e);
    groups.set(e.groupKey, list);
  }
  // Domains needing attention (or actively running) float to the top bands.
  const orderedGroups = [...groups.entries()].sort((a, b) => {
    const aBest = Math.min(...a[1].map((e) => e.statePriority));
    const bBest = Math.min(...b[1].map((e) => e.statePriority));
    return aBest - bBest || a[0].localeCompare(b[0]);
  });
  const bandPos = new Map<string, Vec2>();
  const aggregators: CanvasNode[] = [];
  const hiddenByGroup = new Map<string, WorkflowEntry[]>();
  let bandRow = 0;
  for (const [groupKey, groupEntries] of orderedGroups) {
    groupEntries.sort((a, b) => a.statePriority - b.statePriority || a.wfLabel.localeCompare(b.wfLabel));
    // Scale rule: an unexpanded domain shows at most ONE band row. Failed and
    // active workflows always show; idle ones fill the remaining slots and the
    // rest collapse behind a "+N idle" expander. Dozens of workflows stay one
    // calm row per domain instead of a wall of cards.
    const expanded = expandedDomains.has(groupKey);
    const overflows = groupEntries.length > columns;
    const visibleBudget = !overflows ? groupEntries.length : expanded ? groupEntries.length : columns - 1;
    const visible = groupEntries.slice(0, visibleBudget);
    const hidden = groupEntries.slice(visibleBudget);
    if (hidden.length > 0) hiddenByGroup.set(groupKey, hidden);

    let col = 0;
    for (const e of visible) {
      bandPos.set(e.workflow.id, gridPosAt(bandRow, col));
      col += 1;
      if (col >= columns) { col = 0; bandRow += 1; }
    }
    if (overflows) {
      // The expander persists in both states so the band can collapse again.
      const pos = gridPosAt(bandRow, col);
      const domainLabel = groupKey === '~ungrouped' ? 'workspace' : groupKey;
      aggregators.push({
        id: `workflow-more:${encodeURIComponent(groupKey)}`,
        kind: 'workflow',
        tier: 3,
        title: expanded ? 'Show less' : `+${hidden.length} more`,
        subtitle: expanded ? `collapse ${domainLabel}` : `idle in ${domainLabel}`,
        x: pos.x,
        y: pos.y,
        width: NODE.workflow.width,
        height: NODE.workflow.height,
        ghost: true,
        tooltipLines: compactStrings([
          expanded
            ? 'Collapse this domain back to one row.'
            : `${hidden.length} idle workflow${hidden.length === 1 ? '' : 's'} collapsed.`,
          ...hidden.slice(0, 6).map((h) => `· ${h.wfLabel}`),
          hidden.length > 6 ? `· …and ${hidden.length - 6} more` : undefined,
        ]),
      });
      col += 1;
      if (col >= columns) { col = 0; bandRow += 1; }
    }
    if (col !== 0) bandRow += 1; // each domain starts a fresh band
  }
  // Knowledge/artifacts continue on the row after the workflow bands.
  index = bandRow * columns;

  // ── Phase 3: emit nodes (anchored first, then the banded order) ──
  const placementOrder = [
    ...entries.filter((e) => e.anchoredSourceId),
    ...orderedGroups.flatMap(([groupKey, groupEntries]) => {
      const hidden = hiddenByGroup.get(groupKey);
      return hidden ? groupEntries.filter((e) => !hidden.includes(e)) : groupEntries;
    }),
  ];
  resources.push(...aggregators);
  for (const e of placementOrder) {
    const { workflow, wfLabel, run, connectedAgentIds, workflowSpaceId, workflowSpaceName, workflowAccent, anchoredSourceId, failed } = e;
    const pos = anchoredSourceId ? anchoredPosition(anchoredSourceId) : bandPos.get(workflow.id) ?? positions(index++);
    resources.push({
      id: `workflow-${workflow.id}`,
      kind: 'workflow',
      tier: 3,
      title: wfLabel,
      subtitle: run ? activeRunSubtitle(run) : statusLabel(workflow.status, 'workflow'),
      x: pos.x,
      y: pos.y,
      width: NODE.workflow.width,
      height: NODE.workflow.height,
      spaceId: workflowSpaceId,
      spaceName: workflowSpaceName,
      active: Boolean(run) || activeWorkflowIds.has(workflow.id),
      warn: Boolean(failed),
      route: `/workflows/${workflow.id}`,
      accent: workflowAccent,
      imageUrl: workflowImageUrl(workflow),
      icon: <Workflow size={17} />,
      progress: runProgress(run),
      startedAt: run?.startedAt,
      artifactCount: artifactCountsByWorkflow.get(workflow.id) ?? 0,
      tooltipLines: compactStrings([
        `Status: ${run ? activeRunSubtitle(run) : statusLabel(workflow.status, 'idle')}`,
        workflowSpaceName ? `Domain: ${workflowSpaceName}` : undefined,
        run?.currentStep ? `Step: ${run.currentStep}` : undefined,
        failed?.failedNode ? `Failed at: ${failed.failedNode}` : undefined,
      ]),
      workflow,
      connectedAgentIds,
    });
    workflowDomainById.set(workflow.id, { spaceId: workflowSpaceId, spaceName: workflowSpaceName, accent: workflowAccent });
    workflowPositions.set(workflow.id, pos);
  }

  for (const base of [...data.knowledgeBases].sort((a, b) => a.name.localeCompare(b.name))) {
    const pos = positions(index++);
    resources.push({
      id: `knowledge-${base.id}`,
      kind: 'knowledge',
      tier: 3,
      title: base.name,
      subtitle: 'knowledge base',
      x: pos.x,
      y: pos.y,
      width: NODE.knowledge.width,
      height: NODE.knowledge.height,
      active: false,
      route: `/knowledge/bases/${base.id}`,
      imageUrl: imageFromRecord(base, ['imageUrl', 'iconUrl']),
      icon: <BookOpen size={17} />,
      tooltipLines: compactStrings([base.description, 'Used as shared workspace memory']),
      knowledge: base,
    });
  }

  for (const artifact of artifacts) {
    const workflowId = artifact.workflowId ?? null;
    const workflowPos = workflowId ? workflowPositions.get(workflowId) : undefined;
    const workflowDomain = workflowId ? workflowDomainById.get(workflowId) : undefined;
    const artifactDomain = workflowDomain ?? resolveDomainFromSources(
      artifact.agentId ? [`agent-${artifact.agentId}`] : undefined,
      sourceNodeById,
    );
    const localIndex = workflowId ? workflowArtifactIndex.get(workflowId) ?? 0 : 0;
    if (workflowId) workflowArtifactIndex.set(workflowId, localIndex + 1);
    const pos = workflowPos
      ? artifactDetailPosition(workflowPos, localIndex, workflowId ? artifactCountsByWorkflow.get(workflowId) ?? 1 : 1)
      : positions(index++);
    resources.push({
      id: `artifact-${artifact.id}`,
      kind: 'artifact',
      tier: 4,
      title: artifact.title,
      subtitle: artifact.agent ? artifact.agent : 'generated asset',
      x: pos.x,
      y: pos.y,
      width: NODE.artifact.width,
      height: NODE.artifact.height,
      spaceId: artifactDomain.spaceId ?? null,
      spaceName: artifactDomain.spaceName ?? null,
      active: false,
      route: '/artifacts',
      accent: artifactDomain.accent,
      imageUrl: artifactImageUrl(artifact),
      icon: artifact.kind === 'data' || artifact.type === 'data' ? <Database size={17} /> : artifact.kind === 'code' || artifact.type === 'code' ? <Boxes size={17} /> : <Layers size={17} />,
      tooltipLines: compactStrings([
        `Type: ${artifact.kind ?? artifact.type ?? 'artifact'}`,
        artifactDomain.spaceName ? `Domain: ${artifactDomain.spaceName}` : undefined,
        artifact.agent ? `Agent: ${artifact.agent}` : undefined,
        artifact.workflowId ? `Workflow: ${artifact.workflowId}` : undefined,
      ]),
      artifact,
      connectedAgentIds: artifact.agentId ? [`agent-${artifact.agentId}`] : undefined,
    });
  }

  for (const approval of approvals) {
    const assignee = approval.agentName
      ? Array.from(sourceNodeById.values()).find((node) => node.agent?.name === approval.agentName)
      : undefined;
    const connectedAgentIds = assignee ? [assignee.id] : undefined;
    const approvalDomain = resolveDomainFromSources(connectedAgentIds, sourceNodeById);
    const pos = positions(index++);
    resources.push({
      id: `approval-${approval.id}`,
      kind: 'approval',
      tier: 3,
      title: approval.agentName ? `${approval.agentName} needs review` : 'Approval needed',
      subtitle: approval.workflowName ?? 'human decision',
      x: pos.x,
      y: pos.y,
      width: NODE.approval.width,
      height: NODE.approval.height,
      spaceId: approvalDomain.spaceId ?? null,
      spaceName: approvalDomain.spaceName ?? null,
      active: false,
      warn: true,
      route: '/history?tab=runs',
      accent: approvalDomain.accent,
      icon: <CanvasApprovalNodeBadge />,
      tooltipLines: compactStrings([
        approvalDomain.spaceName ? `Domain: ${approvalDomain.spaceName}` : undefined,
        approval.summary,
        approval.runId ? `Run: ${approval.runId}` : undefined,
      ]),
      approval,
      connectedAgentIds,
    });
  }

  if (resources.length === 0) {
    const defaultSourceId = spaceSourceIds.values().next().value as string | undefined;
    const ghostKinds = [
      ['Resource layer', 'apps, workflows, knowledge, outputs', <FileText size={16} />],
      ['Knowledge', 'workspace memory appears here', <BookOpen size={16} />],
      ['Artifacts', 'agent output lands here', <Layers size={16} />],
    ] as const;
    ghostKinds.forEach(([title, subtitle, icon], ghostIndex) => {
      const pos = positions(ghostIndex);
      resources.push({
        id: `ghost-resource-${ghostIndex}`,
        kind: 'ghost',
        tier: 3,
        title,
        subtitle,
        x: pos.x,
        y: pos.y,
        width: NODE.resource.width,
        height: NODE.resource.height,
        ghost: true,
        icon,
        route: '/workflows',
        tooltipLines: ['Planned resource node'],
        spaceId: defaultSourceId ? sourceNodeById.get(defaultSourceId)?.spaceId ?? null : null,
        spaceName: defaultSourceId ? sourceNodeById.get(defaultSourceId)?.spaceName ?? null : null,
        accent: defaultSourceId ? sourceNodeById.get(defaultSourceId)?.accent : undefined,
        connectedAgentIds: defaultSourceId ? [defaultSourceId] : undefined,
      });
    });
  }

  return resources;
}

function selectCanvasArtifacts(artifacts: WorkspaceArtifact[], focusWorkflowId: string | null): WorkspaceArtifact[] {
  if (!focusWorkflowId) return [];
  const scoped = artifacts.filter((artifact) => {
    return artifact.workflowId === focusWorkflowId;
  });
  return scoped.slice(0, 8);
}

function shouldRevealKnowledgeNodes(selectedNodeId: string | null, agents: WorkspaceAgent[]): boolean {
  if (!selectedNodeId) return false;
  if (selectedNodeId === 'ghost-orchestrator' || selectedNodeId.startsWith('knowledge-')) return true;
  if (!selectedNodeId.startsWith('agent-')) return false;
  const agentId = selectedNodeId.slice('agent-'.length);
  const agent = agents.find((item) => item.id === agentId);
  const role = agent ? normalizeRole(agent) : null;
  // Authority tiers (orchestrator + managers) own shared workspace memory, so
  // selecting either reveals the knowledge layer — and it persists as you drill
  // down the chain of command. Workers don't surface workspace-wide knowledge.
  return role === 'orchestrator' || role === 'manager';
}

function countArtifactsByWorkflow(artifacts: WorkspaceArtifact[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const artifact of artifacts) {
    if (!artifact.workflowId) continue;
    counts.set(artifact.workflowId, (counts.get(artifact.workflowId) ?? 0) + 1);
  }
  return counts;
}

function artifactDetailPosition(parent: Vec2, index: number, total: number): Vec2 {
  const columns = Math.min(3, Math.max(1, total));
  const col = index % columns;
  const row = Math.floor(index / columns);
  const gap = NODE.artifact.width + 18;
  return {
    x: parent.x + (col - (columns - 1) / 2) * gap,
    y: parent.y + NODE.workflow.height / 2 + 64 + row * 58,
  };
}

function computeWorkerNodeSize(count: number): { width: number; height: number } {
  if (count >= 24) return { width: 132, height: 52 };
  if (count >= 14) return { width: 148, height: 56 };
  if (count >= 9) return { width: 160, height: 60 };
  return NODE.worker;
}

function computeWorkerColumns(count: number): number {
  if (count <= 0) return 1;
  if (count <= 8) return count;
  if (count <= 16) return 8;
  return 10;
}

function distributeRow(count: number, width: number, y: number, nodeWidth: number): Vec2[] {
  if (count <= 0) return [];
  const spacing = Math.max(nodeWidth + 70, 230);
  const rowWidth = (count - 1) * spacing;
  const start = width / 2 - rowWidth / 2;
  return Array.from({ length: count }, (_, index) => ({ x: start + index * spacing, y }));
}

function distributeLayer(count: number, width: number, startY: number, nodeWidth: number, rowGap: number, maxColumns: number): Vec2[] {
  if (count <= 0) return [];
  const columns = Math.max(1, Math.min(count, maxColumns));
  const spacing = nodeWidth + (count >= 14 ? 34 : count >= 9 ? 46 : 64);
  const positions: Vec2[] = [];
  for (let row = 0; positions.length < count; row += 1) {
    const remaining = count - positions.length;
    const rowCount = Math.min(columns, remaining);
    const rowWidth = (rowCount - 1) * spacing;
    const start = width / 2 - rowWidth / 2;
    for (let col = 0; col < rowCount; col += 1) {
      positions.push({ x: start + col * spacing, y: startY + row * rowGap });
    }
  }
  return positions;
}

function commandEdge(from: string, to: string, active: boolean): CanvasEdge {
  return {
    id: `command-${from}-${to}`,
    from,
    to,
    type: 'command',
    activeRunCount: active ? 1 : 0,
    active,
  };
}

function resolveResourceSourceIds(resource: CanvasNode, nodes: CanvasNode[], orchestratorId: string): string[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const agentCandidates = (resource.connectedAgentIds ?? []).filter((id) => byId.has(id));

  if (resource.kind === 'artifact' && resource.artifact?.workflowId) {
    const workflowId = `workflow-${resource.artifact.workflowId}`;
    if (byId.has(workflowId)) return [workflowId];
  }

  if (resource.kind === 'approval' && resource.approval?.agentName) {
    const assignee = nodes.find((node) => node.agent?.name === resource.approval?.agentName);
    if (assignee) return [assignee.id];
  }

  const bestAgentId = pickBestAgentSource(agentCandidates, byId);
  if (bestAgentId) return [bestAgentId];

  return byId.has(orchestratorId) ? [orchestratorId] : [];
}

function pickBestAgentSource(candidates: string[], byId: Map<string, CanvasNode>): string | null {
  if (candidates.length === 0) return null;
  return candidates.find((id) => byId.get(id)?.kind === 'manager' || byId.get(id)?.role === 'manager')
    ?? candidates.find((id) => byId.get(id)?.kind === 'worker' || byId.get(id)?.role === 'worker')
    ?? candidates.find((id) => byId.get(id)?.kind === 'orchestrator' || byId.get(id)?.role === 'orchestrator')
    ?? candidates[0]
    ?? null;
}

function resolveDomainFromSources(
  candidateIds: string[] | undefined,
  sourceNodeById: Map<string, CanvasNode>,
): { spaceId?: string | null; spaceName?: string | null; accent?: string } {
  const sourceNodes = (candidateIds ?? [])
    .map((id) => sourceNodeById.get(id))
    .filter((node): node is CanvasNode => Boolean(node));
  const domainNode = sourceNodes.find((node) => node.role === 'manager' && node.spaceId)
    ?? sourceNodes.find((node) => node.spaceId);
  if (!domainNode) return {};
  return {
    spaceId: domainNode.spaceId ?? null,
    spaceName: domainNode.spaceName ?? null,
    accent: domainNode.accent,
  };
}

function nodeRevealPhase(node: CanvasNode): EntrancePhase {
  if (node.tier <= 0) return 'orchestrator';
  if (node.tier === 1) return 'managers';
  if (node.tier === 2) return 'workers';
  return 'resources';
}

function edgeRevealPhase(edge: CanvasEdge, nodeMap: Map<string, CanvasNode>): EntrancePhase {
  if (edge.type === 'resource') return 'resources';
  const target = nodeMap.get(edge.to);
  if (target?.tier === 1) return 'managers';
  if (target?.tier === 2) return 'workers';
  return 'resources';
}

function phaseReached(current: EntrancePhase, target: EntrancePhase): boolean {
  return PHASE_ORDER[current] >= PHASE_ORDER[target];
}

function findParentManager(agent: WorkspaceAgent, managerNodeIds: string[], managers: WorkspaceAgent[], index: number): string | null {
  if (managerNodeIds.length === 0) return null;
  const record = agent as unknown as Record<string, unknown>;
  const reportsTo = stringField(record, ['reportsTo', 'managerId', 'parentAgentId']);
  if (reportsTo) {
    const managerIndex = managers.findIndex((manager) => manager.id === reportsTo || manager.name === reportsTo);
    if (managerIndex >= 0) return managerNodeIds[managerIndex] ?? null;
  }
  return managerNodeIds[index % managerNodeIds.length] ?? null;
}

function edgePath(from: CanvasNode, to: CanvasNode, type: 'command' | 'resource'): string {
  const verticalGap = to.y - from.y;
  if (Math.abs(verticalGap) < Math.max(from.height, to.height)) {
    const fromX = from.x + Math.sign(to.x - from.x || 1) * from.width / 2;
    const toX = to.x - Math.sign(to.x - from.x || 1) * to.width / 2;
    const midX = (fromX + toX) / 2;
    return `M ${fromX} ${from.y} C ${midX} ${from.y}, ${midX} ${to.y}, ${toX} ${to.y}`;
  }

  const downward = verticalGap >= 0;
  const fromY = from.y + (downward ? from.height / 2 : -from.height / 2);
  const toY = to.y + (downward ? -to.height / 2 : to.height / 2);
  const midY = type === 'command'
    ? (fromY + toY) / 2
    : fromY + (toY - fromY) * 0.42;
  const sway = type === 'resource' ? (to.x - from.x) * 0.08 : 0;
  return `M ${from.x} ${fromY} C ${from.x + sway} ${midY}, ${to.x - sway} ${midY}, ${to.x} ${toY}`;
}

function canvasToScreen(node: CanvasNode, viewport: CanvasViewport): Vec2 {
  return { x: node.x * viewport.zoom + viewport.pan.x, y: node.y * viewport.zoom + viewport.pan.y };
}

function dedupeEdges(edges: CanvasEdge[]): CanvasEdge[] {
  const byId = new Map<string, CanvasEdge>();
  for (const edge of edges) {
    const existing = byId.get(edge.id);
    if (!existing) byId.set(edge.id, edge);
    else byId.set(edge.id, { ...existing, activeRunCount: Math.max(existing.activeRunCount, edge.activeRunCount), active: existing.active || edge.active });
  }
  return Array.from(byId.values());
}

function workflowLabel(workflow: HomeWorkflow): string {
  return workflow.title ?? workflow.name ?? 'Untitled workflow';
}

function activeRunSubtitle(run: WorkspaceActiveRun): string {
  if (run.stepIndex != null && run.totalSteps != null) return `running - step ${run.stepIndex}/${run.totalSteps}`;
  if (run.currentStep) return run.currentStep;
  return 'running now';
}

/**
 * Mission-Control triage row: not a title — the live agent reasoning / current
 * step / progress for one active run, streamed via the activity spine. This is
 * the "see what's happening" surface the triage card was supposed to be.
 */
/**
 * Mission-Control run card: an immersive, alive view of one running workflow —
 * pulsing live beacon, elapsed + step progress, the agent currently working, and a
 * scrolling LIVE REASONING TERMINAL streaming the agent's thoughts and tool calls
 * as they happen. Click to open the full run; Stop to halt it. Fed by the
 * socket-independent run activity stream.
 */
function TriageRunRow({ run, onOpen }: { run: WorkspaceActiveRun; onOpen: () => void }) {
  const feed = useRunActivity(run.id, { cap: 40 });
  const [stopping, setStopping] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const termRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, []);

  const progress =
    feed.find((a) => a.progress)?.progress ??
    (run.totalSteps ? { completed: run.stepIndex ?? 0, total: run.totalSteps } : undefined);
  const pct = progress && progress.total > 0 ? Math.min(100, (progress.completed / progress.total) * 100) : null;
  const agentName = feed.find((a) => a.agentName)?.agentName;
  const nodeTitle = feed.find((a) => a.nodeTitle)?.nodeTitle;
  // Live terminal: the most recent meaningful steps, oldest→newest (terminal order).
  const lines = feed
    .filter((a) => a.kind === 'message' || a.kind === 'tool' || a.kind === 'agent' || a.kind === 'node')
    .slice(0, 6)
    .reverse();
  const elapsed = run.startedAt ? formatElapsed(run.startedAt, now) : null;

  useEffect(() => {
    termRef.current?.scrollTo({ top: termRef.current.scrollHeight, behavior: 'smooth' });
  }, [feed.length]);

  async function stop(event: { stopPropagation: () => void }) {
    event.stopPropagation();
    if (stopping) return;
    setStopping(true);
    try { await api(`/v1/runs/${run.id}/cancel`, { method: 'POST' }); } catch { /* surfaced via realtime */ }
    finally { setStopping(false); }
  }

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => { if (e.key === 'Enter') onOpen(); }}
      className="group cursor-pointer overflow-hidden rounded-xl border border-accent/25 bg-gradient-to-b from-surface/70 to-canvas/55 shadow-[0_0_22px_rgba(74,222,128,0.06)] transition hover:border-accent/45 hover:shadow-[0_0_30px_rgba(74,222,128,0.12)]"
    >
      {/* Header: live beacon + name + elapsed/steps + stop */}
      <div className="flex items-center gap-2.5 px-3 pt-2.5 pb-2">
        <span className="relative flex h-2.5 w-2.5 shrink-0">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent/60" />
          <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-accent" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-semibold text-text-primary">{run.workflowName}</div>
          <div className="flex items-center gap-1.5 text-[10px] text-text-muted">
            {elapsed && <span className="font-mono tabular-nums">{elapsed}</span>}
            {progress && (
              <>
                {elapsed && <span className="opacity-50">·</span>}
                <span className="font-mono tabular-nums">{progress.completed}/{progress.total} steps</span>
              </>
            )}
          </div>
        </div>
        <button
          type="button"
          onClick={stop}
          disabled={stopping}
          aria-label="Stop run"
          title="Stop run"
          className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-text-muted opacity-0 transition hover:bg-danger-soft hover:text-danger group-hover:opacity-100 disabled:opacity-40"
        >
          <Square size={11} />
        </button>
      </div>

      {/* Glowing progress rail */}
      <div className="h-[3px] w-full bg-line/50">
        <div
          className="h-full bg-accent shadow-[0_0_8px_rgba(74,222,128,0.6)] transition-all duration-700"
          style={{ width: pct != null ? `${pct}%` : '0%' }}
        />
      </div>

      {/* Who's working now */}
      {(agentName || nodeTitle) && (
        <div className="flex items-center gap-1.5 px-3 py-1.5">
          {agentName && (
            <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-accent/12 px-1.5 py-0.5 text-[9px] font-semibold text-accent">
              <Bot size={9} /> {agentName}
            </span>
          )}
          {nodeTitle && <span className="min-w-0 truncate text-[10.5px] text-text-secondary">{nodeTitle}</span>}
        </div>
      )}

      {/* LIVE reasoning terminal */}
      <div
        ref={termRef}
        className="max-h-[112px] overflow-y-auto border-t border-white/5 bg-black/30 px-3 py-2"
        style={{ scrollbarWidth: 'none' }}
      >
        {lines.length === 0 ? (
          <div className="flex items-center gap-1.5 font-mono text-[10px] text-text-muted">
            <Loader2 size={10} className="animate-spin text-accent" /> awaiting the agent’s first move…
          </div>
        ) : (
          <div className="space-y-1">
            {lines.map((item, idx) => (
              <div
                key={item.id}
                className={clsx(
                  'flex items-start gap-1.5 font-mono text-[10px] leading-relaxed animate-in fade-in slide-in-from-bottom-1 duration-200',
                  idx === lines.length - 1 ? 'text-text-secondary' : 'text-text-muted/65',
                )}
              >
                <span className="mt-[1px] shrink-0"><ActivityGlyph kind={item.kind} /></span>
                <span className="min-w-0 flex-1 break-words line-clamp-2">
                  {item.agentName ? <span className="text-accent/80">{item.agentName}: </span> : null}
                  {item.detail}
                </span>
                {idx === lines.length - 1 && (
                  <span className="ml-0.5 mt-[3px] inline-block h-2.5 w-1 shrink-0 animate-pulse rounded-sm bg-accent/70" />
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/** Kind → glyph for the live reasoning terminal. */
function ActivityGlyph({ kind }: { kind: string }) {
  if (kind === 'tool') return <Wrench size={10} className="text-sky-400" />;
  if (kind === 'node') return <Workflow size={10} className="text-violet-400" />;
  if (kind === 'run') return <Zap size={10} className="text-amber-400" />;
  return <BrainCircuit size={10} className="text-accent" />;
}

function isActiveRun(run: WorkspaceActiveRun): boolean {
  return run.status.toLowerCase() === 'running';
}

function artifactsProducedToday(artifacts: WorkspaceArtifact[]): number {
  const start = startOfLocalDayMs();
  return artifacts.filter((artifact) => Date.parse(artifact.createdAt) >= start).length;
}

function startOfLocalDayMs(): number {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
}

function statusLabel(status: string | undefined, fallback: string): string {
  if (!status) return fallback;
  return status.replace(/_/g, ' ');
}

function labelize(value: string): string {
  return value
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function normalizeRole(agent: WorkspaceAgent): string {
  const record = agent as unknown as Record<string, unknown>;
  const role = stringField(record, ['role', 'agentRole', 'type'])?.toLowerCase();
  if (role?.includes('orchestrator')) return 'orchestrator';
  if (role?.includes('manager')) return 'manager';
  if (/orchestrator/i.test(agent.name)) return 'orchestrator';
  if (/manager|lead|owner/i.test(agent.name)) return 'manager';
  return 'worker';
}

function rankAgentByStatus(a: WorkspaceAgent, b: WorkspaceAgent): number {
  return rankAgentStatus(b.status) - rankAgentStatus(a.status) || a.name.localeCompare(b.name);
}

function rankAgentStatus(status: string | undefined): number {
  if (status === 'active' || status === 'running' || status === 'busy') return 3;
  if (status === 'online') return 2;
  if (status === 'error' || status === 'offline') return 1;
  return 0;
}

function isAvailableAgent(status: string | undefined): boolean {
  return status === 'online' || status === 'active' || status === 'running' || status === 'busy';
}

function isWorkingAgent(agent: WorkspaceAgent): boolean {
  if (agent.status === 'active' || agent.status === 'running' || agent.status === 'busy') return true;
  return typeof agent.currentTaskId === 'string' && agent.currentTaskId.trim().length > 0;
}

function runProgress(run: WorkspaceActiveRun | undefined): number | undefined {
  if (!run || run.stepIndex == null || run.totalSteps == null || run.totalSteps <= 0) return undefined;
  return clamp(run.stepIndex / run.totalSteps, 0.06, 1);
}

function formatElapsed(startedAt: string, now: number): string {
  const started = new Date(startedAt).getTime();
  if (!Number.isFinite(started)) return '';
  const totalSeconds = Math.max(0, Math.floor((now - started) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, '0')}m`;
  if (minutes > 0) return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
  return `${seconds}s`;
}

function workflowImageUrl(workflow: HomeWorkflow): string | undefined {
  return imageFromRecord(workflow, ['imageUrl', 'iconUrl', 'coverUrl', 'avatarUrl'])
    ?? imageFromRecord(workflow.settings, ['imageUrl', 'iconUrl', 'coverUrl', 'avatarUrl', 'thumbnailUrl']);
}

function artifactImageUrl(artifact: WorkspaceArtifact): string | undefined {
  const thumbnail = artifact.thumbnailUrl ?? artifact.thumbUrl ?? undefined;
  if (thumbnail) return thumbnail;
  const type = artifact.kind ?? artifact.type;
  if (type === 'image') return imageFromRecord(artifact, ['content', 'url', 'imageUrl']);
  return imageFromRecord(artifact, ['imageUrl', 'iconUrl']);
}

function imageFromRecord(source: unknown, keys: string[]): string | undefined {
  return stringField(source, keys);
}

function stringField(source: unknown, keys: string[]): string | undefined {
  if (!isRecord(source)) return undefined;
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string' && value.trim().length > 0) return value;
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function compactStrings(values: Array<string | undefined | null | false>): string[] {
  return values.filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

const CANVAS_STYLE = `
@keyframes homeNodeIn {
  0% { opacity: 0; transform: translate(-50%, calc(-50% + 18px)) scale(0.96); filter: blur(6px); }
  100% { opacity: 1; transform: translate(-50%, -50%) scale(1); filter: blur(0); }
}

@keyframes homeEdgeIn {
  0% { stroke-dasharray: 1; stroke-dashoffset: 1; }
  100% { stroke-dasharray: 1; stroke-dashoffset: 0; }
}

@keyframes homeOrchestratorAura {
  0%, 100% { box-shadow: 0 0 0 1px rgba(167,139,250,0.28), 0 0 44px rgba(167,139,250,0.10); }
  50% { box-shadow: 0 0 0 1px rgba(167,139,250,0.46), 0 0 72px rgba(167,139,250,0.18); }
}

@keyframes homeGhostBreathe {
  0%, 100% { opacity: 0.24; }
  50% { opacity: 0.42; }
}

@keyframes commandEdgeBusy {
  0%, 100% { stroke-opacity: 0.55; }
  50% { stroke-opacity: 1; }
}

.home-node-enter {
  animation: homeNodeIn 520ms cubic-bezier(.2,.8,.2,1) both;
}

.home-edge-enter {
  animation: homeEdgeIn 760ms ease-out both;
}

.home-orchestrator-aura {
  animation-name: homeNodeIn, homeOrchestratorAura;
  animation-duration: 520ms, 3.8s;
  animation-timing-function: cubic-bezier(.2,.8,.2,1), ease-in-out;
  animation-iteration-count: 1, infinite;
  animation-fill-mode: both, none;
}

.home-ghost-breathe {
  animation-name: homeNodeIn, homeGhostBreathe;
  animation-duration: 520ms, 3.5s;
  animation-timing-function: cubic-bezier(.2,.8,.2,1), ease-in-out;
  animation-iteration-count: 1, infinite;
  animation-fill-mode: both, none;
}

.home-command-edge-busy {
  animation: homeEdgeIn 760ms ease-out both, commandEdgeBusy 2s ease-in-out infinite;
}

body.agentis-canvas-fullscreen [data-agentis-shell-header],
body.agentis-canvas-fullscreen [data-agentis-sidebar],
body.agentis-canvas-fullscreen [data-agentis-onboarding-strip],
body.agentis-canvas-fullscreen [data-agentis-live-strip] {
  display: none !important;
}

@media (prefers-reduced-motion: reduce) {
  .home-node-enter,
  .home-edge-enter,
  .home-orchestrator-aura {
    animation: none !important;
  }
}
`;

const PHASE_ORDER: Record<EntrancePhase, number> = {
  idle: 0,
  background: 1,
  orchestrator: 2,
  managers: 3,
  workers: 4,
  resources: 5,
  complete: 6,
};
