/**
 * AgentFleetTable — V1-SPEC §3.3, §11.5 (agent fleet table view).
 *
 * Pure presentation component. Consumes a precomputed list of agents and
 * fires callbacks on row interactions. The owning page (AgentFleetPage)
 * handles fetching + realtime invalidation and feeds rows in.
 */

import { Link } from 'react-router-dom';

export interface AgentFleetRow {
  id: string;
  name: string;
  adapterType: string;
  capabilityTags: string[] | null;
  status: string;
  colorHex: string;
  gatewayId: string | null;
  lastHeartbeatAt: string | null;
  currentTaskId: string | null;
}

export interface AgentFleetTableProps {
  agents: AgentFleetRow[];
}

export function AgentFleetTable({ agents }: AgentFleetTableProps) {
  return (
    <div className="min-h-0 flex-1 overflow-auto rounded-2xl border border-line bg-surface">
      <table className="w-full text-sm">
        <thead className="text-xs uppercase tracking-wide text-text-muted">
          <tr>
            <th className="px-3 py-2 text-left">Agent</th>
            <th className="px-3 py-2 text-left">Adapter</th>
            <th className="px-3 py-2 text-left">Status</th>
            <th className="px-3 py-2 text-left">Capabilities</th>
            <th className="px-3 py-2 text-left">Heartbeat</th>
            <th className="px-3 py-2"></th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {agents.length === 0 && (
            <tr>
              <td colSpan={6} className="px-3 py-8 text-center text-text-muted">
                No agents yet — register your first OpenClaw, Claude Code, or HTTP agent.
              </td>
            </tr>
          )}
          {agents.map((a) => (
            <tr key={a.id} className="hover:bg-surface-2">
              <td className="px-3 py-2">
                <Link to={`/agents/${a.id}`} className="flex items-center gap-2 hover:text-accent">
                  <span
                    className="inline-block h-2.5 w-2.5 rounded-full"
                    style={{ background: a.colorHex }}
                  />
                  {a.name}
                </Link>
              </td>
              <td className="px-3 py-2 text-xs text-text-muted">{a.adapterType}</td>
              <td className="px-3 py-2">
                <AgentStatusDot status={a.status} />
              </td>
              <td className="px-3 py-2 text-xs text-text-muted">
                {(a.capabilityTags ?? []).join(', ') || '—'}
              </td>
              <td className="px-3 py-2 text-xs text-text-muted">
                {a.lastHeartbeatAt ? new Date(a.lastHeartbeatAt).toLocaleTimeString() : '—'}
              </td>
              <td className="px-3 py-2 text-right">
                <Link
                  to={`/conversations/${a.id}`}
                  className="text-xs text-text-muted hover:text-accent"
                >
                  Conversation →
                </Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function AgentStatusDot({ status }: { status: string }) {
  const cls =
    status === 'online' || status === 'busy'
      ? 'bg-accent'
      : status === 'error'
        ? 'bg-danger'
        : 'bg-text-muted';
  return (
    <span className="inline-flex items-center gap-2 text-xs">
      <span className={`inline-block h-2 w-2 rounded-full ${cls}`} />
      {status}
    </span>
  );
}
