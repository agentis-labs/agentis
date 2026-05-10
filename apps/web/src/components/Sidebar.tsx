/**
 * Sidebar — primary navigation rail (5 items + Spaces + Settings).
 *
 * Replaces the previous 11-item flat structure with the new IA from
 * UIUX-REPLAN.md §6.1: Home / Agents / Workflows / Apps / Packages /
 * SPACES / Settings. Live badges on Agents (live count) and Workflows
 * (active runs). Auto-collapse when ChatPanel is docked.
 */

import { useEffect, useState } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import clsx from 'clsx';
import {
  Home as HomeIcon,
  Bot,
  Workflow as WorkflowIcon,
  AppWindow,
  Brain as BrainIcon,
  Package as PackageIcon,
  Settings as SettingsIcon,
  ChevronsLeft,
  ChevronsRight,
  Plus,
  Folder,
  FolderOpen,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { api, workspace as wsStore } from '../lib/api';
import { rtSubscribe, useRealtime } from '../lib/realtime';
import { useToast } from './shared/Toast';
import { useChatPanelStore } from './chat/ChatPanelStore';

interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  badge?: 'liveAgents' | 'activeRuns';
}

const NAV: NavItem[] = [
  { to: '/home',      label: 'Home',      icon: HomeIcon },
  { to: '/agents',    label: 'Agents',    icon: Bot,         badge: 'liveAgents' },
  { to: '/workflows', label: 'Workflows', icon: WorkflowIcon, badge: 'activeRuns' },
  { to: '/apps',      label: 'Apps',      icon: AppWindow },
  { to: '/brain',     label: 'Brain',     icon: BrainIcon },
  { to: '/packages',  label: 'Packages',  icon: PackageIcon },
];

const SPACE_COLORS = ['space-orange', 'space-blue', 'space-purple', 'space-teal', 'space-rose', 'space-lime'] as const;

interface Space {
  id: string;
  name: string;
  slug: string;
  colorHex?: string;
  appCount?: number;
}

interface BadgeCounts {
  liveAgents: number;
  activeRuns: number;
}

const STORAGE_KEY = 'agentis.sidebar.collapsed';
const SPACES_OPEN_KEY = 'agentis.sidebar.spacesOpen';

