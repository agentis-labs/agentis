/**
 * Sidebar — primary navigation rail (5 items + Spaces + Settings).
 *
 * Home / Workflows / Agents / Knowledge / Packages / SPACES / Settings.
 * Live badges on Agents (live count) and Workflows (active runs).
 * Auto-collapse when ChatPanel is docked.
 */

import { useEffect, useState } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import clsx from 'clsx';
import {
  Home as HomeIcon,
  Bot,
  Workflow as WorkflowIcon,
  BookOpen,
  Package as PackageIcon,
  Settings as SettingsIcon,
  ChevronsLeft,
  ChevronsRight,
  Plus,
  Folder,
  FolderOpen,
  Briefcase,
  Megaphone,
  Target,
  Wrench,
  Users,
  ShoppingBag,
  Star,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { api } from '../lib/api';
import { refreshWorkspaceSnapshot, useWorkspaceData } from '../lib/workspaceData';
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
  { to: '/workflows', label: 'Workflows', icon: WorkflowIcon, badge: 'activeRuns' },
  { to: '/agents',    label: 'Agents',    icon: Bot,         badge: 'liveAgents' },
  { to: '/knowledge', label: 'Knowledge', icon: BookOpen },
  { to: '/packages',  label: 'Packages',  icon: PackageIcon },
];

const SPACE_COLORS = ['#f97316', '#3b82f6', '#a855f7', '#14b8a6', '#f43f5e', '#84cc16'] as const;
const SPACE_ICON_LIBRARY = [
  { id: 'folder', label: 'Folder', icon: Folder },
  { id: 'briefcase', label: 'Business', icon: Briefcase },
  { id: 'megaphone', label: 'Marketing', icon: Megaphone },
  { id: 'target', label: 'Goals', icon: Target },
  { id: 'wrench', label: 'Ops', icon: Wrench },
  { id: 'users', label: 'Team', icon: Users },
  { id: 'shopping-bag', label: 'Sales', icon: ShoppingBag },
  { id: 'star', label: 'Priority', icon: Star },
] as const;
const SPACE_ICON_BY_ID = new Map<string, LucideIcon>(SPACE_ICON_LIBRARY.map((item) => [item.id, item.icon]));

interface Space {
  id: string;
  name: string;
  slug: string;
  color?: string | null;
  colorHex?: string;
  iconGlyph?: string | null;
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
  const [creatingSpace, setCreatingSpace] = useState(false);
  const [newSpaceName, setNewSpaceName] = useState('');
  const [newSpaceIcon, setNewSpaceIcon] = useState('folder');
  const [editingSpaceIconId, setEditingSpaceIconId] = useState<string | null>(null);
  const { spaces, counts } = useWorkspaceData();
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

  async function handleCreateSpace(e: React.FormEvent) {
    e.preventDefault();
    const name = newSpaceName.trim();
    if (!name) return;
    try {
      await api('/v1/spaces', {
        method: 'POST',
        body: JSON.stringify({ name, iconGlyph: newSpaceIcon }),
      });
      toast.success('Space created', name);
      setNewSpaceName('');
      setNewSpaceIcon('folder');
      setEditingSpaceIconId(null);
      setCreatingSpace(false);
      void refreshWorkspaceSnapshot();
    } catch (err) {
      toast.error('Failed to create space', String(err));
    }
  }

  function spaceColor(space: Space, idx: number): string {
    return space.colorHex ?? space.color ?? SPACE_COLORS[idx % SPACE_COLORS.length] ?? SPACE_COLORS[0];
  }

  async function handleUpdateSpaceIcon(space: Space, iconGlyph: string) {
    try {
      await api(`/v1/spaces/${space.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ iconGlyph }),
      });
      setEditingSpaceIconId(null);
      toast.success('Space icon updated', space.name);
      void refreshWorkspaceSnapshot();
    } catch (err) {
      toast.error('Failed to update space icon', String(err));
    }
  }

  return (
    <aside
      data-agentis-sidebar
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
                  title={item.label}
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
                      to={`/home?space=${s.id}`}
                      title={s.name}
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
                      <SpaceGlyph
                        space={s}
                        color={spaceColor(s, idx)}
                        onClick={!collapsed ? () => setEditingSpaceIconId((current) => current === s.id ? null : s.id) : undefined}
                      />
                      {!collapsed && <span className="flex-1 truncate">{s.name}</span>}
                    </NavLink>
                    {!collapsed && editingSpaceIconId === s.id && (
                      <div className="px-2 pb-2">
                        <SpaceIconPicker value={s.iconGlyph ?? 'folder'} onChange={(icon) => void handleUpdateSpaceIcon(s, icon)} />
                      </div>
                    )}
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
                        <SpaceIconPicker value={newSpaceIcon} onChange={setNewSpaceIcon} />
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
              <SpaceIconPicker value={newSpaceIcon} onChange={setNewSpaceIcon} />
            </form>
          </div>
        )}

        {/* Settings — separate at bottom */}
        <div className="my-3 border-t border-line/60" />
        <ul className="flex flex-col gap-0.5 px-2">
          <li>
            <NavLink
              to="/settings"
              title="Workspace settings"
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

function SpaceGlyph({ space, color, onClick }: { space: Space; color: string; onClick?: () => void }) {
  const Icon = SPACE_ICON_BY_ID.get(space.iconGlyph ?? '') ?? Folder;
  const interactive = Boolean(onClick);
  return (
    <span
      className={clsx(
        'inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-md border border-line bg-canvas',
        interactive && 'cursor-pointer hover:border-line-strong',
      )}
      role={interactive ? 'button' : undefined}
      tabIndex={interactive ? 0 : undefined}
      onClick={(event) => {
        if (!onClick) return;
        event.preventDefault();
        event.stopPropagation();
        onClick();
      }}
      onKeyDown={(event) => {
        if (!onClick || (event.key !== 'Enter' && event.key !== ' ')) return;
        event.preventDefault();
        event.stopPropagation();
        onClick();
      }}
      style={{ color }}
      title={interactive ? 'Change space icon' : undefined}
    >
      <Icon size={13} strokeWidth={2.2} />
    </span>
  );
}

function SpaceIconPicker({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  return (
    <div className="mt-2 grid grid-cols-4 gap-1">
      {SPACE_ICON_LIBRARY.map((item) => {
        const Icon = item.icon;
        const selected = value === item.id;
        return (
          <button
            key={item.id}
            type="button"
            title={item.label}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => onChange(item.id)}
            className={clsx(
              'flex h-7 items-center justify-center rounded-md border transition-colors',
              selected
                ? 'border-accent bg-accent-soft text-accent'
                : 'border-line bg-surface-2 text-text-muted hover:border-line-strong hover:text-text-primary',
            )}
          >
            <Icon size={13} />
          </button>
        );
      })}
    </div>
  );
}
