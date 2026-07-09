/**
 * AppRuntime — the end-user shell + renderer for an Agentic App
 * (APP-INTERFACE-10X §2.1).
 *
 * An App no longer renders as a bare tab bar over one scrolling column: the
 * runtime OWNS product chrome — sidebar page navigation, a topbar with the live
 * operations cluster (active-run pulse, pending approvals), and a slide-over ops
 * drawer (Runs / Agent activity / Approvals / Rules) available on every page.
 * Chrome is DERIVED, never agent-authored: agents author page content, so every
 * existing surface upgrades to the shell with zero migration. The root node's
 * `style.shell` ('full' | 'minimal' | 'none') overrides the default (full when
 * the app has multiple pages or bound workflows).
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  Activity, AlertTriangle, Brain, ChevronLeft, ChevronRight, Columns3, Contact2, FileText,
  GanttChartSquare, GitBranch, Home, LayoutDashboard, Loader2, MessagesSquare, PanelRight,
  Settings2, ShieldCheck, X,
} from 'lucide-react';
import clsx from 'clsx';
import { useSearchParams } from 'react-router-dom';
import { createInProcessAppClient } from '@agentis/app-client';
import type { AppRecord, AppSurface, ViewNode } from '@agentis/core';
import { REALTIME_EVENTS } from '@agentis/core';
import { appsApi } from '../../lib/appsApi';
import { isActiveRunStatus, opsApi } from '../../lib/opsApi';
import { apiErrorMessage } from '../../lib/api';
import { useRealtime, type RealtimeEnvelope } from '../../lib/realtime';
import { RuntimeProvider, ViewRenderer, useDataRevision } from './ViewRenderer';
import {
  AgentFeedView, ApprovalsInboxView, OrchestrationPanelView, RunMonitorView, useAppWorkflows,
} from './blocks/opsBlocks';

type ShellMode = 'full' | 'minimal' | 'none';
type DrawerTab = 'runs' | 'activity' | 'approvals' | 'rules';

export function AppRuntime({ appId, surfaceName, hideShellNav = false }: { appId: string; surfaceName?: string; hideShellNav?: boolean }) {
  const [app, setApp] = useState<AppRecord | null>(null);
  const [surfaces, setSurfaces] = useState<AppSurface[] | null>(null);
  const [allowCustomCode, setAllowCustomCode] = useState(false);
  const [uiState, setUiState] = useState<Record<string, unknown>>({});
  const uiStateRef = useRef(uiState);
  // Real routing (INTERFACE-OVERHAUL-10X §2.3): the active page lives in the URL
  // (`?page=<surface>`), so browser back/forward, refresh and sharing all work.
  const [searchParams, setSearchParams] = useSearchParams();
  const urlPage = searchParams.get('page');
  const [activeSurfaceName, setActiveSurfaceName] = useState(urlPage ?? surfaceName ?? 'home');
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const dataRevision = useDataRevision(appId);

  useEffect(() => {
    uiStateRef.current = uiState;
  }, [uiState]);

  useEffect(() => {
    setActiveSurfaceName(urlPage ?? surfaceName ?? 'home');
  }, [urlPage, surfaceName]);

  const gotoSurface = useCallback((name: string) => {
    setActiveSurfaceName(name);
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set('page', name);
      return next;
    });
  }, [setSearchParams]);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    Promise.all([appsApi.get(appId), appsApi.listSurfaces(appId)])
      .then(([appRecord, list]) => {
        if (cancelled) return;
        setApp(appRecord);
        setAllowCustomCode(appRecord.policy.customCode === 'allowed');
        setSurfaces(list);
        if (list.length === 0) setError('This app has no surface yet. Ask the agent to render one.');
      })
      .catch((err) => {
        if (!cancelled) setError(apiErrorMessage(err));
      });
    return () => {
      cancelled = true;
    };
  }, [appId, reloadKey]);

  // Derive the active surface from the loaded list — switching pages is instant
  // (no re-fetch); a SURFACE_RENDER/PATCH event bumps reloadKey to refresh views.
  const surface = useMemo(
    () => (surfaces ?? []).find((s) => s.name === activeSurfaceName) ?? surfaces?.[0] ?? null,
    [surfaces, activeSurfaceName],
  );

  const onSurfaceEvent = useCallback(
    (env: RealtimeEnvelope) => {
      const payload = env.payload as { appId?: string; region?: string } | undefined;
      if (payload?.appId && payload.appId !== appId) return;
      // Performed-region pushes (Phase M3) carry a `region` and are handled in
      // place by the matching AgentRegion node — a full reload would wipe the
      // transient (un-pinned) content, so skip it here.
      if (payload?.region) return;
      setReloadKey((k) => k + 1);
    },
    [appId],
  );
  useRealtime(useMemo(() => [REALTIME_EVENTS.SURFACE_RENDER, REALTIME_EVENTS.SURFACE_PATCH], []), onSurfaceEvent);

  const invokeAction = useCallback(
    async (action: string, args?: Record<string, unknown>) => {
      if (!surface) return undefined;
      return appsApi.dispatchAction(appId, surface.name, action, args ?? {});
    },
    [appId, surface],
  );

  const query = useCallback(
    async (collection: string, q?: { filter?: Record<string, unknown>; sort?: Array<{ field: string; dir: 'asc' | 'desc' }>; limit?: number }) => {
      const res = await appsApi.query(appId, collection, q ?? {});
      return res.rows.map((r) => ({ id: r.id, ...r.data }));
    },
    [appId],
  );

  const setStateValue = useCallback((key: string, value: unknown) => {
    setUiState((prev) => setPath(prev, key, value));
  }, []);

  const navigate = useCallback((targetSurface: string, params?: Record<string, unknown>) => {
    setUiState((prev) => ({ ...prev, params: params ?? {} }));
    gotoSurface(targetSurface);
  }, [gotoSurface]);

  const client = useMemo(
    () =>
      createInProcessAppClient({
        appId,
        surface: surface?.name ?? activeSurfaceName,
        query,
        invokeAction,
        getState: (key) => (key ? getPath(uiStateRef.current, key) : uiStateRef.current),
        setState: setStateValue,
        navigate,
      }),
    [activeSurfaceName, appId, invokeAction, navigate, query, setStateValue, surface?.name],
  );

  const ctx = useMemo(
    () =>
      surface
        ? {
            appId,
            surface: surface.name,
            client,
            surfaceActions: surface.actions,
            uiState,
            allowCustomCode,
            dataRevision,
          }
        : null,
    [allowCustomCode, appId, client, dataRevision, surface, uiState],
  );

  if (error) {
    return (
      <div className="flex min-h-[40vh] items-center justify-center">
        <div className="flex items-center gap-2 rounded-card border border-line bg-surface px-4 py-3 text-[13px] text-text-secondary">
          <AlertTriangle size={16} className="text-warn" />
          {error}
        </div>
      </div>
    );
  }
  if (!surface || !ctx || !app) {
    return (
      <div className="flex min-h-[40vh] items-center justify-center text-text-muted">
        <Loader2 size={18} className="animate-spin" />
      </div>
    );
  }

  return (
    <RuntimeProvider value={ctx}>
      <AppShell
        app={app}
        appId={appId}
        surfaces={surfaces ?? []}
        active={surface}
        onNavigate={gotoSurface}
        hideShellNav={hideShellNav}
      >
        {surface.view ? (
          <ViewRenderer node={hideShellNav ? stripEmbeddedDuplicateTitle(surface.view, app.name) : surface.view} />
        ) : (
          <p className="p-6 text-text-muted">Empty surface.</p>
        )}
      </AppShell>
    </RuntimeProvider>
  );
}

// ── App Shell ─────────────────────────────────────────────────

/** Live ops status for the shell topbar: active runs + pending approvals. */
function useOpsStatus(appId: string): { runningRuns: number; waitingRuns: number; pendingApprovals: number } {
  const { workflows } = useAppWorkflows(appId);
  // A run parked WAITING/PAUSED (e.g. blocked on a rate limit, or paused by the
  // the shell pill never claims "running" for a run that is merely in-flight.
  const active = (workflows ?? []).filter((w) => w.activeRun && isActiveRunStatus(w.activeRun.status));
  const runningRuns = active.filter((w) => (w.activeRun?.status ?? '').toUpperCase() === 'RUNNING').length;
  const waitingRuns = active.length - runningRuns;
  const [pendingApprovals, setPendingApprovals] = useState(0);
  const reload = useCallback(() => {
    opsApi.listApprovals().then((rows) => setPendingApprovals(rows.length)).catch(() => undefined);
  }, []);
  useEffect(() => { reload(); }, [reload]);
  useRealtime(useMemo(() => [REALTIME_EVENTS.APPROVAL_REQUESTED, REALTIME_EVENTS.APPROVAL_RESOLVED], []), reload);
  return { runningRuns, waitingRuns, pendingApprovals };
}