export function Sidebar() {
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try { return localStorage.getItem(STORAGE_KEY) === '1'; } catch { return false; }
  });
  const [spacesOpen, setSpacesOpen] = useState<boolean>(() => {
    try { return localStorage.getItem(SPACES_OPEN_KEY) !== '0'; } catch { return true; }
  });
  const [spaces, setSpaces] = useState<Space[]>([]);
  const [creatingSpace, setCreatingSpace] = useState(false);
  const [newSpaceName, setNewSpaceName] = useState('');
  const [counts, setCounts] = useState<BadgeCounts>({ liveAgents: 0, activeRuns: 0 });
  const nav = useNavigate();
  const toast = useToast();
  const chatState = useChatPanelStore((s) => s.state);

  // Auto-collapse when chat panel docks (§5.7)
  useEffect(() => {
    if (chatState === 'docked') setCollapsed(true);
  }, [chatState]);

  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, collapsed ? '1' : '0'); } catch { /* ignore */ }
  }, [collapsed]);

  useEffect(() => {
    try { localStorage.setItem(SPACES_OPEN_KEY, spacesOpen ? '1' : '0'); } catch { /* ignore */ }
  }, [spacesOpen]);

  async function refreshCounts() {
    const ws = wsStore.get();
    if (!ws) return;
    try {
      const [agents, runs] = await Promise.allSettled([
        api<{ agents: Array<{ status?: string }> }>(`/v1/agents`).catch(() => ({ agents: [] })),
        api<{ runs:   Array<{ status: string }> }>(`/v1/runs?status=running`).catch(() => ({ runs: [] })),
      ]);
      const liveAgents =
        agents.status === 'fulfilled'
          ? agents.value.agents.filter((a) => a.status === 'online' || a.status === 'active' || a.status === 'running').length
          : 0;
      const activeRuns =
        runs.status === 'fulfilled'
          ? runs.value.runs.filter((r) => r.status === 'running' || r.status === 'pending').length
          : 0;
      setCounts({ liveAgents, activeRuns });
    } catch { /* best-effort */ }
  }

  async function refreshSpaces() {
    const ws = wsStore.get();
    if (!ws) return;
    try {
      const data = await api<{ spaces: Space[] }>(`/v1/spaces`);
      setSpaces(data.spaces ?? []);
    } catch {
      // Spaces endpoint may not exist yet — fallback gracefully
      setSpaces([]);
    }
  }

  useEffect(() => {
    const ws = wsStore.get();
    if (ws) rtSubscribe('workspace', { workspaceId: ws });
    void refreshCounts();
    void refreshSpaces();
    const t = window.setInterval(() => void refreshCounts(), 30_000);
    return () => window.clearInterval(t);
  }, []);

  useRealtime(
    [
      'run.created', 'run.running', 'run.completed', 'run.failed',
      'agent.online', 'agent.offline', 'agent.busy',
    ],
    () => { void refreshCounts(); },
  );

  async function handleCreateSpace(e: React.FormEvent) {
    e.preventDefault();
    const name = newSpaceName.trim();
    if (!name) return;
    try {
      await api('/v1/spaces', {
        method: 'POST',
        body: JSON.stringify({ name, slug: name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') }),
      });
      toast.success('Space created', name);
      setNewSpaceName('');
      setCreatingSpace(false);
      void refreshSpaces();
    } catch (err) {
      toast.error('Failed to create space', String(err));
    }
  }

  function spaceDotColor(space: Space, idx: number): string {
    if (space.colorHex) return '';
    const c = SPACE_COLORS[idx % SPACE_COLORS.length];
    return `bg-${c}`;
  }

  return (
    <aside
      className={clsx(
        'flex shrink-0 flex-col border-r border-line bg-surface transition-[width] duration-150',
        collapsed ? 'w-14' : 'w-56',
      )}
    >
      <nav className="flex-1 overflow-y-auto py-3">
        {/* Primary nav */}
        <ul className="flex flex-col gap-0.5 px-2">
          {NAV.map((item) => {
            const Icon = item.icon;
            const badge = item.badge ? counts[item.badge] : 0;
            return (
              <li key={item.to}>
                <NavLink
                  to={item.to}
                  title={collapsed ? item.label : undefined}
                  className={({ isActive }) =>
                    clsx(
                      'group relative flex items-center gap-2.5 rounded-nav px-2.5 py-2 text-[13px] transition-colors',
                      collapsed && 'justify-center',
                      isActive
                        ? 'bg-surface-2 text-text-primary'
                        : 'text-text-muted hover:bg-surface-2 hover:text-text-primary',
                    )
                  }
                >
                  {({ isActive }) => (
                    <>
                      {isActive && (
                        <span className="absolute left-0 top-1/2 h-5 w-0.5 -translate-y-1/2 rounded-r-full bg-accent" />
                      )}
                      <Icon size={16} className={clsx('shrink-0', isActive && 'text-accent')} />
                      {!collapsed && <span className="flex-1 truncate">{item.label}</span>}
                      {badge > 0 && !collapsed && (
                        <span
                          className={clsx(
                            'inline-flex h-5 min-w-[20px] items-center justify-center rounded-full px-1.5 text-[10px] font-semibold',
                            item.badge === 'liveAgents' && 'bg-accent-soft text-accent',
                            item.badge === 'activeRuns' && 'bg-accent-soft text-accent',
                          )}
                        >
                          {badge > 99 ? '99+' : badge}
                        </span>
                      )}
                      {badge > 0 && collapsed && (
                        <span className="absolute -right-0.5 -top-0.5 inline-flex h-4 min-w-[16px] items-center justify-center rounded-full bg-accent px-1 text-[9px] font-bold text-canvas">
                          {badge > 9 ? '9+' : badge}
                        </span>
                      )}
                    </>
                  )}
                </NavLink>
              </li>
            );
          })}
        </ul>

        {/* Spaces section */}
        {(spaces.length > 0 || creatingSpace) && (
          <>
            <div className="my-3 border-t border-line/60" />
            {!collapsed && (
              <button
                type="button"
                onClick={() => setSpacesOpen((v) => !v)}
                className="flex w-full items-center gap-1.5 px-3 pb-1 text-[10px] font-semibold uppercase tracking-wider text-text-muted hover:text-text-primary"
              >
                {spacesOpen ? <FolderOpen size={10} /> : <Folder size={10} />}
                Spaces
              </button>
            )}
            {(spacesOpen || collapsed) && (
              <ul className="flex flex-col gap-0.5 px-2">
                {spaces.map((s, idx) => (
                  <li key={s.id}>
                    <NavLink
                      to={`/apps?space=${s.id}`}
                      title={collapsed ? s.name : undefined}
                      className={({ isActive }) =>
                        clsx(
                          'group relative flex items-center gap-2 rounded-nav px-2.5 py-1.5 text-[12px] transition-colors',
                          collapsed && 'justify-center',
                          isActive
                            ? 'bg-surface-2 text-text-primary'
                            : 'text-text-muted hover:bg-surface-2 hover:text-text-primary',
                        )
                      }
                    >
                      <span
                        className={clsx('h-2 w-2 shrink-0 rounded-full', spaceDotColor(s, idx))}
                        style={s.colorHex ? { backgroundColor: s.colorHex } : undefined}
                      />
                      {!collapsed && (
                        <>
                          <span className="flex-1 truncate">{s.name}</span>
                          {s.appCount != null && s.appCount > 0 && (
                            <span className="text-[10px] text-text-muted">{s.appCount}</span>
                          )}
                        </>
                      )}
                    </NavLink>
                  </li>
                ))}
                {!collapsed && (
                  <li>
                    {creatingSpace ? (
                      <form onSubmit={handleCreateSpace} className="px-1 py-1">
                        <input
                          autoFocus
                          type="text"
                          value={newSpaceName}
                          onChange={(e) => setNewSpaceName(e.target.value)}
                          onBlur={() => { if (!newSpaceName.trim()) setCreatingSpace(false); }}
                          onKeyDown={(e) => { if (e.key === 'Escape') { setNewSpaceName(''); setCreatingSpace(false); } }}
                          placeholder="Space name"
                          className="h-7 w-full rounded-input border border-line bg-surface-2 px-2 text-[12px] text-text-primary placeholder:text-text-muted focus:border-accent focus:outline-none"
                        />
                      </form>
                    ) : (
                      <button
                        type="button"
                        onClick={() => setCreatingSpace(true)}
                        className="flex w-full items-center gap-2 rounded-nav px-2.5 py-1.5 text-[12px] text-text-muted hover:bg-surface-2 hover:text-text-primary"
                      >
                        <Plus size={12} /> New space
                      </button>
                    )}
                  </li>
                )}
              </ul>
            )}
          </>
        )}

        {/* When no spaces, show inline create at bottom of section */}
        {!collapsed && spaces.length === 0 && !creatingSpace && (
          <div className="mt-3 px-2">
            <button
              type="button"
              onClick={() => setCreatingSpace(true)}
              className="flex w-full items-center gap-2 rounded-nav px-2.5 py-1.5 text-[12px] text-text-muted hover:bg-surface-2 hover:text-text-primary"
            >
              <Plus size={12} /> New space
            </button>
          </div>
        )}
        {!collapsed && spaces.length === 0 && creatingSpace && (
          <div className="mt-3 px-2">
            <form onSubmit={handleCreateSpace}>
              <input
                autoFocus
                type="text"
                value={newSpaceName}
                onChange={(e) => setNewSpaceName(e.target.value)}
                onBlur={() => { if (!newSpaceName.trim()) setCreatingSpace(false); }}
                onKeyDown={(e) => { if (e.key === 'Escape') { setNewSpaceName(''); setCreatingSpace(false); } }}
                placeholder="Space name"
                className="h-7 w-full rounded-input border border-line bg-surface-2 px-2 text-[12px] text-text-primary placeholder:text-text-muted focus:border-accent focus:outline-none"
              />
            </form>
          </div>
        )}

        {/* Settings — separate at bottom */}
        <div className="my-3 border-t border-line/60" />
        <ul className="flex flex-col gap-0.5 px-2">
          <li>
            <NavLink
              to="/settings"
              title={collapsed ? 'Settings' : undefined}
              className={({ isActive }) =>
                clsx(
                  'group relative flex items-center gap-2.5 rounded-nav px-2.5 py-2 text-[13px] transition-colors',
                  collapsed && 'justify-center',
                  isActive
                    ? 'bg-surface-2 text-text-primary'
                    : 'text-text-muted hover:bg-surface-2 hover:text-text-primary',
                )
              }
            >
              {({ isActive }) => (
                <>
                  {isActive && (
                    <span className="absolute left-0 top-1/2 h-5 w-0.5 -translate-y-1/2 rounded-r-full bg-accent" />
                  )}
                  <SettingsIcon size={16} className={clsx('shrink-0', isActive && 'text-accent')} />
                  {!collapsed && <span className="flex-1 truncate">Settings</span>}
                </>
              )}
            </NavLink>
          </li>
        </ul>
      </nav>

      <button
        type="button"
        onClick={() => setCollapsed((v) => !v)}
        className="flex h-9 shrink-0 items-center justify-center gap-2 border-t border-line text-[11px] text-text-muted transition-colors hover:bg-surface-2 hover:text-text-primary"
        title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
      >
        {collapsed ? <ChevronsRight size={14} /> : <ChevronsLeft size={14} />}
        {!collapsed && <span>Collapse</span>}
      </button>
    </aside>
  );
}
