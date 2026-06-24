/**
 * AppEditorPage — the single editor for an Agentic App (route `/apps/:id`).
 *
 * One primitive, one page. The familiar workflow-canvas chrome with facet tabs:
 *   Interface · Workflow · Data · Brain
 *
 * The Workflow facet embeds the real canvas (CanvasEngine via WorkflowCanvasPage
 * in embedded mode) with a switcher over the App's workflow set. A brand-new App
 * opens on Workflow (canvas); an App that already has an interface opens on
 * Interface. There is no separate run/build destination — the Interface facet
 * carries the live preview, and public sharing is a per-surface concern.
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import {
  ArrowLeft,
  BrainCircuit,
  Boxes,
  Code2,
  Database,
  Download,
  Eye,
  LayoutGrid,
  Loader2,
  Pencil,
  Plus,
  Save,
  Settings,
  Sparkles,
  SquareStack,
  X,
  Workflow as WorkflowIcon,
} from 'lucide-react';
import clsx from 'clsx';
import type { AppRecord, AppSurface, CollectionInfo, SurfaceAction, SurfaceKind, ViewNode } from '@agentis/core';
import { appsApi, type AppUpdatePayload } from '../lib/appsApi';
import { api, apiErrorMessage } from '../lib/api';
import { AppRuntime } from '../components/apps/AppRuntime';
import { AppEngineModal } from '../components/apps/AppEngineModal';
import { SurfaceCanvas } from '../components/apps/SurfaceCanvas';
import {
  SURFACE_GROUPS,
  buildBlock,
  buildStarterSurface,
  isBlockKind,
  type BlockKind,
  type ElementKind,
  type PaletteItem,
} from '../components/apps/surfaceTemplates';
import {
  addChildAtPath,
  appendNode,
  canHaveChildren,
  emptySurfaceView,
  getNodeAtPath,
  parseViewDraft,
  pathToLastChild,
  removeNodeAtPath,
  updateNodeAtPath,
} from '../components/apps/viewTree';
import { StudioSurfaceBuilder } from '../components/apps/StudioSurfaceBuilder';
import { WorkflowCanvasPage, WorkflowBrainTab } from './WorkflowCanvasPage';
import { SegmentedControl, type SegmentDef } from '../components/shared/SegmentedControl';

type AppFacet = 'interface' | 'workflow' | 'data' | 'brain';

interface WorkflowRef {
  id: string;
  title: string;
}

const FACETS: ReadonlyArray<SegmentDef<AppFacet>> = [
  { value: 'interface', label: 'Interface', icon: <LayoutGrid size={13} /> },
  { value: 'workflow', label: 'Workflow', icon: <WorkflowIcon size={13} /> },
  { value: 'data', label: 'Data', icon: <Database size={13} /> },
  { value: 'brain', label: 'Brain', icon: <BrainCircuit size={13} /> },
];

export function AppEditorPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  const [app, setApp] = useState<AppRecord | null>(null);
  const [surfaces, setSurfaces] = useState<AppSurface[]>([]);
  const [collections, setCollections] = useState<CollectionInfo[]>([]);
  const [workflows, setWorkflows] = useState<WorkflowRef[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  const [selectedWorkflowId, setSelectedWorkflowId] = useState<string | null>(null);
  const [selectedSurface, setSelectedSurface] = useState<string | null>(null);
  const [surfaceDraft, setSurfaceDraft] = useState('');
  const [surfaceActionsDraft, setSurfaceActionsDraft] = useState<SurfaceAction[]>([]);
  const [generating, setGenerating] = useState(false);
  const [previewKey, setPreviewKey] = useState(0);
  const [nameDraft, setNameDraft] = useState('');
  const [editingName, setEditingName] = useState(false);
  const [engineOpen, setEngineOpen] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [appRow, surfaceRows, collectionRows, workflowIds] = await Promise.all([
        appsApi.get(id),
        appsApi.listSurfaces(id),
        appsApi.listCollections(id),
        appsApi.listWorkflowIds(id),
      ]);
      const workflowRefs = await Promise.all(
        workflowIds.map((wfId) =>
          api<{ workflow: WorkflowRef }>(`/v1/workflows/${wfId}`)
            .then((r) => ({ id: r.workflow.id, title: r.workflow.title }))
            .catch(() => null),
        ),
      );
      setApp(appRow);
      setNameDraft(appRow.name);
      setSurfaces(surfaceRows);
      setCollections(collectionRows);
      const refs = workflowRefs.filter((w): w is WorkflowRef => Boolean(w));
      setWorkflows(refs);
      setSelectedWorkflowId((current) =>
        current && refs.some((workflow) => workflow.id === current) ? current : refs[0]?.id ?? null,
      );
      setSelectedSurface((current) =>
        current && surfaceRows.some((surface) => surface.name === current) ? current : surfaceRows[0]?.name ?? null,
      );
      setLoaded(true);
    } catch (e) {
      setError(apiErrorMessage(e));
      setLoaded(true);
    }
  }, [id]);

  useEffect(() => { void load(); }, [load]);

  // Creation explicitly supplies `?facet=workflow`; every normal visit opens
  // on the Interface facet, whether it has a surface yet or not.
  const facetParam = searchParams.get('facet') as AppFacet | null;
  const defaultFacet: AppFacet = 'interface';
  const facet: AppFacet =
    facetParam && FACETS.some((f) => f.value === facetParam) ? facetParam : defaultFacet;

  const setFacet = useCallback((value: AppFacet) => {
    setSearchParams((params) => {
      const next = new URLSearchParams(params);
      next.set('facet', value);
      return next;
    }, { replace: true });
  }, [setSearchParams]);

  const currentSurface = useMemo(
    () => surfaces.find((s) => s.name === selectedSurface) ?? null,
    [surfaces, selectedSurface],
  );
  useEffect(() => {
    if (currentSurface) {
      setSurfaceDraft(JSON.stringify(currentSurface.view ?? emptySurfaceView(), null, 2));
      setSurfaceActionsDraft(currentSurface.actions ?? []);
    }
  }, [currentSurface]);

  // ── Actions ──────────────────────────────────────────────

  const commitName = useCallback(async () => {
    setEditingName(false);
    const next = nameDraft.trim();
    if (!app || !next || next === app.name) return;
    try {
      const updated = await appsApi.update(id, { name: next });
      setApp(updated);
    } catch (e) {
      setStatus(apiErrorMessage(e));
      setNameDraft(app.name);
    }
  }, [app, id, nameDraft]);

  const saveAppSettings = useCallback(async (patch: AppUpdatePayload) => {
    try {
      const updated = await appsApi.update(id, patch);
      setApp(updated);
      setNameDraft(updated.name);
      setStatus('Saved');
      return updated;
    } catch (e) {
      setStatus(apiErrorMessage(e));
      throw e;
    }
  }, [id]);

  const addWorkflow = useCallback(async () => {
    setBusy('workflow');
    setStatus(null);
    try {
      const created = await api<{ workflow: { id: string; title: string } }>('/v1/workflows', {
        method: 'POST',
        body: JSON.stringify({ title: `${app?.name ?? 'App'} workflow ${workflows.length + 1}` }),
      });
      await appsApi.adoptWorkflow(id, created.workflow.id);
      await load();
      setSelectedWorkflowId(created.workflow.id);
      setFacet('workflow');
    } catch (e) {
      setStatus(apiErrorMessage(e));
    } finally {
      setBusy(null);
    }
  }, [app, id, load, setFacet, workflows.length]);

  const renameWorkflow = useCallback(async (workflowId: string, title: string) => {
    const nextTitle = title.trim();
    if (!nextTitle) return;
    try {
      await api(`/v1/workflows/${workflowId}`, {
        method: 'PATCH',
        body: JSON.stringify({ title: nextTitle }),
      });
      setWorkflows((current) => current.map((workflow) => (
        workflow.id === workflowId ? { ...workflow, title: nextTitle } : workflow
      )));
      setStatus('Saved');
    } catch (e) {
      setStatus(apiErrorMessage(e));
      throw e;
    }
  }, []);

  const createSurface = useCallback(async () => {
    setBusy('surface');
    setStatus(null);
    try {
      const name = uniqueName('surface', surfaces.map((s) => s.name));
      const starter = buildStarterSurface(collections);
      await appsApi.upsertSurface(id, { name, kind: 'page', view: starter.view, actions: starter.actions });
      await load();
      setSelectedSurface(name);
      setFacet('interface');
    } catch (e) {
      setStatus(apiErrorMessage(e));
    } finally {
      setBusy(null);
    }
  }, [collections, id, load, setFacet, surfaces]);

  const renameSurface = useCallback(async (currentName: string, nextName: string) => {
    const trimmed = nextName.trim();
    if (!trimmed || trimmed === currentName) return;
    try {
      const updated = await appsApi.renameSurface(id, currentName, trimmed);
      setSurfaces((current) => current.map((surface) => (
        surface.name === currentName ? updated : surface
      )));
      setSelectedSurface(updated.name);
      setStatus('Saved');
    } catch (e) {
      setStatus(apiErrorMessage(e));
      throw e;
    }
  }, [id]);

  const saveSurface = useCallback(async () => {
    if (!currentSurface) return;
    let view: unknown;
    try {
      view = JSON.parse(surfaceDraft);
    } catch {
      setStatus('Invalid JSON');
      return;
    }
    setBusy('surface-save');
    setStatus(null);
    try {
      await appsApi.upsertSurface(id, { name: currentSurface.name, kind: currentSurface.kind, view, actions: surfaceActionsDraft });
      setStatus('Saved');
      setPreviewKey((k) => k + 1);
      await load();
    } catch (e) {
      setStatus(apiErrorMessage(e));
    } finally {
      setBusy(null);
    }
  }, [currentSurface, id, load, surfaceActionsDraft, surfaceDraft]);

  const updateSurfaceMeta = useCallback(async (patch: { kind?: SurfaceKind; shareable?: boolean }) => {
    if (!currentSurface) return;
    setBusy('surface-save');
    setStatus(null);
    try {
      await appsApi.upsertSurface(id, {
        name: currentSurface.name,
        kind: patch.kind ?? currentSurface.kind,
        view: parseViewDraft(surfaceDraft) ?? currentSurface.view ?? emptySurfaceView(),
        actions: surfaceActionsDraft,
        shareable: patch.shareable ?? currentSurface.shareable,
      });
      setStatus('Saved');
      await load();
    } catch (e) {
      setStatus(apiErrorMessage(e));
    } finally {
      setBusy(null);
    }
  }, [currentSurface, id, load, surfaceActionsDraft, surfaceDraft]);

  const duplicateSurface = useCallback(async () => {
    if (!currentSurface) return;
    setBusy('surface');
    setStatus(null);
    try {
      const name = uniqueName(`${currentSurface.name}-copy`, surfaces.map((s) => s.name));
      await appsApi.upsertSurface(id, {
        name,
        kind: currentSurface.kind,
        view: parseViewDraft(surfaceDraft) ?? currentSurface.view ?? emptySurfaceView(),
        actions: surfaceActionsDraft,
        shareable: currentSurface.shareable,
      });
      await load();
      setSelectedSurface(name);
      setStatus('Duplicated');
    } catch (e) {
      setStatus(apiErrorMessage(e));
    } finally {
      setBusy(null);
    }
  }, [currentSurface, id, load, surfaceActionsDraft, surfaceDraft, surfaces]);

  const deleteSurface = useCallback(async () => {
    if (!currentSurface) return;
    setBusy('surface');
    setStatus(null);
    try {
      await appsApi.removeSurface(id, currentSurface.name);
      const next = surfaces.find((surface) => surface.name !== currentSurface.name)?.name ?? null;
      await load();
      setSelectedSurface(next);
      setStatus('Deleted');
    } catch (e) {
      setStatus(apiErrorMessage(e));
    } finally {
      setBusy(null);
    }
  }, [currentSurface, id, load, surfaces]);

  const generateSurface = useCallback(async (prompt: string) => {
    if (!currentSurface) return;
    setGenerating(true);
    setStatus(null);
    try {
      const result = await appsApi.generateSurface(id, { prompt, surface: currentSurface.name });
      setSurfaceDraft(JSON.stringify(result.view, null, 2));
      setSurfaceActionsDraft(result.actions ?? []);
      setStatus(result.source === 'model' ? 'Generated — review and Save' : 'Drafted a starter — review and Save');
    } catch (e) {
      setStatus(apiErrorMessage(e));
    } finally {
      setGenerating(false);
    }
  }, [currentSurface, id]);

  const exportApp = useCallback(async () => {
    try {
      const envelope = await appsApi.exportApp(id);
      const blob = new Blob([JSON.stringify(envelope, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${app?.slug ?? 'app'}.agentisapp`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setStatus(apiErrorMessage(e));
    }
  }, [app, id]);

  // ── Render ───────────────────────────────────────────────

  if (!loaded) {
    return (
      <div className="flex h-full items-center justify-center text-text-muted">
        <Loader2 className="animate-spin" />
      </div>
    );
  }
  if (error || !app) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-[13px] text-text-muted">
        <span>{error ?? 'App not found'}</span>
        <button type="button" onClick={() => navigate('/apps')} className="rounded-btn border border-line px-3 py-1 text-text-secondary hover:bg-canvas">Back to Apps</button>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      {/* Slim command strip — mirrors the workflow canvas chrome. */}
      <div className="flex shrink-0 items-center gap-2 border-b border-line bg-surface px-4 py-2">
        <button
          onClick={() => navigate('/apps')}
          className="inline-flex items-center gap-1 text-[12px] text-text-muted transition-colors hover:text-text-primary"
        >
          <ArrowLeft size={12} /> Apps
        </button>
        <div className="mx-2 h-4 w-px bg-line" />
        <span className="flex h-7 w-7 items-center justify-center overflow-hidden rounded-md border border-line bg-canvas text-text-secondary">
          {app.icon ? (
            app.icon.startsWith('http://') || app.icon.startsWith('https://') || app.icon.startsWith('data:image/') ? (
              <img src={app.icon} alt="" className="h-full w-full object-cover" />
            ) : (
              <span className="text-[15px]">{app.icon}</span>
            )
          ) : (
            <Boxes size={14} />
          )}
        </span>
        {editingName ? (
          <input
            autoFocus
            value={nameDraft}
            onChange={(e) => setNameDraft(e.target.value)}
            onBlur={() => void commitName()}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void commitName();
              if (e.key === 'Escape') { setNameDraft(app.name); setEditingName(false); }
            }}
            className="h-7 rounded-md border border-line bg-surface-2 px-2 text-[13px] font-medium text-text-primary focus:border-accent focus:outline-none"
          />
        ) : (
          <button onClick={() => setEditingName(true)} className="rounded-md px-1.5 py-0.5 text-[13px] font-medium text-text-primary hover:bg-surface-2">
            {app.name}
          </button>
        )}
        <button
          type="button"
          onClick={() => setEngineOpen(true)}
          className="inline-flex h-7 w-7 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-surface-2 hover:text-text-primary"
          title="App engine"
          aria-label="App engine"
        >
          <Settings size={13} />
        </button>
        <span className="text-[11px] text-text-muted">v{app.version} · {app.status}</span>

        <div className="ml-auto flex items-center gap-2">
          {status ? <span className="max-w-[180px] truncate text-[11px] text-text-muted">{status}</span> : null}
          <SegmentedControl segments={FACETS} value={facet} onChange={setFacet} size="sm" className="whitespace-nowrap" />
          <button
            type="button"
            onClick={() => void exportApp()}
            className="inline-flex h-7 items-center gap-1.5 rounded-md border border-line px-2.5 text-[12px] text-text-secondary transition-colors hover:bg-canvas hover:text-text-primary"
          >
            <Download size={13} /> Export
          </button>
        </div>
      </div>

      {/* Facet body — each fills the remaining height. */}
      <div className="min-h-0 flex-1 overflow-hidden">
        {facet === 'workflow' && (
          <WorkflowFacet
            workflows={workflows}
            selectedId={selectedWorkflowId}
            busy={busy === 'workflow'}
            onSelect={setSelectedWorkflowId}
            onAdd={() => void addWorkflow()}
            onRename={renameWorkflow}
          />
        )}
        {facet === 'interface' && (
          <InterfaceFacet
            appId={id}
            surfaces={surfaces}
            selected={selectedSurface}
            current={currentSurface}
            draft={surfaceDraft}
            actions={surfaceActionsDraft}
            busy={busy === 'surface-save'}
            generating={generating}
            previewKey={previewKey}
            creating={busy === 'surface'}
            collections={collections}
            onSelect={setSelectedSurface}
            onDraftChange={setSurfaceDraft}
            onActionsChange={setSurfaceActionsDraft}
            onCreate={() => void createSurface()}
            onRename={renameSurface}
            onSave={() => void saveSurface()}
            onGenerate={generateSurface}
            onUpdateSurface={(patch) => void updateSurfaceMeta(patch)}
            onDuplicateSurface={() => void duplicateSurface()}
            onDeleteSurface={() => void deleteSurface()}
          />
        )}
        {facet === 'data' && <DataFacet collections={collections} />}
        {facet === 'brain' && <BrainFacet app={app} />}
      </div>
      <AppEngineModal
        open={engineOpen}
        app={app}
        surfaces={surfaces}
        onClose={() => setEngineOpen(false)}
        onSave={saveAppSettings}
      />
    </div>
  );
}

