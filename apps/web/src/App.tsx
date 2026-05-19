import { Routes, Route, Navigate, useNavigate } from 'react-router-dom';
import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { Search, Check, Plus, ChevronDown } from 'lucide-react';
import clsx from 'clsx';
import { LoginPage } from './pages/LoginPage';
import { CommandPalette } from './components/CommandPalette';
import { LiveStrip } from './components/LiveStrip';
import { OnboardingStrip } from './components/OnboardingStrip';
import { Sidebar } from './components/Sidebar';
import { ChatPanelMount } from './components/chat/ChatPanelMount';
import { ChatPanelHeaderButton } from './components/chat/ChatPanelHeaderButton';
import { NotificationPanel } from './components/shared/NotificationPanel';
import { AvatarMenu } from './components/shared/AvatarMenu';
import { ConfirmProvider } from './components/shared/ConfirmDialog';
import { ToastProvider } from './components/shared/Toast';
import { tokens, workspace as wsStore, ambient as ambientStore, api, logout } from './lib/api';
import { useAgentisStore } from './store/agentisStore';
import { useLocation } from 'react-router-dom';
// Initialize theme on app boot
import './components/shared/ThemeToggle';

const HomePage = lazy(() => import('./pages/HomePage').then((m) => ({ default: m.HomePage })));
const WorkflowsPage = lazy(() => import('./pages/WorkflowsPage').then((m) => ({ default: m.WorkflowsPage })));
const WorkflowCanvasPage = lazy(() => import('./pages/WorkflowCanvasPage').then((m) => ({ default: m.WorkflowCanvasPage })));
const RunDetailPage = lazy(() => import('./pages/RunDetailPage').then((m) => ({ default: m.RunDetailPage })));
const AgentsPage = lazy(() => import('./pages/AgentsPage').then((m) => ({ default: m.AgentsPage })));
const AgentDetailPage = lazy(() => import('./pages/AgentDetailPage').then((m) => ({ default: m.AgentDetailPage })));
const PackagesPage = lazy(() => import('./pages/PackagesPage').then((m) => ({ default: m.PackagesPage })));
const KnowledgePage = lazy(() => import('./pages/KnowledgePage').then((m) => ({ default: m.KnowledgePage })));
const KnowledgeBasePage = lazy(() => import('./pages/KnowledgeBasePage').then((m) => ({ default: m.KnowledgeBasePage })));
const HistoryPage = lazy(() => import('./pages/HistoryPage').then((m) => ({ default: m.HistoryPage })));
const SettingsPage = lazy(() => import('./pages/SettingsPage').then((m) => ({ default: m.SettingsPage })));
const WorkspacesPage = lazy(() => import('./pages/WorkspacesPage').then((m) => ({ default: m.WorkspacesPage })));
const ChatPage = lazy(() => import('./pages/ChatPage').then((m) => ({ default: m.ChatPage })));
const ArtifactsPage = lazy(() => import('./pages/ArtifactsPage').then((m) => ({ default: m.ArtifactsPage })));

interface Workspace {
  id: string;
  name: string;
  slug: string;
  imageUrl?: string | null;
}

interface OperatorMe {
  id: string;
  email: string;
  name: string;
  avatarUrl?: string | null;
}

function storeLaunchSession(json: { accessToken: string; refreshToken: string }) {
  tokens.set(json.accessToken, json.refreshToken);
}

async function tryLaunchTokenAuth(token: string): Promise<boolean> {
  try {
    const res = await fetch('/v1/auth/launch', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token }),
    });
    if (!res.ok) return false;
    const json = (await res.json()) as { accessToken: string; refreshToken: string };
    storeLaunchSession(json);
    window.history.replaceState({}, '', window.location.pathname);
    return true;
  } catch {
    return false;
  }
}

async function tryLocalLaunchAuth(): Promise<boolean> {
  try {
    const res = await fetch('/v1/auth/launch', { method: 'GET' });
    if (!res.ok) return false;
    const json = (await res.json()) as { accessToken: string; refreshToken: string };
    storeLaunchSession(json);
    return true;
  } catch {
    return false;
  }
}

