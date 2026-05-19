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
  ArrowLeft, Undo2, Redo2, Play, Upload, Map as MapIcon, MapPinOff,
  ChevronDown, X, Variable, Trash2, Webhook, Clock as ClockIcon, Copy,
  BookOpen, ExternalLink,
} from 'lucide-react';
import clsx from 'clsx';
import { api, workspace as workspaceStore } from '../lib/api';
import { rtSubscribe, useRealtime, type RealtimeEnvelope } from '../lib/realtime';
import { NodePalette } from '../components/canvas/NodePalette';
import { ContextInspector, type InspectorSelection } from '../components/canvas/ContextInspector';
import { RunDrawer } from '../components/canvas/RunDrawer';
import { CanvasEngine } from '../components/canvas/CanvasEngine';
import { AgentFocusOverlayManager } from '../components/canvas/AgentFocusOverlayManager';
import { Typewriter } from '../components/shared/Typewriter';
import { Button } from '../components/shared/Button';
import { SegmentedControl } from '../components/shared/SegmentedControl';
import { useToast } from '../components/shared/Toast';
import { useConfirm } from '../components/shared/ConfirmDialog';
import { WorkflowRunsTab } from '../components/workflows/WorkflowRunsTab';
import { WorkflowOutputTab } from '../components/workflows/WorkflowOutputTab';

interface WorkflowDetail {
  id: string;
  title: string;
  summary: string | null;
  intendedBehavior?: string | null;
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
  appId?: string | null;
}

interface AppOutputOwner {
  id: string;
  slug: string;
  name: string;
}

interface SkillRow { id: string; slug: string; name: string; runtime: string; }