// ── Workflow facet — switcher + the real embedded canvas ─────

function WorkflowFacet({
  workflows,
  selectedId,
  busy,
  onSelect,
  onAdd,
  onRename,
}: {
  workflows: WorkflowRef[];
  selectedId: string | null;
  busy: boolean;
  onSelect: (id: string) => void;
  onAdd: () => void;
  onRename: (workflowId: string, title: string) => Promise<void>;
}) {
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [titleDraft, setTitleDraft] = useState('');

  function startRename(workflow: WorkflowRef) {
    setRenamingId(workflow.id);
    setTitleDraft(workflow.title);
  }

  async function commitRename(workflow: WorkflowRef) {
    const nextTitle = titleDraft.trim();
    if (!nextTitle || nextTitle === workflow.title) {
      setRenamingId(null);
      return;
    }
    try {
      await onRename(workflow.id, nextTitle);
      setRenamingId(null);
    } catch {
      // The page header carries the request failure without discarding the draft.
    }
  }

  if (workflows.length === 0) {
    return (
      <FacetEmpty
        icon={<WorkflowIcon size={30} />}
        title="No workflow yet"
        body="The Workflow facet holds this App's logic — automations, agent orchestration, schedules, and app actions."
        action={{ label: 'Create workflow', busy, onClick: onAdd }}
      />
    );
  }
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div role="tablist" aria-label="App workflows" className="flex shrink-0 items-center gap-1.5 overflow-x-auto border-b border-line bg-surface px-3 py-1.5">
        {workflows.map((wf) => (
          <div
            key={wf.id}
            className={clsx(
              'flex h-7 shrink-0 items-center rounded-btn text-[12px] font-medium transition-colors',
              selectedId === wf.id ? 'bg-accent-soft text-accent' : 'text-text-muted hover:bg-canvas hover:text-text-primary',
            )}
          >
            {renamingId === wf.id ? (
              <input
                autoFocus
                value={titleDraft}
                onChange={(event) => setTitleDraft(event.target.value)}
                onBlur={() => void commitRename(wf)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') void commitRename(wf);
                  if (event.key === 'Escape') setRenamingId(null);
                }}
                className="h-6 w-40 rounded-md border border-line bg-surface px-2 text-[12px] text-text-primary outline-none focus:border-accent"
                aria-label="Workflow title"
              />
            ) : (
              <button
                role="tab"
                aria-selected={selectedId === wf.id}
                type="button"
                onClick={() => onSelect(wf.id)}
                className="h-7 max-w-52 truncate px-2.5 text-left"
              >
                {wf.title}
              </button>
            )}
            {selectedId === wf.id && renamingId !== wf.id ? (
              <button
                type="button"
                onClick={() => startRename(wf)}
                className="mr-1 rounded-btn p-1 text-accent/70 hover:bg-accent/10 hover:text-accent"
                title="Rename workflow"
                aria-label={`Rename ${wf.title}`}
              >
                <Pencil size={11} />
              </button>
            ) : null}
          </div>
        ))}
        <button
          type="button"
          onClick={onAdd}
          disabled={busy}
          className="inline-flex h-7 shrink-0 items-center gap-1 rounded-btn border border-line px-2 text-[12px] text-text-secondary hover:bg-canvas disabled:opacity-50"
        >
          {busy ? <Loader2 size={12} className="animate-spin" /> : <Plus size={12} />}
        </button>
      </div>
      <div className="min-h-0 flex-1">
        {selectedId ? <WorkflowCanvasPage key={selectedId} embedded workflowId={selectedId} /> : null}
      </div>
    </div>
  );
}

