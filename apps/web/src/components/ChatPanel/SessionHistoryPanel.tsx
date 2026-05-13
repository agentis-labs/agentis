import { useEffect, useMemo, useState } from 'react';
import { Search } from 'lucide-react';
import { api } from '../../lib/api';

interface ConversationRow { agentId: string; agentName: string; lastMessageAt: string | null; lastMessagePreview: string | null }
interface RoomRow { id: string; name: string; kind: string; teamId: string | null; lastMessageAt: string | null; agentIds?: string[] }
interface RunRow { id: string; workflowId: string; status: string; createdAt: string; completedAt?: string | null }
interface ArtifactRow { id: string; title: string; type: string; createdAt: string; agentId?: string | null }
interface TeamRow { id: string; name: string; colorHex?: string | null }

type Entry = {
  id: string;
  type: 'thread' | 'room' | 'broadcast' | 'run';
  title: string;
  subtitle: string;
  at: string;
  teamId?: string | null;
  agentId?: string | null;
  actionLabel: string;
  onOpen: () => void;
};

export function SessionHistoryPanel({
  onBack,
  onOpenThread,
  onOpenRoom,
  onOpenBroadcast,
}: {
  onBack: () => void;
  onOpenThread: (agentId: string) => void;
  onOpenRoom: (roomId: string) => void;
  onOpenBroadcast: () => void;
}) {
  const [conversations, setConversations] = useState<ConversationRow[]>([]);
  const [rooms, setRooms] = useState<RoomRow[]>([]);
  const [runs, setRuns] = useState<RunRow[]>([]);
  const [artifacts, setArtifacts] = useState<ArtifactRow[]>([]);
  const [teams, setTeams] = useState<TeamRow[]>([]);
  const [query, setQuery] = useState('');
  const [type, setType] = useState<'all' | Entry['type']>('all');
  const [teamId, setTeamId] = useState('all');

  useEffect(() => {
    void Promise.allSettled([
      api<{ conversations: ConversationRow[] }>('/v1/conversations'),
      api<{ rooms: RoomRow[] }>('/v1/rooms'),
      api<{ runs: RunRow[] }>('/v1/runs?limit=50'),
      api<{ artifacts: ArtifactRow[] }>('/v1/artifacts?limit=50'),
      api<{ teams: TeamRow[] }>('/v1/teams'),
    ]).then(([conversationRes, roomRes, runRes, artifactRes, teamRes]) => {
      if (conversationRes.status === 'fulfilled') setConversations(conversationRes.value.conversations ?? []);
      if (roomRes.status === 'fulfilled') setRooms(roomRes.value.rooms ?? []);
      if (runRes.status === 'fulfilled') setRuns(runRes.value.runs ?? []);
      if (artifactRes.status === 'fulfilled') setArtifacts(artifactRes.value.artifacts ?? []);
      if (teamRes.status === 'fulfilled') setTeams(teamRes.value.teams ?? []);
    });
  }, []);

  const entries = useMemo<Entry[]>(() => {
    const artifactCountByAgent = new Map<string, number>();
    for (const artifact of artifacts) {
      if (artifact.agentId) artifactCountByAgent.set(artifact.agentId, (artifactCountByAgent.get(artifact.agentId) ?? 0) + 1);
    }
    const threadEntries = conversations.map<Entry>((conversation) => ({
      id: `thread-${conversation.agentId}`,
      type: 'thread',
      title: conversation.agentName,
      subtitle: `${conversation.lastMessagePreview ?? 'Agent thread'} · ${artifactCountByAgent.get(conversation.agentId) ?? 0} artifacts`,
      at: conversation.lastMessageAt ?? new Date(0).toISOString(),
      agentId: conversation.agentId,
      actionLabel: 'Resume',
      onOpen: () => onOpenThread(conversation.agentId),
    }));
    const roomEntries = rooms.map<Entry>((room) => ({
      id: `room-${room.id}`,
      type: room.kind === 'workspace' ? 'broadcast' : 'room',
      title: room.kind === 'workspace' ? 'General' : room.name,
      subtitle: `${room.agentIds?.length ?? 0} agents · ${room.kind}`,
      at: room.lastMessageAt ?? new Date(0).toISOString(),
      teamId: room.teamId,
      actionLabel: 'Open',
      onOpen: () => onOpenRoom(room.id),
    }));
    const runEntries = runs.map<Entry>((run) => ({
      id: `run-${run.id}`,
      type: 'run',
      title: `Workflow run ${run.id.slice(0, 8)}`,
      subtitle: `${run.status} · ${artifacts.filter((artifact) => artifact.createdAt >= run.createdAt).length} artifacts`,
      at: run.completedAt ?? run.createdAt,
      actionLabel: 'Open',
      onOpen: () => window.location.assign(`/runs/${run.id}`),
    }));
    return [...threadEntries, ...roomEntries, ...runEntries].sort((a, b) => b.at.localeCompare(a.at));
  }, [artifacts, conversations, onOpenRoom, onOpenThread, rooms, runs]);

  const filtered = entries.filter((entry) => {
    if (type !== 'all' && entry.type !== type) return false;
    if (teamId !== 'all' && entry.teamId !== teamId) return false;
    if (query.trim()) {
      const haystack = `${entry.title} ${entry.subtitle}`.toLowerCase();
      if (!haystack.includes(query.toLowerCase())) return false;
    }
    return true;
  });

  return (
    <div className="flex h-full flex-col bg-surface">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-line px-3">
        <button onClick={onBack} className="rounded-md px-2 py-1 text-xs text-text-muted hover:bg-surface-2 hover:text-text-primary">Back</button>
        <div className="text-sm font-medium text-text-primary">Session History</div>
      </header>
      <div className="border-b border-line p-3">
        <label className="flex items-center gap-2 rounded-md border border-line bg-canvas px-2 py-1 text-xs">
          <Search size={12} className="text-text-muted" />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search" className="min-w-0 flex-1 bg-transparent outline-none" />
        </label>
        <div className="mt-2 flex flex-wrap gap-1">
          {(['all', 'thread', 'room', 'broadcast', 'run'] as const).map((item) => (
            <button key={item} onClick={() => setType(item)} className={`rounded-md border px-2 py-1 text-[10px] capitalize ${type === item ? 'border-accent/40 bg-accent/10 text-accent' : 'border-line text-text-muted'}`}>{item}</button>
          ))}
          <select value={teamId} onChange={(event) => setTeamId(event.target.value)} className="rounded-md border border-line bg-canvas px-2 py-1 text-[10px] text-text-muted outline-none">
            <option value="all">Any team</option>
            {teams.map((team) => <option key={team.id} value={team.id}>{team.name}</option>)}
          </select>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {filtered.length === 0 ? (
          <div className="px-4 py-8 text-center text-xs text-text-muted">No history entries match.</div>
        ) : (
          <div className="divide-y divide-line/60">
            {filtered.map((entry) => (
              <button key={entry.id} onClick={entry.onOpen} className="flex w-full items-start gap-3 px-3 py-3 text-left hover:bg-surface-2">
                <span className="mt-0.5 text-xs text-accent">{iconFor(entry.type)}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-xs font-medium text-text-primary">{entry.title}</span>
                  <span className="mt-0.5 block truncate text-[11px] text-text-muted">{entry.subtitle}</span>
                  <span className="mt-1 block text-[10px] text-text-muted/70">{new Date(entry.at).toLocaleString()}</span>
                </span>
                <span className="text-[10px] text-accent">{entry.actionLabel}</span>
              </button>
            ))}
          </div>
        )}
      </div>
      <button onClick={onOpenBroadcast} className="border-t border-line px-3 py-2 text-left text-xs text-text-muted hover:bg-surface-2 hover:text-accent">Fleet broadcast</button>
    </div>
  );
}

function iconFor(type: Entry['type']) {
  if (type === 'thread') return '@';
  if (type === 'room') return '#';
  if (type === 'broadcast') return '>>';
  return '>';
}