function AppShell({ app, appId, surfaces, active, onNavigate, children, hideShellNav = false }: {
  app: AppRecord;
  appId: string;
  hideShellNav?: boolean;
  surfaces: AppSurface[];
  active: AppSurface;
  onNavigate: (name: string) => void;
  children: ReactNode;
}) {
  const { workflows } = useAppWorkflows(appId);
  const { runningRuns, waitingRuns, pendingApprovals } = useOpsStatus(appId);
  const [collapsed, setCollapsed] = useState(false);

  // The ops drawer is deep-linkable (`?ops=runs|activity|approvals|rules`) so
  const [searchParams, setSearchParams] = useSearchParams();
  const opsParam = searchParams.get('ops');
  const drawer: DrawerTab | null = opsParam === 'runs' || opsParam === 'activity' || opsParam === 'approvals' || opsParam === 'rules' ? opsParam : null;
  const setDrawer = useCallback((next: DrawerTab | null | ((d: DrawerTab | null) => DrawerTab | null)) => {
    setSearchParams((prev) => {
      const cur = prev.get('ops');
      const curTab: DrawerTab | null = cur === 'runs' || cur === 'activity' || cur === 'approvals' || cur === 'rules' ? cur : null;
      const resolved = typeof next === 'function' ? next(curTab) : next;
      const out = new URLSearchParams(prev);
      if (resolved) out.set('ops', resolved); else out.delete('ops');
      return out;
    }, { replace: true });
  }, [setSearchParams]);

  // Run feedback: a workflow action that starts a run announces itself (see
  // useActionInvoker) — surface a live chip that deep-links into the ops drawer.
  const [runToast, setRunToast] = useState<{ runId: string; action: string } | null>(null);
  useEffect(() => {
    const onRunStarted = (e: Event) => {
      const detail = (e as CustomEvent).detail as { runId?: string; action?: string } | undefined;
      if (detail?.runId) setRunToast({ runId: detail.runId, action: detail.action ?? 'workflow' });
    };
    window.addEventListener('agentis:run-started', onRunStarted);
    return () => window.removeEventListener('agentis:run-started', onRunStarted);
  }, []);
  useEffect(() => {
    if (!runToast) return;
    const t = setTimeout(() => setRunToast(null), 7000);
    return () => clearTimeout(t);
  }, [runToast]);

  const rootStyle = active.view?.style as { shell?: ShellMode; appearance?: 'auto' | 'light' | 'dark' } | undefined;
  const appearance = rootStyle?.appearance && rootStyle.appearance !== 'auto' ? rootStyle.appearance : undefined;
  const hasOps = (workflows?.length ?? 0) > 0;
  const mode: ShellMode = rootStyle?.shell ?? (surfaces.length > 1 || hasOps ? 'full' : 'minimal');

  if (hideShellNav) {
    return (
      <div
        className="s-surface h-full min-h-0 w-full overflow-auto bg-canvas text-text-primary"
        {...(appearance ? { 'data-appearance': appearance } : {})}
      >
        <div className="w-full p-3 sm:p-4 lg:p-5">{children}</div>
      </div>
    );
  }

  if (mode === 'none') {
    return <div className="s-surface w-full bg-canvas p-4 sm:p-6" {...(appearance ? { 'data-appearance': appearance } : {})}>{children}</div>;
  }

  const showSidebar = mode === 'full' && surfaces.length > 0;

  return (
    <div
      className="s-surface relative flex h-full min-h-[60vh] w-full overflow-hidden bg-canvas text-text-primary"
      {...(appearance ? { 'data-appearance': appearance } : {})}
    >
      {/* Sidebar — the app's pages */}
      {showSidebar ? (
        <aside
          className={clsx(
            'hidden shrink-0 flex-col border-r border-line bg-surface transition-[width] duration-200 md:flex',
            collapsed ? 'w-[60px]' : 'w-[232px]',
          )}
        >
          <div className={clsx('flex h-14 items-center gap-2.5 border-b border-line px-3.5', collapsed && 'justify-center px-0')}>
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px] bg-accent text-[13px] font-bold text-on-accent shadow-sm">
              {(app.icon && app.icon.length <= 2 ? app.icon : null) ?? app.name.charAt(0).toUpperCase()}
            </span>
            {!collapsed ? (
              <span className="min-w-0">
                <span className="block truncate text-[13.5px] font-semibold leading-tight tracking-[-0.01em]">{app.name}</span>
                <span className="block text-[10.5px] text-text-muted">v{app.version}</span>
              </span>
            ) : null}
          </div>
          <nav className="flex-1 space-y-0.5 overflow-y-auto px-2 py-3" aria-label="App pages">
            {surfaces.map((s) => {
              const isActive = s.name === active.name;
              return (
                <button
                  key={s.name}
                  type="button"
                  onClick={() => onNavigate(s.name)}
                  aria-current={isActive ? 'page' : undefined}
                  title={collapsed ? surfaceLabel(s.name) : undefined}
                  className={clsx(
                    'flex w-full items-center gap-2.5 rounded-[10px] px-3 py-2 text-left text-[13px] font-medium transition-colors',
                    collapsed && 'justify-center px-0',
                    isActive
                      ? 'bg-accent-soft text-accent'
                      : 'text-text-secondary hover:bg-surface-2 hover:text-text-primary',
                  )}
                >
                  <span className="shrink-0">{surfaceIcon(s)}</span>
                  {!collapsed ? <span className="truncate">{surfaceLabel(s.name)}</span> : null}
                </button>
              );
            })}
          </nav>
          <button
            type="button"
            onClick={() => setCollapsed((c) => !c)}
            className="flex items-center justify-center border-t border-line py-2 text-text-muted transition-colors hover:text-text-secondary"
            aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          >
            {collapsed ? <ChevronRight size={14} /> : <ChevronLeft size={14} />}
          </button>
        </aside>
      ) : null}

      {/* Main column */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Topbar */}
        <header className="flex h-14 shrink-0 items-center gap-2.5 border-b border-line bg-surface/85 px-4 backdrop-blur sm:px-5">
          {!showSidebar ? (
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-btn bg-accent-soft text-[11px] font-bold text-accent">
              {(app.icon && app.icon.length <= 2 ? app.icon : null) ?? app.name.charAt(0).toUpperCase()}
            </span>
          ) : null}
          <h1 className="min-w-0 truncate text-[15px] font-semibold tracking-[-0.01em]">
            {showSidebar ? surfaceLabel(active.name) : app.name}
          </h1>
          {/* Mobile page switcher */}
          {surfaces.length > 1 ? (
            <select
              value={active.name}
              onChange={(e) => onNavigate(e.target.value)}
              className="ml-1 h-7 max-w-[140px] rounded-btn border border-line bg-canvas px-1.5 text-[11.5px] text-text-secondary outline-none md:hidden"
              aria-label="Switch page"
            >
              {surfaces.map((s) => <option key={s.name} value={s.name}>{surfaceLabel(s.name)}</option>)}
            </select>
          ) : null}
          <div className="ml-auto flex shrink-0 items-center gap-1.5">
            {hasOps ? (
              <button
                type="button"
                onClick={() => setDrawer((d) => (d === 'runs' ? null : 'runs'))}
                className={clsx(
                  'inline-flex h-7 items-center gap-1.5 rounded-full border px-3 text-[11.5px] font-medium transition-colors',
                  runningRuns > 0 ? 'border-success/30 bg-success-soft text-success'
                    : waitingRuns > 0 ? 'border-warn/30 bg-warn-soft text-warn'
                    : 'border-line text-text-muted hover:bg-surface-2 hover:text-text-secondary',
                )}
                title="Runs"
              >
                <span className={clsx('h-1.5 w-1.5 rounded-full',
                  runningRuns > 0 ? 's-pulse bg-success text-success'
                    : waitingRuns > 0 ? 'bg-warn'
                    : 'bg-text-disabled')} />
                {runningRuns > 0 ? `${runningRuns} running`
                  : waitingRuns > 0 ? `${waitingRuns} waiting`
                  : 'idle'}
              </button>
            ) : null}
            {pendingApprovals > 0 ? (
              <button
                type="button"
                onClick={() => setDrawer((d) => (d === 'approvals' ? null : 'approvals'))}
                className="inline-flex h-7 items-center gap-1.5 rounded-full border border-warn/40 bg-warn-soft px-3 text-[11.5px] font-medium text-warn transition-opacity hover:opacity-90"
                title="Pending approvals"
              >
                <ShieldCheck size={13} /> {pendingApprovals}
              </button>
            ) : null}
            {hasOps ? (
              <button
                type="button"
                onClick={() => setDrawer((d) => (d ? null : 'activity'))}
                className={clsx(
                  'inline-flex h-7 w-7 items-center justify-center rounded-btn border transition-colors',
                  drawer ? 'border-accent/40 bg-accent-soft text-accent' : 'border-line text-text-muted hover:bg-surface-2 hover:text-text-secondary',
                )}
                aria-label="Operations drawer"
                title="Operations"
              >
                <PanelRight size={14} />
              </button>
            ) : null}
          </div>
        </header>

        {/* Content */}
        <main className="min-h-0 flex-1 overflow-auto">
          <div className="w-full p-5 sm:p-6 lg:p-7">{children}</div>
        </main>
      </div>

      {/* Run-started chip — the click → run feedback loop */}
      {runToast ? (
        <div className="s-panel absolute bottom-5 right-5 z-40 flex items-center gap-3 px-4 py-3">
          <span className="s-pulse h-2 w-2 shrink-0 rounded-full bg-success text-success" aria-hidden />
          <div className="min-w-0">
            <div className="text-[13px] font-semibold text-text-primary">Run started</div>
            <div className="truncate text-[11.5px] text-text-muted">{surfaceLabel(runToast.action)}</div>
          </div>
          <button
            type="button"
            className="s-btn s-btn-secondary s-btn-sm"
            onClick={() => { setDrawer('runs'); setRunToast(null); }}
          >
            View run
          </button>
          <button type="button" className="s-icon-btn !h-7 !w-7" onClick={() => setRunToast(null)} aria-label="Dismiss">
            <X size={12} />
          </button>
        </div>
      ) : null}

      {/* Ops drawer — Runs / Agent activity / Approvals / Rules on every page */}
      {drawer ? (
        <div className="absolute inset-0 z-30 flex justify-end bg-overlay-soft" role="presentation" onClick={() => setDrawer(null)}>
          <div
            className="flex h-full w-full max-w-[480px] flex-col border-l border-line bg-canvas"
            style={{ boxShadow: 'var(--app-modal-shadow)' }}
            role="dialog"
            aria-label="Operations"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-1 border-b border-line px-2 py-2">
              {(
                [
                  { id: 'runs' as const, label: 'Runs', icon: <Activity size={12} /> },
                  { id: 'activity' as const, label: 'Thinking', icon: <Brain size={12} /> },
                  { id: 'approvals' as const, label: 'Approvals', icon: <ShieldCheck size={12} />, badge: pendingApprovals },
                  { id: 'rules' as const, label: 'Rules', icon: <GitBranch size={12} /> },
                ]
              ).map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => setDrawer(tab.id)}
                  className={clsx(
                    'inline-flex h-8 items-center gap-1.5 rounded-btn px-3 text-[12.5px] font-medium transition-colors',
                    drawer === tab.id ? 'bg-surface-2 text-text-primary' : 'text-text-muted hover:text-text-secondary',
                  )}
                >
                  {tab.icon} {tab.label}
                  {tab.badge ? <span className="rounded-full bg-warn-soft px-1.5 text-[9.5px] font-semibold text-warn">{tab.badge}</span> : null}
                </button>
              ))}
              <button
                type="button"
                onClick={() => setDrawer(null)}
                className="ml-auto flex h-7 w-7 items-center justify-center rounded-btn text-text-muted hover:bg-surface-2 hover:text-text-primary"
                aria-label="Close"
              >
                <X size={14} />
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-auto p-3">
              {drawer === 'runs' ? <RunMonitorView appId={appId} limit={12} /> : null}
              {drawer === 'activity' ? <AgentFeedView appId={appId} limit={60} /> : null}
              {drawer === 'approvals' ? <ApprovalsInboxView appId={appId} limit={20} /> : null}
              {drawer === 'rules' ? <OrchestrationPanelView appId={appId} title="Workflow rules" /> : null}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** Humanize a surface name for navigation ("lead_inbox" → "Lead inbox"). */
