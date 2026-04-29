import { Routes, Route, Navigate, Link, useLocation, useNavigate } from 'react-router-dom';
import { useEffect, useState } from 'react';
import clsx from 'clsx';
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
import { ConversationDock } from './components/ConversationDock';
import { tokens, workspace as wsStore, api, logout } from './lib/api';

interface Workspace {
  id: string;
  name: string;
  slug: string;
}

export function App() {
  const [authed, setAuthed] = useState<boolean>(!!tokens.access());
  const [ws, setWs] = useState<Workspace | null>(null);

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
      }
    })();
  }, [authed]);

  if (!authed) {
    return (
      <Routes>
        <Route path="*" element={<LoginPage onSuccess={() => setAuthed(true)} />} />
      </Routes>
    );
  }

  return (
    <Shell
      workspaceName={ws?.name ?? '…'}
      workspaceId={ws?.id ?? null}
      onLogout={() => { logout(); setAuthed(false); }}
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
  const loc = useLocation();
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
          <ConversationDock />
          <span className="rounded-md border border-line px-2 py-1 text-[10px] text-text-muted">
            ⌘K to search
          </span>
          <button
            onClick={onLogout}
            className="rounded-md border border-line px-2 py-1 text-xs text-text-muted hover:text-text-primary"
          >
            Sign out
          </button>
        </div>
      </header>
      <div className="flex min-h-0 flex-1">
        <aside className="flex w-14 shrink-0 flex-col items-center gap-1 border-r border-line bg-surface py-3">
          {NAV.map((n) => (
            <Link
              key={n.to}
              to={n.to}
              className={clsx(
                'group flex h-10 w-10 items-center justify-center rounded-lg text-base text-text-muted transition',
                loc.pathname.startsWith(n.to)
                  ? 'bg-surface-2 text-accent shadow-glow'
                  : 'hover:bg-surface-2 hover:text-text-primary',
              )}
              title={n.label}
            >
              {n.glyph}
            </Link>
          ))}
        </aside>
        <main className="min-h-0 flex-1 overflow-auto">{children}</main>
      </div>
      <LiveStrip />
    </div>
  );
}