export function App() {
  const [authed, setAuthed] = useState<boolean>(false);
  const [initializing, setInitializing] = useState<boolean>(true);
  const [initializingLabel, setInitializingLabel] = useState<string>('Loading...');
  const [ws, setWs] = useState<Workspace | null>(null);
  const [wsReady, setWsReady] = useState<boolean>(false);
  const [me, setMe] = useState<OperatorMe | null>(null);

  useEffect(() => {
    void (async () => {
      const urlToken = new URLSearchParams(window.location.search).get('token');
      if (urlToken) {
        try { logout(); } catch { /* noop */ }
        setInitializingLabel('Opening Agentis...');
        const launched = await tryLaunchTokenAuth(urlToken);
        if (launched) {
          setAuthed(true);
          setInitializing(false);
          return;
        }
      }
      if (tokens.access()) {
        setAuthed(true);
        setInitializing(false);
        return;
      }
      setInitializingLabel('Opening Agentis...');
      const launched = await tryLocalLaunchAuth();
      if (launched) {
        setAuthed(true);
        setInitializing(false);
        return;
      }
      setInitializingLabel('Loading...');
      setInitializing(false);
    })();
  }, []);

  useEffect(() => {
    if (!authed) return;
    void (async () => {
      try {
        const [data, meData] = await Promise.all([
          api<{ workspaces: Workspace[] }>('/v1/workspaces'),
          api<{ user: OperatorMe }>('/v1/auth/me').catch(() => null),
        ]);
        const current = wsStore.get();
        const picked = data.workspaces.find((w) => w.id === current) ?? data.workspaces[0] ?? null;
        if (picked) {
          wsStore.set(picked.id);
          useAgentisStore.getState().setContext(picked.id, ambientStore.get());
          setWs(picked);
        }
        if (meData?.user) setMe(meData.user);
      } catch {
        logout();
        setAuthed(false);
      } finally {
        setWsReady(true);
      }
    })();
  }, [authed]);

  if (initializing) {
    return (
      <div className="flex h-screen items-center justify-center bg-canvas text-[13px] text-text-muted">
        {initializingLabel}
      </div>
    );
  }

  if (!authed) {
    return (
      <Routes>
        <Route path="*" element={<LoginPage onSuccess={() => { setWsReady(false); setAuthed(true); }} />} />
      </Routes>
    );
  }

  if (!wsReady) {
    return (
      <div className="flex h-screen items-center justify-center bg-canvas text-[13px] text-text-muted">
        Loading…
      </div>
    );
  }

  return (
    <ToastProvider>
      <ConfirmProvider>
        <Shell
          workspaceName={ws?.name ?? '…'}
          workspaceImage={ws?.imageUrl ?? null}
          workspaceId={ws?.id ?? null}
          operator={me}
          onLogout={() => {
            logout();
            useAgentisStore.getState().clearContext();
            setAuthed(false);
            setWsReady(false);
          }}
        >
          <Suspense fallback={<RouteFallback />}>
            <Routes>
              <Route path="/" element={<Navigate to="/home" replace />} />
              <Route path="/home" element={<HomePage />} />
              <Route path="/agents" element={<AgentsPage />} />
              <Route path="/agents/:id" element={<AgentDetailPage />} />
              <Route path="/workflows" element={<WorkflowsPage />} />
              <Route path="/workflows/:id" element={<WorkflowCanvasPage />} />
              <Route path="/knowledge" element={<KnowledgePage />} />
              <Route path="/knowledge/bases/:knowledgeBaseId" element={<KnowledgeBasePage />} />
              <Route path="/artifacts" element={<ArtifactsPage />} />
              <Route path="/packages" element={<PackagesPage />} />
              <Route path="/history" element={<HistoryPage />} />
              <Route path="/runs/:id" element={<RunDetailPage />} />
              <Route path="/chat" element={<ChatPage />} />
              <Route path="/chat/agent/:agentId" element={<ChatPage />} />
              <Route path="/workspaces" element={<WorkspacesPage />} />
              <Route path="/settings" element={<SettingsPage />} />

              {/* Backward-compat redirects */}
              <Route path="/fleet" element={<Navigate to="/home" replace />} />
              <Route path="/runs" element={<Navigate to="/history?tab=runs" replace />} />
              <Route path="/activity" element={<Navigate to="/history?tab=activity" replace />} />
              <Route path="/approvals" element={<Navigate to="/home" replace />} />
              <Route path="/gateways" element={<Navigate to="/settings?tab=connections" replace />} />
              <Route path="/conversations" element={<Navigate to="/chat" replace />} />
              <Route path="/conversations/:agentId" element={<Navigate to="/chat" replace />} />
              <Route path="/settings/channels" element={<Navigate to="/settings?tab=connections" replace />} />
              <Route path="/skills" element={<Navigate to="/packages?tab=skills" replace />} />

              <Route path="*" element={<Navigate to="/home" replace />} />
            </Routes>
          </Suspense>
          <CommandPalette />
        </Shell>
      </ConfirmProvider>
    </ToastProvider>
  );
}

