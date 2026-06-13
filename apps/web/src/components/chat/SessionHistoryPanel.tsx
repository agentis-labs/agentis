import { useEffect, useMemo, useState, useRef } from 'react';
import { ChevronLeft, Clock3, Hash, Megaphone, MessageCircle, Search, Pencil, Trash2, Archive, Check, X, ChevronDown, ChevronUp, Loader2, MoreVertical, ExternalLink } from 'lucide-react';
import clsx from 'clsx';
import * as Tabs from '@radix-ui/react-tabs';
import * as Collapsible from '@radix-ui/react-collapsible';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { formatDistanceToNow, parseISO } from 'date-fns';
import { api, apiErrorMessage } from '../../lib/api';
import { useToast } from '../shared/Toast';

interface ConversationRow {
  id: string;
  agentId: string;
  agentName: string;
  agentStatus?: string | null;
  agentColor?: string | null;
  title?: string | null;
  archivedAt?: string | null;
  lastMessageAt: string | null;
  lastMessagePreview: string | null;
  unread?: number;
  createdAt?: string | null;
}

interface RoomRow {
  id: string;
  name: string;
  kind: 'workspace' | 'team' | 'custom' | 'thread';
  teamId?: string | null;
  lastMessageAt: string | null;
  lastMessagePreview?: string | null;
  unreadCount?: number;
}

type HistoryEntry = {
  id: string;
  conversationId: string;
  agentId: string;
  agentStatus?: string | null;
  agentColor?: string | null;
  adapterType?: string | null;
  kind: 'agent' | 'room' | 'broadcast';
  title: string;
  subtitle?: string;
  preview: string;
  at: string;
  unread: number;
  archivedAt?: string | null;
  onOpen: () => void;
};

type RoomStarter = {
  id: string;
  kind: 'room' | 'broadcast';
  title: string;
  subtitle: string;
  unread: number;
  onOpen: () => void;
};

type HistoryFilter = 'all' | 'recent' | 'agent' | 'room' | 'broadcast';

const EMPTY_DATE = new Date(0).toISOString();

