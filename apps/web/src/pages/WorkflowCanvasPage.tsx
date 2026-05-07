/**
 * WorkflowCanvasPage — visual workflow editor.
 *
 * Per UIUX-REPLAN §7.3:
 *   - Clear toolbar with editable title, undo/redo, Variables, Test run, Publish
 *   - Auto-save every 30s with "Saved ·" indicator + "Unsaved" dot
 *   - Toggleable minimap
 *   - Run input form (no confusing variable prompt)
 *   - Stays inside Shell
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  Handle,
  Position,
  type Node,
  type Edge,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import {
  ArrowLeft, Undo2, Redo2, Play, Upload, Map as MapIcon, MapPinOff,
  ChevronDown, X, Variable, Trash2, Webhook, Clock as ClockIcon,
} from 'lucide-react';
import clsx from 'clsx';
import { api } from '../lib/api';
import { NodePalette } from '../components/canvas/NodePalette';
import { ContextInspector, type InspectorSelection } from '../components/canvas/ContextInspector';
import { RunDrawer } from '../components/canvas/RunDrawer';
import { AgentFocusOverlayManager } from '../components/canvas/AgentFocusOverlayManager';
import { Typewriter } from '../components/shared/Typewriter';
import { Button } from '../components/shared/Button';
import { useToast } from '../components/shared/Toast';
import { useConfirm } from '../components/shared/ConfirmDialog';

interface WorkflowDetail {
  id: string;
  title: string;
  summary: string | null;
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
  variables?: Array<{ name: string; type: string; default?: unknown }>;
  isReusable?: boolean;
  isInLibrary?: boolean;
}

interface SkillRow { id: string; slug: string; name: string; runtime: string; }

const NODE_GLYPH: Record<string, string> = {
  trigger: '◉', skill_task: '✦', agent_task: '◎', router: '⤳',
  merge: '⟴', checkpoint: '✓', subflow: '⊞', scratchpad: '◈',
};

type SaveState = 'saved' | 'saving' | 'dirty' | 'error';

const MINIMAP_KEY = 'agentis.canvas.minimap';

export function WorkflowCanvasPage() {
  const { id } = useParams<{ id: string }>();
  const nav = useNavigate();
  const toast = useToast();
  const confirm = useConfirm();

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
  const [saveState, setSaveState] = useState<SaveState>('saved');
  const [showMinimap, setShowMinimap] = useState<boolean>(() => {
    try { return localStorage.getItem(MINIMAP_KEY) === '1'; } catch { return false; }
  });

  const [selection, setSelection] = useState<InspectorSelection>({ kind: null });
  const overlayHostRef = useRef<HTMLDivElement | null>(null);
  const overlayManagerRef = useRef<AgentFocusOverlayManager | null>(null);
  const saveTimerRef = useRef<number | null>(null);
  const rfInstanceRef = useRef<{ screenToFlowPosition(p: { x: number; y: number }): { x: number; y: number } } | null>(null);

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
    });
    void api<{ skills: SkillRow[] }>('/v1/skills').then((d) => setSkills(d.skills));
  }, [id]);

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

  const flowNodes = useMemo<Node[]>(() => {
    if (!wf) return [];
    return wf.graph.nodes.map((n) => ({
      id: n.id,
      type: 'agentis',
      position: n.position,
      data: { label: n.title, kind: n.config.kind, type: n.type },
    }));
  }, [wf]);

  const flowEdges = useMemo<Edge[]>(() => {
    if (!wf) return [];
    return wf.graph.edges.map((e) => ({
      id: e.id, source: e.source, target: e.target, animated: false,
    }));
  }, [wf]);

  // Auto-save: debounce 30s, also save on unmount
  const saveNow = useCallback(async (graph?: WorkflowDetail['graph'], title?: string) => {
    if (!wf) return;
    setSaveState('saving');
    try {
      await api(`/v1/workflows/${wf.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          graph: graph ?? wf.graph,
          title: title ?? wf.title,
        }),
      });
      setSaveState('saved');
    } catch {
      setSaveState('error');
      toast.error('Auto-save failed');
    }
  }, [wf, toast]);

  const queueSave = useCallback(() => {
    setSaveState('dirty');
    if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
    saveTimerRef.current = window.setTimeout(() => { void saveNow(); }, 30_000);
  }, [saveNow]);

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
      toast.success('Run started');
      nav(`/runs/${res.runId}`);
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
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-line bg-surface px-4">
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

        <div className="ml-auto flex items-center gap-1.5">
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
            Variables
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

      {/* Canvas + side panels */}
      <div className="flex min-h-0 flex-1">
        <NodePalette />
        <div ref={overlayHostRef} className="relative min-h-0 flex-1">
          <ReactFlow
            nodes={flowNodes}
            edges={flowEdges}
            fitView
            nodeTypes={{ agentis: AgentisNode }}
            onInit={(inst) => { rfInstanceRef.current = inst as typeof rfInstanceRef.current; }}
            onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; }}
            onDrop={(e) => {
              e.preventDefault();
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
              const pos = rfInstanceRef.current?.screenToFlowPosition({ x: e.clientX, y: e.clientY })
                ?? { x: 100, y: 100 };
              const newNode = {
                id: `${nodeType}-${Date.now()}`,
                type: nodeType,
                title: (extra.label as string | undefined) ?? nodeType.replace(/_/g, ' '),
                position: pos,
                config: { kind: nodeType, ...extra },
              };
              const nextNodes = [...wf.graph.nodes, newNode];
              const nextGraph = { ...wf.graph, nodes: nextNodes };
              setWf({ ...wf, graph: nextGraph });
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
            onPaneClick={() => setSelection({ kind: null })}
            onNodesChange={() => queueSave()}
            onEdgesChange={() => queueSave()}
            proOptions={{ hideAttribution: true }}
          >
            <Background gap={20} size={1} color="#1c2028" />
            <Controls position="bottom-right" />
            {showMinimap && <MiniMap pannable zoomable position="bottom-left" />}
          </ReactFlow>
          <RunDrawer runId={activeRunId} open={drawerOpen} onClose={() => setDrawerOpen(false)} />
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

      <RunInputDialog
        open={runDialogOpen}
        onClose={() => setRunDialogOpen(false)}
        variables={wf.variables ?? []}
        onRun={(inputs) => void runWorkflow(inputs)}
        running={running}
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
            toast.success('Variables saved');
            setVariablesOpen(false);
          } catch (e) { toast.error('Failed to save variables', String(e)); }
        }}
      />
    </div>
  );
}

