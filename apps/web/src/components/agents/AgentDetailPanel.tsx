/**
 * AgentDetailPanel — V1-SPEC §3.3, §11.6 (agent detail header + status).
 *
 * Pure presentational header for an agent detail view. Renders the color
 * dot, name, adapter, status, heartbeat, and the cancel-current-task
 * action. The owning page (AgentDetailPage) wires fetching + realtime.
 */

import { Link } from 'react-router-dom';

export interface AgentDetailPanelAgent {
  id: string;
  name: string;
  adapterType: string;
  status: string;
  colorHex: string;
  capabilityTags: string[] | null;
  currentTaskId: string | null;
  lastHeartbeatAt: string | null;
}

export interface AgentDetailPanelProps {
  agent: AgentDetailPanelAgent;
  onCancelTask?: (taskId: string) => void;
}

export function AgentDetailPanel({ agent, onCancelTask }: AgentDetailPanelProps) {
  return (
    <header className="flex items-center gap-3 border-b border-line bg-surface px-4 py-3">
      <span
        className="inline-block h-3 w-3 rounded-full"
        style={{ background: agent.colorHex }}
      />
      <div>
        <div className="text-sm font-medium">{agent.name}</div>
        <div className="text-xs text-text-muted">
          {agent.adapterType} • {agent.status}
          {agent.lastHeartbeatAt
            ? ` • ❤ ${new Date(agent.lastHeartbeatAt).toLocaleTimeString()}`
            : ''}
        </div>
      </div>
      {agent.currentTaskId && onCancelTask && (
        <button
          onClick={() => onCancelTask(agent.currentTaskId!)}
          className="ml-auto rounded-md border border-danger/40 px-2 py-1 text-xs text-danger"
        >
          Cancel current task
        </button>
      )}
      <Link to="/agents" className="ml-auto text-xs text-text-muted hover:text-accent">
        ← All agents
      </Link>
    </header>
  );
}
