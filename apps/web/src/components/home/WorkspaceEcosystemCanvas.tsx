import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
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
} from 'lucide-react';
import clsx from 'clsx';
import { api, workspace as workspaceStore } from '../../lib/api';
import { useRealtime } from '../../lib/realtime';
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
import { AgentLiveFeed } from './AgentLiveFeed';
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

type EntrancePhase = 'idle' | 'background' | 'orchestrator' | 'managers' | 'workers' | 'resources' | 'complete';

const EMPTY_DATA: EcosystemData = {
  workflows: [],
  knowledgeBases: [],
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
  orchestrator: { width: 292, height: 110 },
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
  const [isPanning, setIsPanning] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [entrancePhase, setEntrancePhase] = useState<EntrancePhase>('idle');
  const [createPreset, setCreatePreset] = useState<{ role: 'orchestrator' | 'manager' | 'worker'; flipFrom: FlipSnapshot | null; lock: boolean } | null>(null);
  const chatState = useChatPanelStore((state) => state.state);
  const dockedWidth = useChatPanelStore((state) => state.dockedWidth);

  const refresh = useCallback(async () => {
    setData((current) => ({ ...current, loading: true }));
    const [workflowsRes, knowledgeRes] = await Promise.allSettled([
      api<{ workflows: HomeWorkflow[] }>('/v1/workflows'),
      api<{ knowledgeBases: HomeKnowledgeBase[] }>('/v1/knowledge-bases'),
    ]);
    setData({
      workflows: workflowsRes.status === 'fulfilled' ? workflowsRes.value.workflows ?? [] : [],
      knowledgeBases: knowledgeRes.status === 'fulfilled' ? knowledgeRes.value.knowledgeBases ?? [] : [],
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
    () => buildCanvasModel(canvasData, agents, activeRuns, canvasArtifacts, approvals, failedRuns, virtualSize),
    [canvasData, agents, activeRuns, canvasArtifacts, approvals, failedRuns, virtualSize],
  );
  const contentBounds = useMemo(() => computeCanvasContentBounds(model.nodes), [model.nodes]);

  const selectedNode = useMemo(
    () => model.nodes.find((node) => node.id === selectedNodeId) ?? null,
    [model.nodes, selectedNodeId],
  );
  const hoveredNode = useMemo(
    () => model.nodes.find((node) => node.id === hoveredNodeId) ?? null,
    [model.nodes, hoveredNodeId],
  );
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
    if (initialCenteredRef.current && userMovedRef.current) return;
    if (containerSize.width <= 0 || model.nodes.length === 0) return;
    const next = computeHomeViewport(containerSize, contentBounds, chatState, dockedWidth);
    setViewport(next);
    initialCenteredRef.current = true;
  }, [chatState, containerSize, contentBounds, dockedWidth, model.nodes.length]);

  const orchestratorNode = model.orchestratorId
    ? model.nodes.find((node) => node.id === model.orchestratorId) ?? null
    : null;
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
    animateViewportTo(computeHomeViewport(containerSize, contentBounds, chatState, dockedWidth), 340);
  }, [chatState, containerSize, contentBounds, dockedWidth]);

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
      animateViewportTo(computeHomeViewport(containerSize, contentBounds, chatState, dockedWidth), 280);
    }, 80);
    return () => window.clearTimeout(timer);
  }, [isFullscreen, chatState, containerSize, contentBounds, dockedWidth]);

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
            const animation = computeEdgeAnimation(edge.activeRunCount, edge.type);
            const focused = !focusedNodeIds || (focusedNodeIds.has(edge.from) && focusedNodeIds.has(edge.to));
            const revealed = phaseReached(entrancePhase, edgeRevealPhase(edge, nodeMap));
            return (
              <g key={edge.id} className={clsx(focused ? undefined : 'opacity-[0.14]', !revealed && 'invisible')}>
                <path
                  className={clsx('home-edge-enter', edge.busy && edge.type === 'command' && 'home-command-edge-busy')}
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

      <AgentLiveFeed
        agents={agents}
        activeRuns={activeRuns}
        approvals={approvals}
        onRefresh={refresh}
        onSelectNode={setSelectedNodeId}
      />

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
        onClose={() => setTriageOpen(false)}
        onNavigate={(route) => {
          setTriageOpen(false);
          nav(route);
        }}
        onRefresh={refresh}
      />

      <CanvasHudBar
        counts={fleetCounts}
        connected={fleet?.gateways.connected ? fleet.gateways.connected > 0 : true}
        isFullscreen={isFullscreen}
        onOpenTriage={() => setTriageOpen(true)}
        onToggleFullscreen={() => void toggleFullscreen()}
        onResetView={resetViewport}
      />

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
): CanvasModel {
  const nodes: CanvasNode[] = [];
  const edges: CanvasEdge[] = [];
  const managerActiveWorkers = new Map<string, number>();
  const activeWorkflowIds = new Set(activeRuns.map((run) => run.workflowId));
  const availableAgentIds = new Set(agents.filter((agent) => isAvailableAgent(agent.status)).map((agent) => agent.id));
  const workingAgentIds = new Set(activeRuns.flatMap((run) => run.agents?.map((agent) => agent.id) ?? []));
  for (const agent of agents) if (isWorkingAgent(agent)) workingAgentIds.add(agent.id);

  const roles = classifyAgents(agents);
  const managerCount = Math.max(roles.managers.length, agents.length === 0 ? 2 : roles.workers.length > 0 && roles.managers.length === 0 ? 1 : 0);
  const workerCount = Math.max(roles.workers.length, agents.length === 0 ? 4 : roles.workers.length === 0 ? Math.max(2, roles.managers.length) : 0);
  const workerSize = computeWorkerNodeSize(workerCount);
  const workerColumns = computeWorkerColumns(workerCount);
  const workerRows = Math.max(1, Math.ceil(workerCount / Math.max(1, workerColumns)));
  const managerPositions = distributeRow(managerCount, canvasSize.width, 350, NODE.manager.width);
  const workerPositions = distributeLayer(workerCount, canvasSize.width, 530, workerSize.width, workerSize.height + 42, workerColumns);
  const resourceStartY = 530 + workerRows * (workerSize.height + 42) + 68;
  const availableCommandSourceIds = new Set<string>();

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
    if (availableAgentIds.has(agent.id)) availableCommandSourceIds.add(node.id);
    edges.push(commandEdge(orchestratorId, node.id, workingAgentIds.has(agent.id) && availableCommandSourceIds.has(orchestratorId)));
  });
  for (let index = roles.managers.length; index < managerCount; index += 1) {
    const id = `ghost-manager-${index}`;
    const pos = managerPositions[index] ?? { x: canvasSize.width / 2, y: 350 };
    nodes.push(ghostNode(id, 'manager', index === 0 ? 'Manager layer' : `Manager ${index + 1}`, 'assign a team or domain', pos, NODE.manager));
    managerNodeIds.push(id);
    edges.push(commandEdge(orchestratorId, id, false));
  }

  roles.workers.forEach((agent, index) => {
    const pos = workerPositions[index] ?? { x: canvasSize.width / 2, y: 530 };
    const node = agentNode(agent, 'worker', pos, workingAgentIds, approvals, activeRuns, workerSize);
    nodes.push(node);
    const parentId = findParentManager(agent, managerNodeIds, roles.managers, index) ?? orchestratorId;
    if (workingAgentIds.has(agent.id)) managerActiveWorkers.set(parentId, (managerActiveWorkers.get(parentId) ?? 0) + 1);
    edges.push(commandEdge(parentId, node.id, workingAgentIds.has(agent.id) && availableCommandSourceIds.has(parentId)));
  });
  for (let index = roles.workers.length; index < workerCount; index += 1) {
    const id = `ghost-worker-${index}`;
    const pos = workerPositions[index] ?? { x: canvasSize.width / 2, y: 530 };
    nodes.push(ghostNode(id, 'worker', `Worker ${index + 1}`, 'ready for a task agent', pos, workerSize));
    edges.push(commandEdge(managerNodeIds[index % Math.max(1, managerNodeIds.length)] ?? orchestratorId, id, false));
  }

  for (const edge of edges) {
    if (edge.type === 'command' && edge.from === orchestratorId && edge.active && (managerActiveWorkers.get(edge.to) ?? 0) >= 2) {
      edge.busy = true;
    }
  }

  const resourceNodes = buildResourceNodes(data, activeRuns, artifacts, approvals, failedRuns, canvasSize, activeWorkflowIds, resourceStartY);
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
  onClick: () => void;
  onOpen: () => void;
  onHover: () => void;
  onLeave: () => void;
}) {
  const elapsed = node.startedAt ? formatElapsed(node.startedAt, now) : null;
  const isAgentNode = node.kind === 'orchestrator' || node.kind === 'manager' || node.kind === 'worker';
  const isOperationalWarning = Boolean(node.outOfCredits || node.warn);
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
            : node.active
              ? 'border-accent/35 bg-accent-soft'
              : node.ghost
                ? 'border-dashed border-line bg-surface/45 text-text-muted'
                : 'border-line bg-surface/90 hover:border-line-strong hover:bg-surface',
        selected && 'ring-2 ring-violet-300/55',
        dimmed && 'opacity-[0.32] saturate-[0.6]',
      )}
      style={{ ...style, visibility: revealed ? 'visible' : 'hidden' }}
    >
      <div className={clsx('flex h-full items-center', compact ? 'gap-2' : 'gap-3')}>
        <span
          className={clsx(
            'relative flex shrink-0 items-center justify-center overflow-hidden rounded-card border',
            avatarClass,
            node.outOfCredits
              ? 'border-warn/50 bg-warn/10 text-warn shadow-[0_0_8px_rgba(245,158,11,0.2)]'
              : node.warn
                ? 'border-warn/35 bg-warn-soft text-warn'
                : node.active
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
                'absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full border border-canvas',
                node.online
                  ? 'bg-success shadow-[0_0_12px_rgba(74,222,128,0.75)]'
                  : 'bg-text-muted',
                node.active && 'animate-pulse-dot',
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
    </button>
  );
}