export function SessionHistoryPanel({
  onBack,
  onOpenAgent,
  onOpenRoom,
  onOpenBroadcast,
  activeConversationId,
}: {
  onBack?: () => void;
  onOpenAgent: (agentId: string, name: string, options?: { conversationId?: string | null; archivedAt?: string | null }) => void;
  onOpenRoom: (roomId: string, name: string) => void;
  onOpenBroadcast: () => void;
  activeConversationId?: string | null;
}) {
  const [conversations, setConversations] = useState<ConversationRow[]>([]);
  const [rooms, setRooms] = useState<RoomRow[]>([]);
  const [agents, setAgents] = useState<Array<{ id: string; adapterType: string }>>([]);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<HistoryFilter>('all');
  const [loading, setLoading] = useState(true);
  const [archivedCollapsed, setArchivedCollapsed] = useState(true);

  // States for inline renaming, archiving, and deletion
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState('');
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [actionLoadingId, setActionLoadingId] = useState<string | null>(null);

  const renameInputRef = useRef<HTMLInputElement>(null);
  const toast = useToast();

  async function load() {
    try {
      const [conversationRes, roomRes, agentRes] = await Promise.allSettled([
        api<{ conversations: ConversationRow[] }>('/v1/conversations'),
        api<{ rooms: RoomRow[] }>('/v1/rooms'),
        api<{ agents: Array<{ id: string; adapterType: string }> }>('/v1/agents'),
      ]);
      if (conversationRes.status === 'fulfilled') setConversations(conversationRes.value.conversations ?? []);
      if (roomRes.status === 'fulfilled') setRooms(roomRes.value.rooms ?? []);
      if (agentRes.status === 'fulfilled') setAgents(agentRes.value.agents ?? []);
    } catch (err) {
      console.error('Failed to load history', err);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    setLoading(true);
    void load();
    window.addEventListener('agentis:workspace-changed', load);
    window.addEventListener('agentis:chat-history-changed', load);
    return () => {
      window.removeEventListener('agentis:workspace-changed', load);
      window.removeEventListener('agentis:chat-history-changed', load);
    };
  }, []);

  // Set focus on rename input
  useEffect(() => {
    if (editingId && renameInputRef.current) {
      renameInputRef.current.focus();
      renameInputRef.current.select();
    }
  }, [editingId]);

  const handleStartRename = (conversationId: string, currentTitle: string) => {
    setEditingId(conversationId);
    setEditingTitle(currentTitle);
    setConfirmDeleteId(null);
  };

  const handleSaveRename = async (conversationId: string) => {
    const trimmed = editingTitle.trim();
    if (!trimmed) {
      setEditingId(null);
      return;
    }
    setActionLoadingId(conversationId);
    try {
      await api(`/v1/conversations/session/${conversationId}`, {
        method: 'PATCH',
        body: JSON.stringify({ title: trimmed }),
      });
      toast.success('Session renamed');
      window.dispatchEvent(new CustomEvent('agentis:chat-history-changed'));
    } catch (error) {
      toast.error('Failed to rename session', apiErrorMessage(error));
    } finally {
      setActionLoadingId(null);
      setEditingId(null);
    }
  };

  const handleToggleArchive = async (conversationId: string, currentArchived: boolean) => {
    setActionLoadingId(conversationId);
    try {
      await api(`/v1/conversations/session/${conversationId}`, {
        method: 'PATCH',
        body: JSON.stringify({ archived: !currentArchived }),
      });
      toast.success(currentArchived ? 'Session unarchived' : 'Session archived');
      window.dispatchEvent(new CustomEvent('agentis:chat-history-changed'));
    } catch (error) {
      toast.error('Failed to update archive status', apiErrorMessage(error));
    } finally {
      setActionLoadingId(null);
    }
  };

  const handleDeleteConversation = async (conversationId: string) => {
    setActionLoadingId(conversationId);
    try {
      await api(`/v1/conversations/session/${conversationId}`, {
        method: 'DELETE',
      });
      toast.success('Session deleted');
      setConfirmDeleteId(null);
      
      if (activeConversationId === conversationId) {
        window.dispatchEvent(new CustomEvent('agentis:active-conversation-deleted'));
      }
      
      window.dispatchEvent(new CustomEvent('agentis:chat-history-changed'));
    } catch (error) {
      toast.error('Failed to delete session', apiErrorMessage(error));
    } finally {
      setActionLoadingId(null);
    }
  };

  const agentAdapterMap = useMemo(() => {
    const map: Record<string, string> = {};
    for (const a of agents) {
      map[a.id] = a.adapterType;
    }
    return map;
  }, [agents]);

  const recentEntries = useMemo<HistoryEntry[]>(() => {
    const threadEntries = conversations
      .filter((conversation) => !conversation.archivedAt || Boolean(conversation.lastMessageAt))
      .map<HistoryEntry>((conversation) => ({
        id: `agent-${conversation.id}`,
        conversationId: conversation.id,
        agentId: conversation.agentId,
        agentStatus: conversation.agentStatus,
        agentColor: conversation.agentColor,
        adapterType: agentAdapterMap[conversation.agentId] ?? null,
        kind: 'agent',
        title: conversation.title?.trim() || conversation.agentName,
        subtitle: conversation.archivedAt ? `${conversation.agentName} (Archived)` : conversation.agentName,
        preview: conversation.lastMessagePreview?.trim() || 'Direct conversation',
        at: conversation.lastMessageAt ?? conversation.createdAt ?? EMPTY_DATE,
        unread: conversation.unread ?? 0,
        archivedAt: conversation.archivedAt,
        onOpen: () => onOpenAgent(conversation.agentId, conversation.agentName, {
          conversationId: conversation.id,
          archivedAt: conversation.archivedAt,
        }),
      }));

    return threadEntries.sort((left, right) => right.at.localeCompare(left.at));
  }, [conversations, onOpenAgent, agentAdapterMap]);

  const roomStarters = useMemo<RoomStarter[]>(() => {
    const next = rooms
      .filter((room) => room.kind !== 'workspace')
      .map<RoomStarter>((room) => ({
        id: room.id,
        kind: 'room',
        title: room.name,
        subtitle: room.lastMessagePreview?.trim() || `${room.kind} room`,
        unread: room.unreadCount ?? 0,
        onOpen: () => onOpenRoom(room.id, room.name),
      }));
    return next.sort((left, right) => {
      return left.title.localeCompare(right.title);
      return left.title.localeCompare(right.title);
    });
  }, [onOpenBroadcast, onOpenRoom, rooms]);

  const normalizedQuery = query.trim().toLowerCase();

  const filteredRecent = recentEntries.filter((entry) => {
    if (filter === 'agent' && entry.kind !== 'agent') return false;
    if (filter === 'room' && entry.kind !== 'room') return false;
    if (filter === 'broadcast' && entry.kind !== 'broadcast') return false;
    if (filter === 'recent' || filter === 'all' || filter === entry.kind) {
      if (!normalizedQuery) return true;
      const haystack = `${entry.title} ${entry.preview} ${entry.subtitle}`.toLowerCase();
      return haystack.includes(normalizedQuery);
    }
    return false;
  });

  const filteredRooms = roomStarters.filter((entry) => {
    if (filter === 'agent' || filter === 'recent') return false;
    if (filter === 'room' && entry.kind !== 'room') return false;
    if (filter === 'broadcast' && entry.kind !== 'broadcast') return false;
    if (!normalizedQuery) return true;
    return `${entry.title} ${entry.subtitle}`.toLowerCase().includes(normalizedQuery);
  });

  const [activeRecent, archivedRecent] = useMemo(() => {
    const active: HistoryEntry[] = [];
    const archived: HistoryEntry[] = [];
    for (const entry of filteredRecent) {
      if (entry.archivedAt) {
        archived.push(entry);
      } else {
        active.push(entry);
      }
    }
    return [active, archived];
  }, [filteredRecent]);

  const activeGroups = useMemo(() => {
    const groups: Array<{ label: string; entries: HistoryEntry[] }> = [];
    const today: HistoryEntry[] = [];
    const yesterday: HistoryEntry[] = [];
    const earlier: HistoryEntry[] = [];
    for (const entry of activeRecent) {
      const bucket = groupForDate(entry.at);
      if (bucket === 'Today') today.push(entry);
      else if (bucket === 'Yesterday') yesterday.push(entry);
      else earlier.push(entry);
    }
    if (today.length > 0) groups.push({ label: 'Today', entries: today });
    if (yesterday.length > 0) groups.push({ label: 'Yesterday', entries: yesterday });
    if (earlier.length > 0) groups.push({ label: 'Earlier', entries: earlier });
    return groups;
  }, [activeRecent]);

  const isEmpty = !loading && activeGroups.length === 0 && archivedRecent.length === 0 && filteredRooms.length === 0;

  // Global keyboard shortcut to focus search input
  const searchInputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        searchInputRef.current?.focus();
      }
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  return (
    <div className="flex h-full flex-col bg-surface border-r border-line shadow-inner">
      <header className="flex h-14 shrink-0 items-center gap-2.5 border-b border-line px-4 bg-surface-2/40">
        {onBack && (
          <button
            type="button"
            onClick={onBack}
            aria-label="Back"
            className="-m-1 rounded-lg p-1.5 text-text-muted hover:bg-surface-3 hover:text-text-primary transition-colors"
          >
            <ChevronLeft size={16} />
          </button>
        )}
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold text-text-primary">Chat history</div>
          <div className="text-[10px] text-text-muted">Saved sessions and active room threads</div>
        </div>
      </header>

      <div className="border-b border-line p-3.5 bg-surface/20">
        <label className="flex items-center gap-2 rounded-xl border border-line bg-canvas/60 px-3 py-2 text-xs text-text-muted focus-within:border-accent/35 focus-within:bg-canvas/90 transition-all duration-200">
          <Search size={14} className="text-text-muted" />
          <input
            ref={searchInputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search... (Ctrl+K)"
            className="min-w-0 flex-1 bg-transparent text-text-primary outline-none placeholder:text-text-muted/65"
          />
        </label>
        
        <Tabs.Root value={filter} onValueChange={(val) => setFilter(val as HistoryFilter)}>
          <Tabs.List className="mt-2.5 flex flex-wrap gap-1">
            {(['all', 'recent', 'agent', 'room', 'broadcast'] as const).map((item) => (
              <Tabs.Trigger
                key={item}
                value={item}
                className={clsx(
                  'rounded-lg border px-2.5 py-1 text-[10px] font-medium capitalize transition-all duration-150',
                  filter === item
                    ? 'border-accent/25 bg-accent/8 text-accent font-semibold shadow-sm'
                    : 'border-line text-text-muted hover:bg-surface-3 hover:text-text-primary',
                )}
              >
                {item === 'agent' ? 'Direct' : item}
              </Tabs.Trigger>
            ))}
          </Tabs.List>
        </Tabs.Root>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {loading ? (
          <div className="flex h-full items-center justify-center px-4 text-xs text-text-muted font-mono">
            <Loader2 size={15} className="animate-spin text-accent mr-2" />
            Loading index...
          </div>
        ) : isEmpty ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center animate-in fade-in duration-200">
            <div className="h-10 w-10 rounded-2xl bg-surface-2 border border-line flex items-center justify-center text-text-muted/60">
              <Clock3 size={18} />
            </div>
            <div className="text-xs font-semibold text-text-primary">No results match filters</div>
            <div className="max-w-[200px] text-[11px] text-text-muted leading-relaxed">
              Try updating search queries or clearing active filter tabs.
            </div>
          </div>
        ) : (
          <div className="space-y-4 px-3 py-3">
            {/* Active Conversations Section */}
            {activeGroups.length > 0 && (
              <Section title="Conversations" subtitle="Active adapter sessions">
                <div className="space-y-3">
                  {activeGroups.map((group) => (
                    <div key={group.label} className="space-y-1">
                      <div className="mb-1 px-1.5 text-[9px] font-bold uppercase tracking-wider text-text-muted/60">
                        {group.label}
                      </div>
                      <div className="overflow-hidden rounded-xl border border-line bg-surface-2/15 space-y-[1px] shadow-sm">
                        {group.entries.map((entry) => (
                          <HistoryRow
                            key={entry.id}
                            entry={entry}
                            isActive={activeConversationId === entry.conversationId}
                            isEditing={editingId === entry.conversationId}
                            editingTitle={editingTitle}
                            setEditingTitle={setEditingTitle}
                            onSaveRename={() => handleSaveRename(entry.conversationId)}
                            onCancelRename={() => setEditingId(null)}
                            onStartRename={() => handleStartRename(entry.conversationId, entry.title)}
                            onToggleArchive={() => handleToggleArchive(entry.conversationId, false)}
                            onConfirmDelete={() => handleDeleteConversation(entry.conversationId)}
                            confirmDelete={confirmDeleteId === entry.conversationId}
                            setConfirmDelete={(val) => setConfirmDeleteId(val ? entry.conversationId : null)}
                            actionLoading={actionLoadingId === entry.conversationId}
                            renameInputRef={renameInputRef}
                          />
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </Section>
            )}

            {/* Archived Conversations Collapsible Section */}
            {archivedRecent.length > 0 && (
              <Collapsible.Root open={!archivedCollapsed} onOpenChange={(open) => setArchivedCollapsed(!open)} className="rounded-xl border border-line bg-surface-2/10 overflow-hidden shadow-sm">
                <Collapsible.Trigger asChild>
                  <button
                    type="button"
                    className="flex w-full items-center justify-between px-3 py-2.5 text-left text-[10px] font-bold uppercase tracking-wider text-text-muted hover:bg-surface-3/40 transition-colors"
                  >
                    <span className="flex items-center gap-1.5">
                      <Archive size={12} className="text-text-muted" />
                      Archived Sessions ({archivedRecent.length})
                    </span>
                    {archivedCollapsed ? <ChevronDown size={13} /> : <ChevronUp size={13} />}
                  </button>
                </Collapsible.Trigger>
                <Collapsible.Content className="overflow-hidden animate-in fade-in duration-200 border-t border-line/50 bg-surface/30 p-1.5 space-y-1">
                  {archivedRecent.map((entry) => (
                    <HistoryRow
                      key={entry.id}
                      entry={entry}
                      isActive={activeConversationId === entry.conversationId}
                      isEditing={editingId === entry.conversationId}
                      editingTitle={editingTitle}
                      setEditingTitle={setEditingTitle}
                      onSaveRename={() => handleSaveRename(entry.conversationId)}
                      onCancelRename={() => setEditingId(null)}
                      onStartRename={() => handleStartRename(entry.conversationId, entry.title)}
                      onToggleArchive={() => handleToggleArchive(entry.conversationId, true)}
                      onConfirmDelete={() => handleDeleteConversation(entry.conversationId)}
                      confirmDelete={confirmDeleteId === entry.conversationId}
                      setConfirmDelete={(val) => setConfirmDeleteId(val ? entry.conversationId : null)}
                      actionLoading={actionLoadingId === entry.conversationId}
                      renameInputRef={renameInputRef}
                    />
                  ))}
                </Collapsible.Content>
              </Collapsible.Root>
            )}

            {/* Rooms Section */}
            {filteredRooms.length > 0 && (
              <Section title="Rooms" subtitle="Workspace channels">
                <div className="overflow-hidden rounded-xl border border-line bg-surface-2/15 space-y-[1px] shadow-sm">
                  {filteredRooms.map((entry) => (
                    <StarterRow
                      key={entry.kind === 'broadcast' ? `broadcast-${entry.id}` : entry.id}
                      icon={entry.kind === 'broadcast' ? <Megaphone size={13} /> : <Hash size={13} />}
                      title={entry.title}
                      subtitle={entry.subtitle}
                      unread={entry.unread}
                      onOpen={entry.onOpen}
                    />
                  ))}
                </div>
              </Section>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function Section({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-1.5">
      <div className="mb-2 px-1 flex flex-col">
        <div className="text-[10px] font-bold uppercase tracking-wider text-text-muted">{title}</div>
        <div className="text-[9px] text-text-muted/75 leading-tight">{subtitle}</div>
      </div>
      {children}
    </section>
  );
}

function StatusDot({ status }: { status?: string | null }) {
  const value = (status ?? 'offline').toLowerCase();
  if (value === 'online' || value === 'active' || value === 'running') {
    return (
      <span className="relative flex h-2 w-2">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent opacity-75"></span>
        <span className="relative inline-flex h-2 w-2 rounded-full bg-accent shadow-[0_0_8px_rgba(74,222,128,0.6)]"></span>
      </span>
    );
  }
  if (value === 'idle') {
    return (
      <span className="relative flex h-2 w-2">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-amber-400 opacity-75"></span>
        <span className="relative inline-flex h-2 w-2 rounded-full bg-amber-500 shadow-[0_0_8px_rgba(245,158,11,0.6)]"></span>
      </span>
    );
  }
  return <span className="h-1.5 w-1.5 rounded-full bg-gray-400/80"></span>;
}

export function HarnessBadge({ adapterType }: { adapterType?: string | null }) {
  if (!adapterType) return null;
  const normalized = adapterType.toLowerCase();
  
  let label = adapterType;
  let colorClasses = "bg-surface-3 border-line text-text-muted";
  
  if (normalized === 'codex') {
    label = 'Codex';
    colorClasses = "bg-[#10b981]/10 text-[#10b981] border-[#10b981]/20";
  } else if (normalized === 'claude_code') {
    label = 'Claude';
    colorClasses = "bg-[#8b5cf6]/10 text-[#a78bfa] border-[#8b5cf6]/20";
  } else if (normalized === 'cursor') {
    label = 'Cursor';
    colorClasses = "bg-[#3b82f6]/10 text-[#60a5fa] border-[#3b82f6]/20";
  } else if (normalized === 'http') {
    label = 'HTTP';
    colorClasses = "bg-surface-3 border-line text-text-muted";
  } else {
    label = adapterType.split('_')[0] ?? '';
    label = label.charAt(0).toUpperCase() + label.slice(1);
    colorClasses = "bg-surface-3 border-line text-text-secondary";
  }
  
  return (
    <span className={clsx("inline-flex items-center rounded px-1.5 py-0.5 text-[8.5px] font-mono font-medium border uppercase tracking-wider scale-[0.9]", colorClasses)}>
      {label}
    </span>
  );
}

function HistoryRow({
  entry,
  isActive,
  isEditing,
  editingTitle,
  setEditingTitle,
  onSaveRename,
  onCancelRename,
  onStartRename,
  onToggleArchive,
  onConfirmDelete,
  confirmDelete,
  setConfirmDelete,
  actionLoading,
  renameInputRef,
}: {
  entry: HistoryEntry;
  isActive: boolean;
  isEditing: boolean;
  editingTitle: string;
  setEditingTitle: (val: string) => void;
  onSaveRename: () => void;
  onCancelRename: () => void;
  onStartRename: () => void;
  onToggleArchive: () => void;
  onConfirmDelete: () => void;
  confirmDelete: boolean;
  setConfirmDelete: (val: boolean) => void;
  actionLoading: boolean;
  renameInputRef: React.RefObject<HTMLInputElement>;
}) {
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <div
      onClick={() => {
        if (!isEditing && !confirmDelete && !actionLoading) {
          entry.onOpen();
        }
      }}
      onDoubleClick={() => {
        if (!entry.archivedAt && !isEditing) {
          onStartRename();
        }
      }}
      className={clsx(
        'group relative flex w-full flex-col gap-1 border-b border-line/45 px-3 py-3 text-left last:border-b-0 cursor-pointer transition-all duration-200 select-none hover:bg-surface-3/40',
        isActive
          ? 'bg-accent/5 backdrop-blur-[2px] border-l-2 border-l-accent'
          : 'bg-transparent border-l-2 border-l-transparent hover:-translate-x-0.5'
      )}
    >
      <div className="flex items-start gap-2.5">
        <span
          className="mt-0.5 flex h-6.5 w-6.5 shrink-0 items-center justify-center rounded-full text-text-muted border border-line bg-surface"
          style={{ color: entry.agentColor ?? '#7a8390' }}
        >
          <MessageCircle size={13} />
        </span>
        <span className="min-w-0 flex-1 space-y-0.5">
          <span className="flex items-center gap-1.5">
            <span className="mt-0.5 shrink-0 flex items-center justify-center">
              <StatusDot status={entry.agentStatus} />
            </span>
            {isEditing ? (
              <div
                className="flex items-center gap-1 min-w-0 w-full"
                onClick={(e) => e.stopPropagation()}
              >
                <input
                  ref={renameInputRef}
                  value={editingTitle}
                  onChange={(e) => setEditingTitle(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') onSaveRename();
                    if (e.key === 'Escape') onCancelRename();
                  }}
                  className="h-6 min-w-0 flex-1 rounded border border-accent bg-canvas px-1 text-xs text-text-primary outline-none focus:border-accent font-sans"
                />
                <button
                  type="button"
                  onClick={onSaveRename}
                  disabled={actionLoading}
                  className="rounded p-0.5 text-emerald-500 hover:bg-surface-3"
                  aria-label="Confirm Rename"
                >
                  <Check size={12} />
                </button>
                <button
                  type="button"
                  onClick={onCancelRename}
                  className="rounded p-0.5 text-rose-500 hover:bg-surface-3"
                  aria-label="Cancel Rename"
                >
                  <X size={12} />
                </button>
              </div>
            ) : (
              <span className="truncate text-xs font-semibold text-text-primary leading-tight">
                {entry.title}
              </span>
            )}
            {entry.unread > 0 && !isEditing && (
              <span className="inline-flex h-3.5 min-w-[14px] items-center justify-center rounded-full bg-accent px-1 text-[8px] font-extrabold text-canvas leading-none unread-badge-enter">
                {entry.unread > 9 ? '9+' : entry.unread}
              </span>
            )}
          </span>
          {!isEditing && (
            <>
              <div className="flex flex-wrap items-center gap-1.5">
                {entry.adapterType && <HarnessBadge adapterType={entry.adapterType} />}
                {entry.subtitle && (
                  <span className="block truncate text-[10px] text-text-muted leading-tight max-w-[110px]">
                    {entry.subtitle}
                  </span>
                )}
              </div>
              <span className="block truncate text-[10px] text-text-muted/80 leading-normal font-normal">
                {entry.preview}
              </span>
            </>
          )}
        </span>

        {/* Action Button or Confirmation */}
        <div
          className="shrink-0 flex items-center gap-1.5"
          onClick={(e) => e.stopPropagation()}
        >
          {actionLoading ? (
            <Loader2 size={12} className="animate-spin text-accent" />
          ) : confirmDelete ? (
            <div className="flex items-center gap-1 bg-surface rounded-md border border-line p-0.5 shadow-sm">
              <span className="text-[9px] font-bold text-rose-500 px-1 font-mono">Delete?</span>
              <button
                type="button"
                onClick={onConfirmDelete}
                className="rounded bg-rose-500 text-canvas px-1.5 py-0.5 text-[9px] font-bold hover:bg-rose-600"
              >
                Yes
              </button>
              <button
                type="button"
                onClick={() => setConfirmDelete(false)}
                className="rounded bg-surface-3 px-1.5 py-0.5 text-[9px] font-bold text-text-muted hover:bg-surface-4"
              >
                No
              </button>
            </div>
          ) : (
            <div className="opacity-0 group-hover:opacity-100 focus-within:opacity-100 flex items-center gap-0.5 transition-opacity duration-150">
              <DropdownMenu.Root open={menuOpen} onOpenChange={setMenuOpen}>
                <DropdownMenu.Trigger asChild>
                  <button
                    type="button"
                    title="Actions"
                    className="rounded-lg p-1 text-text-muted hover:bg-surface-3 hover:text-text-primary focus:outline-none"
                  >
                    <MoreVertical size={13} />
                  </button>
                </DropdownMenu.Trigger>
                <DropdownMenu.Portal>
                  <DropdownMenu.Content
                    className="z-[12000] min-w-[150px] rounded-xl border border-glass-border bg-glass-panel/98 backdrop-blur-xl p-1.5 shadow-dropdown animate-in fade-in slide-in-from-top-2 duration-150"
                    align="end"
                    sideOffset={5}
                  >
                    {!entry.archivedAt && (
                      <DropdownMenu.Item
                        onSelect={onStartRename}
                        className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-xs text-text-secondary outline-none hover:bg-surface-3/50 hover:text-text-primary focus:bg-surface-3/50 focus:text-text-primary transition-colors"
                      >
                        <Pencil size={12} className="text-text-muted" />
                        Rename Session
                      </DropdownMenu.Item>
                    )}
                    <DropdownMenu.Item
                      onSelect={onToggleArchive}
                      className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-xs text-text-secondary outline-none hover:bg-surface-3/50 hover:text-text-primary focus:bg-surface-3/50 focus:text-text-primary transition-colors"
                    >
                      <Archive size={12} className={clsx('text-text-muted', entry.archivedAt && 'text-accent')} />
                      {entry.archivedAt ? 'Unarchive' : 'Archive'}
                    </DropdownMenu.Item>
                    <DropdownMenu.Item
                      onSelect={() => {
                        // Open in new tab by simulating direct navigation or dispatching event
                        window.open(`/chat?session=${entry.conversationId}`, '_blank');
                      }}
                      className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-xs text-text-secondary outline-none hover:bg-surface-3/50 hover:text-text-primary focus:bg-surface-3/50 focus:text-text-primary transition-colors"
                    >
                      <ExternalLink size={12} className="text-text-muted" />
                      Open in New Tab
                    </DropdownMenu.Item>
                    <DropdownMenu.Separator className="my-1 h-[1px] bg-line" />
                    <DropdownMenu.Item
                      onSelect={() => setConfirmDelete(true)}
                      className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-xs text-rose-500 font-medium outline-none hover:bg-rose-500/10 focus:bg-rose-500/10 transition-colors"
                    >
                      <Trash2 size={12} />
                      Delete Session
                    </DropdownMenu.Item>
                  </DropdownMenu.Content>
                </DropdownMenu.Portal>
              </DropdownMenu.Root>
            </div>
          )}
        </div>
      </div>
      {!isEditing && (
        <span className="mt-1 block text-[8.5px] text-text-muted/50 text-right leading-none font-mono">
          {formatAt(entry.at)}
        </span>
      )}
    </div>
  );
}

function StarterRow({
  icon,
  title,
  subtitle,
  unread,
  onOpen,
}: {
  icon: React.ReactNode;
  title: string;
  subtitle: string;
  unread: number;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex w-full items-start gap-2.5 border-b border-line/45 px-3 py-3 text-left last:border-b-0 hover:bg-surface-3/40 transition-all duration-200 hover:-translate-x-0.5"
    >
      <span className="mt-0.5 flex h-6.5 w-6.5 shrink-0 items-center justify-center rounded-full bg-surface border border-line text-text-muted shadow-sm">
        {icon}
      </span>
      <span className="min-w-0 flex-1 space-y-0.5">
        <span className="flex items-center gap-2">
          <span className="truncate text-xs font-semibold text-text-primary leading-tight">{title}</span>
          {unread > 0 && (
            <span className="inline-flex h-3.5 min-w-[14px] items-center justify-center rounded-full bg-accent px-1 text-[8px] font-extrabold text-canvas leading-none unread-badge-enter">
              {unread > 9 ? '9+' : unread}
            </span>
          )}
        </span>
        <span className="block truncate text-[10px] text-text-muted leading-tight">{subtitle}</span>
      </span>
    </button>
  );
}

function groupForDate(value: string): 'Today' | 'Yesterday' | 'Earlier' {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Earlier';
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const target = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const diffDays = Math.round((today - target) / 86400000);
  if (diffDays <= 0) return 'Today';
  if (diffDays === 1) return 'Yesterday';
  return 'Earlier';
}

function formatAt(value: string): string {
  if (!value || value === EMPTY_DATE) return 'No activity yet';
  const date = parseISO(value);
  if (Number.isNaN(date.getTime())) return 'No activity yet';
  try {
    return formatDistanceToNow(date, { addSuffix: true });
  } catch {
    return date.toLocaleDateString();
  }
}
