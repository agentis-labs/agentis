/**
 * RoomList — chat panel room/thread list.
 *
 * Sections: Rooms (workspace, team, custom), Direct threads (1:1 agent),
 * Fleet broadcast.
 */

import { useEffect, useState } from 'react';
import { Hash, MessageCircle, Megaphone } from 'lucide-react';
import { api, workspace as wsStore } from '../../lib/api';
import { Skeleton } from '../shared/Skeleton';
import { StatusDot } from '../shared/StatusBadge';

interface Room {
  id: string;
  name: string;
  kind: 'workspace' | 'team' | 'custom' | 'thread';
  unreadCount?: number;
  lastMessagePreview?: string;
}

interface AgentThread {
  agentId: string;
  agentName: string;
  status?: string;
  lastMessagePreview?: string;
  unreadCount?: number;
}

type Selected = { kind: 'room' | 'agent'; id: string; name: string };

export function RoomList({ onSelect }: { onSelect: (t: Selected) => void }) {
  const [rooms, setRooms] = useState<Room[]>([]);
  const [agents, setAgents] = useState<AgentThread[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const ws = wsStore.get();
      if (!ws) { setLoading(false); return; }
      try {
        const [roomsRes, agentsRes] = await Promise.allSettled([
          api<{ rooms: Room[] }>('/v1/rooms'),
          api<{ agents: Array<{ id: string; name: string; status?: string }> }>('/v1/agents'),
        ]);
        if (cancelled) return;
        if (roomsRes.status === 'fulfilled') setRooms(roomsRes.value.rooms ?? []);
        if (agentsRes.status === 'fulfilled') {
          setAgents(agentsRes.value.agents.map((a) => ({
            agentId: a.id,
            agentName: a.name,
            status: a.status,
          })));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  if (loading) {
    return (
      <div className="space-y-2 p-3">
        <Skeleton height={48} />
        <Skeleton height={48} />
        <Skeleton height={48} />
      </div>
    );
  }

  return (
    <div className="py-2">
      {rooms.length > 0 && (
        <Section label="Rooms">
          {rooms.map((r) => (
            <RoomRow
              key={r.id}
              icon={<Hash size={14} className="text-text-muted" />}
              name={r.name}
              meta={r.kind === 'workspace' ? 'workspace' : r.kind === 'team' ? 'team · auto' : 'custom'}
              unread={r.unreadCount}
              onClick={() => onSelect({ kind: 'room', id: r.id, name: r.name })}
            />
          ))}
        </Section>
      )}

      {agents.length > 0 && (
        <Section label="Direct">
          {agents.map((a) => (
            <RoomRow
              key={a.agentId}
              icon={<StatusDot status={a.status ?? 'offline'} size={8} />}
              name={a.agentName}
              meta={a.status ?? 'offline'}
              unread={a.unreadCount}
              onClick={() => onSelect({ kind: 'agent', id: a.agentId, name: a.agentName })}
            />
          ))}
        </Section>
      )}

      <Section label="Broadcast">
        <RoomRow
          icon={<Megaphone size={14} className="text-text-muted" />}
          name="Fleet broadcast"
          meta="One message to every live agent"
          onClick={() => onSelect({ kind: 'room', id: '__broadcast__', name: 'Fleet broadcast' })}
        />
      </Section>

      {rooms.length === 0 && agents.length === 0 && (
        <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
          <MessageCircle size={32} className="text-text-muted opacity-50" />
          <span className="text-subheading text-text-primary">No conversations yet</span>
          <span className="text-[12px] text-text-muted">
            Create a room or start a thread with an agent.
          </span>
        </div>
      )}
    </div>
  );
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mb-2">
      <div className="px-3 pb-1 text-[10px] font-semibold uppercase tracking-wider text-text-muted">
        {label}
      </div>
      <ul className="flex flex-col">{children}</ul>
    </div>
  );
}

function RoomRow({
  icon, name, meta, unread, onClick,
}: {
  icon: React.ReactNode;
  name: string;
  meta?: string;
  unread?: number;
  onClick: () => void;
}) {
  return (
    <li>
      <button
        type="button"
        onClick={onClick}
        className="flex w-full items-center gap-2.5 px-3 py-2 text-left transition-colors hover:bg-surface-2"
      >
        <span className="flex h-6 w-6 shrink-0 items-center justify-center">{icon}</span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-medium text-text-primary">{name}</div>
          {meta && <div className="truncate text-[11px] text-text-muted">{meta}</div>}
        </div>
        {unread != null && unread > 0 && (
          <span className="inline-flex h-5 min-w-[20px] items-center justify-center rounded-full bg-accent px-1.5 text-[10px] font-bold text-canvas">
            {unread > 99 ? '99+' : unread}
          </span>
        )}
      </button>
    </li>
  );
}
