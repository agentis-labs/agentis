import { useEffect, useMemo, useState } from 'react';
import { ChevronLeft, Clock3, Hash, Megaphone, MessageCircle, Search } from 'lucide-react';
import clsx from 'clsx';
import { api } from '../../lib/api';

interface ConversationRow {
  id: string;
  agentId: string;
  agentName: string;
  title?: string | null;
  archivedAt?: string | null;
  lastMessageAt: string | null;
  lastMessagePreview: string | null;
  unread?: number;
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
}: {
  onBack: () => void;
  onOpenAgent: (agentId: string, name: string, options?: { conversationId?: string | null; archivedAt?: string | null }) => void;
  onOpenRoom: (roomId: string, name: string) => void;
  onOpenBroadcast: () => void;
}) {
  const [conversations, setConversations] = useState<ConversationRow[]>([]);
  const [rooms, setRooms] = useState<RoomRow[]>([]);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<HistoryFilter>('all');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      try {
        const [conversationRes, roomRes] = await Promise.allSettled([
          api<{ conversations: ConversationRow[] }>('/v1/conversations'),
          api<{ rooms: RoomRow[] }>('/v1/rooms'),
        ]);
        if (cancelled) return;
        if (conversationRes.status === 'fulfilled') setConversations(conversationRes.value.conversations ?? []);
        if (roomRes.status === 'fulfilled') setRooms(roomRes.value.rooms ?? []);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void load();
    window.addEventListener('agentis:workspace-changed', load);
    window.addEventListener('agentis:chat-history-changed', load);
    return () => {
      cancelled = true;
      window.removeEventListener('agentis:workspace-changed', load);
      window.removeEventListener('agentis:chat-history-changed', load);
    };
  }, []);

  const recentEntries = useMemo<HistoryEntry[]>(() => {
    const threadEntries = conversations
      .filter((conversation) => Boolean(conversation.lastMessageAt))
      .map<HistoryEntry>((conversation) => ({
      id: `agent-${conversation.id}`,
      kind: 'agent',
      title: conversation.archivedAt ? conversation.title?.trim() || conversation.agentName : conversation.agentName,
      subtitle: conversation.archivedAt ? conversation.agentName : 'Current conversation',
      preview: conversation.lastMessagePreview?.trim() || 'Direct conversation',
      at: conversation.lastMessageAt ?? EMPTY_DATE,
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
      const haystack = `${entry.title} ${entry.preview}`.toLowerCase();
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

  const recentGroups = useMemo(() => {
    const groups: Array<{ label: string; entries: HistoryEntry[] }> = [];
    const today: HistoryEntry[] = [];
    const yesterday: HistoryEntry[] = [];
    const earlier: HistoryEntry[] = [];
    for (const entry of filteredRecent) {
      const bucket = groupForDate(entry.at);
      if (bucket === 'Today') today.push(entry);
      else if (bucket === 'Yesterday') yesterday.push(entry);
      else earlier.push(entry);
    }
    if (today.length > 0) groups.push({ label: 'Today', entries: today });
    if (yesterday.length > 0) groups.push({ label: 'Yesterday', entries: yesterday });
    if (earlier.length > 0) groups.push({ label: 'Earlier', entries: earlier });
    return groups;
  }, [filteredRecent]);

  const isEmpty = !loading && recentGroups.length === 0 && filteredRooms.length === 0;

  return (
    <div className="flex h-full flex-col bg-surface">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-line px-3">
        <button
          type="button"
          onClick={onBack}
          aria-label="Back to threads"
          className="-m-1 rounded-md p-1 text-text-muted hover:bg-surface-2 hover:text-text-primary"
        >
          <ChevronLeft size={16} />
        </button>
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
                'rounded-full border px-2 py-1 text-[10px] font-medium capitalize transition-colors',
                filter === item
                  ? 'border-accent/40 bg-accent/10 text-accent'
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
            {recentGroups.length > 0 && (filter === 'all' || filter === 'recent' || filter === 'agent' || filter === 'room' || filter === 'broadcast') && (
              <Section title="Conversations" subtitle="Active and saved sessions">
                <div className="space-y-3">
                  {recentGroups.map((group) => (
                    <div key={group.label}>
                      <div className="mb-1 px-1 text-[10px] font-semibold uppercase tracking-wider text-text-muted">
                        {group.label}
                      </div>
                      <div className="overflow-hidden rounded-md border border-line/60 bg-surface-2/30">
                        {group.entries.map((entry) => (
                          <HistoryRow key={entry.id} entry={entry} />
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </Section>
            )}

            {filteredRooms.length > 0 && (
              <Section title="Rooms" subtitle="Open existing rooms or broadcast">
                <div className="overflow-hidden rounded-md border border-line/60 bg-surface-2/30">
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

function HistoryIcon({ kind }: { kind: HistoryEntry['kind'] }) {
  if (kind === 'agent') return <MessageCircle size={14} />;
  if (kind === 'broadcast') return <Megaphone size={14} />;
  return <Hash size={14} />;
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
    <section>
      <div className="mb-2 px-1">
        <div className="text-[11px] font-semibold uppercase tracking-wider text-text-muted">{title}</div>
        <div className="text-[11px] text-text-muted/80">{subtitle}</div>
      </div>
      {children}
    </section>
  );
}

function HistoryRow({ entry }: { entry: HistoryEntry }) {
  return (
    <button
      type="button"
      onClick={entry.onOpen}
      className="flex w-full items-start gap-3 border-b border-line/60 px-3 py-3 text-left last:border-b-0 hover:bg-surface-2"
    >
      <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-surface-2 text-text-muted">
        <HistoryIcon kind={entry.kind} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span className="truncate text-[13px] font-medium text-text-primary">{entry.title}</span>
          {entry.unread > 0 && (
            <span className="inline-flex h-4 min-w-[16px] items-center justify-center rounded-full bg-accent px-1 text-[9px] font-bold text-canvas">
              {entry.unread > 9 ? '9+' : entry.unread}
            </span>
          )}
        </span>
        {entry.subtitle && <span className="mt-0.5 block truncate text-[11px] text-text-muted">{entry.subtitle}</span>}
        <span className="mt-0.5 block truncate text-[11px] text-text-muted/90">{entry.preview}</span>
        <span className="mt-1 block text-[10px] text-text-muted/80">{formatAt(entry.at)}</span>
      </span>
    </button>
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
      className="flex w-full items-start gap-3 border-b border-line/60 px-3 py-3 text-left last:border-b-0 hover:bg-surface-2"
    >
      <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-surface-2 text-text-muted">
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span className="truncate text-[13px] font-medium text-text-primary">{title}</span>
          {unread > 0 && (
            <span className="inline-flex h-4 min-w-[16px] items-center justify-center rounded-full bg-accent px-1 text-[9px] font-bold text-canvas">
              {unread > 9 ? '9+' : unread}
            </span>
          )}
        </span>
        <span className="mt-0.5 block truncate text-[11px] text-text-muted">{subtitle}</span>
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

function compareAgentStatus(left?: string, right?: string): number {
  return statusRank(left) - statusRank(right);
}

function statusRank(status?: string): number {
  const value = (status ?? 'offline').toLowerCase();
  if (value === 'running' || value === 'active' || value === 'online') return 0;
  if (value === 'idle') return 1;
  return 2;
}

function describeAgentStatus(status?: string): string {
  const value = (status ?? 'offline').toLowerCase();
  if (value === 'running' || value === 'active' || value === 'online') return 'Available now';
  if (value === 'idle') return 'Idle';
  return 'Offline';
}

function formatAt(value: string): string {
  if (!value || value === EMPTY_DATE) return 'No activity yet';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'No activity yet';
  return date.toLocaleString();
}