// ── Interface facet — the living app (Live) with Edit/Code as opt-in modes ──

type BuilderMode = 'live' | 'edit' | 'code';

function InterfaceFacet({
  appId,
  surfaces,
  selected,
  current,
  draft,
  actions,
  busy,
  generating,
  creating,
  collections,
  previewKey,
  onSelect,
  onDraftChange,
  onActionsChange,
  onCreate,
  onRename,
  onSave,
  onGenerate,
  onUpdateSurface,
  onDuplicateSurface,
  onDeleteSurface,
}: {
  appId: string;
  surfaces: AppSurface[];
  selected: string | null;
  current: AppSurface | null;
  draft: string;
  actions: SurfaceAction[];
  busy: boolean;
  generating: boolean;
  creating: boolean;
  collections: CollectionInfo[];
  previewKey: number;
  onSelect: (name: string) => void;
  onDraftChange: (value: string) => void;
  onActionsChange: (actions: SurfaceAction[]) => void;
  onCreate: () => void;
  onRename: (currentName: string, nextName: string) => Promise<void>;
  onSave: () => void;
  onGenerate: (prompt: string) => Promise<void>;
  onUpdateSurface: (patch: { kind?: SurfaceKind; shareable?: boolean }) => void;
  onDuplicateSurface: () => void;
  onDeleteSurface: () => void;
}) {
  const [mode, setMode] = useState<BuilderMode>('live');
  const [renamingSurface, setRenamingSurface] = useState<string | null>(null);
  const [surfaceNameDraft, setSurfaceNameDraft] = useState('');
  const [selectedPath, setSelectedPath] = useState<number[]>([]);
  const [prompt, setPrompt] = useState('');
  const view = parseViewDraft(draft);
  const selectedNode = view ? getNodeAtPath(view, selectedPath) : null;

  function setView(next: ViewNode) {
    onDraftChange(JSON.stringify(next, null, 2));
  }

  function mergeActions(next: SurfaceAction[]) {
    const byName = new Map(actions.map((action) => [action.name, action]));
    for (const action of next) byName.set(action.name, action);
    onActionsChange([...byName.values()]);
  }

  function addBlock(kind: BlockKind, target: 'root' | 'selected' = 'root') {
    const root = view ?? emptySurfaceView();
    const built = buildBlock(kind, collections);
    if (built.actions?.length) mergeActions(built.actions);
    if (target === 'selected' && selectedNode && canHaveChildren(selectedNode)) {
      setView(addChildAtPath(root, selectedPath, built.node));
      return;
    }
    const next = appendNode(root, built.node);
    setView(next);
    setSelectedPath(pathToLastChild(next));
  }

  function updateSelected(mutator: (node: ViewNode) => ViewNode) {
    if (!view || !selectedNode) return;
    setView(updateNodeAtPath(view, selectedPath, mutator));
  }

  function removeSelected() {
    if (!view || selectedPath.length === 0) return;
    setView(removeNodeAtPath(view, selectedPath));
    setSelectedPath([]);
  }

  async function commitSurfaceRename(surfaceName: string) {
    const next = surfaceNameDraft.trim();
    if (!next || next === surfaceName) {
      setRenamingSurface(null);
      return;
    }
    await onRename(surfaceName, next);
    setRenamingSurface(null);
  }

  async function submitPrompt(event: { preventDefault: () => void }) {
    event.preventDefault();
    const value = prompt.trim();
    if (!value || generating) return;
    setSelectedPath([]);
    await onGenerate(value);
    setPrompt('');
  }

  if (surfaces.length === 0) {
    return (
      <FacetEmpty
        icon={<LayoutGrid size={30} />}
        title="No interface yet"
        body="Create a surface, then build it visually — drop sections, edit in place, or let the agent draft it from a prompt."
        action={{ label: 'Create surface', busy: creating, onClick: onCreate }}
      />
    );
  }

  const rootEmpty = !view || (canHaveChildren(view) && view.children.length === 0);

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Top strip: surfaces · mode · AI · save */}
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line bg-surface px-3 py-2">
        <div className="flex items-center gap-1 overflow-x-auto">
          {surfaces.map((surface) => (
            <div
              key={surface.id}
              className={clsx(
                'group flex shrink-0 items-center rounded-btn text-[12px]',
                selected === surface.name ? 'bg-accent-soft text-accent' : 'text-text-muted hover:bg-canvas hover:text-text-primary',
              )}
            >
              {renamingSurface === surface.name ? (
                <input
                  autoFocus
                  value={surfaceNameDraft}
                  onChange={(event) => setSurfaceNameDraft(event.target.value)}
                  onBlur={() => void commitSurfaceRename(surface.name)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') void commitSurfaceRename(surface.name);
                    if (event.key === 'Escape') setRenamingSurface(null);
                  }}
                  className="h-7 w-36 rounded-md border border-line bg-canvas px-2 text-[12px] text-text-primary outline-none focus:border-accent"
                  aria-label="Surface name"
                />
              ) : (
                <button
                  type="button"
                  onClick={() => { onSelect(surface.name); setSelectedPath([]); }}
                  className="h-7 max-w-44 truncate px-2.5 text-left"
                >
                  {surface.name}
                </button>
              )}
              {renamingSurface !== surface.name ? (
                <button
                  type="button"
                  onClick={() => { setRenamingSurface(surface.name); setSurfaceNameDraft(surface.name); }}
                  className="mr-1 rounded-btn p-1 opacity-0 hover:bg-canvas group-hover:opacity-100"
                  aria-label={`Rename ${surface.name}`}
                  title="Rename surface"
                >
                  <Pencil size={11} />
                </button>
              ) : null}
            </div>
          ))}
          <button
            type="button"
            onClick={onCreate}
            disabled={creating}
            className="inline-flex h-7 shrink-0 items-center rounded-btn border border-line px-1.5 text-text-secondary hover:bg-canvas disabled:opacity-50"
            aria-label="Add surface"
          >
            {creating ? <Loader2 size={12} className="animate-spin" /> : <Plus size={12} />}
          </button>
        </div>

        <div className="mx-1 h-5 w-px bg-line" />

        <div className="inline-flex rounded-btn border border-line bg-canvas p-0.5">
          {([
            { id: 'live', label: 'Live', icon: <Eye size={13} /> },
            { id: 'edit', label: 'Edit', icon: <SquareStack size={13} /> },
            { id: 'code', label: 'Code', icon: <Code2 size={13} /> },
          ] as Array<{ id: BuilderMode; label: string; icon: ReactNode }>).map((segment) => (
            <button
              key={segment.id}
              type="button"
              onClick={() => setMode(segment.id)}
              className={clsx('inline-flex h-7 items-center gap-1 rounded-md px-2 text-[12px]', mode === segment.id ? 'bg-surface text-text-primary' : 'text-text-muted hover:text-text-primary')}
            >
              {segment.icon} {segment.label}
            </button>
          ))}
        </div>

        {mode === 'edit' ? (
          <form onSubmit={(event) => void submitPrompt(event)} className="ml-auto flex min-w-[220px] flex-1 items-center gap-1.5 sm:max-w-md">
            <div className="relative flex-1">
              <Sparkles size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-text-muted" />
              <input
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
                placeholder="Describe a surface for the agent to build…"
                aria-label="Describe a surface"
                className="h-8 w-full rounded-btn border border-line bg-canvas pl-7 pr-2 text-[12px] text-text-primary outline-none focus:border-accent"
              />
            </div>
            <button
              type="submit"
              disabled={generating || !prompt.trim()}
              className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-btn border border-line bg-surface px-2.5 text-[12px] font-medium text-text-secondary hover:bg-surface-2 hover:text-text-primary disabled:opacity-50"
            >
              {generating ? <Loader2 size={13} className="animate-spin" /> : <Sparkles size={13} />} Generate
            </button>
          </form>
        ) : (
          <div className="ml-auto" />
        )}

        {mode !== 'live' ? (
          <button
            type="button"
            onClick={onSave}
            disabled={!current || busy}
            className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-btn bg-accent px-3 text-[12px] font-semibold text-canvas hover:bg-accent-hover disabled:opacity-50"
          >
            {busy ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />} Save
          </button>
        ) : null}
      </div>

      {/* Body */}
      <div className="min-h-0 flex-1 overflow-hidden">
        {mode === 'code' ? (
          <textarea
            value={draft}
            onChange={(event) => onDraftChange(event.target.value)}
            spellCheck={false}
            className="h-full w-full resize-none bg-canvas p-4 font-mono text-[12px] leading-relaxed text-text-primary outline-none"
            placeholder="ViewNode JSON…"
          />
        ) : mode === 'live' ? (
          <div className="h-full overflow-auto bg-canvas">
            {current ? (
              <AppRuntime key={`${current.name}:${previewKey}`} appId={appId} surfaceName={current.name} />
            ) : (
              <div className="flex h-full items-center justify-center text-text-muted">No surface selected</div>
            )}
          </div>
        ) : current ? (
          <StudioSurfaceBuilder
            appId={appId}
            current={current}
            draft={draft}
            actions={actions}
            collections={collections}
            onDraftChange={onDraftChange}
            onActionsChange={onActionsChange}
            onUpdateSurface={onUpdateSurface}
            onDuplicateSurface={onDuplicateSurface}
            onDeleteSurface={onDeleteSurface}
          />
        ) : (
          <div className="flex h-full items-center justify-center text-text-muted">No surface selected</div>
        )}
      </div>
    </div>
  );
}