function RouteFallback() {
  return (
    <div className="flex h-full items-center justify-center text-[13px] text-text-muted">
      Loading…
    </div>
  );
}

function Shell({
  children,
  workspaceName,
  workspaceImage,
  workspaceId,
  operator,
  onLogout,
}: {
  children: React.ReactNode;
  workspaceName: string;
  workspaceImage: string | null;
  workspaceId: string | null;
  operator: OperatorMe | null;
  onLogout: () => void;
}) {
  const nav = useNavigate();
  const location = useLocation();
  const onChatPage = location.pathname.startsWith('/chat');
  const embedded = new URLSearchParams(location.search).get('embed') === '1';

  if (embedded) {
    return <main className="h-full min-h-0 bg-canvas">{children}</main>;
  }

  return (
    <div className="flex h-full flex-col bg-canvas" data-agentis-shell>
      <header data-agentis-shell-header className="flex h-12 shrink-0 items-center gap-3 border-b border-line bg-surface px-4">
        <button
          onClick={() => nav('/home')}
          className="flex items-center gap-2 text-[13px] font-semibold text-text-primary"
        >
          <span className="inline-block h-2 w-2 rounded-full bg-accent shadow-glow" />
          Agentis
        </button>
        <span className="text-text-muted">/</span>
        <WorkspaceSwitcher
          workspaceName={workspaceName}
          workspaceImage={workspaceImage}
          workspaceId={workspaceId}
        />
        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            onClick={() => {
              const ev = new KeyboardEvent('keydown', { key: 'k', metaKey: true });
              window.dispatchEvent(ev);
            }}
            className="inline-flex h-9 items-center gap-1.5 rounded-btn border border-line bg-surface-2 px-2.5 text-[12px] text-text-muted transition-colors hover:bg-surface-3 hover:text-text-primary"
            title="Search (⌘K)"
          >
            <Search size={12} />
            Search
            <span className="rounded border border-line px-1 py-0.5 text-[9px]">⌘K</span>
          </button>
          <NotificationPanel />
          {!onChatPage && <ChatPanelHeaderButton />}
          <AvatarMenu
            name={operator?.name ?? 'Operator'}
            email={operator?.email}
            imageUrl={operator?.avatarUrl ?? undefined}
            onLogout={onLogout}
          />
        </div>
      </header>
      <div data-agentis-onboarding-strip>
        <OnboardingStrip />
      </div>
      <div data-agentis-shell-layout className="flex min-h-0 flex-1">
        <Sidebar />
        <main data-agentis-shell-main className="min-h-0 flex-1 overflow-auto">{children}</main>
        {!onChatPage && <ChatPanelMount />}
      </div>
      <div data-agentis-live-strip>
        <LiveStrip />
      </div>
    </div>
  );
}

function workspaceInitial(name: string): string {
  return (name?.[0] ?? '?').toUpperCase();
}

