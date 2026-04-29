/**
 * Sidebar — primary navigation rail.
 *
 * Replaces the icon-only glyph rail with a grouped, label-first design
 * inspired by Linear/Vercel: dense, monochrome, keyboard-friendly. Each
 * item uses a real icon from `lucide-react` plus a visible label so a
 * first-time user never has to hover to discover the route. Live badges
 * (pending approvals, active runs, degraded gateways) surface directly
 * inline so the rail doubles as an at-a-glance status board.
 */

import { useEffect, useState } from 'react';
import { NavLink } from 'react-router-dom';
import clsx from 'clsx';
import {
  LayoutDashboard,
  Activity,
  History,
  CheckSquare,
  Workflow,
  Sparkles,
  Bot,
  Plug,
  Hash,
  Building2,
  Settings,
  ChevronsLeft,
  ChevronsRight,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { api, workspace as wsStore } from '../lib/api';
import { rtSubscribe, useRealtime } from '../lib/realtime';

interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  badge?: 'pendingApprovals' | 'activeRuns' | 'degradedGateways';
}

interface NavGroup {
  label: string;
  items: NavItem[];
}

const GROUPS: NavGroup[] = [
  {
    label: 'Monitor',
    items: [
      { to: '/fleet', label: 'Fleet', icon: LayoutDashboard },
      { to: '/activity', label: 'Activity', icon: Activity },
      { to: '/runs', label: 'Runs', icon: History, badge: 'activeRuns' },
      { to: '/approvals', label: 'Approvals', icon: CheckSquare, badge: 'pendingApprovals' },
    ],
  },
  {
    label: 'Build',
    items: [
      { to: '/workflows', label: 'Workflows', icon: Workflow },
      { to: '/skills', label: 'Skills', icon: Sparkles },
    ],
  },
  {
    label: 'Operate',
    items: [
      { to: '/agents', label: 'Agents', icon: Bot },
      { to: '/gateways', label: 'Gateways', icon: Plug, badge: 'degradedGateways' },
      { to: '/settings/channels', label: 'Channels', icon: Hash },
    ],
  },
  {
    label: 'Admin',
    items: [
      { to: '/workspaces', label: 'Workspaces', icon: Building2 },
      { to: '/settings', label: 'Settings', icon: Settings },
    ],
  },
];

interface BadgeCounts {
  pendingApprovals: number;
  activeRuns: number;
  degradedGateways: number;
}

const STORAGE_KEY = 'agentis.sidebar.collapsed';

export function Sidebar() {
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try {
      return localStorage.getItem(STORAGE_KEY) === '1';
    } catch {
      return false;
    }
  });
  const [counts, setCounts] = useState<BadgeCounts>({
    pendingApprovals: 0,
    activeRuns: 0,
    degradedGateways: 0,
  });

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, collapsed ? '1' : '0');
    } catch {
      /* ignore */
    }
  }, [collapsed]);

  async function refreshCounts() {
    const ws = wsStore.get();
    if (!ws) return;
    try {
      const [approvals, runs, gateways] = await Promise.allSettled([
        api<{ approvals: Array<{ status: string }> }>(`/v1/approvals?status=pending`).catch(
          () => ({ approvals: [] }),
        ),
        api<{ runs: Array<{ status: string }> }>(`/v1/runs?status=running`).catch(() => ({
          runs: [],
        })),
        api<{ gateways: Array<{ status: string }> }>(`/v1/gateways`).catch(() => ({
          gateways: [],
        })),
      ]);
      const pendingApprovals =
        approvals.status === 'fulfilled' ? approvals.value.approvals.length : 0;
      const activeRuns =
        runs.status === 'fulfilled'
          ? runs.value.runs.filter((r) => r.status === 'running' || r.status === 'pending').length
          : 0;
      const degradedGateways =
        gateways.status === 'fulfilled'
          ? gateways.value.gateways.filter((g) => g.status !== 'connected' && g.status !== 'online')
              .length
          : 0;
      setCounts({ pendingApprovals, activeRuns, degradedGateways });
    } catch {
      /* best-effort */
    }
  }

  useEffect(() => {
    const ws = wsStore.get();
    if (ws) rtSubscribe('workspace', { workspaceId: ws });
    void refreshCounts();
    const t = window.setInterval(() => void refreshCounts(), 30_000);
    return () => window.clearInterval(t);
  }, []);

  useRealtime(
    [
      'approval.requested',
      'approval.resolved',
      'run.created',
      'run.running',
      'run.completed',
      'run.failed',
      'gateway.connected',
      'gateway.degraded',
      'gateway.disconnected',
    ],
    () => {
      void refreshCounts();
    },
  );

  return (
    <aside
      className={clsx(
        'flex shrink-0 flex-col border-r border-line bg-surface transition-[width] duration-150',
        collapsed ? 'w-14' : 'w-56',
      )}
    >
      <nav className="flex-1 overflow-y-auto py-3">
        {GROUPS.map((group) => (
          <div key={group.label} className="mb-4 px-2">
            {!collapsed && (
              <div className="px-2 pb-1 text-[10px] font-medium uppercase tracking-wider text-text-muted/70">
                {group.label}
              </div>
            )}
            <ul className="flex flex-col gap-0.5">
              {group.items.map((item) => {
                const Icon = item.icon;
                const badge = item.badge ? counts[item.badge] : 0;
                return (
                  <li key={item.to}>
                    <NavLink
                      to={item.to}
                      title={collapsed ? item.label : undefined}
                      className={({ isActive }) =>
                        clsx(
                          'group relative flex items-center gap-2.5 rounded-md px-2 py-1.5 text-[13px] transition',
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
                          <Icon
                            size={16}
                            className={clsx('shrink-0', isActive && 'text-accent')}
                          />
                          {!collapsed && <span className="flex-1 truncate">{item.label}</span>}
                          {badge > 0 && (
                            <span
                              className={clsx(
                                'inline-flex h-4 min-w-[1rem] items-center justify-center rounded-full px-1 text-[10px] font-medium',
                                item.badge === 'pendingApprovals' && 'bg-warn/20 text-warn',
                                item.badge === 'activeRuns' && 'bg-accent/20 text-accent',
                                item.badge === 'degradedGateways' && 'bg-danger/20 text-danger',
                                collapsed && 'absolute right-1 top-1',
                              )}
                            >
                              {badge > 99 ? '99+' : badge}
                            </span>
                          )}
                        </>
                      )}
                    </NavLink>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>
      <button
        type="button"
        onClick={() => setCollapsed((v) => !v)}
        className="flex h-9 shrink-0 items-center justify-center gap-2 border-t border-line text-[11px] text-text-muted hover:text-text-primary"
        title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
      >
        {collapsed ? <ChevronsRight size={14} /> : <ChevronsLeft size={14} />}
        {!collapsed && <span>Collapse</span>}
      </button>
    </aside>
  );
}