const NODE_GLYPH: Record<string, string> = {
  trigger: '◉', skill_task: '✦', agent_task: '◎', router: '⤳',
  merge: '⟴', checkpoint: '✓', subflow: '⊞', scratchpad: '◈', knowledge: '◇',
};

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
  const [skills, setSkills] = useState<SkillRow[]>([]);
  const [titleDraft, setTitleDraft] = useState('');
  const [titleEditing, setTitleEditing] = useState(false);

  const [running, setRunning] = useState(false);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [runDialogOpen, setRunDialogOpen] = useState(false);
  const [publishOpen, setPublishOpen] = useState(false);
  const [variablesOpen, setVariablesOpen] = useState(false);
  const [intentOpen, setIntentOpen] = useState(false);
  const [intentDraft, setIntentDraft] = useState('');
  const [savingIntent, setSavingIntent] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>('saved');
  const [knowledgeBaseCount, setKnowledgeBaseCount] = useState<number | null>(null);
  const [showMinimap, setShowMinimap] = useState<boolean>(() => {
    try { return localStorage.getItem(MINIMAP_KEY) === '1'; } catch { return false; }
  });

  const [selection, setSelection] = useState<InspectorSelection>({ kind: null });
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; nodeId: string } | null>(null);
  const overlayHostRef = useRef<HTMLDivElement | null>(null);
  const overlayManagerRef = useRef<AgentFocusOverlayManager | null>(null);
  const saveTimerRef = useRef<number | null>(null);
  const syncFrameRef = useRef<number | null>(null);
  const lastSavedFingerprintRef = useRef<string | null>(null);

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
      setIntentDraft(d.workflow.intendedBehavior ?? '');
      lastSavedFingerprintRef.current = graphFingerprint(d.workflow.graph, d.workflow.title);
    });
    void api<{ skills: SkillRow[] }>('/v1/skills').then((d) => setSkills(d.skills));
    void api<{ knowledgeBases: Array<{ id: string }> }>('/v1/knowledge-bases').then((d) => setKnowledgeBaseCount(d.knowledgeBases?.length ?? 0)).catch(() => setKnowledgeBaseCount(0));
  }, [id]);

  const hasKnowledgeNode = useMemo(() => wf?.graph.nodes.some((n) => n.config.kind === 'knowledge' || n.type === 'knowledge') ?? false, [wf]);

  // Keep the workspace room subscription alive while editing so run
  // lifecycle events reach the Runs/Output tabs and drive the post-run
  // hand-off (live drawer → Output tab) without a page navigation.
  useEffect(() => {
    const ws = workspaceStore.get();
    if (!ws) return;
    return rtSubscribe('workspace', { workspaceId: ws });
  }, []);

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
    setTab('output');
  });

  useEffect(() => {
    try { localStorage.setItem(MINIMAP_KEY, showMinimap ? '1' : '0'); } catch { /* ignore */ }
  }, [showMinimap]);

  // Auto-bind unbound echo skill template (preserved from original)
  useEffect(() => {
    if (!wf) return;
    const echo = skills.find((s) => s.slug === 'echo');
    if (!echo) return;
    let changed = false;
    const nextNodes = wf.graph.nodes.map((n) => {
      if (n.config.kind === 'skill_task' && n.config.skillId === 'BIND_AT_RUNTIME') {
        changed = true;
        return { ...n, config: { ...n.config, skillId: echo.id } };
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
  }, [wf, skills]);

  // React Flow owns the node/edge state so it can manage selection,
  // dragging, and multi-select internally. We sync changes back to
  // wf.graph (for saves) inside the change handlers.
  const [flowNodes, setFlowNodes, onFlowNodesChange] = useNodesState<Node>([]);
  const [flowEdges, setFlowEdges, onFlowEdgesChange] = useEdgesState<Edge>([]);

  // Hydrate RF state once when the workflow loads (and on workflow ID change).
  // We compare by ID to avoid clobbering local edits on re-renders.
  const hydratedIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (!wf) return;
    if (hydratedIdRef.current === wf.id) return;
    hydratedIdRef.current = wf.id;
    setFlowNodes(
      wf.graph.nodes.map((n) => ({
        id: n.id,
        type: 'agentis',
        position: n.position,
        data: { label: n.title, kind: (n.config as { kind?: string }).kind ?? n.type, type: n.type },
      })),
    );
    setFlowEdges(
      wf.graph.edges.map((e) => ({ id: e.id, source: e.source, target: e.target, animated: false })),
    );
  }, [wf, setFlowNodes, setFlowEdges]);

  // Auto-save: debounce 1.2s for snappy feedback, save on unmount.
  // Use a ref-based latest reference so debounced callbacks don't capture
  // stale `wf` state during rapid drags.
  const wfRef = useRef<WorkflowDetail | null>(null);
  useEffect(() => { wfRef.current = wf; }, [wf]);

  const saveNow = useCallback(async (graph?: WorkflowDetail['graph'], title?: string) => {
    const current = wfRef.current;
    if (!current) return;
    const nextGraph = graph ?? current.graph;
    const nextTitle = title ?? current.title;
    const fingerprint = graphFingerprint(nextGraph, nextTitle);
    if (fingerprint === lastSavedFingerprintRef.current) {
      setSaveState('saved');
      return;
    }
    setSaveState('saving');
    try {
      await api(`/v1/workflows/${current.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          graph: nextGraph,
          title: nextTitle,
        }),
      });
      lastSavedFingerprintRef.current = fingerprint;
      setSaveState('saved');
    } catch (e) {
      setSaveState('error');
      // Show actual error to operator instead of swallowing
      const msg = (e as { message?: string })?.message ?? String(e);
      toast.error('Auto-save failed', msg);
    }
  }, [toast]);

  const queueSave = useCallback(() => {
    setSaveState('dirty');
    if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
    saveTimerRef.current = window.setTimeout(() => { void saveNow(); }, 1200);
  }, [saveNow]);

  // Sync flow state → wf.graph and persist. Called after each meaningful
  // mutation (drag-end, delete, connect, etc.).
  const syncAndSave = useCallback(() => {
    setWf((prev) => {
      if (!prev) return prev;
      const byId = new Map(prev.graph.nodes.map((n) => [n.id, n] as const));
      const nextNodes: WorkflowDetail['graph']['nodes'] = flowNodes.map((fn) => {
        const orig = byId.get(fn.id);
        if (orig) {
          return { ...orig, position: fn.position };
        }
        // New node added by drop — it should already exist in prev.graph from
        // the drop handler, but as a safety net synthesize a minimal node.
        const data = (fn.data ?? {}) as { type?: string; kind?: string };
        return {
          id: fn.id,
          type: data.type ?? 'task',
          title: (data as { label?: string }).label ?? fn.id,
          position: fn.position,
          config: { kind: data.kind ?? data.type ?? 'task' },
        };
      });
      const nextEdges = flowEdges.map((fe) => ({ id: fe.id, source: fe.source, target: fe.target }));
      return { ...prev, graph: { ...prev.graph, nodes: nextNodes, edges: nextEdges } };
    });
    queueSave();
  }, [flowNodes, flowEdges, queueSave]);

  const queueSyncAndSave = useCallback(() => {
    if (syncFrameRef.current !== null) window.cancelAnimationFrame(syncFrameRef.current);
    syncFrameRef.current = window.requestAnimationFrame(() => {
      syncFrameRef.current = null;
      syncAndSave();
    });
  }, [syncAndSave]);

  const handleConnect = useCallback((conn: Connection) => {
    if (!conn.source || !conn.target) return;
    setFlowEdges((eds) => {
      const exists = eds.some((e) => e.source === conn.source && e.target === conn.target);
      if (exists) return eds;
      const id = `e-${conn.source}-${conn.target}-${Date.now().toString(36)}`;
      return [...eds, { id, source: conn.source!, target: conn.target!, animated: false }];
    });
    queueSyncAndSave();
  }, [setFlowEdges, queueSyncAndSave]);

  const deleteNodeById = useCallback((nodeId: string) => {
    setFlowNodes((nds) => nds.filter((n) => n.id !== nodeId));
    setFlowEdges((eds) => eds.filter((e) => e.source !== nodeId && e.target !== nodeId));
    setSelection({ kind: null });
    setContextMenu(null);
    queueSyncAndSave();
  }, [setFlowNodes, setFlowEdges, queueSyncAndSave]);

  const duplicateNode = useCallback((nodeId: string) => {
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
    queueSyncAndSave();
  }, [setFlowNodes, queueSyncAndSave]);

  // Close context menu on global click/escape
  useEffect(() => {
    if (!contextMenu) return;
    const onClick = () => setContextMenu(null);
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setContextMenu(null); };
    window.addEventListener('click', onClick);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('click', onClick);
      window.removeEventListener('keydown', onKey);
    };
  }, [contextMenu]);

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

  // Save on unmount if dirty
  useEffect(() => () => {
    if (syncFrameRef.current !== null) window.cancelAnimationFrame(syncFrameRef.current);
    if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
    if (saveState === 'dirty' && wf) {
      void saveNow();
    }
  }, [saveState, saveNow, wf]);

  async function commitTitle() {
    if (!wf || titleDraft.trim() === wf.title) { setTitleEditing(false); return; }
    const next = titleDraft.trim() || wf.title;
    setWf({ ...wf, title: next });
    setTitleEditing(false);
    await saveNow(undefined, next);
  }

  async function saveIntent() {
    if (!wf) return;
    setSavingIntent(true);
    try {
      const nextIntent = intentDraft.trim();
      await api(`/v1/workflows/${wf.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ intendedBehavior: nextIntent || null }),
      });
      setWf({ ...wf, intendedBehavior: nextIntent || null });
      setIntentOpen(false);
      toast.success('Intent saved');
    } catch (error) {
      toast.error('Failed to save intent', String(error));
    } finally {
      setSavingIntent(false);
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
      toast.error('Failed to start run', String(e));
    } finally {
      setRunning(false);
    }
  }

  async function handlePublish(target: 'schedule' | 'webhook' | 'library' | 'reusable') {
    if (!wf) return;
    setPublishOpen(false);
    if (target === 'library' || target === 'reusable') {
      const ok = await confirm({
        title: target === 'library' ? 'Save to library?' : 'Mark as reusable node?',
        body: target === 'library'
          ? 'Saving to library makes this workflow available as a starting template for new workflows.'
          : 'Reusable workflows can be embedded as subflows in other workflows.',
        confirmLabel: target === 'library' ? 'Save to library' : 'Mark as reusable',
      });
      if (!ok) return;
    }
    try {
      await api(`/v1/workflows/${wf.id}/publish`, {
        method: 'POST',
        body: JSON.stringify({ target }),
      });
      toast.success(target === 'schedule' ? 'Deployed to schedule' : target === 'webhook' ? 'Deployed as webhook' : target === 'library' ? 'Saved to library' : 'Marked as reusable');
    } catch (e) { toast.error('Publish failed', String(e)); }
  }

  if (!wf) return <div className="p-6 text-[13px] text-text-muted">Loading workflow…</div>;

  return (
    <div className="flex h-full flex-col">
      {/* Toolbar */}
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line bg-surface px-4 py-3">
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
              if (e.key === 'Escape') { setTitleDraft(wf.title); setTitleEditing(false); }
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

        <div className="ml-auto flex max-w-full flex-wrap items-center justify-end gap-1.5">
          <div className="max-w-full overflow-x-auto pb-1">
            <SegmentedControl
              segments={WORKFLOW_TAB_SEGMENTS}
              value={tab}
              onChange={setTab}
              size="sm"
              className="whitespace-nowrap"
            />
          </div>
          <Button variant="ghost" size="sm" aria-label="Undo" disabled><Undo2 size={12} /></Button>
          <Button variant="ghost" size="sm" aria-label="Redo" disabled><Redo2 size={12} /></Button>
          <div className="mx-1 h-4 w-px bg-line" />
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
          <Button variant="secondary" size="sm" iconLeft={<Variable size={12} />} onClick={() => setVariablesOpen(true)}>
            Inputs
          </Button>
          <Button variant="secondary" size="sm" iconLeft={<BookOpen size={12} />} onClick={() => { setIntentDraft(wf.intendedBehavior ?? ''); setIntentOpen(true); }}>
            Intent
          </Button>
          <Button variant="secondary" size="sm" iconLeft={<Play size={12} />} onClick={() => setRunDialogOpen(true)} disabled={running}>
            Test run
          </Button>
          <div className="relative">
            <button
              type="button"
              onClick={() => setPublishOpen((v) => !v)}
              className="inline-flex h-9 items-center gap-1.5 rounded-btn bg-accent px-3 text-[13px] font-semibold text-canvas hover:bg-accent-hover"
            >
              <Upload size={12} /> Publish <ChevronDown size={12} />
            </button>
            {publishOpen && (
              <div className="absolute right-0 z-40 mt-1.5 w-64 rounded-card border border-line bg-surface shadow-dropdown">
                <PublishOption icon={<ClockIcon size={14} />} title="Deploy to schedule" desc="Run on a cron schedule" onClick={() => void handlePublish('schedule')} />
                <PublishOption icon={<Webhook size={14} />} title="Deploy as webhook" desc="Run when called via HTTP" onClick={() => void handlePublish('webhook')} />
                <div className="my-1 border-t border-line" />
                <PublishOption icon={<Upload size={14} />} title="Save to library" desc="Use as a starting template" onClick={() => void handlePublish('library')} />
                <PublishOption icon={<Upload size={14} />} title="Mark as reusable" desc="Embed in other workflows" onClick={() => void handlePublish('reusable')} />
              </div>
            )}
          </div>
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
            nodeTypes={{ agentis: AgentisNode }}
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
                  data: { label, kind: nodeType, type: nodeType, ...extra },
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
              });
            }}
            onNodeContextMenu={(e, n) => {
              e.preventDefault();
              e.stopPropagation();
              setContextMenu({ x: e.clientX, y: e.clientY, nodeId: n.id });
            }}
            onNodeDragStop={() => syncAndSave()}
            onNodesDelete={queueSyncAndSave}
            onEdgesDelete={queueSyncAndSave}
            onPaneClick={() => { setSelection({ kind: null }); setContextMenu(null); }}
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
            backgroundColor="#1c2028"
          />
          {hasKnowledgeNode && knowledgeBaseCount === 0 && <KnowledgeCanvasCallout onOpen={() => nav('/knowledge')} />}
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
        <ContextInspector
          selection={selection}
          onClose={() => setSelection({ kind: null })}
          onSave={(data) => {
            if (!wf || !selection.nodeId) return;
            const nextNodes = wf.graph.nodes.map((n) =>
              n.id === selection.nodeId ? { ...n, config: { ...n.config, ...data } } : n,
            );
            const nextGraph = { ...wf.graph, nodes: nextNodes };
            setWf({ ...wf, graph: nextGraph });
            setSelection((s) => ({ ...s, data }));
            void saveNow(nextGraph);
          }}
        />
      </div>

      {tab === 'runs' && (
        <div className="flex min-h-0 flex-1 flex-col overflow-auto">
          <WorkflowRunsTab workflowId={wf.id} onRun={() => setRunDialogOpen(true)} />
        </div>
      )}
      {tab === 'output' && (
        <div className="flex min-h-0 flex-1 flex-col overflow-auto">
          {wf.appId ? (
            <WorkflowAppOutputRedirect appId={wf.appId} />
          ) : (
            <WorkflowOutputTab workflowId={wf.id} onRun={() => setRunDialogOpen(true)} />
          )}
        </div>
      )}

      <RunInputDialog
        open={runDialogOpen}
        onClose={() => setRunDialogOpen(false)}
        variables={wf.variables ?? []}
        onRun={(inputs) => void runWorkflow(inputs)}
        running={running}
      />

      <WorkflowIntentDialog
        open={intentOpen}
        value={intentDraft}
        saving={savingIntent}
        onChange={setIntentDraft}
        onClose={() => setIntentOpen(false)}
        onSave={() => void saveIntent()}
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
          } catch (e) { toast.error('Failed to save inputs', String(e)); }
        }}
      />
    </div>
  );
}