function PaletteGroup({
  title,
  items,
  onAdd,
  className,
}: {
  title: string;
  items: PaletteItem[];
  onAdd: (kind: BlockKind) => void;
  className?: string;
}) {
  return (
    <div className={className}>
      <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-text-muted">{title}</div>
      <div className="grid grid-cols-2 gap-1.5">
        {items.map((item) => (
          <button
            key={item.kind}
            type="button"
            draggable
            title={item.hint}
            onDragStart={(event) => {
              event.dataTransfer.setData('application/x-agentis-block', item.kind);
              event.dataTransfer.effectAllowed = 'copy';
            }}
            onClick={() => onAdd(item.kind)}
            className="flex h-16 flex-col items-start justify-between rounded-card border border-line bg-canvas p-2 text-left text-[11px] text-text-secondary transition-colors hover:border-accent/50 hover:bg-surface-2 hover:text-text-primary"
          >
            <span className="text-text-muted">{item.icon}</span>
            <span className="font-medium">{item.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function EmptyCanvasHint() {
  return (
    <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center px-6 text-center text-text-muted">
      <LayoutGrid size={30} className="mb-3" />
      <div className="text-[13px] font-medium text-text-secondary">Build your surface</div>
      <p className="mt-1 max-w-xs text-[12px] leading-relaxed">Drop a section from the left, or describe it in the prompt bar and let the agent draft it.</p>
    </div>
  );
}

// ── Inspector — properties for the selected node ─────────────

function SurfaceProperties({
  node,
  collections,
  onChange,
  onRemove,
  onAddInside,
}: {
  node: ViewNode;
  collections: CollectionInfo[];
  onChange: (mutator: (node: ViewNode) => ViewNode) => void;
  onRemove?: () => void;
  onAddInside?: (kind: ElementKind) => void;
}) {
  return (
    <div className="space-y-3">
      <div className="rounded-card border border-line bg-canvas p-3">
        <div className="text-[12px] font-semibold text-text-primary">{node.type}</div>
        <div className="mt-1 truncate text-[11px] text-text-muted">{surfaceNodeLabel(node)}</div>
      </div>
      <SurfaceNodeFields node={node} collections={collections} onChange={onChange} />
      {onAddInside ? (
        <div>
          <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-text-muted">Add inside</div>
          <div className="grid grid-cols-2 gap-1.5">
            {(['heading', 'text', 'card', 'metric'] as ElementKind[]).map((kind) => (
              <button key={kind} type="button" onClick={() => onAddInside(kind)} className="rounded-btn border border-line bg-canvas px-2 py-1 text-[11px] capitalize text-text-secondary hover:bg-surface-2 hover:text-text-primary">
                {kind}
              </button>
            ))}
          </div>
        </div>
      ) : null}
      {onRemove ? (
        <button type="button" onClick={onRemove} className="inline-flex h-8 w-full items-center justify-center gap-1.5 rounded-btn border border-danger/30 bg-danger-soft px-2 text-[12px] font-medium text-danger">
          <X size={13} /> Remove block
        </button>
      ) : null}
    </div>
  );
}

function SurfaceNodeFields({
  node,
  collections,
  onChange,
}: {
  node: ViewNode;
  collections: CollectionInfo[];
  onChange: (mutator: (node: ViewNode) => ViewNode) => void;
}) {
  if (node.type === 'Heading' || node.type === 'Text' || node.type === 'Markdown') {
    return <PropertyTextarea label="Content" value={node.value} onChange={(value) => onChange((current) => ({ ...current, value } as ViewNode))} />;
  }
  if (node.type === 'Card' || node.type === 'Section') {
    return <PropertyInput label="Title" value={node.title ?? ''} onChange={(title) => onChange((current) => ({ ...current, title } as ViewNode))} />;
  }
  if (node.type === 'Stack' || node.type === 'Row' || node.type === 'Grid') {
    return <PropertyInput label="Gap" value={String(node.gap ?? 12)} onChange={(gap) => onChange((current) => ({ ...current, gap: Number(gap) || 0 } as ViewNode))} />;
  }
  if (node.type === 'Metric') {
    return (
      <>
        <PropertyInput label="Label" value={node.label} onChange={(label) => onChange((current) => ({ ...current, label } as ViewNode))} />
        <PropertyInput label="Value" value={bindableToInput(node.value)} onChange={(value) => onChange((current) => ({ ...current, value: inputToBindable(value) } as ViewNode))} />
        <PropertyInput label="Delta" value={bindableToInput(node.delta ?? '')} onChange={(delta) => onChange((current) => ({ ...current, delta: inputToBindable(delta) } as ViewNode))} />
      </>
    );
  }
  if (node.type === 'Button') {
    return (
      <>
        <PropertyInput label="Label" value={node.label} onChange={(label) => onChange((current) => ({ ...current, label } as ViewNode))} />
        <PropertyInput label="Action" value={node.action.action} onChange={(action) => onChange((current) => ({ ...current, action: { ...(current as Extract<ViewNode, { type: 'Button' }>).action, action } } as ViewNode))} />
      </>
    );
  }
  if (node.type === 'Image') {
    return (
      <>
        <PropertyInput label="Source" value={bindableToInput(node.src)} onChange={(src) => onChange((current) => ({ ...current, src: inputToBindable(src) } as ViewNode))} />
        <PropertyInput label="Alt" value={node.alt ?? ''} onChange={(alt) => onChange((current) => ({ ...current, alt } as ViewNode))} />
      </>
    );
  }
  if (node.type === 'Table') {
    return (
      <>
        <CollectionSelect node={node} collections={collections} onChange={onChange} />
        <PropertyInput
          label="Columns"
          value={node.columns.map((column) => column.key).join(', ')}
          onChange={(value) => onChange((current) => ({
            ...current,
            columns: value.split(',').map((part) => part.trim()).filter(Boolean).map((key) => ({ key, label: key })),
          } as ViewNode))}
        />
      </>
    );
  }
  if (node.type === 'Badge') {
    return <PropertyInput label="Value" value={bindableToInput(node.value)} onChange={(value) => onChange((current) => ({ ...current, value: inputToBindable(value) } as ViewNode))} />;
  }
  return <div className="rounded-card border border-line bg-canvas p-3 text-[12px] text-text-muted">No editable fields for this block.</div>;
}

function CollectionSelect({
  node,
  collections,
  onChange,
}: {
  node: Extract<ViewNode, { type: 'Table' }>;
  collections: CollectionInfo[];
  onChange: (mutator: (node: ViewNode) => ViewNode) => void;
}) {
  return (
    <label className="block text-[11px] font-medium text-text-muted">
      Collection
      <select
        value={node.bind.collection}
        onChange={(event) => onChange((current) => ({
          ...current,
          bind: { ...(current as Extract<ViewNode, { type: 'Table' }>).bind, collection: event.target.value },
        } as ViewNode))}
        className="mt-1 h-8 w-full rounded-md border border-line bg-canvas px-2 text-[12px] text-text-primary outline-none focus:border-accent"
      >
        {collections.length === 0 ? <option value={node.bind.collection}>{node.bind.collection}</option> : null}
        {collections.map((collection) => <option key={collection.id} value={collection.name}>{collection.name}</option>)}
      </select>
    </label>
  );
}

function PropertyInput({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return (
    <label className="block text-[11px] font-medium text-text-muted">
      {label}
      <input value={value} onChange={(event) => onChange(event.target.value)} className="mt-1 h-8 w-full rounded-md border border-line bg-canvas px-2 text-[12px] text-text-primary outline-none focus:border-accent" />
    </label>
  );
}

function PropertyTextarea({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return (
    <label className="block text-[11px] font-medium text-text-muted">
      {label}
      <textarea value={value} onChange={(event) => onChange(event.target.value)} className="mt-1 min-h-20 w-full resize-none rounded-md border border-line bg-canvas p-2 text-[12px] text-text-primary outline-none focus:border-accent" />
    </label>
  );
}

function bindableToInput(value: unknown): string {
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (typeof record.$row === 'string') return `$row.${record.$row}`;
    if (typeof record.$state === 'string') return `$state.${record.$state}`;
    if (typeof record.$bind === 'string') return `$bind.${record.$bind}`;
  }
  return value == null ? '' : String(value);
}

function inputToBindable(value: string) {
  if (value.startsWith('$row.')) return { $row: value.slice(5) };
  if (value.startsWith('$state.')) return { $state: value.slice(7) };
  if (value.startsWith('$bind.')) return { $bind: value.slice(6) };
  return value;
}

function surfaceNodeLabel(node: ViewNode): string {
  if (node.type === 'Metric') return node.label;
  if (node.type === 'Button') return node.label;
  if (node.type === 'Table') return node.bind.collection;
  if (node.type === 'Image') return bindableToInput(node.src);
  if ('value' in node) return bindableToInput(node.value);
  if ('title' in node && node.title) return node.title;
  return canHaveChildren(node) ? `${node.children.length} children` : '';
}

function DataFacet({ collections }: { collections: CollectionInfo[] }) {
  return (
    <main className="h-full min-h-0 overflow-auto p-6">
      <div className="mb-4">
        <h2 className="text-[15px] font-semibold text-text-primary">Data</h2>
        <p className="mt-1 text-[12px] text-text-muted">Typed datastore collections owned by this App.</p>
      </div>
      {collections.length === 0 ? (
        <FacetEmpty icon={<Database size={30} />} title="No collections yet" body="Collections defined by agents or app actions appear here, each a typed table the Interface can bind to." />
      ) : (
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2 xl:grid-cols-3">
          {collections.map((collection) => (
            <div key={collection.id} className="rounded-card border border-line bg-surface p-4">
              <div className="text-[14px] font-semibold text-text-primary">{collection.name}</div>
              <div className="mt-1 text-[12px] text-text-muted">{collection.schema.fields.length} fields</div>
              <div className="mt-3 flex flex-wrap gap-1.5">
                {collection.schema.fields.slice(0, 8).map((field) => (
                  <span key={field.key} className="rounded-full border border-line bg-canvas px-2 py-0.5 text-[10px] text-text-secondary">
                    {field.key}:{field.type}
                  </span>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </main>
  );
}

// ── Brain facet — the App's intelligence (memory bound to this App) ──────────

function BrainFacet({ app }: { app: AppRecord }) {
  // Scoped to the App, not a single workflow: this is the memory the operator
  // forms and the records promoted via data_promote_memory (AGENTIC-APPS-10X §5.4).
  return <WorkflowBrainTab workflow={{ id: app.id, title: app.name }} kind="app" />;
}

// ── Shared helpers ───────────────────────────────────────────

function FacetEmpty({
  icon,
  title,
  body,
  action,
}: {
  icon: ReactNode;
  title: string;
  body: string;
  action?: { label: string; onClick: () => void; busy?: boolean };
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center px-6 text-center text-text-muted">
      <div className="mb-3 text-text-secondary">{icon}</div>
      <div className="text-[14px] font-medium text-text-secondary">{title}</div>
      <p className="mt-1 max-w-md text-[12px] leading-relaxed">{body}</p>
      {action ? (
        <button
          type="button"
          onClick={action.onClick}
          disabled={action.busy}
          className="mt-4 inline-flex h-9 items-center gap-1.5 rounded-btn bg-accent px-4 text-[12px] font-semibold text-canvas hover:bg-accent-hover disabled:opacity-50"
        >
          {action.busy ? <Loader2 size={13} className="animate-spin" /> : <Plus size={13} />}
          {action.label}
        </button>
      ) : null}
    </div>
  );
}

function uniqueName(base: string, existing: string[]): string {
  if (!existing.includes(base)) return base;
  let n = 2;
  while (existing.includes(`${base}-${n}`)) n += 1;
  return `${base}-${n}`;
}
