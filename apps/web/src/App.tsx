import { Routes, Route, Navigate, useNavigate } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { Search, LogOut } from 'lucide-react';
import { LoginPage } from './pages/LoginPage';
import { FleetOverviewPage } from './pages/FleetOverviewPage';
import { WorkflowsPage } from './pages/WorkflowsPage';
import { WorkflowCanvasPage } from './pages/WorkflowCanvasPage';
import { RunDetailPage } from './pages/RunDetailPage';
import { RunHistoryPage } from './pages/RunHistoryPage';
import { ActivityPage } from './pages/ActivityPage';
import { ApprovalsPage } from './pages/ApprovalsPage';
import { SkillsPage } from './pages/SkillsPage';
import { AgentsPage } from './pages/AgentsPage';
import { AgentDetailPage } from './pages/AgentDetailPage';
import { GatewaysPage } from './pages/GatewaysPage';
import { ConversationsPage } from './pages/ConversationsPage';
import { SettingsPage } from './pages/SettingsPage';
import { SettingsChannelsPage } from './pages/SettingsChannelsPage';
import { WorkspacesPage } from './pages/WorkspacesPage';
import { CommandPalette } from './components/CommandPalette';
import { AmbientSelector, GatewayHealthPill } from './components/TopBarPills';
import { LiveStrip } from './components/LiveStrip';
import { OnboardingStrip } from './components/OnboardingStrip';
import { Sidebar } from './components/Sidebar';
import {
  Assistant,
  AssistantHeaderButton,
  AssistantProvider,
} from './components/assistant/Assistant';
import { ConfirmProvider } from './components/shared/ConfirmDialog';
import { ToastProvider } from './components/shared/Toast';
import { tokens, workspace as wsStore, api, logout } from './lib/api';

interface Workspace {
  id: string;
  name: string;
  slug: string;
}

/**
 * Token-file auto-login for the local CLI launch flow.
 *
 * The CLI writes a random token to .agentis/token and opens the
 * dashboard URL with `?token=<value>`. We POST it to /v1/auth/launch
 * to exchange it for a normal JWT pair, then strip the query param
 * so it doesn't linger in browser history.
 */
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

  // On mount: if the URL has ?token=, always try the launch-token
  // exchange first — it overrides any stale JWT in localStorage so a
  // freshly-restarted CLI session can sign you in cleanly. Otherwise
  // fall back to whatever JWT we already have.
  useEffect(() => {
    void (async () => {
      const hasUrlToken = new URLSearchParams(window.location.search).has('token');
      if (hasUrlToken) {
        // Clear stale tokens so the launch exchange isn't shadowed.
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
      <div className="flex h-screen items-center justify-center bg-canvas text-sm text-text-muted">
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
      <div className="flex h-screen items-center justify-center bg-canvas text-sm text-text-muted">
        Loading…
      </div>
    );
  }

  return (
    <ToastProvider>
      <ConfirmProvider>
        <AssistantProvider>
          <Shell
            workspaceName={ws?.name ?? '…'}
            workspaceId={ws?.id ?? null}
            onLogout={() => {
              logout();
              setAuthed(false);
              setWsReady(false);
            }}
          >
            <Routes>
        <Route path="/" element={<Navigate to="/fleet" replace />} />
        <Route path="/fleet" element={<FleetOverviewPage />} />
        <Route path="/workflows" element={<WorkflowsPage />} />
        <Route path="/workflows/:id" element={<WorkflowCanvasPage />} />
        <Route path="/runs" element={<RunHistoryPage />} />
        <Route path="/runs/:id" element={<RunDetailPage />} />
        <Route path="/agents" element={<AgentsPage />} />
        <Route path="/agents/:id" element={<AgentDetailPage />} />
        <Route path="/gateways" element={<GatewaysPage />} />
        <Route path="/conversations" element={<ConversationsPage />} />
        <Route path="/conversations/:agentId" element={<ConversationsPage />} />
        <Route path="/activity" element={<ActivityPage />} />
        <Route path="/approvals" element={<ApprovalsPage />} />
        <Route path="/skills" element={<SkillsPage />} />
        <Route path="/workspaces" element={<WorkspacesPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="/settings/channels" element={<SettingsChannelsPage />} />
        <Route path="*" element={<Navigate to="/fleet" replace />} />
      </Routes>
      <CommandPalette />
    </Shell>
        </AssistantProvider>
      </ConfirmProvider>
    </ToastProvider>
  );
}

const NAV = [
  { to: '/fleet', label: 'Fleet', glyph: '◎' },
  { to: '/workflows', label: 'Workflows', glyph: '⌘' },
  { to: '/runs', label: 'Runs', glyph: '⟳' },
  { to: '/agents', label: 'Agents', glyph: '◈' },
  { to: '/gateways', label: 'Gateways', glyph: '⏚' },
  { to: '/conversations', label: 'Conversations', glyph: '✉' },
  { to: '/activity', label: 'Activity', glyph: '≈' },
  { to: '/approvals', label: 'Approvals', glyph: '✓' },
  { to: '/skills', label: 'Skills', glyph: '✦' },
  { to: '/workspaces', label: 'Workspaces', glyph: '▣' },
  { to: '/settings', label: 'Settings', glyph: '⚙' },
];

function Shell({
  children,
  workspaceName,
  workspaceId,
  onLogout,
}: {
  children: React.ReactNode;
  workspaceName: string;
  workspaceId: string | null;
  onLogout: () => void;
}) {
  const nav = useNavigate();
  return (
    <div className="flex h-full flex-col">
      <header className="flex h-12 shrink-0 items-center gap-3 border-b border-line bg-surface px-4 text-sm">
        <button
          onClick={() => nav('/fleet')}
          className="flex items-center gap-2 font-medium text-text-primary"
        >
          <span className="inline-block h-2 w-2 rounded-full bg-accent shadow-glow" />
          Agentis
        </button>
        <span className="text-text-muted">/</span>
        <button onClick={() => nav('/workspaces')} className="text-text-muted hover:text-accent">
          {workspaceName}
        </button>
        {workspaceId && <AmbientSelector workspaceId={workspaceId} />}
        <div className="ml-auto flex items-center gap-2">
          <GatewayHealthPill />
          <AssistantHeaderButton />
          <button
            type="button"
            onClick={() => {
              const ev = new KeyboardEvent('keydown', { key: 'k', metaKey: true });
              window.dispatchEvent(ev);
            }}
            className="inline-flex items-center gap-1.5 rounded-md border border-line bg-surface-2 px-2 py-1 text-xs text-text-muted hover:text-text-primary"
            title="Search (⌘K)"
          >
            <Search size={12} />
            Search
            <span className="rounded border border-line px-1 py-0.5 text-[9px]">⌘K</span>
          </button>
          <button
            onClick={onLogout}
            title="Sign out"
            aria-label="Sign out"
            className="inline-flex items-center gap-1 rounded-md border border-line px-2 py-1 text-xs text-text-muted hover:text-text-primary"
          >
            <LogOut size={12} />
          </button>
        </div>
      </header>
      <OnboardingStrip />
      <div className="flex min-h-0 flex-1">
        <Sidebar />
        <main className="min-h-0 flex-1 overflow-auto">{children}</main>
      </div>
      <LiveStrip />
      <Assistant />
    </div>
  );
}
