/**
 * AgentInteractionFeed — the "watch agents work together" surface
 * (UNIVERSAL-HARNESS §7, Pillar 4). Renders the unified agent↔agent timeline
 * from /v1/interactions: chat between agents + non-chat actions (delegation,
 * hand-offs, tool calls). Scope to one agent via `agentId`, or omit for the
 * whole workspace.
 */

import { useCallback, useEffect, useState } from 'react';
import { MessageSquare, GitBranch, RefreshCw, ChevronRight } from 'lucide-react';
import { listInteractions, type InteractionEvent } from '../../lib/connections';
import { api, apiErrorMessage } from '../../lib/api';
import { useRealtime } from '../../lib/realtime';
import { Skeleton } from '../shared/Skeleton';

// Agent-to-agent interaction is driven by activity events + room messages; a
// new one of either should refresh the timeline live.
const LIVE_EVENTS = ['activity.created', 'room.message.sent', 'room.message.received'];

export function AgentInteractionFeed({ agentId, roomId, limit = 50 }: { agentId?: string; roomId?: string; limit?: number }) {
  const [events, setEvents] = useState<InteractionEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  // Resolve actor/room ids → friendly names (agents show their name; unknown ids
  // are shortened instead of dumping a raw UUID).
  const [names, setNames] = useState<Record<string, string>>({});
  useEffect(() => {
    void api<{ agents: Array<{ id: string; name: string }> }>('/v1/agents')
      .then((res) => setNames(Object.fromEntries((res.agents ?? []).map((a) => [a.id, a.name]))))
      .catch(() => undefined);
  }, []);
  const nameFor = useCallback((id: string | null | undefined): string => {
    if (!id) return '—';
    if (names[id]) return names[id]!;
    return id.length > 12 ? `${id.slice(0, 8)}…` : id;
  }, [names]);

  const load = useCallback(async () => {
    try {
      const res = await listInteractions({ agentId, roomId, limit });
      setEvents(res.events);
      setError(null);
    } catch (e) {
      setError(apiErrorMessage(e));
    } finally {
      setLoading(false);
    }
  }, [agentId, roomId, limit]);

  useEffect(() => { void load(); }, [load]);

  // Live updates: refresh when a new agent interaction (activity or room message) fires.
  useRealtime(LIVE_EVENTS, () => { void load(); });

  if (loading) return <div className="space-y-2"><Skeleton className="h-12 w-full" /><Skeleton className="h-12 w-full" /></div>;
  if (error) return <p className="text-[13px] text-danger">{error}</p>;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-subheading text-text-primary">Agent interactions</h3>
        <button className="flex items-center gap-1 text-[12px] text-text-secondary hover:text-text-primary" onClick={() => void load()} aria-label="Refresh interactions">
          <RefreshCw size={13} /> Refresh
        </button>
      </div>

      {events.length === 0 ? (
        <p className="text-[13px] text-text-muted">No agent-to-agent interactions yet. They appear here as agents delegate, hand off, and message each other.</p>
      ) : (
        <ol className="space-y-2" aria-label="interaction timeline">
          {events.map((e) => {
            const expanded = expandedId === e.id;
            return (
              <li key={e.id} className="rounded-lg border border-line bg-surface">
                <button
                  type="button"
                  onClick={() => setExpandedId(expanded ? null : e.id)}
                  aria-expanded={expanded}
                  className="flex w-full gap-2.5 p-2.5 text-left"
                >
                  <span className={`mt-0.5 ${e.kind === 'message' ? 'text-info' : 'text-accent'}`}>
                    {e.kind === 'message' ? <MessageSquare size={15} /> : <GitBranch size={15} />}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 text-[11px] text-text-muted">
                      <span className="font-medium text-text-secondary">{e.actor.id ? nameFor(e.actor.id) : e.actor.type}</span>
                      <span className="rounded bg-bg px-1.5 py-0.5">{e.eventType}</span>
                      <span className="ml-auto">{formatTime(e.at)}</span>
                    </div>
                    <div className={`mt-0.5 text-[13px] text-text-secondary ${expanded ? 'whitespace-pre-wrap break-words' : 'truncate'}`}>{e.summary}</div>
                  </div>
                  <ChevronRight size={14} className={`mt-0.5 shrink-0 text-text-muted transition-transform ${expanded ? 'rotate-90' : ''}`} />
                </button>
                {expanded && (
                  <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 border-t border-line/70 px-2.5 py-2 text-[11px]">
                    <dt className="text-text-muted">Kind</dt><dd className="text-text-secondary">{e.kind}</dd>
                    <dt className="text-text-muted">Event</dt><dd className="font-mono text-text-secondary">{e.eventType}</dd>
                    <dt className="text-text-muted">Actor</dt><dd className="text-text-secondary">{e.actor.type}{e.actor.id ? <> · {nameFor(e.actor.id)} <span className="font-mono text-text-muted">({e.actor.id.slice(0, 8)})</span></> : ''}</dd>
                    {e.entity ? (<><dt className="text-text-muted">Entity</dt><dd className="text-text-secondary">{e.entity.type} · {nameFor(e.entity.id)}</dd></>) : null}
                    {e.roomId ? (<><dt className="text-text-muted">Room</dt><dd className="text-text-secondary">{nameFor(e.roomId)}</dd></>) : null}
                    <dt className="text-text-muted">When</dt><dd className="text-text-secondary">{new Date(e.at).toLocaleString()}</dd>
                  </dl>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}



