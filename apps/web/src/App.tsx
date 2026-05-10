import { Routes, Route, Navigate, useNavigate } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { Search } from 'lucide-react';
import { LoginPage } from './pages/LoginPage';
import { HomePage } from './pages/HomePage';
import { WorkflowsPage } from './pages/WorkflowsPage';
import { WorkflowCanvasPage } from './pages/WorkflowCanvasPage';
import { RunDetailPage } from './pages/RunDetailPage';
import { AgentsPage } from './pages/AgentsPage';
import { AgentDetailPage } from './pages/AgentDetailPage';
import { AppsPage } from './pages/AppsPage';
import { AppDetailPage } from './pages/AppDetailPage';
import { PackagesPage } from './pages/PackagesPage';
import { HistoryPage } from './pages/HistoryPage';
import { SettingsPage } from './pages/SettingsPage';
import { WorkspacesPage } from './pages/WorkspacesPage';
import { ChatPage } from './pages/ChatPage';
import { BrainPage } from './pages/BrainPage';
import { CommandPalette } from './components/CommandPalette';
import { AmbientSelector } from './components/TopBarPills';
import { LiveStrip } from './components/LiveStrip';
import { OnboardingStrip } from './components/OnboardingStrip';
import { Sidebar } from './components/Sidebar';
import { ChatPanel } from './components/chat/ChatPanel';
import { ChatPanelHeaderButton } from './components/chat/ChatPanelHeaderButton';
import { NotificationPanel } from './components/shared/NotificationPanel';
import { AvatarMenu } from './components/shared/AvatarMenu';
import { ConfirmProvider } from './components/shared/ConfirmDialog';
import { ToastProvider } from './components/shared/Toast';
import { tokens, workspace as wsStore, api, logout } from './lib/api';
import { useLocation } from 'react-router-dom';
// Initialize theme on app boot
import './components/shared/ThemeToggle';

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

async function tryLaunchTokenAuth(): Promise<boolean> {
  const params = new URLSearchParams(window.location.search);
  const token = params.get('token');
  if (!token) return false;
  try {
    const res = await fetch('/v1/auth/launch', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token }),
    });
    if (!res.ok) return false;
    const json = (await res.json()) as { accessToken: string; refreshToken: string };
    tokens.set(json.accessToken, json.refreshToken);
    window.history.replaceState({}, '', window.location.pathname);
    return true;
  } catch {
    return false;
  }
}

export function App() {
  const [authed, setAuthed] = useState<boolean>(false);
  const [initializing, setInitializing] = useState<boolean>(true);
  const [ws, setWs] = useState<Workspace | null>(null);
  const [wsReady, setWsReady] = useState<boolean>(false);
  const [me, setMe] = useState<OperatorMe | null>(null);

  useEffect(() => {
    void (async () => {
      const hasUrlToken = new URLSearchParams(window.location.search).has('token');
      if (hasUrlToken) {
        try { logout(); } catch { /* noop */ }
        const launched = await tryLaunchTokenAuth();
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
      setInitializing(false);
    })();
  }, []);

  useEffect(() => {
    if (!authed) return;
    void (async () => {
      try {
        const data = await api<{ workspaces: Workspace[] }>('/v1/workspaces');
        const current = wsStore.get();
        const picked = data.workspaces.find((w) => w.id === current) ?? data.workspaces[0] ?? null;
        if (picked) {
          wsStore.set(picked.id);
          setWs(picked);
        }
        try {
          const meData = await api<{ user: OperatorMe }>('/v1/auth/me');
          setMe(meData.user);
        } catch { /* fine — me endpoint is optional */ }
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
        Loading…
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
            setAuthed(false);
            setWsReady(false);
          }}
        >
          <Routes>
            <Route path="/" element={<Navigate to="/home" replace />} />
            <Route path="/home" element={<HomePage />} />
            <Route path="/agents" element={<AgentsPage />} />
            <Route path="/agents/:id" element={<AgentDetailPage />} />
            <Route path="/workflows" element={<WorkflowsPage />} />
            <Route path="/workflows/:id" element={<WorkflowCanvasPage />} />
            <Route path="/apps" element={<AppsPage />} />
            <Route path="/apps/:slug" element={<AppDetailPage />} />
            <Route path="/brain" element={<BrainPage />} />
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
          <CommandPalette />
        </Shell>
      </ConfirmProvider>
    </ToastProvider>
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

  function workspaceInitial(name: string): string {
    return (name?.[0] ?? '?').toUpperCase();
  }

  return (
    <div className="flex h-full flex-col bg-canvas">
      <header className="flex h-12 shrink-0 items-center gap-3 border-b border-line bg-surface px-4">
        <button
          onClick={() => nav('/home')}
          className="flex items-center gap-2 text-[13px] font-semibold text-text-primary"
        >
          <span className="inline-block h-2 w-2 rounded-full bg-accent shadow-glow" />
          Agentis
        </button>
        <span className="text-text-muted">/</span>
        <button
          onClick={() => nav('/workspaces')}
          className="flex items-center gap-2 rounded-md px-1.5 py-0.5 text-[13px] text-text-secondary transition-colors hover:bg-surface-2 hover:text-text-primary"
        >
          {workspaceImage ? (
            <img src={workspaceImage} alt="" className="h-5 w-5 rounded-md object-cover" />
          ) : (
            <span className="flex h-5 w-5 items-center justify-center rounded-md bg-surface-2 text-[10px] font-semibold text-text-primary">
              {workspaceInitial(workspaceName)}
            </span>
          )}
          {workspaceName}
        </button>
        {workspaceId && <AmbientSelector workspaceId={workspaceId} />}
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
      <OnboardingStrip />
      <div className="flex min-h-0 flex-1">
        <Sidebar />
        <main className="min-h-0 flex-1 overflow-auto">{children}</main>
        {!onChatPage && <ChatPanel />}
      </div>
      <LiveStrip />
    </div>
  );
}