function CanvasTriagePanel({
  open,
  activeRuns,
  approvals,
  onClose,
  onNavigate,
  onRefresh,
}: {
  open: boolean;
  activeRuns: WorkspaceActiveRun[];
  approvals: WorkspaceApproval[];
  onClose: () => void;
  onNavigate: (route: string) => void;
  onRefresh: () => void;
}) {
  if (!open) return null;
  const hasLiveTriage = activeRuns.length > 0 || approvals.length > 0;

  async function resolveApproval(approval: WorkspaceApproval, decision: 'approve' | 'reject') {
    await api(`/v1/approvals/${approval.id}/resolve`, {
      method: 'POST',
      body: JSON.stringify({ decision }),
    }).catch(() => undefined);
    onRefresh();
  }

  return (
    <div data-canvas-control className="absolute bottom-20 right-4 z-50 w-[min(420px,calc(100%-2rem))] rounded-2xl border border-line bg-surface/96 shadow-2xl backdrop-blur-xl" role="dialog" aria-label="Workspace triage">
      <header className="flex items-start justify-between gap-3 border-b border-line px-4 py-3">
        <div>
          <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-text-muted">Workspace triage</div>
          <h2 className="mt-1 text-heading text-text-primary">Live action queue</h2>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close triage"
          className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-btn text-text-muted hover:bg-surface-2 hover:text-text-primary"
        >
          <X size={15} />
        </button>
      </header>

      <div className="max-h-[420px] overflow-y-auto px-4 py-4">
        {!hasLiveTriage && (
          <div className="rounded-card border border-line bg-canvas/45 px-4 py-5 text-center">
            <CheckCircle2 size={28} className="mx-auto text-accent" />
            <div className="mt-3 text-subheading text-text-primary">Nothing needs live triage.</div>
            <p className="mt-1 text-[12px] leading-relaxed text-text-secondary">
              No runs are executing and there are no pending approvals. Failed runs and viewed alerts stay in Notifications.
            </p>
          </div>
        )}

        {activeRuns.length > 0 && (
          <section className="space-y-2">
            <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wide text-text-muted">
              <Clock size={13} />
              Running now
            </div>
            {activeRuns.map((run) => (
              <button
                key={run.id}
                type="button"
                onClick={() => onNavigate(`/runs/${run.id}`)}
                className="block w-full rounded-card border border-line bg-canvas/45 px-3 py-2 text-left hover:border-line-strong hover:bg-surface-2"
              >
                <div className="truncate text-[13px] font-medium text-text-primary">{run.workflowName}</div>
                <div className="mt-0.5 truncate text-[11px] text-text-muted">{activeRunSubtitle(run)}</div>
              </button>
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
      </div>
    </div>
  );
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
    1180,
    managerCount * (NODE.manager.width + 62) + 320,
    Math.min(workerCount, workerColumns) * (workerSize.width + 48) + 320,
    Math.min(resources, 8) * 220 + 260,
  );
  const resourceRows = Math.max(1, Math.ceil(Math.max(resources, 4) / Math.max(4, Math.floor(width / 220))));
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

function computeViewportInsets(containerSize: VirtualCanvasSize, chatState: ChatPanelState = 'hidden', dockedWidth = 0): CanvasInsets {
  const baseSideInset = clamp(containerSize.width * 0.035, 24, 52);
  const dockedChatInset = chatState === 'docked'
    ? Math.min(containerSize.width * 0.44, dockedWidth + 32)
    : 0;
  return {
    top: clamp(containerSize.height * (chatState === 'docked' ? 0.14 : 0.16), 96, 138),
    right: baseSideInset + dockedChatInset,
    bottom: clamp(containerSize.height * 0.14, 96, 126),
    left: baseSideInset,
  };
}

function computeHomeViewport(containerSize: VirtualCanvasSize, bounds: CanvasBounds, chatState: ChatPanelState = 'hidden', dockedWidth = 0): CanvasViewport {
  const insets = computeViewportInsets(containerSize, chatState, dockedWidth);
  const safeWidth = Math.max(1, containerSize.width - insets.left - insets.right);
  const safeHeight = Math.max(1, containerSize.height - insets.top - insets.bottom);
  const zoom = clamp(Math.min(safeWidth / bounds.width, safeHeight / bounds.height, 1) * 0.98, VIEWPORT_MIN, 1);
  return {
    zoom,
    pan: {
      x: insets.left + (safeWidth - bounds.width * zoom) / 2 - bounds.left * zoom,
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
    subtitle: role === 'orchestrator' ? `orchestrator - ${status}` : role === 'manager' ? `manager - ${status}` : `worker - ${status}`,
    x: pos.x,
    y: pos.y,
    width: size.width,
    height: size.height,
    role,
    active,
    online,
    warn: Boolean(approval) || agent.status === 'error' || agent.status === 'offline' || outOfCredits,
    outOfCredits,
    status: agent.status,
    operationalState,
    route: `/agents/${agent.id}`,
    accent: stringField(record, ['colorHex', 'accentColor']) ?? (role === 'orchestrator' ? '#a78bfa' : undefined),
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
): CanvasNode[] {
  const resources: CanvasNode[] = [];
  const workflowPositions = new Map<string, Vec2>();
  const workflowArtifactIndex = new Map<string, number>();
  const artifactCountsByWorkflow = countArtifactsByWorkflow(artifacts);
  const columns = Math.max(3, Math.floor(canvasSize.width / 240));
  const positions = (index: number): Vec2 => {
    const col = index % columns;
    const row = Math.floor(index / columns);
    const margin = 120;
    const available = canvasSize.width - margin * 2;
    const x = columns === 1 ? canvasSize.width / 2 : margin + (available * col) / Math.max(1, columns - 1);
    return { x, y: resourceStartY + row * 104 };
  };

  let index = 0;
  for (const workflow of [...data.workflows].sort((a, b) => workflowLabel(a).localeCompare(workflowLabel(b)))) {
    const run = activeRuns.find((item) => item.workflowId === workflow.id);
    const wfLabel = workflowLabel(workflow);
    const pos = positions(index++);
    const failed = failedRuns.find((item) => item.workflowName === wfLabel);
    let connectedAgentIds = run?.agents?.map((agent) => `agent-${agent.id}`);
    if ((!connectedAgentIds || connectedAgentIds.length === 0) && run && workflow?.graph?.nodes) {
      const workflowAgentIds = workflow.graph.nodes
        .filter((node: any) => node.config?.kind === 'agent_task' && node.config?.agentId)
        .map((node: any) => `agent-${node.config.agentId}`);
      connectedAgentIds = workflowAgentIds;
    }
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
      active: Boolean(run) || activeWorkflowIds.has(workflow.id),
      warn: Boolean(failed),
      route: `/workflows/${workflow.id}`,
      imageUrl: workflowImageUrl(workflow),
      icon: <Workflow size={17} />,
      progress: runProgress(run),
      startedAt: run?.startedAt,
      artifactCount: artifactCountsByWorkflow.get(workflow.id) ?? 0,
      tooltipLines: compactStrings([
        `Status: ${run ? activeRunSubtitle(run) : statusLabel(workflow.status, 'idle')}`,
        run?.currentStep ? `Step: ${run.currentStep}` : undefined,
        failed?.failedNode ? `Failed at: ${failed.failedNode}` : undefined,
      ]),
      workflow,
      connectedAgentIds,
    });
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
      active: false,
      route: '/artifacts',
      imageUrl: artifactImageUrl(artifact),
      icon: artifact.kind === 'data' || artifact.type === 'data' ? <Database size={17} /> : artifact.kind === 'code' || artifact.type === 'code' ? <Boxes size={17} /> : <Layers size={17} />,
      tooltipLines: compactStrings([
        `Type: ${artifact.kind ?? artifact.type ?? 'artifact'}`,
        artifact.agent ? `Agent: ${artifact.agent}` : undefined,
        artifact.workflowId ? `Workflow: ${artifact.workflowId}` : undefined,
      ]),
      artifact,
      connectedAgentIds: artifact.agentId ? [`agent-${artifact.agentId}`] : undefined,
    });
  }

  for (const approval of approvals) {
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
      active: false,
      warn: true,
      route: '/history?tab=runs',
      icon: <CanvasApprovalNodeBadge />,
      tooltipLines: compactStrings([approval.summary, approval.runId ? `Run: ${approval.runId}` : undefined]),
      approval,
    });
  }

  if (resources.length === 0) {
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
  return Boolean(agent && normalizeRole(agent) === 'orchestrator');
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
  return candidates.find((id) => byId.get(id)?.kind === 'manager')
    ?? candidates.find((id) => byId.get(id)?.kind === 'worker')
    ?? candidates.find((id) => byId.get(id)?.kind === 'orchestrator')
    ?? candidates[0]
    ?? null;
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
