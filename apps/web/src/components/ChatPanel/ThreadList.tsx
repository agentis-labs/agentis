/**
 * Rooms & Threads sidebar (AGENTIS-UX-V2 §6.4).
 *
 * §5.5 — Orchestrator agent distinction: any agent whose name matches
 * "Orchestrator" (or that carries the `orchestrator` capability tag) is
 * pinned to the top of "Direct Threads" with a `◎ Orchestrator` label
 * and the Agentis platform-badge dot next to its avatar.
 */
import { Hash, Megaphone, MessageCircle, Plus } from 'lucide-react';
import type { AgentRow, ConversationRow, RoomRow, TeamRow } from './ChatPanel';

function isOrchestrator(agent: AgentRow): boolean {
  if (!agent?.name) return false;
  if (/orchestrat/i.test(agent.name)) return true;
  const tags = (agent as AgentRow & { capabilityTags?: string[] | null }).capabilityTags;
  if (Array.isArray(tags) && tags.some((t) => /orchestrat/i.test(t))) return true;
  return false;
}

interface Props {
  list: ConversationRow[];
  agents: AgentRow[];
  rooms: RoomRow[];
  teams: TeamRow[];
  onSelect: (agentId: string) => void;
  onSelectRoom: (roomId: string) => void;
  onBroadcast: () => void;
  onCreateRoom: () => void;
}

