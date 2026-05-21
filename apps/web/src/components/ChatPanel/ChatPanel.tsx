/**
 * ChatPanel — UIUX-REFACTOR §4.
 *
 * Persistent right-column chat surface that replaces the floating
 * Assistant orb + ConversationDock. Two views:
 *   - Thread list (default): every operator-agent conversation +
 *     broadcast option.
 *   - Thread view: messages + composer with slash commands, @mentions,
 *     #resource references.
 *
 * The panel can render in two layouts:
 *   - "panel" (default): right column inside the Shell, 360px wide.
 *   - "fullscreen": the /chat route renders this with `mode="fullscreen"`.
 */

import { useEffect, useState } from 'react';
import { ChevronLeft, Clock, MessageCircle, Pin, PinOff, Users, X } from 'lucide-react';
import { REALTIME_EVENTS } from '@agentis/core';
import { api, workspace as wsStore } from '../../lib/api';
import { rtSubscribe, useRealtime } from '../../lib/realtime';
import { useAgentisStore } from '../../store/agentisStore';
import { ThreadList } from './ThreadList';
import { ThreadView } from './ThreadView';
import { BroadcastView } from './BroadcastView';
import { RoomView } from './RoomView';
import { SessionHistoryPanel } from './SessionHistoryPanel';

export interface ConversationRow {
  id: string;
  agentId: string;
  agentName: string;
  agentColor: string;
  unread: number;
  lastMessageAt: string | null;
  lastMessagePreview: string | null;
  mirroredSessionId?: string | null;
}

export interface AgentRow {
  id: string;
  name: string;
  color?: string;
  colorHex?: string | null;
  status: string;
  isPaused?: boolean | null;
  teamId?: string | null;
  capabilityTags?: string[] | null;
}

export interface RoomRow {
  id: string;
  name: string;
  description?: string | null;
  kind: 'workspace' | 'team' | 'custom' | 'thread';
  teamId: string | null;
  isTeamDefault: boolean;
  visibility: string;
  pinnedAt: string | null;
  lastMessageAt: string | null;
  agentIds?: string[];
}

export interface TeamRow {
  id: string;
  name: string;
  colorHex?: string | null;
  stats?: { agents?: number; liveAgents?: number };
}

interface Props {
  mode?: 'panel' | 'fullscreen';
}

