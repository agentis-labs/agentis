/**
 * AppCanvasView — visual editor for the App Canvas (embeddable).
 *
 * Spec: docs/app-canvas/APP-CANVAS-ARCHITECTURE.md §11.2, §15.1.
 *
 * Mounted by AppDetailPage when the operator selects the `Canvas` segment of
 * the [Output][Canvas][Memory] shell. The view manages its own load + save
 * lifecycle and renders the toolbar / palette / stage / inspector.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, AlertTriangle, RotateCcw, Map as MapIcon, MapPinOff, Save, Check } from 'lucide-react';
import {
  type AppGraph,
  type AppGraphNode,
  type AppGraphNodeType,
  type AppGraphReferenceScope,
  REALTIME_EVENTS,
  emptyAppGraph,
} from '@agentis/core';
import { api } from '../../lib/api';
import { rtSubscribe, useRealtime, type RealtimeEnvelope } from '../../lib/realtime';
import { Button } from '../shared/Button';
import { Skeleton } from '../shared/Skeleton';
import { useToast } from '../shared/Toast';
import { useConfirm } from '../shared/ConfirmDialog';
import { AppGraphPalette } from './AppGraphPalette';
import { AppGraphInspector } from './AppGraphInspector';
import { AppGraphStage, defaultConfigFor, defaultPositionFor } from './AppGraphStage';

interface CanvasResponse {
  app: { id: string; slug: string; name: string; status: string; description?: string };
  graph: AppGraph;
  references: AppGraphReferenceScope;
  validation: {
    errors: Array<{ code: string; message: string; nodeId?: string }>;
    warnings: Array<{ code: string; message: string; nodeId?: string }>;
  };
}

type SaveState = 'saved' | 'saving' | 'dirty' | 'error';

export interface WorkflowLiveStatus {
  status: string;
  lastRunAt: string | null;
}

const MINIMAP_KEY = 'agentis.app-canvas.minimap';

interface AppCanvasViewProps {
  /** App identifier — same value used in /v1/apps/:slug routes. */
  slug: string;
}