function WorkspaceSwitcher({
  workspaceName,
  workspaceImage,
  workspaceId,
}: {
  workspaceName: string;
  workspaceImage: string | null;
  workspaceId: string | null;
}) {
  const nav = useNavigate();
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<Workspace[]>([]);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const popoverRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void api<{ workspaces: Workspace[] }>('/v1/workspaces')
      .then((d) => { if (!cancelled) setItems(d.workspaces ?? []); })
      .catch(() => {});
    const onClick = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('mousedown', onClick);
    window.addEventListener('keydown', onKey);
    return () => {
      cancelled = true;
      window.removeEventListener('mousedown', onClick);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  function pick(ws: Workspace) {
    if (ws.id === workspaceId) { setOpen(false); return; }
    wsStore.set(ws.id);
    setOpen(false);
    // Hard reload to re-fetch all workspace-scoped data cleanly.
    window.location.reload();
  }

  async function createWorkspace(e: React.FormEvent) {
    e.preventDefault();
    const name = newName.trim();
    if (!name) return;
    try {
      const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || `workspace-${Date.now().toString(36)}`;
      const res = await api<{ workspace: Workspace }>('/v1/workspaces', {
        method: 'POST',
        body: JSON.stringify({ name, slug }),
      });
      wsStore.set(res.workspace.id);
      setNewName('');
      setCreating(false);
      window.location.reload();
    } catch {
      // Toast would be nice here but the parent owns ToastProvider context.
      setCreating(false);
    }
  }

  return (
    <div className="relative" ref={popoverRef}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={clsx(
          'flex items-center gap-2 rounded-md px-1.5 py-0.5 text-[13px] text-text-secondary transition-colors hover:bg-surface-2 hover:text-text-primary',
          open && 'bg-surface-2 text-text-primary',
        )}
      >
        {workspaceImage ? (
          <img src={workspaceImage} alt="" className="h-5 w-5 rounded-md object-cover" />
        ) : (
          <span className="flex h-5 w-5 items-center justify-center rounded-md bg-surface-2 text-[10px] font-semibold text-text-primary">
            {workspaceInitial(workspaceName)}
          </span>
        )}
        {workspaceName}
        <ChevronDown size={12} className="text-text-muted" />
      </button>
      {open && (
        <div className="absolute left-0 top-full z-50 mt-1 w-64 overflow-hidden rounded-card border border-line bg-surface shadow-dropdown">
          <div className="max-h-72 overflow-y-auto py-1">
            {items.length === 0 ? (
              <div className="px-3 py-3 text-[12px] text-text-muted">Loading…</div>
            ) : (
              items.map((w) => {
                const isActive = w.id === workspaceId;
                return (
                  <button
                    key={w.id}
                    type="button"
                    onClick={() => pick(w)}
                    className={clsx(
                      'flex w-full items-center gap-2 px-3 py-2 text-left text-[13px] transition-colors',
                      isActive ? 'bg-surface-2 text-text-primary' : 'text-text-secondary hover:bg-surface-2 hover:text-text-primary',
                    )}
                  >
                    {w.imageUrl ? (
                      <img src={w.imageUrl} alt="" className="h-5 w-5 rounded-md object-cover" />
                    ) : (
                      <span className="flex h-5 w-5 items-center justify-center rounded-md bg-surface-2 text-[10px] font-semibold text-text-primary">
                        {workspaceInitial(w.name)}
                      </span>
                    )}
                    <span className="flex-1 truncate">{w.name}</span>
                    {isActive && <Check size={12} className="text-accent" />}
                  </button>
                );
              })
            )}
          </div>
          <div className="border-t border-line">
            {creating ? (
              <form onSubmit={createWorkspace} className="flex gap-1.5 p-2">
                <input
                  autoFocus
                  type="text"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Escape') { setCreating(false); setNewName(''); } }}
                  placeholder="Workspace name"
                  className="h-7 flex-1 rounded-input border border-line bg-surface-2 px-2 text-[12px] text-text-primary placeholder:text-text-muted focus:border-accent focus:outline-none"
                />
                <button
                  type="submit"
                  disabled={!newName.trim()}
                  className="inline-flex h-7 items-center rounded-btn bg-accent px-2 text-[11px] font-semibold text-canvas hover:bg-accent-hover disabled:opacity-50"
                >
                  Add
                </button>
              </form>
            ) : (
              <button
                type="button"
                onClick={() => setCreating(true)}
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-[12px] text-text-secondary hover:bg-surface-2 hover:text-text-primary"
              >
                <Plus size={12} /> New workspace
              </button>
            )}
            <button
              type="button"
              onClick={() => { setOpen(false); nav('/settings?tab=workspace'); }}
              className="block w-full border-t border-line px-3 py-2 text-left text-[11px] text-text-muted hover:bg-surface-2 hover:text-text-primary"
            >
              Manage workspace settings →
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