function surfaceLabel(name: string): string {
  const s = name.replace(/[_-]+/g, ' ').trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Icon heuristic for a page — derived from the surface name + kind, never authored. */
function surfaceIcon(surface: AppSurface): ReactNode {
  const n = surface.name.toLowerCase();
  const size = 15;
  if (n === 'home' || n === 'main' || n === 'index') return <Home size={size} />;
  if (surface.kind === 'dashboard' || /dash|overview|metric|analytic|report/.test(n)) return <LayoutDashboard size={size} />;
  if (/board|kanban|pipeline|deal|task/.test(n)) return <Columns3 size={size} />;
  if (/record|contact|customer|lead|crm|people|client|account/.test(n)) return <Contact2 size={size} />;
  if (/road|plan|timeline|schedule|calendar|release/.test(n)) return <GanttChartSquare size={size} />;
  if (surface.kind === 'thread' || /inbox|chat|message|thread|conversation|support/.test(n)) return <MessagesSquare size={size} />;
  if (/setting|config|admin|rule/.test(n)) return <Settings2 size={size} />;
  if (/run|ops|monitor|activity|log/.test(n)) return <Activity size={size} />;
  return <FileText size={size} />;
}

function getPath(source: Record<string, unknown>, path: string): unknown {
  return path.split('.').filter(Boolean).reduce<unknown>((acc, key) => {
    if (!acc || typeof acc !== 'object' || Array.isArray(acc)) return undefined;
    return (acc as Record<string, unknown>)[key];
  }, source);
}

function setPath(source: Record<string, unknown>, path: string, value: unknown): Record<string, unknown> {
  const parts = path.split('.').filter(Boolean);
  if (parts.length === 0) return source;
  const [head, ...rest] = parts;
  if (!head) return source;
  if (rest.length === 0) return { ...source, [head]: value };
  const child = source[head];
  return {
    ...source,
    [head]: setPath(child && typeof child === 'object' && !Array.isArray(child) ? child as Record<string, unknown> : {}, rest.join('.'), value),
  };
}

function stripEmbeddedDuplicateTitle(view: ViewNode, appName: string): ViewNode {
  if (!hasViewChildren(view)) {
    return titleLooksLikeApp(view, appName) ? emptyStack(view.style) : view;
  }

  let changed = false;
  const children = view.children.flatMap((child, index) => {
    if (index >= 3 || !titleLooksLikeApp(child, appName)) return [child];
    changed = true;
    return child.type === 'Hero' ? heroReplacement(child) : [];
  });
  if (!changed) return view;

  return {
    ...view,
    children,
  } as ViewNode;
}

function hasViewChildren(node: ViewNode): node is ViewNode & { children: ViewNode[] } {
  return 'children' in node && Array.isArray((node as { children?: unknown }).children);
}

function titleLooksLikeApp(node: ViewNode, appName: string): boolean {
  if (node.type === 'Heading') return titleMatchesApp(node.value, appName);
  if (node.type === 'Hero') return titleMatchesApp(node.title, appName);
  return false;
}

function titleMatchesApp(title: string, appName: string): boolean {
  const normalizedTitle = normalizeTitle(title);
  const normalizedApp = normalizeTitle(appName);
  const unbrandedApp = normalizeTitle(appName.replace(/\bagentis\b/gi, ''));
  if (!normalizedTitle || !normalizedApp) return false;
  return normalizedTitle.startsWith(normalizedApp)
    || normalizedApp.startsWith(normalizedTitle)
    || (unbrandedApp.length > 4 && (normalizedTitle.includes(unbrandedApp) || unbrandedApp.includes(normalizedTitle)));
}

function normalizeTitle(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
}

function emptyStack(style: ViewNode['style']): ViewNode {
  return { type: 'Stack', gap: 12, ...(style ? { style } : {}), children: [] } as ViewNode;
}

function heroReplacement(hero: Extract<ViewNode, { type: 'Hero' }>): ViewNode[] {
  const nodes: ViewNode[] = [];
  if (hero.subtitle) {
    nodes.push({ type: 'Text', value: hero.subtitle, style: { emphasis: 'normal' } } as ViewNode);
  }
  if (hero.actions?.length) {
    nodes.push({
      type: 'Toolbar',
      children: hero.actions.map((action) => ({
        type: 'Button',
        label: action.action.replace(/[_-]+/g, ' '),
        action,
        variant: 'primary',
      } as ViewNode)),
    } as ViewNode);
  }
  return nodes;
}