export function ChatPanel({ mode = 'panel' }: Props) {
  const open = useAgentisStore((s) => s.chatPanelOpen);
  const threadId = useAgentisStore((s) => s.chatPanelThreadId);
  const setOpen = useAgentisStore((s) => s.setChatPanelOpen);
  const openThread = useAgentisStore((s) => s.openChatThread);

  const [list, setList] = useState<ConversationRow[]>([]);
  const [agents, setAgents] = useState<AgentRow[]>([]);
  const [rooms, setRooms] = useState<RoomRow[]>([]);
  const [teams, setTeams] = useState<TeamRow[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [tick, setTick] = useState(0);
  const [roomDialogOpen, setRoomDialogOpen] = useState(false);
  const [roomNameInput, setRoomNameInput] = useState('');
  const [docked, setDocked] = useState(() => window.localStorage.getItem('agentis.chatPanelDocked') === '1');

  const roomId = threadId?.startsWith('room:') ? threadId.slice('room:'.length) : null;
  const activeRoom = roomId ? rooms.find((room) => room.id === roomId) : null;

  useEffect(() => {
    if (mode === 'panel' && !open) return;
    const ws = wsStore.get();
    if (ws) rtSubscribe('workspace', { workspaceId: ws });
    void loadLists();
  }, [tick, open, mode]);

  async function loadLists() {
    const [cv, ag, roomRes, teamRes] = await Promise.all([
      api<{ conversations: ConversationRow[] }>('/v1/conversations'),
      api<{ agents: AgentRow[] }>('/v1/agents').catch(() => ({ agents: [] as AgentRow[] })),
      api<{ rooms: RoomRow[] }>('/v1/rooms').catch(() => ({ rooms: [] as RoomRow[] })),
      api<{ teams: TeamRow[] }>('/v1/teams').catch(() => ({ teams: [] as TeamRow[] })),
    ]);
    setList(cv.conversations);
    setAgents(ag.agents);
    setTeams(teamRes.teams);
    setRooms(roomRes.rooms);
  }

  async function ensureGeneralRoom(existing: RoomRow[]): Promise<RoomRow[]> {
    if (existing.some((room) => room.kind === 'workspace' || (!room.teamId && room.name.toLowerCase() === 'general'))) return existing;
    try {
      const created = await api<{ room: RoomRow }>('/v1/rooms', {
        method: 'POST',
        body: JSON.stringify({ name: 'General', kind: 'workspace', visibility: 'workspace', agentIds: [] }),
      });
      return [created.room, ...existing];
    } catch {
      return existing;
    }
  }

  useRealtime(
    [
      REALTIME_EVENTS.CONVERSATION_MESSAGE_RECEIVED,
      REALTIME_EVENTS.CONVERSATION_MESSAGE_SENT,
      REALTIME_EVENTS.AGENT_STATUS_CHANGED,
      REALTIME_EVENTS.ROOM_CREATED,
      REALTIME_EVENTS.ROOM_UPDATED,
      REALTIME_EVENTS.ROOM_DELETED,
      REALTIME_EVENTS.ROOM_MESSAGE_RECEIVED,
    ],
    () => setTick((t) => t + 1),
  );

  // Allow other components to request the panel be opened (e.g. quick
  // actions on Home page). Keeps the ChatPanel state owner-free.
  useEffect(() => {
    if (mode === 'fullscreen') return;
    const onOpen = (event: Event) => {
      setOpen(true);
      const detail = (event as CustomEvent<{ agentId?: string; roomId?: string }>).detail;
      const agentId = detail?.agentId;
      const eventRoomId = detail?.roomId;
      if (agentId) openThread(agentId);
      if (eventRoomId) openThread(`room:${eventRoomId}`);
    };
    window.addEventListener('agentis:chat-panel-open', onOpen);
    return () => window.removeEventListener('agentis:chat-panel-open', onOpen);
  }, [mode, openThread, setOpen]);

  useEffect(() => {
    const onGeneral = (event: Event) => {
      const message = (event as CustomEvent<{ message?: string }>).detail?.message?.trim();
      if (!message) return;
      void (async () => {
        const currentRooms = rooms.length > 0 ? rooms : await ensureGeneralRoom([]);
        const general = currentRooms.find((room) => room.kind === 'workspace' || (!room.teamId && room.name.toLowerCase() === 'general'));
        if (!general) return;
        openThread(`room:${general.id}`);
        await api(`/v1/rooms/${general.id}/messages`, {
          method: 'POST',
          body: JSON.stringify({ contentType: 'text', content: { text: message } }),
        }).catch(() => undefined);
      })();
    };
    window.addEventListener('agentis:room-general-message', onGeneral);
    return () => window.removeEventListener('agentis:room-general-message', onGeneral);
  }, [openThread, rooms]);

  if (mode === 'panel' && !open) return null;

  const totalUnread = list.reduce((acc, c) => acc + c.unread, 0);
  const panelWidthClass = docked ? 'w-[480px]' : 'w-[360px]';

  function toggleDocked() {
    setDocked((current) => {
      const next = !current;
      window.localStorage.setItem('agentis.chatPanelDocked', next ? '1' : '0');
      return next;
    });
  }

  return (
    <aside
      className={
        mode === 'fullscreen'
          ? 'flex h-full w-full flex-col bg-surface'
          : `flex h-full ${panelWidthClass} shrink-0 flex-col border-l border-line bg-surface`
      }
      aria-label="Chat panel"
    >
      <header
        className="flex h-12 shrink-0 items-center gap-2 border-b border-line px-3"
        style={
          threadId && threadId !== 'broadcast' && !roomId
            ? ({
                ['--agent-color' as string]: agents.find((a) => a.id === threadId)?.color ?? 'var(--accent)',
              } as React.CSSProperties)
            : undefined
        }
      >
        {threadId && threadId !== 'broadcast' && !roomId && (
          <span
            aria-hidden
            className="h-2 w-2 rounded-full"
            style={{ backgroundColor: 'var(--agent-color, var(--accent))' }}
          />
        )}
        {threadId && (
          <button
            type="button"
            onClick={() => openThread(null)}
            aria-label="Back to thread list"
            className="rounded-md p-1 text-text-muted hover:bg-surface-2 hover:text-text-primary"
          >
            <ChevronLeft size={16} />
          </button>
        )}
        <div className="flex items-center gap-2">
          <MessageCircle size={14} className="text-accent" />
          <span className="text-sm font-medium text-text-primary">
            {(() => {
              if (roomId) return activeRoom?.name ?? 'Room';
              if (threadId === 'broadcast') return 'Fleet broadcast';
              if (!threadId) return 'Chat';
              const agent = agents.find((a) => a.id === threadId);
              if (!agent) return 'Conversation';
              const isOrch = /orchestrat/i.test(agent.name)
                || (Array.isArray(agent.capabilityTags) && agent.capabilityTags.some((t) => /orchestrat/i.test(t)));
              return isOrch ? `◎ Orchestrator` : agent.name;
            })()}
          </span>
          {!roomId && threadId && threadId !== 'broadcast' && (() => {
            const agent = agents.find((a) => a.id === threadId);
            if (!agent) return null;
            const isOrch = /orchestrat/i.test(agent.name)
              || (Array.isArray(agent.capabilityTags) && agent.capabilityTags.some((t) => /orchestrat/i.test(t)));
            return isOrch ? (
              <span className="rounded-full border border-accent/40 bg-accent/10 px-1.5 py-0.5 text-[9px] uppercase tracking-wider text-accent">platform</span>
            ) : null;
          })()}
          {!threadId && totalUnread > 0 && (
            <span className="rounded-full bg-accent px-1.5 text-[10px] font-medium text-canvas">
              {totalUnread}
            </span>
          )}
        </div>
        {!threadId && (
          <button
            type="button"
            onClick={() => setHistoryOpen(true)}
            aria-label="Open session history"
            className="ml-auto rounded-md p-1 text-text-muted hover:bg-surface-2 hover:text-text-primary"
          >
            <Clock size={15} />
          </button>
        )}
        {mode === 'panel' && (
          <button
            type="button"
            onClick={toggleDocked}
            aria-label={docked ? 'Use compact chat panel' : 'Dock wide chat panel'}
            aria-pressed={docked}
            title={docked ? 'Compact panel' : 'Dock wide panel'}
            className={!threadId ? 'rounded-md p-1 text-text-muted hover:bg-surface-2 hover:text-text-primary' : 'ml-auto rounded-md p-1 text-text-muted hover:bg-surface-2 hover:text-text-primary'}
          >
            {docked ? <PinOff size={16} /> : <Pin size={16} />}
          </button>
        )}
        {mode === 'panel' && (
          <button
            type="button"
            onClick={() => setOpen(false)}
            aria-label="Close chat panel"
            className="rounded-md p-1 text-text-muted hover:bg-surface-2 hover:text-text-primary"
          >
            <X size={16} />
          </button>
        )}
      </header>

      <div className="min-h-0 flex-1 overflow-hidden">
        {historyOpen ? (
          <SessionHistoryPanel
            onBack={() => setHistoryOpen(false)}
            onOpenThread={(id) => {
              setHistoryOpen(false);
              openThread(id);
            }}
            onOpenRoom={(id) => {
              setHistoryOpen(false);
              openThread(`room:${id}`);
            }}
            onOpenBroadcast={() => {
              setHistoryOpen(false);
              openThread('broadcast');
            }}
          />
        ) : threadId === 'broadcast' ? (
          <BroadcastView agents={agents} />
        ) : roomId ? (
          <RoomView roomId={roomId} agents={agents} />
        ) : threadId ? (
          <ThreadView
            agentId={threadId}
            agentColor={agents.find((a) => a.id === threadId)?.color}
            agentName={agents.find((a) => a.id === threadId)?.name}
          />
        ) : (
          <ThreadList
            list={list}
            agents={agents}
            rooms={rooms}
            teams={teams}
            onSelect={(id) => openThread(id)}
            onSelectRoom={(id) => openThread(`room:${id}`)}
            onBroadcast={() => openThread('broadcast')}
            onCreateRoom={() => { setRoomNameInput(''); setRoomDialogOpen(true); }}
          />
        )}
      </div>
      {roomDialogOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
          onClick={() => setRoomDialogOpen(false)}
        >
          <div
            className="w-80 rounded-lg border border-line bg-surface p-4 shadow-lg"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="mb-3 text-sm font-medium text-text-primary">New room</h3>
            <input
              type="text"
              autoFocus
              value={roomNameInput}
              onChange={(e) => setRoomNameInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void submitRoom();
                if (e.key === 'Escape') setRoomDialogOpen(false);
              }}
              placeholder="Room name"
              maxLength={80}
              className="w-full rounded-md border border-line bg-surface-2 px-3 py-2 text-sm text-text-primary placeholder:text-text-muted focus:border-accent/40 focus:outline-none"
            />
            <div className="mt-3 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setRoomDialogOpen(false)}
                className="rounded-md px-3 py-1.5 text-sm text-text-muted hover:text-text-primary"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void submitRoom()}
                className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-canvas"
              >
                Create
              </button>
            </div>
          </div>
        </div>
      )}
    </aside>
  );

  async function submitRoom() {
    const name = roomNameInput.trim();
    if (!name) return;
    setRoomDialogOpen(false);
    try {
      const response = await api<{ room: RoomRow }>('/v1/rooms', {
        method: 'POST',
        body: JSON.stringify({ name, kind: 'custom', visibility: 'workspace', agentIds: [] }),
      });
      setRooms((current) => [response.room, ...current]);
      openThread(`room:${response.room.id}`);
    } catch {
      /* best-effort */
    }
  }
}