export function AppCanvasView({ slug }: AppCanvasViewProps) {
  const toast = useToast();
  const confirm = useConfirm();

  const [data, setData] = useState<CanvasResponse | null>(null);
  const [graph, setGraph] = useState<AppGraph>(emptyAppGraph);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<SaveState>('saved');
  const [showMinimap, setShowMinimap] = useState<boolean>(() => {
    try { return localStorage.getItem(MINIMAP_KEY) === '1'; } catch { return false; }
  });
  const [loading, setLoading] = useState(true);
  const [workflowStatus, setWorkflowStatus] = useState<Record<string, WorkflowLiveStatus>>({});
  const [focusedDomainId, setFocusedDomainId] = useState<string | null>(null);
  const saveTimerRef = useRef<number | null>(null);

  const loadStatus = useCallback(async () => {
    if (!slug) return;
    try {
      const d = await api<{ workflowStatus: Record<string, WorkflowLiveStatus> }>(
        `/v1/apps/${slug}/canvas/status`,
      );
      setWorkflowStatus(d.workflowStatus ?? {});
    } catch {
      /* status overlay is best-effort */
    }
  }, [slug]);

  const loadCanvas = useCallback(async (options?: { silent?: boolean }) => {
    if (!slug) return;
    if (!options?.silent) setLoading(true);
    try {
      const d = await api<CanvasResponse>(`/v1/apps/${slug}/canvas`);
      setData(d);
      setGraph(d.graph ?? emptyAppGraph());
      setSaveState('saved');
    } catch (e) {
      toast.error('Failed to load canvas', String(e));
    } finally {
      if (!options?.silent) setLoading(false);
    }
  }, [slug, toast]);

  // ── Initial load ──
  useEffect(() => {
    void loadCanvas();
    void loadStatus();
  }, [loadCanvas, loadStatus]);

  useEffect(() => rtSubscribe('workspace', {}), []);

  useRealtime([REALTIME_EVENTS.APP_CANVAS_UPDATED], (env: RealtimeEnvelope) => {
    const payload = env.payload as { appId?: string; slug?: string };
    if (payload.slug !== slug && payload.appId !== data?.app.id) return;
    void loadCanvas({ silent: true });
  });

  // Live node status — runs update the canvas overlays in real time (§Layer 2).
  useRealtime(
    [REALTIME_EVENTS.RUN_RUNNING, REALTIME_EVENTS.RUN_COMPLETED, REALTIME_EVENTS.RUN_FAILED],
    (env: RealtimeEnvelope) => {
      const payload = env.payload as { workflowId?: string; status?: string };
      if (!payload.workflowId || !payload.status) return;
      setWorkflowStatus((prev) => ({
        ...prev,
        [payload.workflowId as string]: {
          status: payload.status as string,
          lastRunAt: new Date().toISOString(),
        },
      }));
    },
  );

  // ── Persist minimap pref ──
  useEffect(() => {
    try { localStorage.setItem(MINIMAP_KEY, showMinimap ? '1' : '0'); } catch { /* ignore */ }
  }, [showMinimap]);

  // ── Auto-save (debounced) ──
  useEffect(() => {
    if (saveState !== 'dirty' || !slug) return;
    if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
    saveTimerRef.current = window.setTimeout(() => { void doSave(); }, 1500);
    return () => { if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graph, saveState]);

  async function doSave() {
    if (!slug) return;
    setSaveState('saving');
    try {
      const next = await api<CanvasResponse>(`/v1/apps/${slug}/canvas`, {
        method: 'PATCH',
        body: JSON.stringify({ graph }),
      });
      setData((prev) => (prev ? { ...prev, ...next } : next));
      setSaveState('saved');
    } catch (e) {
      setSaveState('error');
      toast.error('Save failed', String(e));
    }
  }

  function updateGraph(next: AppGraph) {
    setGraph(next);
    setSaveState('dirty');
  }

  const selectedNode = useMemo<AppGraphNode | null>(
    () => graph.nodes.find((n) => n.id === selectedId) ?? null,
    [graph.nodes, selectedId],
  );

  const domains = graph.domains ?? [];
  const focusWorkflowIds = useMemo<string[] | null>(() => {
    if (!focusedDomainId) return null;
    return domains.find((d) => d.id === focusedDomainId)?.workflowIds ?? null;
  }, [domains, focusedDomainId]);

  function dropNodeAt(type: AppGraphNodeType, position: { x: number; y: number }) {
    const id = `n_${Math.random().toString(36).slice(2, 10)}`;
    const node: AppGraphNode = {
      id,
      type,
      title: titleFor(type),
      position,
      config: defaultConfigFor(type),
    };
    updateGraph({ ...graph, nodes: [...graph.nodes, node] });
    setSelectedId(id);
  }

  function dropCollectionAt(
    collection: NonNullable<AppGraphReferenceScope['collections']>[number],
    position: { x: number; y: number },
  ) {
    if (collection.workflows.length === 0) return;
    const existingCore = graph.nodes.find((n) => n.type === 'app_core');
    const coreId = existingCore?.id ?? `n_${Math.random().toString(36).slice(2, 10)}`;
    const coreNode: AppGraphNode | null = existingCore ? null : {
      id: coreId,
      type: 'app_core',
      title: appNameForCollection(collection.name),
      position,
      config: { kind: 'app_core' },
    };
    const workflowNodes = collection.workflows.map((workflow, index): AppGraphNode => {
      const nodeId = `n_${Math.random().toString(36).slice(2, 10)}`;
      return {
        id: nodeId,
        type: 'workflow_module',
        title: workflow.title,
        position: {
          x: position.x + (existingCore ? 0 : 260),
          y: position.y + index * 110,
        },
        config: { kind: 'workflow_module', workflowId: workflow.id },
      };
    });
    updateGraph({
      ...graph,
      nodes: [...graph.nodes, ...(coreNode ? [coreNode] : []), ...workflowNodes],
      edges: [
        ...graph.edges,
        ...workflowNodes.map((node) => ({
          id: `e_${Math.random().toString(36).slice(2, 10)}`,
          source: coreId,
          target: node.id,
          type: 'activates' as const,
          label: collection.name,
        })),
      ],
    });
    setSelectedId(workflowNodes[0]?.id ?? coreId);
  }

  function updateNode(node: AppGraphNode) {
    updateGraph({
      ...graph,
      nodes: graph.nodes.map((n) => (n.id === node.id ? node : n)),
    });
  }

  function deleteNode(nodeId: string) {
    updateGraph({
      ...graph,
      nodes: graph.nodes.filter((n) => n.id !== nodeId),
      edges: graph.edges.filter((e) => e.source !== nodeId && e.target !== nodeId),
    });
    if (selectedId === nodeId) setSelectedId(null);
  }

  async function resetFromPackage() {
    if (!slug) return;
    const ok = await confirm({
      title: 'Reset canvas from package?',
      body: 'This replaces the current graph with the manifest\'s appGraphTemplate. Unsaved changes will be lost.',
      confirmLabel: 'Reset',
      tone: 'danger',
    });
    if (!ok) return;
    try {
      const next = await api<CanvasResponse>(`/v1/apps/${slug}/canvas/from-package`, { method: 'POST' });
      setData(next);
      setGraph(next.graph ?? emptyAppGraph());
      setSelectedId(null);
      setSaveState('saved');
      toast.success('Canvas reset from package');
    } catch (e) {
      toast.error('Reset failed', String(e));
    }
  }

  if (loading) {
    return <div className="space-y-3 p-6"><Skeleton height={32} width={300} /><Skeleton height={520} /></div>;
  }
  if (!data) {
    return (
      <div className="p-8 text-[14px] text-text-muted">Could not load this app's canvas.</div>
    );
  }

  const { app, references, validation } = data;
  const errCount = validation.errors.length;
  const warnCount = validation.warnings.length;
  // The validation that ships with the page is the one for the *saved* graph.
  // Local edits show a ".dirty" hint until the next save.
  const errorList = validation.errors;
  const warningList = validation.warnings;

  return (
    <div className="flex h-full flex-col">
      {/* Inline toolbar — header (back button + segmented shell) belongs to AppDetailPage */}
      <div className="flex items-center justify-between border-b border-line px-5 py-2">
        <div className="flex items-center gap-3 min-w-0">
          <span className="text-[12px] text-text-muted">
            {graph.nodes.length} module{graph.nodes.length === 1 ? '' : 's'} ·{' '}
            {graph.edges.length} edge{graph.edges.length === 1 ? '' : 's'}
          </span>
        </div>

        <div className="flex items-center gap-2">
          <SaveIndicator state={saveState} />
          <Button
            variant="ghost" size="sm"
            iconLeft={showMinimap ? <MapPinOff size={12} /> : <MapIcon size={12} />}
            onClick={() => setShowMinimap((v) => !v)}
          >
            {showMinimap ? 'Hide map' : 'Show map'}
          </Button>
          <Button variant="ghost" size="sm" iconLeft={<RotateCcw size={12} />} onClick={() => void resetFromPackage()}>
            Reset
          </Button>
          <Button
            variant="primary" size="sm" iconLeft={<Save size={12} />}
            onClick={() => void doSave()}
            disabled={saveState === 'saved' || saveState === 'saving'}
          >
            Save
          </Button>
        </div>
      </div>

      {/* Validation banner — only shows when there are issues on the saved graph */}
      {(errCount > 0 || warnCount > 0) && (
        <div className="space-y-1 border-b border-line bg-surface px-5 py-2">
          {errorList.slice(0, 3).map((e, i) => (
            <div key={'e' + i} className="flex items-start gap-2 text-[12px] text-rose-300">
              <AlertCircle size={13} className="mt-0.5 shrink-0" />
              <span>{e.message}</span>
            </div>
          ))}
          {warningList.slice(0, 3).map((w, i) => (
            <div key={'w' + i} className="flex items-start gap-2 text-[12px] text-amber-300">
              <AlertTriangle size={13} className="mt-0.5 shrink-0" />
              <span>{w.message}</span>
            </div>
          ))}
        </div>
      )}

      {/* Macro domain band — the two-zoom-level view (§Layer 2). Renders only
          when the app declares domain groups; click a domain to focus it. */}
      {domains.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 border-b border-line bg-surface px-5 py-2">
          <span className="text-[11px] uppercase tracking-wider text-text-muted">Domains</span>
          {domains.map((d) => {
            const running = (d.workflowIds ?? []).some(
              (id) => mapStatus(workflowStatus[id]?.status) === 'running',
            );
            const focused = focusedDomainId === d.id;
            return (
              <button
                key={d.id}
                onClick={() => setFocusedDomainId(focused ? null : d.id)}
                className={[
                  'flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] transition',
                  focused
                    ? 'border-accent bg-accent/10 text-text-primary'
                    : 'border-line text-text-secondary hover:border-text-muted',
                ].join(' ')}
              >
                <span
                  className={[
                    'h-1.5 w-1.5 rounded-full',
                    running ? 'bg-cyan-400 animate-pulse' : 'bg-slate-500',
                  ].join(' ')}
                />
                {d.name}
                <span className="text-text-muted">{(d.workflowIds ?? []).length}</span>
              </button>
            );
          })}
          {focusedDomainId && (
            <button
              onClick={() => setFocusedDomainId(null)}
              className="text-[11px] text-text-muted hover:text-text-primary"
            >
              Clear focus
            </button>
          )}
        </div>
      )}

      {/* Stage */}
      <div className="flex flex-1 overflow-hidden">
        <AppGraphPalette
          collections={references.collections ?? []}
          onDragStart={(type, e) => {
            e.dataTransfer.setData('application/x-agentis-app-node', type);
            e.dataTransfer.effectAllowed = 'move';
          }}
        />
        <div className="relative flex-1">
          {graph.nodes.length === 0 && (
            <div className="pointer-events-none absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 text-center">
              <div className="text-[16px] font-semibold text-text-secondary">
                {isNewAppCanvas() ? `Start building ${app.name}` : 'Compose this app visually'}
              </div>
              <div className="max-w-md text-[12px] text-text-muted">
                {app.description
                  ? `${app.description} Drag modules or workflow collections from the left to start.`
                  : 'Drag modules or workflow collections from the left to start.'}
              </div>
              <Button
                variant="secondary" size="sm" className="pointer-events-auto mt-2"
                onClick={() => {
                  // Seed a minimal sensible starting graph: app_core only.
                  const id = `n_${Math.random().toString(36).slice(2, 10)}`;
                  updateGraph({
                    ...graph,
                    nodes: [{
                      id,
                      type: 'app_core',
                      title: app.name,
                      position: defaultPositionFor(graph),
                      config: { kind: 'app_core' },
                    }],
                  });
                  setSelectedId(id);
                }}
              >
                Start with the app core
              </Button>
            </div>
          )}
          <AppGraphStage
            graph={graph}
            onChange={updateGraph}
            selectedId={selectedId}
            onSelect={setSelectedId}
            onDropNodeType={dropNodeAt}
            onDropCollection={dropCollectionAt}
            showMinimap={showMinimap}
            workflowStatus={workflowStatus}
            focusWorkflowIds={focusWorkflowIds}
          />
        </div>
        <AppGraphInspector
          node={selectedNode}
          references={references}
          onChange={updateNode}
          onDelete={deleteNode}
        />
      </div>
    </div>
  );
}