function WorkflowAppOutputRedirect({ appId }: { appId: string }) {
  const [app, setApp] = useState<AppOutputOwner | null>(null);

  useEffect(() => {
    let cancelled = false;
    void api<{ app: AppOutputOwner }>(`/v1/apps/${appId}`)
      .then((data) => {
        if (!cancelled) setApp(data.app);
      })
      .catch(() => {
        if (!cancelled) setApp(null);
      });
    return () => {
      cancelled = true;
    };
  }, [appId]);

  const appName = app?.name ?? 'its app';
  const appPath = `/apps/${app?.slug ?? appId}?layer=output`;

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-1 items-center px-6 py-10">
      <div className="w-full rounded-card border border-line bg-surface p-6 shadow-sm">
        <div className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-text-muted">
          Output surface transferred
        </div>
        <h2 className="text-[18px] font-semibold text-text-primary">
          This workflow is part of {appName}
        </h2>
        <p className="mt-2 max-w-2xl text-[13px] leading-relaxed text-text-secondary">
          App-connected workflows defer their output surface to the app, so operators see one canonical place for results, history, and generated artifacts.
        </p>
        <Link
          to={appPath}
          className="mt-4 inline-flex h-9 items-center gap-1.5 rounded-btn bg-accent px-3 text-[13px] font-semibold text-canvas hover:bg-accent-hover"
        >
          View outputs in {appName}
          <ExternalLink size={12} />
        </Link>
      </div>
    </div>
  );
}