/**
 * Header trigger button that toggles the chat panel. Replaces the old
 * AssistantHeaderButton from Phase 1's Assistant component.
 *
 * Polls /v1/conversations every 30s to surface a notification dot when
 * unread messages arrive while the panel is closed (UIUX-REFACTOR §8.1).
 */
export function ChatPanelHeaderButton() {
  const toggle = useAgentisStore((s) => s.toggleChatPanel);
  const open = useAgentisStore((s) => s.chatPanelOpen);
  const [unread, setUnread] = useState(0);

  useEffect(() => {
    let cancelled = false;
    async function tick() {
      try {
        const r = await api<{ conversations: Array<{ unread: number }> }>(
          '/v1/conversations',
        );
        if (!cancelled) setUnread(r.conversations.reduce((a, c) => a + (c.unread || 0), 0));
      } catch {
        /* ignore */
      }
    }
    void tick();
    const id = window.setInterval(tick, 30_000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, []);

  useRealtime(
    [
      REALTIME_EVENTS.CONVERSATION_MESSAGE_RECEIVED,
      REALTIME_EVENTS.CONVERSATION_MESSAGE_SENT,
    ],
    () => {
      // Optimistically bump; the next poll reconciles.
      setUnread((u) => u + 1);
    },
  );

  return (
    <button
      type="button"
      onClick={toggle}
      title={open ? 'Hide chat panel' : 'Open chat panel'}
      aria-pressed={open}
      aria-label={unread > 0 ? `Toggle chat panel, ${unread} unread` : 'Toggle chat panel'}
      className={`relative inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs transition ${
        open
          ? 'border-accent/40 bg-accent/10 text-accent'
          : 'border-line bg-surface-2 text-text-muted hover:text-text-primary'
      }`}
    >
      <Users size={12} />
      Chat
      {!open && unread > 0 && (
        <span
          aria-hidden
          className="absolute -right-1 -top-1 grid h-4 min-w-4 place-items-center rounded-full bg-accent px-1 text-[9px] font-semibold text-canvas"
        >
          {unread > 9 ? '9+' : unread}
        </span>
      )}
    </button>
  );
}