function isNewAppCanvas(): boolean {
  try { return new URLSearchParams(window.location.search).get('new') === '1'; }
  catch { return false; }
}

function appNameForCollection(name: string): string {
  return name.trim() ? `${name} app` : 'App core';
}

/** True-ish run status → 'running' for the domain-band pulse. */
function mapStatus(status: string | undefined): 'running' | 'other' {
  return status === 'RUNNING' || status === 'PLANNING' || status === 'CREATED'
    ? 'running'
    : 'other';
}

function SaveIndicator({ state }: { state: SaveState }) {
  const text =
    state === 'saved'  ? 'Saved'  :
    state === 'saving' ? 'Saving…':
    state === 'error'  ? 'Save error' :
                         'Unsaved';
  const color =
    state === 'saved'  ? 'text-text-muted' :
    state === 'saving' ? 'text-text-secondary' :
    state === 'error'  ? 'text-rose-400' :
                         'text-amber-400';
  return (
    <span className={['inline-flex items-center gap-1.5 text-[11px]', color].join(' ')}>
      {state === 'saved' && <Check size={11} />}
      <span>{text}</span>
    </span>
  );
}

function titleFor(t: AppGraphNodeType): string {
  switch (t) {
    case 'app_core': return 'App core';
    case 'entry_workflow': return 'Trigger';
    case 'workflow_module': return 'Workflow';
    case 'agent_group': return 'Team';
    case 'knowledge_source': return 'Knowledge';
    case 'memory_surface': return 'Memory';
    case 'integration_surface': return 'Connection';
    case 'approval_surface': return 'Checkpoint';
    case 'output_surface': return 'Output';
    case 'scheduler': return 'Schedule';
    case 'channel_surface': return 'Channel';
    case 'brain_surface': return 'Brain';
  }
}