export function ThreadList({ list, agents, rooms, teams, onSelect, onSelectRoom, onBroadcast, onCreateRoom }: Props) {
  const byAgent = new Map(list.map((thread) => [thread.agentId, thread]));
  const rows = agents.map((agent) => {
    const thread = byAgent.get(agent.id);
    return {
      id: thread?.id ?? `agent:${agent.id}`,
      agentId: agent.id,
      agentName: thread?.agentName ?? agent.name,
      agentColor: thread?.agentColor ?? agent.color ?? '#7a8390',
      unread: thread?.unread ?? 0,
      lastMessageAt: thread?.lastMessageAt ?? null,
      lastMessagePreview: thread?.lastMessagePreview ?? null,
      mirroredSessionId: thread?.mirroredSessionId ?? null,
      status: agent.status,
      teamId: agent.teamId ?? null,
    };
  });

  const pinned = rooms.filter((room) => room.pinnedAt);
  const workspaceRooms = rooms.filter((room) => room.kind === 'workspace' || (!room.teamId && room.name.toLowerCase() === 'general'));
  const customRooms = rooms.filter((room) => room.kind === 'custom' && !room.teamId);
  // §5.5 — Orchestrator pinned to the top, then unread-then-online ordering.
  const agentById = new Map(agents.map((a) => [a.id, a]));
  const directThreads = rows.sort((a, b) => {
    const aOrch = isOrchestrator(agentById.get(a.agentId) ?? ({} as AgentRow));
    const bOrch = isOrchestrator(agentById.get(b.agentId) ?? ({} as AgentRow));
    if (aOrch && !bOrch) return -1;
    if (!aOrch && bOrch) return 1;
    const unreadDiff = b.unread - a.unread;
    if (unreadDiff !== 0) return unreadDiff;
    return Number(['online', 'busy'].includes(b.status)) - Number(['online', 'busy'].includes(a.status));
  });

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-line px-3 py-2.5">
        <div className="text-sm font-medium text-text-primary">Rooms & Threads</div>
        <button
          type="button"
          onClick={onCreateRoom}
          className="ml-auto inline-flex items-center gap-1 rounded-md border border-line px-2 py-1 text-[10px] text-text-muted hover:border-accent/40 hover:text-accent"
        >
          <Plus size={11} /> New room
        </button>
      </div>
      <div className="flex-1 overflow-y-auto py-2">
        {pinned.length > 0 && <RoomSection title="Pinned" rooms={pinned} onSelectRoom={onSelectRoom} />}
        {teams.map((team) => {
          const teamRooms = rooms.filter((room) => room.teamId === team.id);
          if (teamRooms.length === 0) return null;
          return (
            <section key={team.id} className="py-1">
              <div className="flex items-center gap-1.5 px-3 pb-1 text-[10px] font-medium uppercase tracking-wide text-text-muted">
                <span className="h-1.5 w-1.5 rounded-full" style={{ background: team.colorHex ?? '#9cffb0' }} />
                {team.name}
                <span className="ml-auto">{team.stats?.agents ?? ''}</span>
              </div>
              <RoomRows rooms={teamRooms} onSelectRoom={onSelectRoom} />
            </section>
          );
        })}
        {workspaceRooms.length > 0 && <RoomSection title="General" rooms={workspaceRooms} onSelectRoom={onSelectRoom} />}
        {customRooms.length > 0 && <RoomSection title="Custom rooms" rooms={customRooms} onSelectRoom={onSelectRoom} />}
        <section className="py-1">
          <div className="px-3 pb-1 text-[10px] font-medium uppercase tracking-wide text-text-muted">Direct threads</div>
          {directThreads.length === 0 ? (
            <div className="px-4 py-4 text-xs text-text-muted">No agents yet.</div>
          ) : (
            <ul className="divide-y divide-line/60 border-y border-line/50">
              {directThreads.map((thread) => {
                const orch = isOrchestrator(agentById.get(thread.agentId) ?? ({} as AgentRow));
                return (
                  <li key={thread.id} className={orch ? 'bg-accent/5' : undefined}>
                    <button type="button" onClick={() => onSelect(thread.agentId)} className="flex w-full items-start gap-3 px-3 py-2.5 text-left hover:bg-surface-2">
                      <span className="relative mt-1 shrink-0">
                        <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: thread.agentColor }} />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-2">
                          {orch && <span className="text-text-muted" aria-hidden>◎</span>}
                          <span className="truncate text-sm text-text-primary">
                            {orch ? `Orchestrator${thread.agentName.toLowerCase().includes('orchestrator') ? '' : ` · ${thread.agentName}`}` : thread.agentName}
                          </span>
                          <TeamBadge team={teams.find((team) => team.id === thread.teamId)} />
                          {orch && (
                            <span className="rounded-full border border-accent/40 bg-accent/10 px-1.5 py-0.5 text-[9px] uppercase tracking-wider text-accent">
                              platform
                            </span>
                          )}
                          {thread.unread > 0 && <span className="ml-auto rounded-full bg-accent px-1.5 text-[10px] font-medium text-canvas">{thread.unread}</span>}
                        </span>
                        <span className="mt-0.5 flex items-center gap-2 text-xs text-text-muted">
                          <span className="capitalize">{thread.status}</span>
                          {thread.lastMessagePreview && <span className="truncate">{thread.lastMessagePreview}</span>}
                        </span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>
      <button type="button" onClick={onBroadcast} className="flex items-center gap-3 border-t border-line px-3 py-2.5 text-left hover:bg-surface-2">
        <span className="grid h-7 w-7 place-items-center rounded-full bg-accent/15 text-accent"><Megaphone size={14} /></span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm text-text-primary">Fleet broadcast</span>
          <span className="block text-xs text-text-muted">One message to every live agent</span>
        </span>
      </button>
    </div>
  );
}

function RoomSection({ title, rooms, onSelectRoom }: { title: string; rooms: RoomRow[]; onSelectRoom: (roomId: string) => void }) {
  return (
    <section className="py-1">
      <div className="px-3 pb-1 text-[10px] font-medium uppercase tracking-wide text-text-muted">{title}</div>
      <RoomRows rooms={rooms} onSelectRoom={onSelectRoom} />
    </section>
  );
}

function RoomRows({ rooms, onSelectRoom }: { rooms: RoomRow[]; onSelectRoom: (roomId: string) => void }) {
  return (
    <ul className="divide-y divide-line/60 border-y border-line/50">
      {rooms.map((room) => (
        <li key={room.id}>
          <button type="button" onClick={() => onSelectRoom(room.id)} className="flex w-full items-start gap-3 px-3 py-2.5 text-left hover:bg-surface-2">
            <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-surface-2 text-text-muted">
              {room.kind === 'workspace' ? <Hash size={12} /> : <MessageCircle size={12} />}
            </span>
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-2">
                <span className="truncate text-sm text-text-primary">{room.name}</span>
                {room.isTeamDefault && <span className="rounded border border-line px-1 text-[9px] uppercase text-text-muted">auto</span>}
              </span>
              <span className="mt-0.5 block truncate text-xs text-text-muted">{room.description || room.kind}</span>
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function TeamBadge({ team }: { team?: TeamRow }) {
  if (!team) return null;
  return (
    <span className="inline-flex items-center gap-1 rounded border border-line px-1 text-[9px] uppercase text-text-muted">
      <span className="h-1 w-1 rounded-full" style={{ background: team.colorHex ?? '#9cffb0' }} />
      {team.name.slice(0, 2)}
    </span>
  );
}