function SaveIndicator({ state }: { state: SaveState }) {
  if (state === 'saved') return <span className="text-[11px] text-text-muted">Saved ·</span>;
  if (state === 'saving') return <span className="text-[11px] text-text-muted">Saving…</span>;
  if (state === 'dirty') return <span className="inline-flex items-center gap-1 text-[11px] text-warn"><span className="h-1.5 w-1.5 rounded-full bg-warn" /> Unsaved</span>;
  return <span className="inline-flex items-center gap-1 text-[11px] text-danger"><span className="h-1.5 w-1.5 rounded-full bg-danger" /> Save failed</span>;
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
  variables: Array<{ name: string; type: string; default?: unknown }>;
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
          <h3 className="text-heading text-text-primary">Test this workflow</h3>
          <button type="button" onClick={onClose} aria-label="Close" className="-m-1 rounded-md p-1 text-text-muted hover:bg-surface-2 hover:text-text-primary">
            <X size={16} />
          </button>
        </header>
        <div className="space-y-4 px-5 py-5">
          {variables.length === 0 ? (
            <p className="text-[13px] text-text-secondary">
              No variables to provide. The trigger doesn't need any inputs to run.
            </p>
          ) : (
            <>
              <p className="text-[13px] text-text-secondary">The trigger expects these inputs:</p>
              {variables.map((v) => (
                <div key={v.name} className="space-y-1.5">
                  <label className="text-[12px] font-medium text-text-secondary">
                    {v.name} <span className="text-text-muted">({v.type})</span>
                  </label>
                  <input
                    type="text"
                    value={values[v.name] ?? ''}
                    onChange={(e) => setValues((s) => ({ ...s, [v.name]: e.target.value }))}
                    placeholder={v.default != null ? String(v.default) : `Enter ${v.name}…`}
                    className="h-9 w-full rounded-input border border-line bg-surface-2 px-3 text-[13px] text-text-primary placeholder:text-text-muted focus:border-accent focus:outline-none"
                  />
                </div>
              ))}
              <p className="text-[11px] text-text-muted">Or leave empty to use defaults.</p>
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

function VariablesDialog({
  open, onClose, wf, onSave,
}: {
  open: boolean; onClose: () => void; wf: WorkflowDetail;
  onSave: (vars: Array<{ name: string; type: string; default?: unknown }>) => Promise<void>;
}) {
  const [vars, setVars] = useState<Array<{ name: string; type: string; default?: string }>>(
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
      <div className="animate-scale-in w-full max-w-lg rounded-modal border border-line bg-surface shadow-modal">
        <header className="flex items-center justify-between border-b border-line px-5 py-4">
          <h3 className="text-heading text-text-primary">Variables</h3>
          <button type="button" onClick={onClose} aria-label="Close" className="-m-1 rounded-md p-1 text-text-muted hover:bg-surface-2 hover:text-text-primary">
            <X size={16} />
          </button>
        </header>
        <div className="space-y-3 px-5 py-5">
          {vars.length === 0 ? (
            <p className="text-[13px] text-text-muted">No variables defined yet.</p>
          ) : (
            vars.map((v, i) => (
              <div key={i} className="grid grid-cols-[1fr_120px_1fr_auto] items-center gap-2">
                <input
                  type="text" value={v.name}
                  onChange={(e) => setVars((arr) => arr.map((x, idx) => idx === i ? { ...x, name: e.target.value } : x))}
                  placeholder="name"
                  className="h-9 rounded-input border border-line bg-surface-2 px-3 text-[13px] text-text-primary focus:border-accent focus:outline-none"
                />
                <select
                  value={v.type}
                  onChange={(e) => setVars((arr) => arr.map((x, idx) => idx === i ? { ...x, type: e.target.value } : x))}
                  className="h-9 rounded-input border border-line bg-surface-2 px-2 text-[13px] text-text-primary focus:border-accent focus:outline-none"
                >
                  <option value="string">string</option>
                  <option value="number">number</option>
                  <option value="boolean">boolean</option>
                  <option value="json">json</option>
                </select>
                <input
                  type="text" value={v.default ?? ''}
                  onChange={(e) => setVars((arr) => arr.map((x, idx) => idx === i ? { ...x, default: e.target.value } : x))}
                  placeholder="default"
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
            ))
          )}
          <button
            type="button"
            onClick={() => setVars((arr) => [...arr, { name: '', type: 'string', default: '' }])}
            className="inline-flex h-8 items-center gap-1.5 rounded-btn border border-line bg-surface-2 px-2.5 text-[12px] font-medium text-text-secondary hover:bg-surface-3 hover:text-text-primary"
          >+ Add variable</button>
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
