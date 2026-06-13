/**
 * AgentInteractionFeed — the "watch agents work together" surface
 * (UNIVERSAL-HARNESS §7, Pillar 4). Renders the unified agent↔agent timeline
 * from /v1/interactions: chat between agents + non-chat actions (delegation,
 * hand-offs, tool calls). Scope to one agent via `agentId`, or omit for the
 * whole workspace.
 */

import { useCallback, useEffect, useState } from 'react';
import { MessageSquare, GitBranch, RefreshCw } from 'lucide-react';
import { listInteractions, type InteractionEvent } from '../../lib/connections';
import { apiErrorMessage } from '../../lib/api';
import { useRealtime } from '../../lib/realtime';
import { Skeleton } from '../shared/Skeleton';

// Agent-to-agent interaction is driven by activity events + room messages; a
// new one of either should refresh the timeline live.
const LIVE_EVENTS = ['activity.created', 'room.message.sent', 'room.message.received'];

export function AgentInteractionFeed({ agentId, roomId, limit = 50 }: { agentId?: string; roomId?: string; limit?: number }) {
  const [events, setEvents] = useState<InteractionEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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
          {events.map((e) => (
            <li key={e.id} className="flex gap-2.5 rounded-lg border border-line bg-surface p-2.5">
              <span className={`mt-0.5 ${e.kind === 'message' ? 'text-info' : 'text-accent'}`}>
                {e.kind === 'message' ? <MessageSquare size={15} /> : <GitBranch size={15} />}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 text-[11px] text-text-muted">
                  <span className="font-mono">{e.actor.id ?? e.actor.type}</span>
                  <span className="rounded bg-bg px-1.5 py-0.5">{e.eventType}</span>
                  <span className="ml-auto">{formatTime(e.at)}</span>
                </div>
                <div className="mt-0.5 truncate text-[13px] text-text-secondary" title={e.summary}>{e.summary}</div>
              </div>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}