function SaveIndicator({ state }: { state: SaveState }) {
  if (state === 'saved') return <span className="text-[11px] text-text-muted">Saved ·</span>;
  if (state === 'saving') return <span className="text-[11px] text-text-muted">Saving…</span>;
  if (state === 'dirty') return <span className="inline-flex items-center gap-1 text-[11px] text-warn"><span className="h-1.5 w-1.5 rounded-full bg-warn" /> Unsaved</span>;
  return <span className="inline-flex items-center gap-1 text-[11px] text-danger"><span className="h-1.5 w-1.5 rounded-full bg-danger" /> Save failed</span>;
}

function graphFingerprint(graph: WorkflowDetail['graph'], title: string): string {
  return JSON.stringify({ title, graph });
}

function PublishOption({ icon, title, desc, onClick }: { icon: React.ReactNode; title: string; desc: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-start gap-2.5 px-3 py-2.5 text-left transition-colors hover:bg-surface-2"
    >
      <span className="mt-0.5 shrink-0 text-text-muted">{icon}</span>
      <div className="min-w-0">
        <div className="text-[13px] font-medium text-text-primary">{title}</div>
        <div className="text-[11px] text-text-muted">{desc}</div>
      </div>
    </button>
  );
}

function RunInputDialog({
  open, onClose, variables, onRun, running,
}: {
  open: boolean; onClose: () => void;
  variables: Array<{ name: string; type: string; default?: unknown; label?: string }>;
  onRun: (inputs: Record<string, unknown>) => void;
  running: boolean;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  useEffect(() => {
    if (open) {
      const init: Record<string, string> = {};
      variables.forEach((v) => { init[v.name] = v.default != null ? String(v.default) : ''; });
      setValues(init);
    }
  }, [open, variables]);

  if (!open) return null;
  return (
    <div className="animate-fade-in fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4" role="dialog" aria-modal="true">
      <form
        onSubmit={(e) => { e.preventDefault(); onRun(values); }}
        className="animate-scale-in w-full max-w-md rounded-modal border border-line bg-surface shadow-modal"
      >
        <header className="flex items-center justify-between border-b border-line px-5 py-4">
          <h3 className="text-heading text-text-primary">Run this workflow</h3>
          <button type="button" onClick={onClose} aria-label="Close" className="-m-1 rounded-md p-1 text-text-muted hover:bg-surface-2 hover:text-text-primary">
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
              <p className="text-[13px] text-text-secondary">Fill in the inputs below to run this workflow.</p>
              {variables.map((v) => {
                const displayLabel = (v.label && v.label.trim()) ? v.label : humanizeInputName(v.name);
                return (
                  <div key={v.name} className="space-y-1.5">
                    <label className="text-[12px] font-medium text-text-secondary">
                      {displayLabel}
                    </label>
                    <input
                      type="text"
                      value={values[v.name] ?? ''}
                      onChange={(e) => setValues((s) => ({ ...s, [v.name]: e.target.value }))}
                      placeholder={v.default != null ? String(v.default) : `Enter ${displayLabel.toLowerCase()}…`}
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
          >Cancel</button>
          <button
            type="submit"
            disabled={running}
            className="inline-flex h-9 items-center gap-1.5 rounded-btn bg-accent px-3 text-[13px] font-semibold text-canvas hover:bg-accent-hover disabled:opacity-60"
          >{running ? 'Starting…' : 'Run'}</button>
        </footer>
      </form>
    </div>
  );
}

function WorkflowIntentDialog({
  open,
  value,
  saving,
  onChange,
  onClose,
  onSave,
}: {
  open: boolean;
  value: string;
  saving: boolean;
  onChange: (value: string) => void;
  onClose: () => void;
  onSave: () => void;
}) {
  if (!open) return null;
  return (
    <div className="animate-fade-in fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4" role="dialog" aria-modal="true">
      <div className="animate-scale-in w-full max-w-xl rounded-modal border border-line bg-surface shadow-modal">
        <header className="flex items-center justify-between border-b border-line px-5 py-4">
          <h3 className="text-heading text-text-primary">Workflow intent</h3>
          <button type="button" onClick={onClose} aria-label="Close" className="-m-1 rounded-md p-1 text-text-muted hover:bg-surface-2 hover:text-text-primary">
            <X size={16} />
          </button>
        </header>
        <div className="px-5 py-5">
          <label className="text-[12px] font-medium text-text-secondary">Intended behavior</label>
          <textarea
            value={value}
            onChange={(event) => onChange(event.target.value)}
            rows={10}
            className="mt-1.5 min-h-[220px] w-full resize-y rounded-input border border-line bg-surface-2 px-3 py-2.5 text-[13px] leading-relaxed text-text-primary focus:border-accent focus:outline-none"
          />
        </div>
        <footer className="flex items-center justify-end gap-2 border-t border-line bg-surface-2 px-5 py-3">
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-9 items-center justify-center rounded-btn border border-line bg-transparent px-3 text-[13px] font-medium text-text-secondary hover:bg-surface-3 hover:text-text-primary"
          >Cancel</button>
          <button
            type="button"
            onClick={onSave}
            disabled={saving}
            className="inline-flex h-9 items-center gap-1.5 rounded-btn bg-accent px-3 text-[13px] font-semibold text-canvas hover:bg-accent-hover disabled:opacity-60"
          >{saving ? 'Saving...' : 'Save intent'}</button>
        </footer>
      </div>
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
  open, onClose, wf, onSave,
}: {
  open: boolean; onClose: () => void; wf: WorkflowDetail;
  onSave: (vars: Array<{ name: string; type: string; default?: unknown; label?: string }>) => Promise<void>;
}) {
  const [vars, setVars] = useState<Array<{ name: string; type: string; default?: string; label?: string }>>(
    wf.variables?.map((v) => ({ ...v, default: v.default == null ? '' : String(v.default) })) ?? [],
  );

  useEffect(() => {
    if (open) {
      setVars(wf.variables?.map((v) => ({ ...v, default: v.default == null ? '' : String(v.default) })) ?? []);
    }
  }, [open, wf.variables]);

  if (!open) return null;
  return (
    <div className="animate-fade-in fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4" role="dialog" aria-modal="true">
      <div className="animate-scale-in w-full max-w-2xl rounded-modal border border-line bg-surface shadow-modal">
        <header className="flex items-center justify-between border-b border-line px-5 py-4">
          <div>
            <h3 className="text-heading text-text-primary">Inputs</h3>
            <p className="mt-0.5 text-[12px] text-text-muted">Things this workflow asks for when it runs. Give each one a clear label so the run prompt makes sense.</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="-m-1 rounded-md p-1 text-text-muted hover:bg-surface-2 hover:text-text-primary">
            <X size={16} />
          </button>
        </header>
        <div className="space-y-3 px-5 py-5">
          {vars.length === 0 ? (
            <p className="text-[13px] text-text-muted">No inputs yet. Add one if your workflow needs information when it runs (like a company name or a URL).</p>
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
                    type="text" value={v.label ?? ''}
                    onChange={(e) => setVars((arr) => arr.map((x, idx) => idx === i ? { ...x, label: e.target.value } : x))}
                    placeholder="e.g. Company name"
                    className="h-9 rounded-input border border-line bg-surface-2 px-3 text-[13px] text-text-primary focus:border-accent focus:outline-none"
                  />
                  <input
                    type="text" value={v.name}
                    onChange={(e) => setVars((arr) => arr.map((x, idx) => idx === i ? { ...x, name: e.target.value } : x))}
                    placeholder="variable_name"
                    className="h-9 rounded-input border border-line bg-surface-2 px-3 font-mono text-[12px] text-text-secondary focus:border-accent focus:outline-none"
                  />
                  <select
                    value={v.type}
                    onChange={(e) => setVars((arr) => arr.map((x, idx) => idx === i ? { ...x, type: e.target.value } : x))}
                    className="h-9 rounded-input border border-line bg-surface-2 px-2 text-[13px] text-text-primary focus:border-accent focus:outline-none"
                  >
                    <option value="string">Text</option>
                    <option value="number">Number</option>
                    <option value="boolean">Yes/No</option>
                    <option value="json">JSON</option>
                  </select>
                  <input
                    type="text" value={v.default ?? ''}
                    onChange={(e) => setVars((arr) => arr.map((x, idx) => idx === i ? { ...x, default: e.target.value } : x))}
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
            onClick={() => setVars((arr) => [...arr, { name: '', type: 'string', default: '', label: '' }])}
            className="inline-flex h-8 items-center gap-1.5 rounded-btn border border-line bg-surface-2 px-2.5 text-[12px] font-medium text-text-secondary hover:bg-surface-3 hover:text-text-primary"
          >+ Add input</button>
        </div>
        <footer className="flex items-center justify-end gap-2 border-t border-line bg-surface-2 px-5 py-3">
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-9 items-center rounded-btn border border-line bg-transparent px-3 text-[13px] font-medium text-text-secondary hover:bg-surface-3 hover:text-text-primary"
          >Cancel</button>
          <button
            type="button"
            onClick={() => void onSave(vars.filter((v) => v.name.trim()))}
            className="inline-flex h-9 items-center rounded-btn bg-accent px-3 text-[13px] font-semibold text-canvas hover:bg-accent-hover"
          >Save</button>
        </footer>
      </div>
    </div>
  );
}

function AgentisNode({ data }: { data: { label: string; kind: string; type: string; toolPreview?: string } }) {
  const glyph = NODE_GLYPH[data.kind] ?? '•';
  const isTrigger = data.kind === 'trigger';
  return (
    <div
      className={clsx(
        'relative flex min-w-[160px] flex-col gap-1 rounded-node border bg-surface-2 px-3 py-2 shadow-card',
        isTrigger ? 'border-accent/60 shadow-glow' : 'border-line',
      )}
    >
      {!isTrigger && (
        <Handle type="target" position={Position.Left} className="!h-2 !w-2 !border-line !bg-surface" />
      )}
      <Handle type="source" position={Position.Right} className="!h-2 !w-2 !border-line !bg-surface" />
      <div className="flex items-center gap-2">
        <span
          className={clsx(
            'flex h-7 w-7 items-center justify-center rounded-md text-sm',
            isTrigger ? 'bg-accent-soft text-accent' : 'bg-surface text-text-muted',
          )}
        >
          {glyph}
        </span>
        <div className="leading-tight">
          <div className="text-[13px] text-text-primary">{data.label}</div>
          <div className="text-[10px] uppercase tracking-wide text-text-muted">{data.type}</div>
        </div>
      </div>
      {data.toolPreview && (
        <Typewriter text={data.toolPreview} className="text-[10px] text-text-muted" />
      )}
    </div>
  );
}

function KnowledgeCanvasCallout({ onOpen }: { onOpen: () => void }) {
  return (
    <div className="absolute right-4 top-4 z-30 max-w-xs rounded-card border border-line bg-surface p-3 shadow-card">
      <div className="flex items-start gap-2">
        <BookOpen size={15} className="mt-0.5 shrink-0 text-accent" />
        <div className="min-w-0">
          <div className="text-[12px] font-medium text-text-primary">Knowledge node needs sources</div>
          <p className="mt-1 text-[11px] leading-relaxed text-text-muted">Create a knowledge base or upload documents before this workflow retrieves context.</p>
          <button type="button" onClick={onOpen} className="mt-2 text-[11px] font-medium text-accent hover:text-accent-hover">Open Knowledge</button>
        </div>
      </div>
    </div>
  );
}
