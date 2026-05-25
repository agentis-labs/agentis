import { useEffect, useMemo, useState, useRef } from 'react';
import { ChevronLeft, Clock3, Hash, Megaphone, MessageCircle, Search, Pencil, Trash2, Archive, Check, X, ChevronDown, ChevronUp, Loader2 } from 'lucide-react';
import clsx from 'clsx';
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
      const [conversationRes, roomRes] = await Promise.allSettled([
        api<{ conversations: ConversationRow[] }>('/v1/conversations'),
        api<{ rooms: RoomRow[] }>('/v1/rooms'),
      ]);
      if (conversationRes.status === 'fulfilled') setConversations(conversationRes.value.conversations ?? []);
      if (roomRes.status === 'fulfilled') setRooms(roomRes.value.rooms ?? []);
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

  const handleStartRename = (e: React.MouseEvent, conversationId: string, currentTitle: string) => {
    e.stopPropagation();
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

  const handleToggleArchive = async (e: React.MouseEvent, conversationId: string, currentArchived: boolean) => {
    e.stopPropagation();
    setActionLoadingId(conversationId);
    try {
      await api(`/v1/conversations/session/${conversationId}`, {
        method: 'PATCH',
        body: JSON.stringify({ archived: !currentArchived }),
      });
      toast.success(currentArchived ? 'Session unarchived' : 'Session archived');
      window.dispatchEvent(new CustomEvent('agentis:chat-history-changed'));
    } catch (error) {
      toast.error('Failed to update session archive status', apiErrorMessage(error));
    } finally {
      setActionLoadingId(null);
    }
  };

  const handleDeleteConversation = async (e: React.MouseEvent, conversationId: string) => {
    e.stopPropagation();
    setActionLoadingId(conversationId);
    try {
      await api(`/v1/conversations/session/${conversationId}`, {
        method: 'DELETE',
      });
      toast.success('Session deleted');
      setConfirmDeleteId(null);
      
      // If we deleted the currently active conversation, trigger a fallback
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

  const recentEntries = useMemo<HistoryEntry[]>(() => {
    const threadEntries = conversations
      .filter((conversation) => !conversation.archivedAt || Boolean(conversation.lastMessageAt))
      .map<HistoryEntry>((conversation) => ({
        id: `agent-${conversation.id}`,
        conversationId: conversation.id,
        agentId: conversation.agentId,
        agentStatus: conversation.agentStatus,
        agentColor: conversation.agentColor,
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
  }, [conversations, onOpenAgent]);

  const roomStarters = useMemo<RoomStarter[]>(() => {
    const next = rooms.map<RoomStarter>((room) => ({
      id: room.id,
      kind: room.kind === 'workspace' ? 'broadcast' : 'room',
      title: room.kind === 'workspace' ? 'Fleet broadcast' : room.name,
      subtitle: room.kind === 'workspace'
        ? 'Send one message to every live agent'
        : room.lastMessagePreview?.trim() || `${room.kind} room`,
      unread: room.unreadCount ?? 0,
      onOpen: () => (room.kind === 'workspace' ? onOpenBroadcast() : onOpenRoom(room.id, room.name)),
    }));
    return next.sort((left, right) => {
      if (left.kind !== right.kind) return left.kind === 'broadcast' ? -1 : 1;
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

  // Separate Active and Archived entries
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

  return (
    <div className="flex h-full flex-col bg-surface">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-line px-3">
        {onBack && (
          <button
            type="button"
            onClick={onBack}
            aria-label="Back"
            className="-m-1 rounded-md p-1 text-text-muted hover:bg-surface-2 hover:text-text-primary"
          >
            <ChevronLeft size={16} />
          </button>
        )}
        <div className="min-w-0 flex-1">
          <div className="text-subheading text-text-primary">Chat history</div>
          <div className="text-[10px] text-text-muted">Saved agent sessions and room activity</div>
        </div>
      </header>

      <div className="border-b border-line p-3">
        <label className="flex items-center gap-2 rounded-md border border-line bg-canvas px-2 py-2 text-[12px] text-text-muted focus-within:border-accent/40">
          <Search size={14} />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search conversations or rooms"
            className="min-w-0 flex-1 bg-transparent text-text-primary outline-none placeholder:text-text-muted"
          />
        </label>
        <div className="mt-2 flex flex-wrap gap-1">
          {(['all', 'recent', 'agent', 'room', 'broadcast'] as const).map((item) => (
            <button
              key={item}
              type="button"
              onClick={() => setFilter(item)}
              className={clsx(
                'rounded-full border px-2.5 py-1 text-[10px] font-medium capitalize transition-colors',
                filter === item
                  ? 'border-accent/40 bg-accent/10 text-accent font-semibold'
                  : 'border-line text-text-muted hover:bg-surface-2 hover:text-text-primary',
              )}
            >
              {item === 'agent' ? 'Direct' : item}
            </button>
          ))}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {loading ? (
          <div className="flex h-full items-center justify-center px-4 text-[12px] text-text-muted">
            <Loader2 size={16} className="animate-spin text-accent mr-2" />
            Loading history…
          </div>
        ) : isEmpty ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-4 text-center">
            <Clock3 size={24} className="text-text-muted opacity-60" />
            <div className="text-[13px] font-medium text-text-primary">Nothing matches this view</div>
            <div className="max-w-[220px] text-[12px] text-text-muted">
              Try a different search or switch filters.
            </div>
          </div>
        ) : (
          <div className="space-y-4 px-3 py-3">
            {/* Active Conversations Section */}
            {activeGroups.length > 0 && (
              <Section title="Conversations" subtitle="Active sessions">
                <div className="space-y-3">
                  {activeGroups.map((group) => (
                    <div key={group.label} className="space-y-1">
                      <div className="mb-1 px-1 text-[9px] font-bold uppercase tracking-wider text-text-muted/70">
                        {group.label}
                      </div>
                      <div className="overflow-hidden rounded-lg border border-line/50 bg-surface-2/20 space-y-[1px]">
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
                            onStartRename={(e) => handleStartRename(e, entry.conversationId, entry.title)}
                            onToggleArchive={(e) => handleToggleArchive(e, entry.conversationId, false)}
                            onConfirmDelete={(e) => handleDeleteConversation(e, entry.conversationId)}
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
              <div className="rounded-lg border border-line bg-surface-2/10 overflow-hidden">
                <button
                  type="button"
                  onClick={() => setArchivedCollapsed((c) => !c)}
                  className="flex w-full items-center justify-between px-3 py-2.5 text-left text-xs font-semibold uppercase tracking-wider text-text-muted hover:bg-surface-2/30"
                >
                  <span className="flex items-center gap-1.5">
                    <Archive size={12} className="text-text-muted" />
                    Archived Conversations ({archivedRecent.length})
                  </span>
                  {archivedCollapsed ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
                </button>
                {!archivedCollapsed && (
                  <div className="border-t border-line/60 bg-surface/30 p-1.5 space-y-1">
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
                        onStartRename={(e) => handleStartRename(e, entry.conversationId, entry.title)}
                        onToggleArchive={(e) => handleToggleArchive(e, entry.conversationId, true)}
                        onConfirmDelete={(e) => handleDeleteConversation(e, entry.conversationId)}
                        confirmDelete={confirmDeleteId === entry.conversationId}
                        setConfirmDelete={(val) => setConfirmDeleteId(val ? entry.conversationId : null)}
                        actionLoading={actionLoadingId === entry.conversationId}
                        renameInputRef={renameInputRef}
                      />
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Rooms Section */}
            {filteredRooms.length > 0 && (
              <Section title="Rooms" subtitle="Workspace and team rooms">
                <div className="overflow-hidden rounded-lg border border-line/50 bg-surface-2/20 space-y-[1px]">
                  {filteredRooms.map((entry) => (
                    <StarterRow
                      key={entry.kind === 'broadcast' ? `broadcast-${entry.id}` : entry.id}
                      icon={entry.kind === 'broadcast' ? <Megaphone size={14} /> : <Hash size={14} />}
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
    <section className="space-y-1">
      <div className="mb-1.5 px-1 flex flex-col">
        <div className="text-[10px] font-bold uppercase tracking-wider text-text-muted">{title}</div>
        <div className="text-[10px] text-text-muted/80 leading-tight">{subtitle}</div>
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
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75"></span>
        <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.6)]"></span>
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
  return <span className="h-2 w-2 rounded-full bg-gray-400/80"></span>;
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
  onStartRename: (e: React.MouseEvent) => void;
  onToggleArchive: (e: React.MouseEvent) => void;
  onConfirmDelete: (e: React.MouseEvent) => void;
  confirmDelete: boolean;
  setConfirmDelete: (val: boolean) => void;
  actionLoading: boolean;
  renameInputRef: React.RefObject<HTMLInputElement>;
}) {
  return (
    <div
      onClick={() => {
        if (!isEditing && !confirmDelete && !actionLoading) {
          entry.onOpen();
        }
      }}
      onDoubleClick={(e) => {
        if (!entry.archivedAt && !isEditing) {
          onStartRename(e);
        }
      }}
      className={clsx(
        'group relative flex w-full flex-col gap-1 border-b border-line/40 px-3 py-2.5 text-left last:border-b-0 cursor-pointer transition-all duration-200 select-none hover:bg-surface-3/50',
        isActive
          ? 'bg-accent/5 backdrop-blur-[4px] border-l-2 border-l-accent border-r border-r-line/20'
          : 'bg-transparent border-l-2 border-l-transparent'
      )}
    >
      <div className="flex items-start gap-2.5">
        <span
          className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-text-muted transition-colors"
          style={{ backgroundColor: entry.agentColor ? `${entry.agentColor}15` : 'rgba(122, 131, 144, 0.15)', color: entry.agentColor ?? '#7a8390' }}
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
                  className="h-6 min-w-0 flex-1 rounded border border-accent bg-canvas px-1 text-xs text-text-primary outline-none focus:border-accent"
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
              <span className="truncate text-xs font-semibold text-text-primary leading-none">
                {entry.title}
              </span>
            )}
            {entry.unread > 0 && !isEditing && (
              <span className="inline-flex h-3.5 min-w-[14px] items-center justify-center rounded-full bg-accent px-1 text-[8px] font-extrabold text-canvas leading-none">
                {entry.unread > 9 ? '9+' : entry.unread}
              </span>
            )}
          </span>
          {!isEditing && (
            <>
              {entry.subtitle && (
                <span className="block truncate text-[10px] text-text-muted leading-tight">
                  {entry.subtitle}
                </span>
              )}
              <span className="block truncate text-[10px] text-text-muted/80 leading-normal font-normal">
                {entry.preview}
              </span>
            </>
          )}
        </span>

        {/* Inline Confirmation Bubble or Action Buttons */}
        <div
          className="shrink-0 flex items-center gap-1.5"
          onClick={(e) => e.stopPropagation()}
        >
          {actionLoading ? (
            <Loader2 size={12} className="animate-spin text-accent" />
          ) : confirmDelete ? (
            <div className="flex items-center gap-1 bg-surface-2 rounded-md border border-line p-0.5 shadow-sm">
              <span className="text-[9px] font-bold text-rose-500 px-1">Delete?</span>
              <button
                type="button"
                onClick={onConfirmDelete}
                className="rounded bg-rose-500 text-canvas px-1 py-0.5 text-[9px] font-bold hover:bg-rose-600"
              >
                Yes
              </button>
              <button
                type="button"
                onClick={() => setConfirmDelete(false)}
                className="rounded bg-surface-3 px-1 py-0.5 text-[9px] font-bold text-text-muted hover:bg-surface-4"
              >
                No
              </button>
            </div>
          ) : (
            <div className="opacity-0 group-hover:opacity-100 flex items-center gap-0.5 transition-opacity duration-150">
              {!entry.archivedAt && (
                <button
                  type="button"
                  onClick={onStartRename}
                  title="Rename Session (Double click card)"
                  className="rounded p-1 text-text-muted hover:bg-surface-3 hover:text-text-primary"
                >
                  <Pencil size={11} />
                </button>
              )}
              <button
                type="button"
                onClick={onToggleArchive}
                title={entry.archivedAt ? 'Unarchive Session' : 'Archive Session'}
                className="rounded p-1 text-text-muted hover:bg-surface-3 hover:text-text-primary"
              >
                <Archive size={11} className={clsx(entry.archivedAt && 'text-accent')} />
              </button>
              <button
                type="button"
                onClick={() => setConfirmDelete(true)}
                title="Delete Session"
                className="rounded p-1 text-text-muted hover:bg-surface-3 hover:text-rose-500"
              >
                <Trash2 size={11} />
              </button>
            </div>
          )}
        </div>
      </div>
      {!isEditing && (
        <span className="mt-0.5 block text-[8px] text-text-muted/60 text-right leading-none">
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
      className="flex w-full items-start gap-2.5 border-b border-line/40 px-3 py-2.5 text-left last:border-b-0 hover:bg-surface-3/50 transition-colors"
    >
      <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-surface-3 text-text-muted">
        {icon}
      </span>
      <span className="min-w-0 flex-1 space-y-0.5">
        <span className="flex items-center gap-2">
          <span className="truncate text-xs font-semibold text-text-primary leading-none">{title}</span>
          {unread > 0 && (
            <span className="inline-flex h-3.5 min-w-[14px] items-center justify-center rounded-full bg-accent px-1 text-[8px] font-extrabold text-canvas leading-none">
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
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'No activity yet';
  return date.toLocaleString();
}
