import {
  Children,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type SetStateAction,
  type WheelEvent as ReactWheelEvent,
} from 'react';
import { useNavigate } from 'react-router-dom';
import { REALTIME_EVENTS, type WorkStepTrack } from '@agentis/core';
import {
  AlertTriangle,
  Bot,
  Boxes,
  BrainCircuit,
  BookOpen,
  CheckCircle2,
  ChevronDown,
  Clock,
  Database,
  FileText,
  Layers,
  ListTodo,
  PackageOpen,
  Play,
  Plus,
  RotateCcw,
  Save,
  ShieldCheck,
  Workflow,
  X,
  Square,
  Wrench,
  Trash2,
  Pencil,
  Loader2,
  Zap,
  RefreshCw,
  Sparkles,
  Activity as ActivityIcon,
  MessageSquare,
  Maximize2,
  Minimize2,
  Users,
} from 'lucide-react';
import clsx from 'clsx';
import { api, workspace as workspaceStore } from '../../lib/api';
import { openRunModal } from '../../lib/runModal';
import { openApprovalModal } from '../../lib/approvalModal';
import { useRealtime } from '../../lib/realtime';
import { useRunActivity } from '../../lib/useRunActivity';
import {
  useWorkspaceActivity,
  workspaceRequestStatus,
  type WorkspaceRequestStatus,
} from '../../lib/useWorkspaceActivity';
import {
  buildWorkSessions,
  captionMapFromSessions,
  liveNodeIdsFromSessions,
  type WorkSession,
} from '../../lib/workSessions';
import { buildStepIndex, sessionStepTrack, type StepIndex } from '../../lib/workSteps';
import {
  isActiveObservation,
  observationTone,
  useActivityStream,
  type ObservationTone,
  type ObservabilityEvent,
} from '../../lib/observability';
import type { RealtimeActivity } from '../../lib/realtimeActivity';
import type {
  WorkspaceActiveRun,
  WorkspaceAgent,
  WorkspaceApproval,
  WorkspaceArtifact,
  WorkspaceFailedRun,
  WorkspaceFleetOverview,
  WorkspaceIssue,
  WorkspaceUser,
} from '../../lib/workspaceData';
import { useChatPanelStore, type ChatPanelState } from '../chat/ChatPanelStore';
import { AgentCreateWizard } from '../agents/AgentCreateWizard';
import { captureFlip, type FlipSnapshot } from '../shared/flip';
import { CanvasActivityPopover } from './CanvasActivityPopover';
import { CanvasApprovalNodeBadge } from './CanvasApprovalNode';
import { CanvasBackground, type CanvasBackgroundHandle } from './CanvasBackground';
import { CanvasComposerOverlay } from './CanvasComposerOverlay';
import { CanvasControls } from './CanvasControls';
import { CanvasLoadingOverlay } from './CanvasLoadingOverlay';
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
  HomeApp,
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
  issues?: WorkspaceIssue[];
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

interface LiveWorkspaceFrame {
  x: number;
  y: number;
  width: number;
  height: number;
}

type EntrancePhase = 'idle' | 'background' | 'orchestrator' | 'managers' | 'workers' | 'resources' | 'complete';

const EMPTY_DATA: EcosystemData = {
  workflows: [],
  apps: [],
  knowledgeBases: [],
  spaces: [],
  loading: true,
};
const EMPTY_APPROVALS: WorkspaceApproval[] = [];
const EMPTY_FAILED_RUNS: WorkspaceFailedRun[] = [];
const EMPTY_ISSUES: WorkspaceIssue[] = [];
const LIVE_WORKSPACE_KINDS = new Set<string>(['run', 'node', 'agent', 'tool', 'workflow', 'listener']);

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

const RESOURCE_LAYOUT = {
  sideMargin: 120,
  rowGap: 92,
  gridColumnGap: 64,
  anchoredColumnGap: 38,
  nodeClearance: 24,
};
const RESOURCE_GRID_COLUMN_WIDTH = NODE.workflow.width + RESOURCE_LAYOUT.gridColumnGap;
const ANCHORED_WORKFLOW_COLUMN_WIDTH = NODE.workflow.width + RESOURCE_LAYOUT.anchoredColumnGap;
const AUTHORITY_LANE = {
  columnGap: 24,
};
const AUTHORITY_LANE_COLUMN_WIDTH = NODE.workflow.width + AUTHORITY_LANE.columnGap;
const FULL_VIEW_WORKFLOW_ROWS = 2;
const FOCUSED_MANAGER_WORKFLOW_ROWS = 3;
const WORKFLOW_BRANCH_ROW_PATTERN = [2, 3, 4, 5];

const VIEWPORT_MIN = 0.36;
const VIEWPORT_MAX = 2.25;
const LIVE_WORKSPACE_MARGIN = 12;
const LIVE_WORKSPACE_MIN_WIDTH = 320;
const LIVE_WORKSPACE_MIN_HEIGHT = 320;
const LIVE_WORKSPACE_DEFAULT_FRAME: LiveWorkspaceFrame = {
  x: 14,
  y: 14,
  width: 420,
  height: 500,
};

