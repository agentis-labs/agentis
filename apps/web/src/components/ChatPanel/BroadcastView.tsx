/**
 * BroadcastView — fleet broadcast inside the ChatPanel.
 *
 * Thin re-export of the existing FleetBroadcastThread so we don't fork
 * the broadcast logic. Phase 5 will deepen the broadcast UX with target
 * audience pickers and per-agent reply tracking.
 */
import { FleetBroadcastThread } from '../assistant/FleetBroadcastThread';
import type { AgentRow } from './ChatPanel';

export function BroadcastView({ agents }: { agents: AgentRow[] }) {
  return (
    <div className="h-full">
      <FleetBroadcastThread agents={agents.map((a) => ({ id: a.id, name: a.name, status: a.status, isPaused: a.isPaused ?? null }))} />
    </div>
  );
}