export function WorkspaceEcosystemCanvas({
  agents,
  activeRuns,
  artifacts,
  snapshotLoading,
  approvals: approvalsProp,
  failedRuns: failedRunsProp,
  issues: issuesProp,
  me = null,
  fleet = null,
  counts,
}: WorkspaceEcosystemCanvasProps) {
  const approvals = approvalsProp ?? EMPTY_APPROVALS;
  const failedRuns = failedRunsProp ?? EMPTY_FAILED_RUNS;
  const issues = issuesProp ?? EMPTY_ISSUES;
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
  const [liveWorkspaceOpen, setLiveWorkspaceOpen] = useState(false);
  
  const [expandedDomains, setExpandedDomains] = useState<ReadonlySet<string>>(new Set<string>());
  const [liveWorkspaceFrame, setLiveWorkspaceFrame] = useState<LiveWorkspaceFrame>(() => ({ ...LIVE_WORKSPACE_DEFAULT_FRAME }));
  const [isPanning, setIsPanning] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [entrancePhase, setEntrancePhase] = useState<EntrancePhase>('idle');
  const [createPreset, setCreatePreset] = useState<{ role: 'orchestrator' | 'manager' | 'worker'; flipFrom: FlipSnapshot | null; lock: boolean } | null>(null);
  const chatState = useChatPanelStore((state) => state.state);
  const dockedWidth = useChatPanelStore((state) => state.dockedWidth);

  const refresh = useCallback(async () => {
    setData((current) => ({ ...current, loading: true }));
    const [workflowsRes, appsRes, knowledgeRes, spacesRes] = await Promise.allSettled([
      api<{ workflows: HomeWorkflow[] }>('/v1/workflows'),
      api<{ data: HomeApp[] }>('/v1/apps'),
      api<{ knowledgeBases: HomeKnowledgeBase[] }>('/v1/knowledge-bases'),
      api<{ data: HomeSpace[] }>('/v1/domains'),
    ]);
    setData({
      workflows: workflowsRes.status === 'fulfilled' ? workflowsRes.value.workflows ?? [] : [],
      apps: appsRes.status === 'fulfilled' ? appsRes.value.data ?? [] : [],
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
  // Focus (drill-in) mode: a real manager is selected — the rest of the canvas
  // darkens and the view scopes to that manager's subtree.
  const focusActive = Boolean(selectedNode && selectedNode.role === 'manager' && !selectedNode.ghost);

  // Workspace-wide live activity spine — powers Live Workspace and the
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
  // `now` (1s tick) is a dep so liveness RE-EVALUATES as wall-clock advances, not
  // only when a new event arrives. Without it, a session/orchestrator that goes
  // quiet stays "active" forever until the next event or a page refresh.
  const staleTick = Math.floor(now / 3000);
  const requestStatus = useMemo(() => workspaceRequestStatus(workspaceActivity), [workspaceActivity, staleTick]);
  const commandCenter = useActivityStream({ type: 'workspace', limit: 160 });
  const workSessions = useMemo(() => buildWorkSessions({
    activity: workspaceActivity,
    activeRuns: activeRuns.filter(isActiveRun),
    failedRuns,
    observabilityEvents: commandCenter.events,
    now,
    limit: 16,
  }), [activeRuns, commandCenter.events, failedRuns, workspaceActivity, now]);
  const liveIds = useMemo(() => liveNodeIdsFromSessions(workSessions), [workSessions]);

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
    const map = captionMapFromSessions(workSessions);
    if (requestStatus.busy && model.orchestratorId && requestStatus.label && !map.has(model.orchestratorId)) {
      map.set(model.orchestratorId, requestStatus.label);
    }
    return map;
  }, [workSessions, requestStatus.busy, requestStatus.label, model.orchestratorId]);

  // Select a workflow's canvas node (opens its detail card) from Live Workspace
  const selectWorkflowNode = useCallback((workflowId: string) => {
    setSelectedNodeId(`workflow-${workflowId}`);
  }, []);

  // When the orchestrator starts a new piece of work, surface Live Workspace
  // automatically (open-only; never force-closes what the user opened).
  const wasBusyRef = useRef(false);
  useEffect(() => {
    if (requestStatus.busy && !wasBusyRef.current) setLiveWorkspaceOpen(true);
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
  // Boot state: until the first snapshot AND ecosystem have both loaded once,
  // show a full skeleton instead of the half-assembled tree. Subsequent
  // refreshes are silent (the small "Syncing" chip covers those).
  const [bootLoaded, setBootLoaded] = useState(false);
  useEffect(() => {
    if (!bootLoaded && !snapshotLoading && !data.loading) setBootLoaded(true);
  }, [bootLoaded, snapshotLoading, data.loading]);
  const bootLoading = !bootLoaded && (snapshotLoading || data.loading);
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
  const liveHudCount = Math.max(
    runningCount,
    requestStatus.busy ? 1 : 0,
    workSessions.filter((session) => session.active).length,
  );
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

  function zoomByStep(factor: number) {
    stopAnimation();
    userMovedRef.current = true;
    const current = viewportRef.current;
    const nextZoom = clamp(current.zoom * factor, VIEWPORT_MIN, VIEWPORT_MAX);
    const cx = containerSize.width / 2;
    const cy = containerSize.height / 2;
    const world = { x: (cx - current.pan.x) / current.zoom, y: (cy - current.pan.y) / current.zoom };
    animateViewportTo({ zoom: nextZoom, pan: { x: cx - world.x * nextZoom, y: cy - world.y * nextZoom } }, 180);
  }

  // Drill-in framing: fit the focused manager's subtree, centered, like a fresh
  // orchestrator view scoped to that branch.
  const centerOnSubtree = useCallback((ids: ReadonlySet<string>) => {
    const subtreeNodes = model.nodes.filter((node) => ids.has(node.id));
    if (subtreeNodes.length === 0) return;
    const bounds = computeCanvasContentBounds(subtreeNodes);
    animateViewportTo(computeHomeViewport(containerSize, bounds, chatState, dockedWidth, null), 360);
  }, [model.nodes, containerSize, chatState, dockedWidth]);

  // When a manager is focused, frame its subtree (workers are revealed in the
  // recomputed model, so this runs after that settles).
  useEffect(() => {
    if (!focusActive || !focusedNodeIds) return;
    const ids = focusedNodeIds;
    const raf = window.requestAnimationFrame(() => centerOnSubtree(ids));
    return () => window.cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusActive, selectedNodeId, focusedNodeIds, centerOnSubtree]);

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
    const willSelect = selectedNodeId !== node.id;
    setSelectedNodeId(willSelect ? node.id : null);
    if (!willSelect) {
      // Deselecting (incl. exiting a manager focus) → animate back to overview.
      userMovedRef.current = false;
      animateViewportTo(computeHomeViewport(containerSize, contentBounds, chatState, dockedWidth, orchestratorNode), 340);
      return;
    }
    const isManagerFocus = node.role === 'manager' && !node.ghost;
    // Managers get subtree framing via the focus effect; everything else gets a
    // simple center-on-node.
    if (!isManagerFocus) centerOnNode(node);
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
            focusMode={focusActive}
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
        observabilityEvents={commandCenter.events}
        onClose={() => setSelectedNodeId(null)}
        onNavigate={nav}
        onOpenChat={openNodeChat}
        onRefresh={refresh}
      />

      <LiveWorkspacePanel
        open={liveWorkspaceOpen}
        fleet={fleet}
        agents={agents}
        activeRuns={activeRuns.filter(isActiveRun)}
        approvals={approvals}
        failedRuns={failedRuns}
        issues={issues}
        activity={workspaceActivity}
        workSessions={workSessions}
        observabilityEvents={commandCenter.events}
        streamConnected={commandCenter.connected}
        requestStatus={requestStatus}
        frame={liveWorkspaceFrame}
        onFrameChange={setLiveWorkspaceFrame}
        containerSize={containerSize}
        onClose={() => setLiveWorkspaceOpen(false)}
        onSelectWorkflow={(workflowId) => selectWorkflowNode(workflowId)}
        onNavigate={(route) => {
          setLiveWorkspaceOpen(false);
          nav(route);
        }}
        onRefresh={refresh}
      />

      {/* Controls a populated canvas; in the ghost empty state (no agents)
          there's nothing to zoom, fit, or expand — keep it clean. */}
      {agents.length > 0 && (
        <CanvasControls
          isFullscreen={isFullscreen}
          liveCount={liveHudCount}
          liveActive={liveHudCount > 0}
          hasAttention={fleetCounts.attentionCount > 0}
          focusActive={focusActive}
          onZoomIn={() => zoomByStep(1.2)}
          onZoomOut={() => zoomByStep(1 / 1.2)}
          onFit={resetViewport}
          onToggleFullscreen={() => void toggleFullscreen()}
          onOpenLiveWorkspace={() => setLiveWorkspaceOpen(true)}
          onExitFocus={resetViewport}
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

      {bootLoading && <CanvasLoadingOverlay />}
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
  const workingAgentIds = new Set<string>();
  for (const agent of agents) if (isWorkingAgent(agent)) workingAgentIds.add(agent.id);

  const roles = classifyAgents(agents);
  const spaces = data.spaces ?? [];
  const availableCommandSourceIds = new Set<string>();

  // Balanced-branch packing: managers + the orchestrator's direct-workflows
  // group share one centered row so the tree reads as a pyramid and lanes never
  // collide. Branch identity/spaceId are resolved first (no x needed), then
  // each branch is sized from its workflow count and packed.
  const { managerNodeIds, spaceSourceIds, hasDirectBranch, branchCount } = deriveTopBranchLayout(data, agents, roles);
  const branchSlots = packTopBranches(branchCount, canvasSize.width);
  const managerSlots = branchSlots.slice(0, managerNodeIds.length);
  const directSlot = hasDirectBranch ? branchSlots[managerNodeIds.length] ?? null : null;
  const branchSlotById = new Map<string, BranchSlot>();
  managerNodeIds.forEach((id, i) => {
    if (managerSlots[i]) branchSlotById.set(id, managerSlots[i]);
  });

  const orchestratorId = roles.orchestrator ? `agent-${roles.orchestrator.id}` : 'ghost-orchestrator';
  if (roles.orchestrator) {
    nodes.push(agentNode(roles.orchestrator, 'orchestrator', { x: canvasSize.width / 2, y: 170 }, workingAgentIds, approvals));
    if (availableAgentIds.has(roles.orchestrator.id)) availableCommandSourceIds.add(orchestratorId);
  } else {
    nodes.push(ghostNode('ghost-orchestrator', 'orchestrator', 'Orchestrator', 'commission your workspace orchestrator', { x: canvasSize.width / 2, y: 170 }, NODE.orchestrator));
  }

  // How many specialists report to each manager — surfaced on the collapsed
  // manager node so the org depth is visible without drilling in.
  const specialistCountByManager = new Map<string, number>();
  for (const worker of roles.workers) {
    const reportsTo = stringField(worker as unknown as Record<string, unknown>, ['reportsTo', 'managerId', 'parentAgentId']);
    if (!reportsTo) continue;
    const manager = roles.managers.find((m) => m.id === reportsTo || m.name === reportsTo);
    if (!manager) continue;
    const key = `agent-${manager.id}`;
    specialistCountByManager.set(key, (specialistCountByManager.get(key) ?? 0) + 1);
  }

  roles.managers.forEach((agent, index) => {
    const pos = { x: managerSlots[index]?.centerX ?? canvasSize.width / 2, y: 350 };
    const node = agentNode(agent, 'manager', pos, workingAgentIds, approvals);
    node.specialistCount = specialistCountByManager.get(node.id) ?? 0;
    nodes.push(node);
    if (availableAgentIds.has(agent.id)) availableCommandSourceIds.add(node.id);
    edges.push(commandEdge(orchestratorId, node.id, workingAgentIds.has(agent.id) && availableCommandSourceIds.has(orchestratorId)));
  });
  for (let index = roles.managers.length; index < managerNodeIds.length; index += 1) {
    const id = `ghost-manager-${index}`;
    const pos = { x: managerSlots[index]?.centerX ?? canvasSize.width / 2, y: 350 };
    const space = spaces[index - roles.managers.length] ?? null;
    const ghost = ghostNode(
      id,
      'manager',
      space ? `${space.name} manager` : index === 0 ? 'Manager layer' : `Manager ${index + 1}`,
      space ? 'domain owner' : 'assign a domain',
      pos,
      NODE.manager,
    );
    ghost.spaceId = space?.id ?? null;
    ghost.spaceName = space?.name ?? null;
    ghost.accent = space?.colorHex ?? ghost.accent;
    nodes.push(ghost);
    edges.push(commandEdge(orchestratorId, id, false));
  }

  const expandedManagerId = expandedNodeId && managerNodeIds.includes(expandedNodeId) ? expandedNodeId : null;
  const workerCenterX = (expandedManagerId ? branchSlotById.get(expandedManagerId)?.centerX : undefined) ?? canvasSize.width / 2;
  const workerShift = workerCenterX - canvasSize.width / 2;
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
    const raw = workerPositions[index] ?? { x: canvasSize.width / 2, y: 530 };
    // Fan the focused manager's workers out under the manager itself, not the
    // canvas center, so the drilled-in subtree stays a clean vertical pyramid.
    const pos = { x: raw.x + workerShift, y: raw.y };
    const node = agentNode(agent, 'worker', pos, workingAgentIds, approvals, workerSize);
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
    expandedManagerId,
    branchSlotById,
    directSlot,
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
    strokeColor: activeLoad > 0 ? 'rgba(255,255,255,0.5)' : 'rgba(120,120,130,0.4)',
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
  focusMode = false,
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
  /** True while a manager is focused — non-subtree nodes darken hard. */
  focusMode?: boolean;
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
  // A failing App/workflow card should read as a quiet RED state — a small red
  // status dot, not a whole orange-washed card. (Agent attention/approval keeps
  // the amber warn treatment; only resource failures go minimal-red.)
  const isFailingResource = node.kind === 'workflow' && Boolean(node.warn) && !node.outOfCredits;
  // Liveness = a formal active run OR live workspace activity for this node.
  const isLive = Boolean(node.active) || live;
  const compact = node.height <= 60 || node.kind === 'artifact';
  const showSubtitle = !compact || node.kind !== 'worker';
  // Match the docked-chat header (Orchy / Personal Orchestrator): title 14px,
  // subtitle 10px, uniform across every node kind.
  const titleClass = 'text-[14px]';
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
          : isFailingResource
            ? 'border-danger/35 bg-surface/90 hover:border-danger/55 hover:bg-surface'
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
        // Focus (drill-in) darkens the rest of the canvas hard; the normal
        // selection dim is gentler.
        dimmed && (focusMode ? 'pointer-events-none opacity-[0.1] saturate-0 blur-[1.5px]' : 'opacity-[0.32] saturate-[0.6]'),
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
              : isFailingResource
                ? 'border-line bg-surface-2 text-text-secondary'
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
                isFailingResource || node.status === 'offline' ? 'bg-danger' : 'bg-warn',
              )}
            />
          )}
        </span>
        <span className="min-w-0 flex-1">
          <span className={clsx('block truncate font-semibold text-text-primary', titleClass)}>{node.title}</span>
          {showSubtitle && <span className="mt-0.5 block truncate text-[10px] text-text-muted">{node.subtitle}</span>}
          {node.kind === 'manager' && (node.specialistCount ?? 0) > 0 && (
            <span className="mt-1 inline-flex items-center gap-1 rounded-full border border-line bg-canvas/55 px-1.5 py-0.5 text-[9px] font-medium text-text-secondary">
              <Users size={9} aria-hidden="true" />
              {node.specialistCount} specialist{node.specialistCount === 1 ? '' : 's'}
            </span>
          )}
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
 * transitions, agent messages. This is what turns Live Workspace from a static
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

function LiveWorkspacePanel({
  open,
  fleet,
  agents,
  activeRuns,
  approvals,
  failedRuns,
  issues,
  activity,
  workSessions,
  observabilityEvents,
  streamConnected,
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
  fleet: WorkspaceFleetOverview | null;
  agents: WorkspaceAgent[];
  activeRuns: WorkspaceActiveRun[];
  approvals: WorkspaceApproval[];
  failedRuns: WorkspaceFailedRun[];
  issues: WorkspaceIssue[];
  activity: RealtimeActivity[];
  workSessions: WorkSession[];
  observabilityEvents: ObservabilityEvent[];
  streamConnected: boolean;
  requestStatus: WorkspaceRequestStatus;
  frame: LiveWorkspaceFrame;
  onFrameChange: Dispatch<SetStateAction<LiveWorkspaceFrame>>;
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
  const [view, setView] = useState<'live' | 'tech'>('live');
  const [panelFullscreen, setPanelFullscreen] = useState(false);
  const [panelNow, setPanelNow] = useState(() => Date.now());

  useEffect(() => {
    onFrameChange((current) => {
      const next = clampLiveWorkspaceFrame(current, containerSize);
      return liveWorkspaceFramesEqual(current, next) ? current : next;
    });
  }, [containerSize, onFrameChange]);

  useEffect(() => {
    const timer = window.setInterval(() => setPanelNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => () => {
    stopDrag();
    stopResize();
  }, []);

  if (!open) return null;
  // One card per real task: the same dispatch emits agent-, run-, and workflow-
  // keyed events that the session builder splits apart — collapse them by the
  const activeSessions = dedupeActiveSessions(workSessions.filter((session) => session.active)).slice(0, 6);
  // Structured step tracks (the agent's task spine) keyed for per-session lookup.
  const stepIndex = buildStepIndex(activity);
  const activeObservations = observabilityEvents
    .filter((event) => LIVE_WORKSPACE_KINDS.has(event.kind) && isActiveObservation(event) && isRecentIso(event.createdAt, 30 * 60_000))
    .slice(0, 5);
  const waitingObservations = observabilityEvents
    .filter((event) => (event.status === 'waiting' || event.status === 'blocked' || event.kind === 'approval') && isRecentIso(event.createdAt, 30 * 60_000))
    .slice(0, 4);
  // Recency gate — stale failures (days old) and re-run workflows must not keep
  // nagging. Drop failed observations outside the live window, and failed runs
  // whose workflow is currently running again or finished long ago.
  const incidentObservations = observabilityEvents
    .filter((event) => event.status === 'failed' && (event.runId || event.workflowId) && isRecentIso(event.createdAt, 10 * 60_000))
    .slice(0, 4);
  const activeWorkflowIds = new Set(activeRuns.map((run) => run.workflowId).filter(Boolean) as string[]);
  const attentionFailedRuns = failedRuns.filter((run) =>
    (!run.workflowId || !activeWorkflowIds.has(run.workflowId))
    && (!run.finishedAt || isRecentIso(run.finishedAt, 12 * 60 * 60_000)));
  const hasLiveEvents = observabilityEvents.length > 0;
  const showStream = activity.length > 0 && activeSessions.length === 0 && !hasLiveEvents;
  const showBeacon = activeSessions.length > 0 || requestStatus.busy || approvals.length > 0 || attentionFailedRuns.length > 0 || showStream;
  const allAttentionGroups = buildAttentionGroups(approvals, attentionFailedRuns, waitingObservations, incidentObservations);
  const attentionGroups = allAttentionGroups.slice(0, 4);
  const hiddenAttentionCount = Math.max(0, allAttentionGroups.length - attentionGroups.length);
  const liveCount = Math.max(activeSessions.length, activeRuns.length, activeObservations.filter((event) => event.status !== 'waiting' && event.status !== 'blocked').length);
  const waitingCount = Math.max(approvals.length, waitingObservations.length);
  // Issues — open backlog (exclude done/cancelled), newest scheduled first.
  const backlogIssues = issues
    .filter((issue) => issue.status !== 'done' && issue.status !== 'cancelled' && !issue.labels?.includes('sentinel'))
    .sort((a, b) => issueScheduleRank(a) - issueScheduleRank(b));
  // back and see what happened.
  const doneIssues = issues
    .filter((issue) => issue.status === 'done' || issue.status === 'cancelled')
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, 12);
  const techEvents = observabilityEvents.filter((event) => isRecentIso(event.createdAt, 2 * 60 * 60_000));
  const panelWide = panelFullscreen || frame.width >= 620;
  const panelStyle: CSSProperties = panelFullscreen
    ? {
        left: LIVE_WORKSPACE_MARGIN,
        top: LIVE_WORKSPACE_MARGIN,
        width: Math.max(LIVE_WORKSPACE_MIN_WIDTH, containerSize.width - LIVE_WORKSPACE_MARGIN * 2),
        height: Math.max(LIVE_WORKSPACE_MIN_HEIGHT, containerSize.height - LIVE_WORKSPACE_MARGIN * 2),
        maxWidth: containerSize.width - LIVE_WORKSPACE_MARGIN * 2,
        maxHeight: containerSize.height - LIVE_WORKSPACE_MARGIN * 2,
      }
    : {
        left: frame.x,
        top: frame.y,
        width: frame.width,
        height: frame.height,
        maxWidth: containerSize.width - LIVE_WORKSPACE_MARGIN * 2,
        maxHeight: containerSize.height - LIVE_WORKSPACE_MARGIN * 2,
      };

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
    onFrameChange((current) => clampLiveWorkspaceFrame({
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
    onFrameChange((current) => clampLiveWorkspaceFrame({
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
    if (panelFullscreen) return;
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
    if (panelFullscreen) return;
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
      aria-label="Live Workspace"
      className={clsx(
        'absolute z-50 flex flex-col overflow-hidden border border-line/80 bg-surface/[0.97] shadow-[0_24px_80px_rgba(0,0,0,0.38)] backdrop-blur-2xl',
        panelFullscreen ? 'rounded-2xl' : 'rounded-xl',
      )}
      style={panelStyle}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <header
        className={clsx(
          'flex items-center justify-between gap-3 border-b border-line/80 bg-canvas/30 px-3 py-2.5',
          panelFullscreen ? 'cursor-default' : 'cursor-grab active:cursor-grabbing',
        )}
        onPointerDown={handleHeaderPointerDown}
      >
        <div className="flex min-w-0 items-center gap-2">
          <span className={clsx('relative flex h-3 w-3 shrink-0 items-center justify-center', !showBeacon && 'opacity-45')}>
            {showBeacon && <span className="absolute h-5 w-5 animate-ping rounded-full border border-accent/50" />}
            <span className={clsx('relative h-2.5 w-2.5 rounded-full', showBeacon ? 'bg-accent shadow-[0_0_16px_var(--color-accent-muted)]' : 'bg-text-muted')} />
          </span>
          <div className="min-w-0">
            <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-accent">Live Workspace</div>
            <h2 className="mt-0.5 truncate text-[15px] font-semibold leading-tight text-text-primary">
              {requestStatus.busy
                ? 'Work in progress'
                : waitingCount > 0
                  ? 'Needs your attention'
                  : liveCount > 0
                    ? `${liveCount} active task${liveCount === 1 ? '' : 's'}`
                    : 'Workspace is quiet'}
            </h2>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <div className="flex rounded-md border border-line bg-canvas/60 p-0.5" role="group" aria-label="Live Workspace view">
            <button type="button" onClick={() => setView('live')} className={clsx('rounded px-1.5 py-1 text-[10px] font-medium transition', view === 'live' ? 'bg-surface-2 text-text-primary shadow-sm' : 'text-text-muted hover:text-text-secondary')}>Live</button>
            <button type="button" onClick={() => setView('tech')} className={clsx('rounded px-1.5 py-1 text-[10px] font-medium transition', view === 'tech' ? 'bg-surface-2 text-text-primary shadow-sm' : 'text-text-muted hover:text-text-secondary')}>Tech</button>
          </div>
          <button
            type="button"
            onClick={() => setPanelFullscreen((value) => !value)}
            aria-label={panelFullscreen ? 'Restore Live Workspace' : 'Expand Live Workspace'}
            title={panelFullscreen ? 'Restore' : 'Expand'}
            className="inline-flex h-6 w-6 items-center justify-center rounded-md text-text-muted hover:bg-surface-2 hover:text-text-primary"
          >
            {panelFullscreen ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
          </button>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close Live Workspace"
            className="inline-flex h-6 w-6 items-center justify-center rounded-md text-text-muted hover:bg-surface-2 hover:text-text-primary"
          >
            <X size={14} />
          </button>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        {view === 'live' ? (
          <div className="space-y-3">
            {activeSessions.length === 0 && allAttentionGroups.length === 0 && !showStream && <LiveWorkspaceEmptyState />}

            {activeSessions.length > 0 && (
              <section className="space-y-1.5">
                <SectionHeading icon={<ActivityIcon size={12} />} label="Active work" count={activeSessions.length} />
                {activeSessions.map((session) => (
                  <ActiveWorkRow
                    key={session.id}
                    session={session}
                    track={sessionStepTrack(session, stepIndex)}
                    now={panelNow}
                    onOpen={() => {
                      if (session.runId) openRunModal({ runId: session.runId, workflowId: session.workflowId, source: 'live-workspace' });
                      else if (session.workflowId) onSelectWorkflow(session.workflowId);
                      else if (session.agentId) onNavigate(`/agents/${session.agentId}`);
                    }}
                  />
                ))}
              </section>
            )}

            {activeSessions.length === 0 && showStream && (
              <LiveActivityStream activity={activity} onSelectWorkflow={onSelectWorkflow} />
            )}

            {allAttentionGroups.length > 0 && (
              <LiveWorkspaceSection storageKey="attention" label="Needs attention" icon={<AlertTriangle size={12} />} empty="Nothing needs you" count={allAttentionGroups.length} defaultOpen>
                {attentionGroups.map((group) => (
                  <AttentionGroupRow
                    key={group.id}
                    group={group}
                    onReview={group.approval ? () => openApprovalModal({ approval: group.approval! }) : undefined}
                    onInspect={() => {
                      if (group.workflowId) onSelectWorkflow(group.workflowId);
                      else if (group.runId) openRunModal({ runId: group.runId, source: 'live-workspace-attention' });
                      else onNavigate('/history?tab=runs');
                    }}
                    onRetry={group.retryWorkflowId ? () => { void api(`/v1/workflows/${group.retryWorkflowId}/run`, { method: 'POST' }).catch(() => undefined).finally(onRefresh); } : undefined}
                    onDetails={group.runId ? () => openRunModal({ runId: group.runId, workflowId: group.workflowId, source: 'live-workspace-attention-details' }) : undefined}
                  />
                ))}
                {hiddenAttentionCount > 0 && <button type="button" onClick={() => onNavigate('/history?tab=runs')} className="flex h-7 w-full items-center justify-center rounded-md border border-line/70 bg-canvas/35 text-[10px] text-text-muted hover:bg-surface-2 hover:text-text-primary">+{hiddenAttentionCount} more in history</button>}
              </LiveWorkspaceSection>
            )}

            <BacklogScheduleSection
              issues={backlogIssues}
              doneIssues={doneIssues}
              agents={agents}
              defaultOpen={panelFullscreen}
              onRefresh={onRefresh}
              onOpenRun={(runId) => openRunModal({ runId, source: 'live-workspace-issue' })}
            />
          </div>
        ) : (
          <LiveWorkspaceTechnicalFeed events={techEvents} activity={activity} connected={streamConnected} wide={panelWide} workspaceTokens={fleet?.runs.totalTokens ?? null} />
        )}
      </div>
      {!panelFullscreen && (
        <button
          type="button"
          aria-label="Resize Live Workspace"
          title="Resize Live Workspace"
          className="absolute bottom-1.5 right-1.5 flex h-4 w-4 cursor-se-resize items-end justify-end rounded-sm text-text-muted/80 hover:bg-surface-2 hover:text-text-primary"
          onPointerDown={handleResizePointerDown}
        >
          <span className="pointer-events-none block h-2.5 w-2.5 border-b border-r border-current" />
        </button>
      )}
    </div>
  );
}

const OBSERVATION_TONE_TEXT: Record<ObservationTone, string> = {
  accent: 'text-accent',
  success: 'text-emerald-400',
  warn: 'text-warn',
  danger: 'text-danger',
  muted: 'text-text-muted',
};

const OBSERVATION_TONE_BORDER: Record<ObservationTone, string> = {
  accent: 'border-accent/25 bg-accent/5',
  success: 'border-emerald-400/20 bg-emerald-400/5',
  warn: 'border-warn/25 bg-warn-soft/60',
  danger: 'border-danger/25 bg-danger-soft/50',
  muted: 'border-line bg-canvas/40',
};

function LiveWorkspaceEmptyState() {
  return (
    <div className="mt-2.5 flex min-h-[130px] flex-col items-center justify-center rounded-xl border border-line/70 bg-canvas/35 px-4 py-4 text-center">
      <div className="flex h-11 w-11 animate-pulse items-center justify-center rounded-xl border border-accent/20 bg-accent/5 text-accent">
        <CheckCircle2 size={20} />
      </div>
      <div className="mt-2 text-[13px] font-medium text-text-primary">Office quiet.</div>
      <div className="mt-0.5 text-[11px] text-text-secondary">No live runs or decisions.</div>
    </div>
  );
}

function LiveWorkspaceTechnicalFeed({
  events,
  activity,
  connected,
  wide,
  workspaceTokens,
}: {
  events: ObservabilityEvent[];
  activity: RealtimeActivity[];
  connected: boolean;
  wide: boolean;
  workspaceTokens: number | null;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = events.find((event) => event.id === selectedId) ?? events[0] ?? null;

  useEffect(() => {
    if (!selectedId || !events.some((event) => event.id === selectedId)) setSelectedId(events[0]?.id ?? null);
  }, [events, selectedId]);

  // Workspace-wide token consumption — exact count for technical review. Refreshes
  // with the workspace snapshot (driven by realtime events).
  const tokenStrip = workspaceTokens != null ? (
    <div className="mb-2 flex items-center gap-2 rounded-lg border border-line bg-canvas/45 px-3 py-1.5">
      <span className="h-1.5 w-1.5 rounded-full bg-accent animate-pulse-dot" />
      <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-text-muted">Workspace tokens</span>
      <span className="ml-auto font-mono text-[12px] font-semibold tabular-nums text-text-primary">{workspaceTokens.toLocaleString()}</span>
    </div>
  ) : null;

  if (events.length === 0) {
    return (
      <section className="rounded-card border border-line bg-canvas/35 px-3 py-3">
        {tokenStrip}
        <div className="flex items-center gap-2 text-[12px] text-text-secondary">
          <span className={clsx('h-1.5 w-1.5 rounded-full', connected ? 'bg-accent animate-pulse-dot' : 'bg-text-muted')} />
          {connected ? 'Waiting for the first normalized runtime event.' : 'Reconnect to receive the technical event stream.'}
        </div>
        {activity.length > 0 && <LiveActivityStream activity={activity} onSelectWorkflow={() => undefined} />}
      </section>
    );
  }

  return (
    <div>
      {tokenStrip}
      <section className={clsx('gap-3', wide ? 'grid grid-cols-[minmax(0,1.15fr)_minmax(280px,0.85fr)]' : 'space-y-3')}>
      <div className="min-w-0 overflow-hidden rounded-xl border border-line bg-canvas/35">
        <div className="flex items-center justify-between border-b border-line/70 px-3 py-2">
          <div>
            <div className="font-mono text-[10px] uppercase tracking-[0.14em] text-text-muted">Event stream</div>
            <div className="mt-0.5 text-[11px] text-text-secondary">{connected ? 'SSE live · replay merged' : 'Replay · reconnecting'}</div>
          </div>
          <span className="font-mono text-[10px] text-text-muted">{events.length}</span>
        </div>
        <div className="max-h-[min(64vh,640px)] overflow-y-auto p-1.5">
          {events.slice(0, 80).map((event) => {
            const tone = observationTone(event);
            const selectedRow = selected?.id === event.id;
            return (
              <button
                key={event.id}
                type="button"
                onClick={() => setSelectedId(event.id)}
                className={clsx(
                  'flex w-full items-start gap-2 rounded-md border-l-4 px-2 py-2 text-left transition',
                  selectedRow ? 'bg-surface-2 ring-1 ring-line-strong' : 'hover:bg-surface-2/70',
                  tone === 'danger'
                    ? 'border-l-danger'
                    : tone === 'warn'
                      ? 'border-l-warn'
                      : tone === 'success'
                        ? 'border-l-emerald-400'
                        : tone === 'accent'
                          ? 'border-l-accent'
                          : 'border-l-text-muted/40',
                )}
              >
                <span className={clsx('mt-1 h-1.5 w-1.5 shrink-0 rounded-full', tone === 'danger' ? 'bg-danger' : tone === 'warn' ? 'bg-warn' : tone === 'success' ? 'bg-emerald-400' : tone === 'accent' ? 'bg-accent' : 'bg-text-muted')} />
                <span className="min-w-0 flex-1">
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="truncate text-[11px] font-medium text-text-primary">{event.title}</span>
                    <span className="shrink-0 font-mono text-[8px] uppercase tracking-[0.08em] text-text-muted">{event.kind}</span>
                  </span>
                  <span className="mt-0.5 block truncate text-[10px] text-text-secondary">{event.summary || event.detail || event.sourceEvent}</span>
                </span>
                <span className="shrink-0 font-mono text-[9px] text-text-muted">{formatAge(event.createdAt)}</span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="min-w-0 overflow-hidden rounded-xl border border-line bg-surface-2/60">
        {selected ? (
          <>
            <div className="border-b border-line/70 px-3 py-2.5">
              <div className="flex items-center justify-between gap-2">
                <div className="truncate text-[12px] font-semibold text-text-primary">{selected.title}</div>
                <span className={clsx('shrink-0 rounded-full px-1.5 py-0.5 font-mono text-[8px] uppercase', OBSERVATION_TONE_TEXT[observationTone(selected)])}>{selected.status}</span>
              </div>
              <div className="mt-1 text-[10px] leading-snug text-text-secondary">{selected.summary || selected.detail || selected.sourceEvent}</div>
            </div>
            <div className="max-h-[min(50vh,480px)] space-y-3 overflow-y-auto px-3 py-3">
              <TechnicalField label="Source" value={selected.sourceEvent} />
              <TechnicalField label="Scope" value={compactStrings([selected.kind, selected.actorType, selected.actorId && `agent:${selected.actorId}`, selected.workflowId && `workflow:${selected.workflowId}`, selected.runId && `run:${selected.runId}`]).join(' · ')} />
              <TechnicalField label="Correlation" value={selected.correlationId ?? '—'} />
              {selected.progress && <TechnicalField label="Progress" value={`${selected.progress.label ? `${selected.progress.label} · ` : ''}${selected.progress.completed ?? 0}/${selected.progress.total ?? '?'}`} />}
              {selected.evidence.length > 0 && <TechnicalJson label={`Evidence (${selected.evidence.length})`} value={selected.evidence} />}
              <TechnicalJson label="Redacted payload" value={selected.rawPayloadRedacted} />
            </div>
          </>
        ) : null}
      </div>
      </section>
    </div>
  );
}

function TechnicalField({ label, value }: { label: string; value: string }) {
  return <div><div className="font-mono text-[9px] uppercase tracking-[0.12em] text-text-muted">{label}</div><div className="mt-1 break-words text-[11px] leading-snug text-text-secondary">{value}</div></div>;
}

function TechnicalJson({ label, value }: { label: string; value: unknown }) {
  return (
    <div>
      <div className="font-mono text-[9px] uppercase tracking-[0.12em] text-text-muted">{label}</div>
      <pre className="mt-1 max-h-48 overflow-auto rounded-md border border-line/70 bg-canvas/80 p-2 font-mono text-[9px] leading-relaxed text-text-secondary">
        <HighlightedJson value={value} />
      </pre>
    </div>
  );
}

function HighlightedJson({ value }: { value: unknown }) {
  const json = JSON.stringify(value, null, 2);
  const tokens = json.split(/("(?:\\.|[^"\\])*"(?=\s*:)|"(?:\\.|[^"\\])*"|\btrue\b|\bfalse\b|\bnull\b|-?\d+(?:\.\d+)?(?:e[+-]?\d+)?)/gi);
  return (
    <>
      {tokens.map((token, index) => {
        const className = token.match(/^"(?:\\.|[^"\\])*"(?=\s*:)/)
          ? 'text-accent'
          : token.startsWith('"')
            ? 'text-emerald-300'
            : token === 'true' || token === 'false'
              ? 'text-warn'
              : token === 'null'
                ? 'text-text-muted'
                : /^-?\d/.test(token)
                  ? 'text-sky-300'
                  : undefined;
        return <span key={`${index}:${token.slice(0, 8)}`} className={className}>{token}</span>;
      })}
    </>
  );
}

function LiveWorkspaceSection({
  label,
  icon,
  empty,
  count,
  storageKey,
  defaultOpen = true,
  className,
  children,
}: {
  label: string;
  icon: ReactNode;
  empty: string;
  count?: number;
  storageKey: string;
  defaultOpen?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const items = Children.toArray(children).filter(Boolean);
  const [open, setOpen] = usePersistentSectionState(storageKey, defaultOpen);
  return (
    <section className={clsx('rounded-xl border border-line/70 bg-canvas/30 p-2.5', className)}>
      <button type="button" onClick={() => setOpen((value) => !value)} className="mb-2 flex w-full items-center justify-between gap-2 text-left">
        <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-text-muted">
          <span className="text-text-muted">{icon}</span>
          {label}
        </div>
        <span className="flex items-center gap-2">
          <span className="rounded-full border border-line/70 bg-surface-2 px-1.5 py-0.5 font-mono text-[10px] text-text-muted tabular-nums">{count ?? items.length}</span>
          <ChevronDown size={13} className={clsx('text-text-muted transition-transform duration-200', !open && '-rotate-90')} />
        </span>
      </button>
      <div className={clsx('grid transition-[grid-template-rows] duration-200 ease-out', open ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]')}>
        <div className="min-h-0 overflow-hidden">
          <div className="space-y-1.5">
            {items.length > 0 ? items : (
              <div className="rounded-card border border-line/70 bg-canvas/35 px-2 py-1.5 text-[11px] text-text-muted">{empty}</div>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

function usePersistentSectionState(key: string, defaultOpen: boolean): [boolean, Dispatch<SetStateAction<boolean>>] {
  const storageKey = `agentis:live-workspace:${key}`;
  const [open, setOpen] = useState(() => {
    try {
      const saved = window.localStorage.getItem(storageKey);
      if (saved === 'open') return true;
      if (saved === 'closed') return false;
    } catch {
      /* ignore storage failures */
    }
    return defaultOpen;
  });

  useEffect(() => {
    try {
      window.localStorage.setItem(storageKey, open ? 'open' : 'closed');
    } catch {
      /* ignore storage failures */
    }
  }, [open, storageKey]);

  return [open, setOpen];
}

interface CommandAttentionGroup {
  id: string;
  title: string;
  summary: string;
  count: number;
  tone: ObservationTone;
  workflowId?: string;
  runId?: string;
  retryWorkflowId?: string;
  approval?: WorkspaceApproval;
}

function currentSessionStep(session: WorkSession | null): string | null {
  if (!session) return null;
  const event = session.events.at(-1);
  return event?.detail || event?.title || session.detail || null;
}

function sessionStart(session: WorkSession | null): string | null {
  if (!session) return null;
  return session.events[0]?.at ?? session.at ?? null;
}

function AttentionGroupRow({
  group,
  onReview,
  onInspect,
  onRetry,
  onDetails,
}: {
  group: CommandAttentionGroup;
  onReview?: () => void;
  onInspect: () => void;
  onRetry?: () => void;
  onDetails?: () => void;
}) {
  return (
    <div className={clsx('rounded-card border px-2 py-1.5', OBSERVATION_TONE_BORDER[group.tone])}>
      <div className="flex items-center gap-2">
        <span className={clsx('mt-0.5 shrink-0', OBSERVATION_TONE_TEXT[group.tone])}>
          {group.tone === 'danger' ? <AlertTriangle size={12} /> : group.approval ? <ShieldCheck size={12} /> : <Clock size={12} />}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <div className="truncate text-[12px] font-medium text-text-primary">{group.title}</div>
            {group.count > 1 && (
              <span className="shrink-0 rounded-full bg-surface-2 px-1.5 py-0.5 font-mono text-[9px] text-text-muted">x{group.count}</span>
            )}
          </div>
          <div className="mt-0.5 truncate text-[11px] text-text-secondary">{group.summary}</div>
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-1">
        {onReview && (
          <button type="button" onClick={onReview} title="Review & decide" aria-label="Review & decide" className="inline-flex h-5 items-center gap-1 rounded-md bg-text-primary px-1.5 text-[10px] font-semibold text-canvas hover:bg-white">
            <ShieldCheck size={11} /> Review
          </button>
        )}
        <button type="button" onClick={onInspect} title="Inspect" aria-label="Inspect" className="inline-flex h-5 w-5 items-center justify-center rounded-md border border-line bg-surface-2 text-text-muted hover:bg-surface-3 hover:text-text-primary">
          <Workflow size={12} />
        </button>
        {onRetry && (
          <button type="button" onClick={onRetry} title="Retry latest" aria-label="Retry latest" className="inline-flex h-5 w-5 items-center justify-center rounded-md border border-line bg-surface-2 text-text-muted hover:bg-surface-3 hover:text-text-primary">
            <RefreshCw size={12} />
          </button>
        )}
        {onDetails && (
          <button type="button" onClick={onDetails} title="Run details" aria-label="Run details" className="inline-flex h-5 w-5 items-center justify-center rounded-md border border-line bg-surface-2 text-text-muted hover:bg-surface-3 hover:text-text-primary">
            <FileText size={12} />
          </button>
        )}
        </div>
      </div>
    </div>
  );
}

function buildAttentionGroups(
  approvals: WorkspaceApproval[],
  failedRuns: WorkspaceFailedRun[],
  waitingEvents: ObservabilityEvent[],
  incidentEvents: ObservabilityEvent[],
): CommandAttentionGroup[] {
  const groups: CommandAttentionGroup[] = [];
  for (const approval of approvals) {
    const selfHeal = isSelfHealApproval(approval);
    groups.push({
      id: `approval:${approval.id}`,
      title: selfHeal ? 'Self-healing fix ready' : approval.workflowName ?? approval.title ?? 'Approval needed',
      summary: approval.summary ?? approval.agentName ?? 'Operator decision required',
      count: 1,
      tone: 'warn',
      runId: approval.runId ?? undefined,
      approval,
    });
  }

  const failedByWorkflow = new Map<string, CommandAttentionGroup>();
  for (const run of failedRuns) {
    if (run.selfHealIncident) {
      groups.push({
        id: `self-heal:${run.id}:${run.selfHealIncident.nodeId}`,
        title: selfHealFailedRunTitle(run.selfHealIncident),
        summary: selfHealFailedRunSummary(run),
        count: 1,
        tone: 'danger',
        workflowId: run.workflowId,
        retryWorkflowId: run.workflowId,
        runId: run.id,
      });
      continue;
    }
    const key = run.workflowId ?? run.workflowName ?? run.id;
    const existing = failedByWorkflow.get(key);
    if (existing) {
      existing.count += 1;
      if (!existing.runId) existing.runId = run.id;
      if (!existing.retryWorkflowId && run.workflowId) existing.retryWorkflowId = run.workflowId;
      continue;
    }
    failedByWorkflow.set(key, {
      id: `failed:${key}`,
      title: run.workflowName ?? 'Failed workflow',
      summary: run.failedNode ? `Failed at ${run.failedNode}` : 'Needs operator review',
      count: 1,
      tone: 'danger',
      workflowId: run.workflowId,
      retryWorkflowId: run.workflowId,
      runId: run.id,
    });
  }
  groups.push(...failedByWorkflow.values());

  const knownApprovalIds = new Set(approvals.map((approval) => approval.id));
  const knownRunIds = new Set(failedRuns.map((run) => run.id));
  for (const event of [...waitingEvents, ...incidentEvents]) {
    if (event.approvalId && knownApprovalIds.has(event.approvalId)) continue;
    if (event.runId && knownRunIds.has(event.runId)) continue;
    groups.push({
      id: `event:${event.id}`,
      title: event.title,
      summary: event.summary || event.detail || event.sourceEvent,
      count: 1,
      tone: observationTone(event),
      workflowId: event.workflowId ?? undefined,
      runId: event.runId ?? undefined,
      retryWorkflowId: event.workflowId ?? undefined,
    });
  }

  return groups.sort((a, b) => attentionRank(a) - attentionRank(b));
}

function isSelfHealApproval(approval: WorkspaceApproval): boolean {
  return approval.source === 'self_heal';
}

function selfHealFailedRunTitle(incident: NonNullable<WorkspaceFailedRun['selfHealIncident']>): string {
  return incident.status === 'EXHAUSTED' ? 'Self-healing exhausted' : 'Self-healing blocked';
}

function selfHealFailedRunSummary(run: WorkspaceFailedRun): string {
  const incident = run.selfHealIncident;
  if (!incident) return run.failedNode ? `Failed at ${run.failedNode}` : 'Needs operator review';
  const node = incident.nodeTitle ?? run.failedNode ?? incident.nodeId;
  const reason = incident.reason ?? incident.diagnosis ?? run.failureReason ?? 'Agentis could not certify a safe repair.';
  return `${run.workflowName ?? 'Workflow'} - ${node}: ${reason}`;
}

function attentionRank(group: CommandAttentionGroup): number {
  if (group.tone === 'danger') return 0;
  if (group.approval) return 1;
  if (group.tone === 'warn') return 2;
  return 3;
}

function dedupeObservations(events: ObservabilityEvent[]): ObservabilityEvent[] {
  const seen = new Set<string>();
  const out: ObservabilityEvent[] = [];
  for (const event of events) {
    const key = event.id || [event.sourceEvent, event.title, event.createdAt].join(':');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(event);
  }
  return out;
}

function isRecentIso(value: string, windowMs: number): boolean {
  const time = new Date(value).getTime();
  return Number.isFinite(time) && Date.now() - time <= windowMs;
}

function formatAge(value: string): string {
  const time = new Date(value).getTime();
  if (!Number.isFinite(time)) return 'now';
  const seconds = Math.max(0, Math.floor((Date.now() - time) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function SectionHeading({ icon, label, count }: { icon: ReactNode; label: string; count?: number }) {
  return (
    <div className="flex items-center justify-between px-0.5">
      <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-text-muted">
        <span className="text-text-muted">{icon}</span>
        {label}
      </div>
      {count != null && (
        <span className="rounded-full border border-line/70 bg-surface-2 px-1.5 py-0.5 font-mono text-[10px] text-text-muted tabular-nums">{count}</span>
      )}
    </div>
  );
}

/**
 * One task = one card. Collapsed it shows only the task and its current step +
 * a thin progress line. The chevron expands it to the full step checklist with
 * the agent's live thought under the running step (image-3 model). Spine steps
 * when the agent published them; the derived current step otherwise.
 */
function ActiveWorkRow({
  session,
  track,
  now,
  onOpen,
}: {
  session: WorkSession;
  track: WorkStepTrack | null;
  now: number;
  onOpen: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const agentName = session.participantNames[0] ?? session.agentName ?? 'Agentis';
  const startedAt = sessionStart(session);
  const elapsed = startedAt ? formatElapsed(startedAt, now) : null;
  const thought = currentSessionStep(session) ?? session.detail;
  const failed = session.status === 'failed';
  const waiting = session.status === 'waiting' || session.status === 'blocked';
  const steps = track?.steps ?? [];
  const hasSteps = steps.length > 0;
  const total = track?.total ?? session.progress?.total ?? 0;
  const current = track?.current ?? session.progress?.completed ?? 0;
  const pct = total > 0 ? Math.min(100, Math.max(4, Math.round((current / total) * 100))) : null;
  const runningStep = steps.find((step) => step.status === 'running');
  const currentLabel = hasSteps
    ? (runningStep?.label ?? steps[Math.min(Math.max(current, 1), steps.length) - 1]?.label ?? steps[0]?.label ?? null)
    : thought;
  const dot = failed ? 'bg-danger' : waiting ? 'bg-warn' : 'bg-accent animate-pulse-dot';

  return (
    <div className="overflow-hidden rounded-card border border-line/70 bg-canvas/35">
      <div className="flex items-center gap-2 px-2.5 py-2">
        <span className={clsx('h-1.5 w-1.5 shrink-0 rounded-full', dot)} />
        <button type="button" onClick={onOpen} className="min-w-0 flex-1 text-left active:scale-[0.99]">
          <div className="truncate text-[12px] font-medium text-text-primary">{session.title}</div>
          <div className="mt-0.5 truncate text-[11px] text-text-secondary">{currentLabel ?? 'Working…'}</div>
        </button>
        {total > 0 && <span className="shrink-0 font-mono text-[10px] tabular-nums text-text-muted">{current}/{total}</span>}
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          aria-label={expanded ? 'Collapse task' : 'Expand task'}
          className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-md text-text-muted hover:bg-surface-2 hover:text-text-primary"
        >
          <ChevronDown size={13} className={clsx('transition-transform duration-150', expanded && 'rotate-180')} />
        </button>
      </div>
      <div className="px-2.5 pb-2">
        <div className="h-1 overflow-hidden rounded-full bg-line/60">
          <div
            className={clsx('h-full rounded-full bg-accent transition-[width] duration-500', pct == null && !failed && 'w-2/5 animate-pulse', failed && 'bg-danger')}
            style={pct != null ? { width: `${pct}%` } : undefined}
          />
        </div>
      </div>
      {expanded && (
        <div className="border-t border-line/60 px-2.5 py-2">
          <div className="mb-2 flex items-center gap-1.5 text-[9.5px] text-text-muted">
            <Bot size={10} className="text-accent" />
            <span className="truncate">{agentName}</span>
            {elapsed && <span className="font-mono tabular-nums">· {elapsed}</span>}
          </div>
          {hasSteps ? (
            <ol className="space-y-1.5">
              {steps.map((step, index) => (
                <li key={step.id || `${index}-${step.label}`}>
                  <div className="flex items-start gap-2">
                    <ActiveStepIcon status={step.status} />
                    <span className={clsx(
                      'min-w-0 flex-1 text-[11px] leading-snug',
                      step.status === 'pending' && 'text-text-muted/70',
                      step.status === 'running' && 'font-medium text-text-primary',
                      step.status === 'done' && 'text-text-muted line-through decoration-line/50',
                      step.status === 'failed' && 'text-danger',
                    )}>
                      {step.label}
                    </span>
                  </div>
                  {step.status === 'running' && thought && thought !== step.label && (
                    <div className="ml-[20px] mt-0.5 line-clamp-2 text-[10px] italic text-text-muted">{thought}</div>
                  )}
                </li>
              ))}
            </ol>
          ) : (
            <div className="line-clamp-3 text-[10px] italic text-text-muted">{thought ?? 'Working…'}</div>
          )}
        </div>
      )}
    </div>
  );
}

function ActiveStepIcon({ status }: { status: WorkStepTrack['steps'][number]['status'] }) {
  if (status === 'running') return <Loader2 size={12} className="mt-0.5 shrink-0 animate-spin text-accent" />;
  if (status === 'done') return <CheckCircle2 size={12} className="mt-0.5 shrink-0 text-accent" />;
  if (status === 'failed') return <AlertTriangle size={12} className="mt-0.5 shrink-0 text-danger" />;
  return <span className="mt-1 h-2.5 w-2.5 shrink-0 rounded-full border border-line" />;
}

/**
 * Collapse the work sessions of a single dispatch (which the session builder
 * splits into agent-, run-, and workflow-keyed rows) into one card per actor.
 * Keys on the agent name first, since that's the one identifier every variant
 * of a dispatch's events carries.
 */
function dedupeActiveSessions(sessions: WorkSession[]): WorkSession[] {
  const byKey = new Map<string, WorkSession>();
  for (const session of sessions) {
    const key = activeTaskKey(session);
    const existing = byKey.get(key);
    if (!existing || isRicherSession(session, existing)) byKey.set(key, existing ? mergeSessionMeta(session, existing) : session);
  }
  return Array.from(byKey.values()).sort((a, b) => b.at.localeCompare(a.at));
}

function activeTaskKey(session: WorkSession): string {
  return session.agentName
    ?? session.participantNames[0]
    ?? session.agentId
    ?? session.workflowId
    ?? session.runId
    ?? session.id;
}

function isRicherSession(candidate: WorkSession, current: WorkSession): boolean {
  const score = (session: WorkSession) =>
    (session.progress ? 2 : 0)
    + (looksGenericTitle(session.title) ? 0 : 1)
    + (session.events.length > 0 ? 1 : 0);
  return score(candidate) > score(current);
}

function mergeSessionMeta(winner: WorkSession, loser: WorkSession): WorkSession {
  return {
    ...winner,
    progress: winner.progress ?? loser.progress,
    participantNames: Array.from(new Set([...winner.participantNames, ...loser.participantNames])),
    participantAgentIds: Array.from(new Set([...winner.participantAgentIds, ...loser.participantAgentIds])),
  };
}

function looksGenericTitle(title: string): boolean {
  return /^workflow\s+[0-9a-f:]/i.test(title) || /^agent:/i.test(title);
}

function BacklogScheduleSection({
  issues,
  doneIssues,
  agents,
  defaultOpen,
  onRefresh,
  onOpenRun,
}: {
  issues: WorkspaceIssue[];
  doneIssues: WorkspaceIssue[];
  agents: WorkspaceAgent[];
  defaultOpen: boolean;
  onRefresh: () => void;
  onOpenRun: (runId: string) => void;
}) {
  const [showHistory, setShowHistory] = useState(false);
  const visible = issues.slice(0, 4);
  return (
    <LiveWorkspaceSection storageKey="backlog" label="Backlog & schedule" icon={<ListTodo size={12} />} empty="No tasks queued" count={issues.length} defaultOpen={defaultOpen}>
      {visible.map((issue) => (
        <ScheduledIssueRow
          key={issue.id}
          issue={issue}
          agents={agents}
          onAccept={async () => {
            await api(`/v1/issues/${issue.id}/accept`, { method: 'POST', body: JSON.stringify({ agentId: issue.assigneeAgentId ?? null }) }).catch(() => undefined);
            onRefresh();
          }}
          onChanged={onRefresh}
          onOpenRun={issue.activeRunId ? () => onOpenRun(issue.activeRunId!) : undefined}
        />
      ))}
      {issues.length > visible.length && (
        <div className="flex h-7 w-full items-center justify-center rounded-md border border-line/70 bg-canvas/35 text-[10px] text-text-muted">+{issues.length - visible.length} more queued</div>
      )}
      <ScheduleTaskForm agents={agents} onCreated={onRefresh} />
      {doneIssues.length > 0 && (
        <div className="mt-1 border-t border-line/50 pt-1.5">
          <button type="button" onClick={() => setShowHistory((value) => !value)} className="flex w-full items-center justify-between text-[10px] text-text-muted hover:text-text-secondary">
            <span className="inline-flex items-center gap-1.5"><CheckCircle2 size={11} className="text-text-muted" /> History · {doneIssues.length} done</span>
            <ChevronDown size={12} className={clsx('transition-transform', showHistory && 'rotate-180')} />
          </button>
          {showHistory && (
            <div className="mt-1.5 space-y-1">
              {doneIssues.map((issue) => (
                <div key={issue.id} className="flex items-center gap-2 rounded-card px-2 py-1 text-[10px]">
                  <CheckCircle2 size={11} className={clsx('shrink-0', issue.status === 'cancelled' ? 'text-text-muted' : 'text-accent')} />
                  <span className="min-w-0 flex-1 truncate text-text-secondary">{issue.title}</span>
                  <span className="shrink-0 font-mono text-text-muted">{formatAge(issue.updatedAt)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </LiveWorkspaceSection>
  );
}

function ScheduledIssueRow({
  issue,
  agents,
  onAccept,
  onChanged,
  onOpenRun,
}: {
  issue: WorkspaceIssue;
  agents: WorkspaceAgent[];
  onAccept: () => Promise<void>;
  onChanged: () => void;
  onOpenRun?: () => void;
}) {
  const [accepting, setAccepting] = useState(false);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [title, setTitle] = useState(issue.title);
  const [assigneeAgentId, setAssigneeAgentId] = useState(issue.assigneeAgentId ?? '');
  const [when, setWhen] = useState(issue.scheduledFor ? toLocalInput(issue.scheduledFor) : '');
  const agent = agents.find((candidate) => candidate.id === issue.assigneeAgentId);
  const schedule = issue.scheduledFor ? formatSchedule(issue.scheduledFor) : null;

  async function handleAccept() {
    setAccepting(true);
    try { await onAccept(); } finally { setAccepting(false); }
  }

  async function handleDelete() {
    setBusy(true);
    try {
      await api(`/v1/issues/${issue.id}`, { method: 'DELETE' }).catch(() => undefined);
      onChanged();
    } finally { setBusy(false); }
  }

  async function handleSave() {
    setBusy(true);
    try {
      await api(`/v1/issues/${issue.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          title: title.trim() || issue.title,
          assigneeAgentId: assigneeAgentId || null,
          scheduledFor: when ? new Date(when).toISOString() : null,
        }),
      }).catch(() => undefined);
      setEditing(false);
      onChanged();
    } finally { setBusy(false); }
  }

  if (editing) {
    return (
      <div className="rounded-card border border-accent/30 bg-canvas/40 px-2 py-2">
        <input
          autoFocus
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          onKeyDown={(event) => { if (event.key === 'Escape') setEditing(false); }}
          className="w-full bg-transparent text-[12px] text-text-primary outline-none placeholder:text-text-muted"
        />
        <div className="mt-2 grid grid-cols-2 gap-1.5">
          <select value={assigneeAgentId} onChange={(event) => setAssigneeAgentId(event.target.value)} className="h-7 rounded-btn border border-line bg-surface-2 px-1.5 text-[10px] text-text-secondary outline-none">
            <option value="">Unassigned</option>
            {agents.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name}</option>)}
          </select>
          <input type="datetime-local" value={when} onChange={(event) => setWhen(event.target.value)} className="h-7 rounded-btn border border-line bg-surface-2 px-1.5 text-[10px] text-text-secondary outline-none" />
        </div>
        <div className="mt-2 flex gap-1.5">
          <button type="button" disabled={busy} onClick={() => void handleSave()} className="inline-flex h-6 items-center gap-1 rounded-btn bg-accent px-2 text-[10px] font-medium text-canvas hover:bg-accent/90 disabled:opacity-50">
            {busy ? <Loader2 size={10} className="animate-spin" /> : <Save size={10} />}Save
          </button>
          <button type="button" onClick={() => setEditing(false)} className="inline-flex h-6 items-center rounded-btn border border-line px-2 text-[10px] text-text-muted hover:bg-surface-2">Cancel</button>
        </div>
      </div>
    );
  }

  return (
    <div className="group flex items-center gap-2 rounded-card border border-line bg-canvas/40 px-2 py-1.5">
      <span className={clsx('h-1.5 w-1.5 shrink-0 rounded-full', issue.status === 'blocked' ? 'bg-danger' : schedule ? 'bg-accent' : 'bg-text-muted/60')} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-[11px] font-medium text-text-primary">{issue.title}</div>
        <div className="mt-0.5 flex min-w-0 items-center gap-1.5 font-mono text-[9px] text-text-muted">
          <span className="truncate">{issue.identifier}</span>
          {agent && <span className="inline-flex items-center gap-0.5"><Bot size={9} className="text-accent" />{agent.name}</span>}
          {schedule && <span className={clsx('inline-flex items-center gap-0.5', schedule.overdue ? 'text-warn' : 'text-text-muted')}><Clock size={9} />{schedule.label}{issue.recurrenceCron ? ' · repeats' : ''}</span>}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {issue.status !== 'in_progress' && issue.status !== 'done' && (
          <button type="button" disabled={accepting} onClick={() => void handleAccept()} title="Run now" aria-label="Run now" className="inline-flex h-5 w-5 items-center justify-center rounded-md bg-accent/10 text-accent hover:bg-accent/20 disabled:opacity-50">
            {accepting ? <Loader2 size={10} className="animate-spin" /> : <Play size={10} />}
          </button>
        )}
        {issue.activeRunId && onOpenRun && (
          <button type="button" onClick={onOpenRun} title="Inspect run" aria-label="Inspect run" className="inline-flex h-5 w-5 items-center justify-center rounded-md border border-line bg-surface-2 text-text-muted hover:bg-surface-3 hover:text-text-primary">
            <ActivityIcon size={10} />
          </button>
        )}
        <button type="button" onClick={() => setEditing(true)} title="Edit" aria-label="Edit task" className="inline-flex h-5 w-5 items-center justify-center rounded-md text-text-muted opacity-0 transition hover:bg-surface-2 hover:text-text-primary group-hover:opacity-100">
          <Pencil size={10} />
        </button>
        <button type="button" disabled={busy} onClick={() => void handleDelete()} title="Delete" aria-label="Delete task" className="inline-flex h-5 w-5 items-center justify-center rounded-md text-text-muted opacity-0 transition hover:bg-danger-soft hover:text-danger group-hover:opacity-100 disabled:opacity-50">
          <Trash2 size={10} />
        </button>
      </div>
    </div>
  );
}

function toLocalInput(iso: string): string {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return '';
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

const RECURRENCE_PRESETS: Array<{ value: string; label: string; cron: string | null }> = [
  { value: 'none', label: 'Once', cron: null },
  { value: 'hourly', label: 'Hourly', cron: '0 * * * *' },
  { value: 'daily', label: 'Daily', cron: '0 9 * * *' },
  { value: 'weekly', label: 'Weekly (Mon)', cron: '0 9 * * 1' },
];

function ScheduleTaskForm({ agents, onCreated }: { agents: WorkspaceAgent[]; onCreated: () => void }) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [assigneeAgentId, setAssigneeAgentId] = useState('');
  const [when, setWhen] = useState('');
  const [recurrence, setRecurrence] = useState('none');
  const [saving, setSaving] = useState(false);

  async function handleCreate() {
    if (!title.trim()) return;
    setSaving(true);
    try {
      const scheduledFor = when ? new Date(when).toISOString() : null;
      const recurrenceCron = RECURRENCE_PRESETS.find((preset) => preset.value === recurrence)?.cron ?? null;
      await api('/v1/issues', {
        method: 'POST',
        body: JSON.stringify({
          title: title.trim(),
          status: scheduledFor ? 'todo' : 'backlog',
          priority: 'medium',
          labels: [],
          assigneeAgentId: assigneeAgentId || null,
          scheduledFor,
          recurrenceCron: scheduledFor ? recurrenceCron : null,
        }),
      });
      setTitle(''); setAssigneeAgentId(''); setWhen(''); setRecurrence('none'); setOpen(false);
      onCreated();
    } catch { /* ignore */ } finally {
      setSaving(false);
    }
  }

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className="flex w-full items-center justify-center gap-1.5 rounded-card border border-dashed border-line px-2 py-1.5 text-[11px] text-text-muted transition-colors hover:border-accent/40 hover:text-accent">
        <Plus size={11} />
        Schedule a task
      </button>
    );
  }

  return (
    <div className="rounded-card border border-accent/30 bg-canvas/40 px-2.5 py-2">
      <input
        autoFocus
        value={title}
        onChange={(event) => setTitle(event.target.value)}
        onKeyDown={(event) => { if (event.key === 'Escape') { setOpen(false); } }}
        placeholder="What should happen…"
        className="w-full bg-transparent text-[12px] text-text-primary outline-none placeholder:text-text-muted"
      />
      <div className="mt-2 grid grid-cols-2 gap-1.5">
        <select value={assigneeAgentId} onChange={(event) => setAssigneeAgentId(event.target.value)} className="h-7 rounded-btn border border-line bg-surface-2 px-1.5 text-[10px] text-text-secondary outline-none">
          <option value="">Unassigned</option>
          {agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
        </select>
        <select value={recurrence} onChange={(event) => setRecurrence(event.target.value)} disabled={!when} className="h-7 rounded-btn border border-line bg-surface-2 px-1.5 text-[10px] text-text-secondary outline-none disabled:opacity-50">
          {RECURRENCE_PRESETS.map((preset) => <option key={preset.value} value={preset.value}>{preset.label}</option>)}
        </select>
      </div>
      <input
        type="datetime-local"
        value={when}
        onChange={(event) => setWhen(event.target.value)}
        className="mt-1.5 h-7 w-full rounded-btn border border-line bg-surface-2 px-1.5 text-[10px] text-text-secondary outline-none"
      />
      <div className="mt-2 flex gap-1.5">
        <button type="button" disabled={!title.trim() || saving} onClick={() => void handleCreate()} className="inline-flex h-6 items-center gap-1 rounded-btn bg-accent px-2 text-[10px] font-medium text-canvas hover:bg-accent/90 disabled:opacity-50">
          {saving ? <Loader2 size={10} className="animate-spin" /> : <Save size={10} />}
          {when ? 'Schedule' : 'Add to backlog'}
        </button>
        <button type="button" onClick={() => { setOpen(false); setTitle(''); }} className="inline-flex h-6 items-center rounded-btn border border-line px-2 text-[10px] text-text-muted hover:bg-surface-2">Cancel</button>
      </div>
    </div>
  );
}

function issueScheduleRank(issue: WorkspaceIssue): number {
  if (!issue.scheduledFor) return Number.MAX_SAFE_INTEGER;
  const time = new Date(issue.scheduledFor).getTime();
  return Number.isFinite(time) ? time : Number.MAX_SAFE_INTEGER;
}

function formatSchedule(iso: string): { label: string; overdue: boolean } {
  const time = new Date(iso).getTime();
  if (!Number.isFinite(time)) return { label: 'scheduled', overdue: false };
  const deltaMs = time - Date.now();
  const overdue = deltaMs < 0;
  const minutes = Math.round(Math.abs(deltaMs) / 60_000);
  const rel = minutes < 1 ? 'now' : minutes < 60 ? `${minutes}m` : minutes < 1440 ? `${Math.round(minutes / 60)}h` : `${Math.round(minutes / 1440)}d`;
  return { label: overdue ? `due ${rel} ago` : `in ${rel}`, overdue };
}

const ISSUE_STATUS_TONE: Record<string, string> = {
  backlog: 'bg-surface-2 text-text-muted',
  todo: 'bg-surface-2 text-text-muted',
  in_progress: 'bg-sky-500/15 text-sky-200',
  in_review: 'bg-violet-500/15 text-violet-200',
  blocked: 'bg-rose-500/15 text-rose-200',
  done: 'bg-emerald-500/15 text-emerald-200',
  cancelled: 'bg-surface-2 text-text-muted',
};

const ISSUE_PRIORITY_TONE: Record<string, string> = {
  urgent: 'bg-rose-500/15 text-rose-300',
  high: 'bg-amber-500/15 text-amber-300',
  medium: 'bg-sky-500/15 text-sky-300',
  low: 'bg-surface-2 text-text-muted',
  none: 'bg-surface-2 text-text-muted',
};

function clampLiveWorkspaceFrame(frame: LiveWorkspaceFrame, containerSize: VirtualCanvasSize): LiveWorkspaceFrame {
  const maxWidth = Math.max(LIVE_WORKSPACE_MIN_WIDTH, containerSize.width - LIVE_WORKSPACE_MARGIN * 2);
  const maxHeight = Math.max(LIVE_WORKSPACE_MIN_HEIGHT, containerSize.height - LIVE_WORKSPACE_MARGIN * 2);
  const width = clamp(frame.width, LIVE_WORKSPACE_MIN_WIDTH, maxWidth);
  const height = clamp(frame.height, LIVE_WORKSPACE_MIN_HEIGHT, maxHeight);
  const maxX = Math.max(LIVE_WORKSPACE_MARGIN, containerSize.width - width - LIVE_WORKSPACE_MARGIN);
  const maxY = Math.max(LIVE_WORKSPACE_MARGIN, containerSize.height - height - LIVE_WORKSPACE_MARGIN);
  const x = clamp(frame.x, LIVE_WORKSPACE_MARGIN, maxX);
  const y = clamp(frame.y, LIVE_WORKSPACE_MARGIN, maxY);
  return { ...frame, x, y, width, height };
}

function liveWorkspaceFramesEqual(a: LiveWorkspaceFrame, b: LiveWorkspaceFrame): boolean {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

function GhostEmptyState({ onCreateOrchestrator }: { onCreateOrchestrator: () => void }) {
  return (
    <div data-canvas-control className="absolute left-1/2 top-[58%] z-30 w-[min(420px,calc(100%-40px))] -translate-x-1/2 rounded-2xl border border-dashed border-line bg-surface/72 px-5 py-4 text-center shadow-card backdrop-blur-md">
      <PackageOpen size={32} className="mx-auto text-text-muted" />
      <h2 className="mt-3 text-heading text-text-primary">Your AI organization will appear here.</h2>
      <p className="mt-2 text-[13px] leading-relaxed text-text-secondary">
        Start with the orchestrator. Once the workspace orchestrator is commissioned, managers and specialists can branch beneath it.
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
      <circle cx="22" cy="22" r={radius} fill="none" stroke="var(--color-accent-soft)" strokeWidth="2" />
      <circle
        cx="22"
        cy="22"
        r={radius}
        fill="none"
        stroke="var(--color-accent)"
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
  const linkedWorkflowRowCount = estimateMaxLinkedWorkflowRowCount(data.workflows, agents, activeRuns);
  // Reserve the full packed branch row (managers + the direct-workflows branch)
  // INCLUDING each edge lane's half-span plus margins, so the uniform-stride
  // pyramid never clamps a lane to one column (vertical line) at the canvas edge.
  const packedContentWidth = packContentWidth(deriveTopBranchLayout(data, agents, roles).branchCount);
  const width = Math.max(
    containerSize.width,
    1040,
    managerCount * (NODE.manager.width + 62) + 320,
    packedContentWidth + (RESOURCE_LAYOUT.sideMargin + NODE.workflow.width / 2) * 2,
    Math.min(workerCount, workerColumns) * (workerSize.width + 48) + 320,
    resourceGridRowWidth(Math.min(resources, 6)) + RESOURCE_LAYOUT.sideMargin * 2,
    linkedWorkflowRowWidth(linkedWorkflowRowCount) + RESOURCE_LAYOUT.sideMargin * 2,
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
  sizeOverride?: { width: number; height: number },
): CanvasNode {
  const record = agent as unknown as Record<string, unknown>;
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
    subtitle: role === 'orchestrator' ? `orchestrator - ${status}` : role === 'manager' ? `${managerLabel} - ${status}` : `specialist - ${status}`,
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
    currentTask: stringField(record, ['currentTask', 'currentTaskId']),
    tooltipLines: compactStrings([
      `Status: ${status}`,
      stringField(record, ['description']),
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
        : ['Specialists execute tasks, research, writing, and automations.'],
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
  focusedManagerId: string | null = null,
  branchSlots: ReadonlyMap<string, BranchSlot> = new Map<string, BranchSlot>(),
  directSlot: BranchSlot | null = null,
): CanvasNode[] {
  const resources: CanvasNode[] = [];
  const workflowPositions = new Map<string, Vec2>();
  const workflowDomainById = new Map<string, { spaceId?: string | null; spaceName?: string | null; accent?: string }>();
  const workflowArtifactIndex = new Map<string, number>();
  const artifactCountsByWorkflow = countArtifactsByWorkflow(artifacts);
  // Apps are the org primitive: collapse each App's workflows into ONE app node
  // (clustered under the App's domain/owner, routed to /apps/:id) while bare
  // workflows (app_id = null) keep rendering as workflow nodes. The app node
  // reuses a real representative workflow id so run liveness still resolves.
  const resourceWorkflows = collapseAppsIntoResourceWorkflows(data, activeWorkflowIds);
  const resourceCountEstimate = Math.max(
    resourceWorkflows.length + data.knowledgeBases.length + artifacts.length + approvals.length,
    3,
  );
  const gridAvailableWidth = Math.max(NODE.workflow.width, canvasSize.width - RESOURCE_LAYOUT.sideMargin * 2);
  const maxGridColumns = Math.max(1, Math.floor((gridAvailableWidth + RESOURCE_LAYOUT.gridColumnGap) / RESOURCE_GRID_COLUMN_WIDTH));
  const columns = Math.max(1, Math.min(resourceCountEstimate, maxGridColumns));
  const gridPosAt = (row: number, col: number): Vec2 => {
    const available = canvasSize.width - RESOURCE_LAYOUT.sideMargin * 2;
    const gridWidth = Math.min(available, Math.max(1, columns - 1) * RESOURCE_GRID_COLUMN_WIDTH);
    const start = canvasSize.width / 2 - gridWidth / 2;
    const x = columns === 1 ? canvasSize.width / 2 : start + (gridWidth * col) / Math.max(1, columns - 1);
    return { x, y: resourceStartY + row * RESOURCE_LAYOUT.rowGap };
  };
  const positions = (index: number): Vec2 => gridPosAt(Math.floor(index / columns), index % columns);
  const workflowMinX = RESOURCE_LAYOUT.sideMargin + NODE.workflow.width / 2;
  const workflowMaxX = canvasSize.width - RESOURCE_LAYOUT.sideMargin - NODE.workflow.width / 2;
  const managerSourceXs = Array.from(sourceNodeById.values())
    .filter((node) => node.role === 'manager')
    .map((node) => node.x)
    .sort((a, b) => a - b);
  const workflowSourceSlot = (sourceX: number): { left: number; right: number } => {
    const anchorX = clamp(sourceX, workflowMinX, workflowMaxX);
    const sourceIndex = managerSourceXs.findIndex((x) => Math.abs(x - sourceX) < 0.5);
    const prevX = sourceIndex > 0 ? managerSourceXs[sourceIndex - 1] : undefined;
    const nextX = sourceIndex >= 0 ? managerSourceXs[sourceIndex + 1] : undefined;
    const left = prevX == null
      ? workflowMinX
      : Math.max(workflowMinX, (prevX + anchorX) / 2 + RESOURCE_LAYOUT.nodeClearance);
    const right = nextX == null
      ? workflowMaxX
      : Math.min(workflowMaxX, (nextX + anchorX) / 2 - RESOURCE_LAYOUT.nodeClearance);
    return right >= left ? { left, right } : { left: anchorX, right: anchorX };
  };
  type BranchGeometry = {
    anchorX: number;
    left: number;
    right: number;
    maxColumns: number;
    direction: 'left' | 'center' | 'right';
  };
  const maxBranchColumns = (left: number, right: number): number => {
    const available = Math.max(NODE.workflow.width, right - left);
    return Math.max(1, Math.min(5, Math.floor((available + AUTHORITY_LANE.columnGap) / AUTHORITY_LANE_COLUMN_WIDTH)));
  };
  const branchRowCapacity = (geometry: BranchGeometry, row: number): number => {
    return Math.max(1, Math.min(geometry.maxColumns, WORKFLOW_BRANCH_ROW_PATTERN[row] ?? geometry.maxColumns));
  };
  const branchCapacity = (geometry: BranchGeometry, rows: number): number => {
    let total = 0;
    for (let row = 0; row < rows; row += 1) total += branchRowCapacity(geometry, row);
    return total;
  };
  const branchPositions = (geometry: BranchGeometry, count: number, startRow: number): Vec2[] => {
    const positions: Vec2[] = [];
    for (let localRow = 0; positions.length < count; localRow += 1) {
      const remaining = count - positions.length;
      const rowCount = Math.min(remaining, branchRowCapacity(geometry, localRow));
      const rowWidth = Math.max(0, rowCount - 1) * AUTHORITY_LANE_COLUMN_WIDTH;
      const desiredFirstX = geometry.direction === 'left'
        ? geometry.anchorX - rowWidth
        : geometry.direction === 'right'
          ? geometry.anchorX
          : geometry.anchorX - rowWidth / 2;
      const firstX = clamp(desiredFirstX, geometry.left, Math.max(geometry.left, geometry.right - rowWidth));
      for (let col = 0; col < rowCount; col += 1) {
        positions.push({
          x: firstX + col * AUTHORITY_LANE_COLUMN_WIDTH,
          y: resourceStartY + (startRow + localRow) * RESOURCE_LAYOUT.rowGap,
        });
      }
    }
    return positions;
  };
  const rowsUsedByBranch = (geometry: BranchGeometry, count: number): number => {
    let remaining = count;
    let rows = 0;
    while (remaining > 0) {
      remaining -= branchRowCapacity(geometry, rows);
      rows += 1;
    }
    return rows;
  };
  // A packed branch lane: workflows fan out symmetrically within their own
  // [left,right] slot so sibling lanes never collide.
  const geometryFromSlot = (slot: BranchSlot): BranchGeometry => {
    const left = clamp(slot.left, workflowMinX, workflowMaxX);
    const right = clamp(Math.max(slot.right, left), workflowMinX, workflowMaxX);
    return {
      anchorX: clamp(slot.centerX, left, right),
      left,
      right,
      maxColumns: maxBranchColumns(left, right),
      direction: 'center',
    };
  };
  const sourceWorkflowGeometry = (sourceId: string | undefined): BranchGeometry => {
    const slot = sourceId ? branchSlots.get(sourceId) : undefined;
    if (slot) return geometryFromSlot(slot);
    // Fallback for non-manager anchors (e.g. a connected worker): keep the
    // original midpoint-between-neighbours bounds.
    const anchorX = clamp(sourceId ? sourceXById.get(sourceId) ?? canvasSize.width / 2 : canvasSize.width / 2, workflowMinX, workflowMaxX);
    const bounds = workflowSourceSlot(anchorX);
    const center = canvasSize.width / 2;
    return {
      anchorX,
      left: bounds.left,
      right: bounds.right,
      maxColumns: maxBranchColumns(bounds.left, bounds.right),
      direction: anchorX < center - 24 ? 'left' : anchorX > center + 24 ? 'right' : 'center',
    };
  };
  const focusedWorkflowGeometry = (sourceId: string | undefined): BranchGeometry => {
    // Centered wide lane for the drilled-in manager: up to ~5 columns so the
    // subtree fans into a balanced pyramid (the dimmed siblings free the room).
    const anchorX = clamp(sourceId ? sourceXById.get(sourceId) ?? canvasSize.width / 2 : canvasSize.width / 2, workflowMinX, workflowMaxX);
    const halfWide = Math.min(canvasSize.width / 2 - RESOURCE_LAYOUT.sideMargin, 3 * AUTHORITY_LANE_COLUMN_WIDTH);
    const left = clamp(anchorX - halfWide, workflowMinX, workflowMaxX);
    const right = clamp(anchorX + halfWide, workflowMinX, workflowMaxX);
    return { anchorX, left, right, maxColumns: maxBranchColumns(left, right), direction: 'center' };
  };
  const orchestratorWorkflowGeometry = (): BranchGeometry => {
    // The orchestrator's direct workflows are a first-class packed branch
    // (centered in their own slot), not a far-right gutter.
    if (directSlot) return geometryFromSlot(directSlot);
    const center = canvasSize.width / 2;
    const left = Math.min(workflowMaxX, center + Math.max(420, NODE.orchestrator.width / 2 + 120));
    const right = workflowMaxX;
    return {
      anchorX: left,
      left,
      right,
      maxColumns: maxBranchColumns(left, right),
      direction: 'right',
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
    laneKind: NonNullable<CanvasNode['laneKind']>;
    laneGroupKey: string;
    failed: WorkspaceFailedRun | undefined;
    groupKey: string;
    /** 0 = needs attention (failed), 1 = active/running, 2 = idle — floats problems up. */
    statePriority: number;
  }
  const entries: WorkflowEntry[] = resourceWorkflows.map((workflow) => {
    const run = activeRuns.find((item) => item.workflowId === workflow.id);
    const wfLabel = workflowLabel(workflow);
    let connectedAgentIds = run?.agents?.map((agent) => `agent-${agent.id}`);
    if ((!connectedAgentIds || connectedAgentIds.length === 0) && workflow?.graph?.nodes) {
      connectedAgentIds = workflowAgentTaskIds(workflow).map((agentId) => `agent-${agentId}`);
    }
    // Manager-owned org structure: a workflow owned by a specialist anchors under
    // that specialist (when its node is on-canvas, i.e. its manager is focused),
    // so the specialist's workflows cluster beneath it.
    const ownerSourceId = workflow.ownerAgentId ? `agent-${workflow.ownerAgentId}` : undefined;
    if (ownerSourceId) connectedAgentIds = preferConnectedSource(connectedAgentIds, ownerSourceId);
    let workflowSpaceId = workflow.spaceId ?? null;
    let workflowSpaceName: string | null = null;
    let workflowAccent: string | undefined;
    const linkedDomain = resolveDomainFromSources(connectedAgentIds, sourceNodeById);
    if (!workflowSpaceId && linkedDomain.spaceId) workflowSpaceId = linkedDomain.spaceId;
    if (linkedDomain.spaceName) workflowSpaceName = linkedDomain.spaceName;
    if (linkedDomain.accent) workflowAccent = linkedDomain.accent;
    let domainSourceId: string | undefined;
    if (workflowSpaceId) {
      domainSourceId = spaceSourceIds.get(workflowSpaceId);
      if (domainSourceId) connectedAgentIds = preferConnectedSource(connectedAgentIds, domainSourceId);
      const sourceNode = domainSourceId ? sourceNodeById.get(domainSourceId) : undefined;
      if (!workflowSpaceName) workflowSpaceName = sourceNode?.spaceName ?? null;
      if (!workflowAccent) workflowAccent = sourceNode?.accent;
    }
    // The owning specialist normally wins the anchor over the domain manager —
    // the specialist is who actually runs the workflow. BUT an explicit domain
    // assignment is authoritative: if the resource is placed in a domain whose
    // manager is NOT the owner's manager, the domain wins, so it never drifts
    // into an unrelated manager's cluster (e.g. an App in General › SEO must not
    // surface under Marketing just because its owner reports there).
    const ownerAnchorId = ownerSourceId && sourceXById.has(ownerSourceId) && isWorkflowAnchorSource(ownerSourceId, sourceNodeById)
      ? ownerSourceId
      : undefined;
    const domainAnchorId = domainSourceId && sourceXById.has(domainSourceId) ? domainSourceId : undefined;
    const ownerHonoursDomain = !ownerAnchorId
      || !domainAnchorId
      || ownerAnchorId === domainAnchorId
      || sourceBelongsToManager(ownerAnchorId, domainAnchorId, sourceNodeById);
    const anchoredSourceId = (ownerHonoursDomain ? ownerAnchorId : undefined)
      ?? domainAnchorId
      ?? connectedAgentIds?.find((sourceId) => sourceXById.has(sourceId) && isWorkflowAnchorSource(sourceId, sourceNodeById));
    const failed = failedRuns.find((item) => item.workflowId === workflow.id || item.workflowName === wfLabel);
    const statusNeedsAttention = /fail|error|blocked/i.test(workflow.status ?? '');
    const isActive = Boolean(run) || activeWorkflowIds.has(workflow.id);
    const statePriority = failed || statusNeedsAttention ? 0 : isActive ? 1 : 2;
    const groupKey = workflowSpaceName ?? workflowSpaceId ?? '~ungrouped';
    const laneKind: NonNullable<CanvasNode['laneKind']> = anchoredSourceId || workflowSpaceId
      ? 'manager-workflows'
      : 'orchestrator-workflows';
    const laneGroupKey = laneKind === 'manager-workflows'
      ? `manager:${anchoredSourceId ?? workflowSpaceId ?? groupKey}`
      : 'orchestrator:direct';
    return { workflow, wfLabel, run, connectedAgentIds, workflowSpaceId, workflowSpaceName, workflowAccent, anchoredSourceId, laneKind, laneGroupKey, failed, groupKey, statePriority };
  });
  // Phase 2: group workflows into expandable ownership lanes.
  const groups = new Map<string, WorkflowEntry[]>();
  for (const e of entries) {
    const list = groups.get(e.laneGroupKey) ?? [];
    list.push(e);
    groups.set(e.laneGroupKey, list);
  }
  // Domains needing attention (or actively running) float to the top of each lane.
  const orderedGroups = [...groups.entries()].sort((a, b) => {
    const aBest = Math.min(...a[1].map((e) => e.statePriority));
    const bBest = Math.min(...b[1].map((e) => e.statePriority));
    const laneDelta = laneOrder(a[1][0]?.laneKind) - laneOrder(b[1][0]?.laneKind);
    return laneDelta || aBest - bBest || workflowGroupLabel(a[1][0]).localeCompare(workflowGroupLabel(b[1][0]));
  });
  const bandPos = new Map<string, Vec2>();
  const aggregators: CanvasNode[] = [];
  const hiddenByGroup = new Map<string, WorkflowEntry[]>();
  let directWorkflowRows = 0;
  let maxWorkflowRows = 0;
  for (const [laneGroupKey, groupEntries] of orderedGroups) {
    groupEntries.sort((a, b) => a.statePriority - b.statePriority || a.wfLabel.localeCompare(b.wfLabel));
    // Scale rule: an unexpanded ownership group shows just enough rows to keep
    // failed and active workflows visible, then hides idle overflow behind a
    // local expander.
    const laneKind = groupEntries[0]?.laneKind ?? 'orchestrator-workflows';
    const focusedManagerGroup = Boolean(
      focusedManagerId
        && laneKind === 'manager-workflows'
        && groupEntries.some((entry) => (
          entry.anchoredSourceId
            ? sourceBelongsToManager(entry.anchoredSourceId, focusedManagerId, sourceNodeById)
            : laneGroupKey === `manager:${focusedManagerId}`
        )),
    );
    // A focused manager's siblings are dimmed out of the way, so give its subtree
    // a wide lane to fan into a real pyramid (2 → 3 → 4 …) instead of a column.
    const geometry = focusedManagerGroup
      ? focusedWorkflowGeometry(groupEntries[0]?.anchoredSourceId)
      : laneKind === 'manager-workflows'
        ? sourceWorkflowGeometry(groupEntries[0]?.anchoredSourceId)
        : orchestratorWorkflowGeometry();
    const expanded = expandedDomains.has(laneGroupKey) || focusedManagerGroup;
    const maxRows = focusedManagerGroup ? FOCUSED_MANAGER_WORKFLOW_ROWS : FULL_VIEW_WORKFLOW_ROWS;
    const rowBudget = branchCapacity(geometry, maxRows);
    const overflows = groupEntries.length > rowBudget;
    const mustShowCount = groupEntries.filter((entry) => entry.statePriority < 2).length;
    const collapsedBudget = Math.max(1, rowBudget - 1);
    const visibleBudget = !overflows
      ? groupEntries.length
      : expanded
        ? groupEntries.length
        : Math.max(collapsedBudget, Math.min(mustShowCount, rowBudget - 1));
    const visible = groupEntries.slice(0, visibleBudget);
    const hidden = groupEntries.slice(visibleBudget);
    if (hidden.length > 0) hiddenByGroup.set(laneGroupKey, hidden);

    const rowStart = laneKind === 'orchestrator-workflows' ? directWorkflowRows : 0;
    const needsExpander = overflows && (hidden.length > 0 || expanded);
    const groupPositions = branchPositions(geometry, visible.length + (needsExpander ? 1 : 0), rowStart);
    for (const [entryIndex, e] of visible.entries()) {
      const pos = groupPositions[entryIndex];
      if (pos) bandPos.set(e.workflow.id, pos);
    }
    if (needsExpander) {
      // The expander persists in both states so the band can collapse again.
      const pos = groupPositions[visible.length] ?? {
        x: geometry.anchorX,
        y: resourceStartY + rowStart * RESOURCE_LAYOUT.rowGap,
      };
      const domainLabel = workflowGroupLabel(groupEntries[0]);
      aggregators.push({
        id: `workflow-more:${encodeURIComponent(laneGroupKey)}`,
        kind: 'workflow',
        tier: 3,
        title: expanded ? 'Show less' : `+${hidden.length} more`,
        subtitle: expanded ? `collapse ${domainLabel}` : `idle in ${domainLabel}`,
        x: pos.x,
        y: pos.y,
        width: NODE.workflow.width,
        height: NODE.workflow.height,
        ghost: true,
        laneId: laneGroupKey,
        laneKind,
        groupKey: groupEntries[0]?.groupKey,
        collapsedCount: hidden.length,
        expanded,
        connectedAgentIds: groupEntries[0]?.anchoredSourceId ? [groupEntries[0].anchoredSourceId] : undefined,
        tooltipLines: compactStrings([
          expanded
            ? 'Collapse this domain back to one row.'
            : `${hidden.length} idle workflow${hidden.length === 1 ? '' : 's'} collapsed.`,
          ...hidden.slice(0, 6).map((h) => `· ${h.wfLabel}`),
          hidden.length > 6 ? `· …and ${hidden.length - 6} more` : undefined,
        ]),
      });
    }
    const usedRows = rowsUsedByBranch(geometry, visible.length + (needsExpander ? 1 : 0));
    const endRow = rowStart + usedRows;
    if (laneKind === 'orchestrator-workflows') directWorkflowRows = endRow + 1;
    maxWorkflowRows = Math.max(maxWorkflowRows, endRow);
  }
  // Knowledge/artifacts continue on the row after the workflow bands.
  index = (maxWorkflowRows + 1) * columns;

  // Phase 3: emit nodes in lane order.
  const placementOrder = orderedGroups.flatMap(([laneGroupKey, groupEntries]) => {
    const hidden = hiddenByGroup.get(laneGroupKey);
    return hidden ? groupEntries.filter((e) => !hidden.includes(e)) : groupEntries;
  });
  resources.push(...aggregators);
  for (const e of placementOrder) {
    const { workflow, wfLabel, run, connectedAgentIds, workflowSpaceId, workflowSpaceName, workflowAccent, failed, statePriority } = e;
    const pos = bandPos.get(workflow.id) ?? positions(index++);
    const appMeta = workflow.app ?? null;
    const appSubtitle = appMeta
      ? `App · ${appMeta.workflowCount} workflow${appMeta.workflowCount === 1 ? '' : 's'}`
      : null;
    const appIconImage = appMeta && isImageIcon(appMeta.icon) ? appMeta.icon ?? undefined : undefined;
    resources.push({
      id: `workflow-${workflow.id}`,
      kind: 'workflow',
      ...(appMeta ? { kindLabel: 'app' } : {}),
      tier: 3,
      title: wfLabel,
      subtitle: run ? activeRunSubtitle(run) : appSubtitle ?? statusLabel(workflow.status, 'workflow'),
      x: pos.x,
      y: pos.y,
      width: NODE.workflow.width,
      height: NODE.workflow.height,
      spaceId: workflowSpaceId,
      spaceName: workflowSpaceName,
      active: Boolean(run) || activeWorkflowIds.has(workflow.id),
      warn: statePriority === 0,
      route: appMeta ? `/apps/${appMeta.id}` : `/apps/workflows/${workflow.id}`,
      accent: workflowAccent,
      imageUrl: appMeta ? appIconImage : workflowImageUrl(workflow),
      icon: appMeta
        ? (appMeta.icon && !isImageIcon(appMeta.icon) ? <span className="text-[15px]">{appMeta.icon}</span> : <Boxes size={17} />)
        : <Workflow size={17} />,
      progress: runProgress(run),
      startedAt: run?.startedAt,
      artifactCount: artifactCountsByWorkflow.get(workflow.id) ?? 0,
      laneId: e.laneGroupKey,
      laneKind: e.laneKind,
      groupKey: e.groupKey,
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

  const positionedWorkflowNodes = resolveResourceCollisions(resources);
  resources.splice(0, resources.length, ...positionedWorkflowNodes);
  for (const node of positionedWorkflowNodes) {
    if (node.workflow) workflowPositions.set(node.workflow.id, { x: node.x, y: node.y });
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
    const selfHeal = isSelfHealApproval(approval);
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
      title: selfHeal ? 'Self-healing fix ready' : approval.agentName ? `${approval.agentName} needs review` : 'Approval needed',
      subtitle: approval.workflowName ?? (selfHeal ? 'repair approval' : 'human decision'),
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
      icon: <CanvasApprovalNodeBadge source={approval.source} />,
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
        route: '/apps',
        tooltipLines: ['Planned resource node'],
        spaceId: defaultSourceId ? sourceNodeById.get(defaultSourceId)?.spaceId ?? null : null,
        spaceName: defaultSourceId ? sourceNodeById.get(defaultSourceId)?.spaceName ?? null : null,
        accent: defaultSourceId ? sourceNodeById.get(defaultSourceId)?.accent : undefined,
        connectedAgentIds: defaultSourceId ? [defaultSourceId] : undefined,
      });
    });
  }

  return resolveResourceCollisions(resources);
}

function resolveResourceCollisions(resources: CanvasNode[]): CanvasNode[] {
  const placed: CanvasNode[] = [];

  // No two resource cards may ever overlap — a hard invariant. The band packer
  // keeps nodes apart *within* a lane, but sibling lanes (and subdomain/fallback
  // anchors) can land on overlapping x-slots, so every node — App/workflow cards
  // included — gets a final nudge-down pass against everything already placed.
  return resources.map((resource) => {
    let y = resource.y;
    while (placed.some((other) => nodesOverlap({ ...resource, y }, other))) {
      y += Math.max(resource.height, RESOURCE_LAYOUT.rowGap) + RESOURCE_LAYOUT.nodeClearance;
    }
    const positioned = y === resource.y ? resource : { ...resource, y };
    placed.push(positioned);
    return positioned;
  });
}

function nodesOverlap(a: CanvasNode, b: CanvasNode): boolean {
  const horizontalClearance = (a.width + b.width) / 2 + RESOURCE_LAYOUT.nodeClearance;
  const verticalClearance = (a.height + b.height) / 2 + RESOURCE_LAYOUT.nodeClearance;
  return Math.abs(a.x - b.x) < horizontalClearance && Math.abs(a.y - b.y) < verticalClearance;
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
  // down the chain of command. Specialists don't surface workspace-wide knowledge.
  return role === 'orchestrator' || role === 'manager';
}

function estimateMaxLinkedWorkflowRowCount(
  workflows: HomeWorkflow[],
  agents: WorkspaceAgent[],
  activeRuns: WorkspaceActiveRun[],
): number {
  const managerIds = new Set(agents.filter((agent) => normalizeRole(agent) === 'manager').map((agent) => agent.id));
  const counts = new Map<string, number>();
  for (const workflow of workflows) {
    let key = workflow.spaceId ? `space:${workflow.spaceId}` : null;
    if (!key) {
      const run = activeRuns.find((item) => item.workflowId === workflow.id);
      const managerRunAgent = run?.agents?.find((agent) => managerIds.has(agent.id));
      if (managerRunAgent) key = `agent:${managerRunAgent.id}`;
    }
    if (!key) {
      const managerGraphAgentId = workflowAgentTaskIds(workflow).find((agentId) => managerIds.has(agentId));
      if (managerGraphAgentId) key = `agent:${managerGraphAgentId}`;
    }
    if (!key) continue;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return Math.max(0, ...counts.values());
}

function linkedWorkflowRowWidth(count: number): number {
  if (count <= 0) return 0;
  return NODE.workflow.width + (count - 1) * ANCHORED_WORKFLOW_COLUMN_WIDTH;
}

function resourceGridRowWidth(count: number): number {
  if (count <= 0) return 0;
  return NODE.workflow.width + (count - 1) * RESOURCE_GRID_COLUMN_WIDTH;
}

function anchoredWorkflowRowCapacity(total: number, canvasWidth: number): number {
  if (total <= 0) return 1;
  const available = Math.max(NODE.workflow.width, canvasWidth - RESOURCE_LAYOUT.sideMargin * 2);
  const capacity = Math.floor((available + RESOURCE_LAYOUT.anchoredColumnGap) / ANCHORED_WORKFLOW_COLUMN_WIDTH);
  return Math.max(1, Math.min(total, capacity));
}

function workflowAgentTaskIds(workflow: HomeWorkflow): string[] {
  return (workflow.graph?.nodes ?? [])
    .map((node) => node.config?.kind === 'agent_task' && typeof node.config.agentId === 'string' ? node.config.agentId : null)
    .filter((agentId): agentId is string => Boolean(agentId));
}

function preferConnectedSource(candidateIds: string[] | undefined, preferredId: string): string[] {
  return [preferredId, ...(candidateIds ?? []).filter((id) => id !== preferredId)];
}

function laneOrder(kind: CanvasNode['laneKind'] | undefined): number {
  return kind === 'manager-workflows' ? 0 : 1;
}

function workflowGroupLabel(entry: { laneKind: CanvasNode['laneKind']; groupKey: string; workflowSpaceName?: string | null } | undefined): string {
  if (!entry) return 'workspace';
  if (entry.laneKind === 'orchestrator-workflows') return 'orchestrator';
  if (entry.workflowSpaceName) return entry.workflowSpaceName;
  if (entry.groupKey === '~ungrouped') return 'workspace';
  if (entry.groupKey.startsWith('space-')) return 'workspace';
  return entry.groupKey;
}

function isWorkflowAnchorSource(sourceId: string, sourceNodeById: Map<string, CanvasNode>): boolean {
  const source = sourceNodeById.get(sourceId);
  return source?.role === 'manager' || source?.role === 'worker';
}

function sourceBelongsToManager(sourceId: string, managerId: string, sourceNodeById: Map<string, CanvasNode>): boolean {
  if (sourceId === managerId) return true;
  const source = sourceNodeById.get(sourceId);
  const manager = sourceNodeById.get(managerId);
  if (!source || !manager) return false;
  if (source.spaceId && manager.spaceId && source.spaceId === manager.spaceId) return true;
  if (source.role !== 'worker' || !source.agent || !manager.agent) return false;
  // Shared Domain ⇒ same authority subtree (mirrors findParentManager). A
  // specialist owning a Subdomain of the manager's Domain belongs to it even
  // when reportsTo points elsewhere.
  const sourceDomain = stringField(source.agent, ['domainId']);
  const managerDomain = stringField(manager.agent, ['domainId']);
  if (sourceDomain && managerDomain && sourceDomain === managerDomain) return true;
  const reportsTo = stringField(source.agent, ['reportsTo', 'managerId', 'parentAgentId']);
  return reportsTo === manager.agent.id || reportsTo === manager.agent.name || reportsTo === managerId;
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

/** One packed horizontal slot for a top-level branch under the orchestrator. */
export interface BranchSlot {
  centerX: number;
  left: number;
  right: number;
}

const BRANCH_GAP = 40;

/**
 * Uniform horizontal stride between sibling branches. The non-overlap guarantee
 * is structural, not spacing-based: every branch gets a symmetric lane exactly
 * `stride` wide, and `maxBranchColumns` caps each lane's workflow columns to fit
 * that width — so nodes can never cross into a neighbour no matter how tightly
 * managers pack. Few branches get roomy 2-column lanes; as the row fills up the
 * stride tapers toward a single column, so even ~15 managers stay compact.
 */
function branchStride(count: number): number {
  const roomy = 2 * AUTHORITY_LANE_COLUMN_WIDTH + BRANCH_GAP;
  const tight = Math.max(NODE.manager.width, AUTHORITY_LANE_COLUMN_WIDTH) + BRANCH_GAP;
  if (count <= 4) return roomy;
  if (count >= 9) return tight;
  const t = (count - 4) / 5;
  return roomy + (tight - roomy) * t;
}

/**
 * Full horizontal span of the branch row INCLUDING each edge lane's half-span,
 * so the virtual canvas is wide enough that no edge lane clamps to a single
 * column at the canvas border (the cause of workflows stacking as a vertical
 * line). Each lane is one stride wide minus clearance, centered on its branch.
 */
function packContentWidth(count: number): number {
  if (count <= 0) return 0;
  const stride = branchStride(count);
  const halfSpan = stride / 2 - RESOURCE_LAYOUT.nodeClearance;
  return (count - 1) * stride + 2 * halfSpan;
}

/**
 * Pack the orchestrator's direct branches (managers + the direct-workflows
 * group) into one centered row beneath the orchestrator, at a uniform stride.
 * Center-out: the middle branch lands directly under the orchestrator and the
 * row stays a balanced pyramid. Each branch's lane is symmetric and exactly one
 * stride wide, so sibling lanes can never collide.
 */
function packTopBranches(count: number, canvasWidth: number): BranchSlot[] {
  if (count <= 0) return [];
  const stride = branchStride(count);
  const center = canvasWidth / 2;
  const half = stride / 2 - RESOURCE_LAYOUT.nodeClearance;
  return Array.from({ length: count }, (_, i) => {
    const centerX = center + (i - (count - 1) / 2) * stride;
    return { centerX, left: centerX - half, right: centerX + half };
  });
}

/**
 * Resolve the orchestrator's top-level branches (manager node ids + their
 * spaceIds, the space→manager map, and a per-branch workflow tally) without
 * needing any x positions. Shared by buildCanvasModel (authoritative placement)
 * and computeVirtualCanvasSize (so the virtual canvas is wide enough). The
 * workflow tally only *sizes* slots — placement stays authoritative in
 * buildResourceNodes, and undersizing merely makes a lane taller, never
 * overlapping.
 */
function deriveTopBranchLayout(
  data: EcosystemData,
  agents: WorkspaceAgent[],
  roles: ReturnType<typeof classifyAgents>,
): {
  managerNodeIds: string[];
  spaceSourceIds: Map<string, string>;
  hasDirectBranch: boolean;
  branchCount: number;
} {
  const spaces = data.spaces ?? [];
  const plannedSpaceCount = Math.max(2, spaces.length);
  const managerCount = Math.max(
    roles.managers.length,
    agents.length === 0 ? plannedSpaceCount : roles.workers.length > 0 && roles.managers.length === 0 ? 1 : 0,
  );
  const managerNodeIds: string[] = [];
  const spaceSourceIds = new Map<string, string>();
  roles.managers.forEach((agent) => {
    const id = `agent-${agent.id}`;
    const record = agent as unknown as Record<string, unknown>;
    const spaceId = stringField(record, ['spaceId']) ?? null;
    // Manager-owned org: a manager is responsible for a Domain (domainId), which
    // is the key Apps/workflows are assigned under. Register both so a domain
    // whose id differs from (or exists without) the legacy spaceId still anchors
    // its resources beneath the owning manager.
    const domainId = stringField(record, ['domainId']) ?? null;
    managerNodeIds.push(id);
    if (spaceId) spaceSourceIds.set(spaceId, id);
    if (domainId) spaceSourceIds.set(domainId, id);
  });
  for (let index = roles.managers.length; index < managerCount; index += 1) {
    const id = `ghost-manager-${index}`;
    const space = spaces[index - roles.managers.length] ?? null;
    managerNodeIds.push(id);
    if (space) spaceSourceIds.set(space.id, id);
  }
  // Subdomains (e.g. General › SEO) don't have their own top-branch lane — their
  // resources cluster under the SAME manager as their parent Domain. Map each
  // subdomain id onto the parent domain's source so an App assigned to a
  // subdomain still anchors beneath the right manager (instead of falling
  // through to the owning specialist's unrelated cluster).
  for (const space of spaces) {
    if (!space.parentDomainId || spaceSourceIds.has(space.id)) continue;
    const parentSource = spaceSourceIds.get(space.parentDomainId);
    if (parentSource) spaceSourceIds.set(space.id, parentSource);
  }
  // The orchestrator's direct-workflows group is a branch too (a workflow with
  // no space, or whose space has no manager).
  const hasDirectBranch = data.workflows.some(
    (workflow) => !(workflow.spaceId && spaceSourceIds.has(workflow.spaceId)),
  );
  const branchCount = managerNodeIds.length + (hasDirectBranch ? 1 : 0);
  return { managerNodeIds, spaceSourceIds, hasDirectBranch, branchCount };
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
  // Domain responsibility is authoritative for the org tree: a specialist that
  // owns a Domain (or a Subdomain of one) sits under that Domain's manager —
  // even if its raw `reportsTo` still points at a different manager. This keeps
  // the canvas consistent with where the specialist's work/Apps actually live.
  const domainId = stringField(record, ['domainId']);
  if (domainId) {
    const byDomain = managers.findIndex((manager) => stringField(manager as unknown as Record<string, unknown>, ['domainId']) === domainId);
    if (byDomain >= 0) return managerNodeIds[byDomain] ?? null;
  }
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
  if (workflow.app) return workflow.app.name;
  return workflow.title ?? workflow.name ?? 'Untitled workflow';
}

/** An icon string is an image when it's a URL or data URI (vs an emoji/glyph). */
function isImageIcon(icon: string | null | undefined): boolean {
  return Boolean(icon && (icon.startsWith('http://') || icon.startsWith('https://') || icon.startsWith('data:image/')));
}

/**
 * Collapse Apps into single canvas resource units. Each App with ≥1 workflow
 * becomes one entry (labelled/routed as the App, clustered by the App's
 * domain/owner), anchored on a representative workflow — a currently-running one
 * if any, else the first — so run liveness still lights the node. Workflows with
 * no App (or whose App is missing) pass through as bare workflow nodes.
 */
function collapseAppsIntoResourceWorkflows(data: EcosystemData, activeWorkflowIds: Set<string>): HomeWorkflow[] {
  const appById = new Map((data.apps ?? []).map((app) => [app.id, app]));
  const byApp = new Map<string, HomeWorkflow[]>();
  const bare: HomeWorkflow[] = [];
  for (const workflow of data.workflows) {
    const appId = workflow.appId ?? null;
    if (appId && appById.has(appId)) {
      (byApp.get(appId) ?? byApp.set(appId, []).get(appId)!).push(workflow);
    } else {
      bare.push(workflow);
    }
  }
  const appUnits: HomeWorkflow[] = [];
  for (const [appId, workflows] of byApp) {
    const app = appById.get(appId)!;
    const representative = workflows.find((wf) => activeWorkflowIds.has(wf.id)) ?? workflows[0]!;
    appUnits.push({
      ...representative,
      // Inherit the App's org placement (workflows page assigns it on the App).
      spaceId: representative.spaceId ?? app.domainId ?? null,
      ownerAgentId: representative.ownerAgentId ?? app.ownerAgentId ?? null,
      app: { id: app.id, name: app.name, icon: app.icon ?? null, workflowCount: workflows.length },
    });
  }
  return [...appUnits, ...bare];
}

function activeRunSubtitle(run: WorkspaceActiveRun): string {
  if (run.stepIndex != null && run.totalSteps != null) return `running - step ${run.stepIndex}/${run.totalSteps}`;
  if (run.currentStep) return run.currentStep;
  return 'running now';
}


/**
 * Live Workspace run card: an immersive view of one running workflow —
 * pulsing live beacon, elapsed + step progress, the agent currently working, and a
 * scrolling LIVE REASONING TERMINAL streaming the agent's thoughts and tool calls
 * as they happen. Click to open the full run; Stop to halt it. Fed by the
 * socket-independent run activity stream.
 */
function LiveRunRow({ run, onOpen }: { run: WorkspaceActiveRun; onOpen: () => void }) {
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
      className="group cursor-pointer overflow-hidden rounded-xl border border-accent/25 bg-gradient-to-b from-surface/70 to-canvas/55 shadow-[0_0_22px_var(--color-accent-soft)] transition hover:border-accent/45 hover:shadow-[0_0_30px_var(--color-accent-muted)]"
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
          className="h-full bg-accent shadow-[0_0_8px_var(--color-accent-muted)] transition-all duration-700"
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



