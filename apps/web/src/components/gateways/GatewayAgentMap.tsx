/**
 * GatewayAgentMap — V1-SPEC §3.3, §11.8 gateway → agents grouping.
 */

import { Link } from 'react-router-dom';

export interface GatewayAgentMapAgent {
  id: string;
  name: string;
  colorHex: string;
  status: string;
  gatewayId: string | null;
}

export function GatewayAgentMap({
  agents,
  gatewayId,
}: {
  agents: GatewayAgentMapAgent[];
  gatewayId: string;
}) {
  const bound = agents.filter((a) => a.gatewayId === gatewayId);
  if (bound.length === 0) {
    return <div className="text-xs text-text-muted">No agents bound to this gateway.</div>;
  }
  return (
    <ul className="space-y-1">
      {bound.map((a) => (
        <li key={a.id}>
          <Link
            to={`/agents/${a.id}`}
            className="flex items-center gap-2 rounded-md bg-surface-2 px-2 py-1 text-xs hover:text-accent"
          >
            <span
              className="inline-block h-2 w-2 rounded-full"
              style={{ background: a.colorHex }}
            />
            {a.name}
            <span className="ml-auto text-text-muted">{a.status}</span>
          </Link>
        </li>
      ))}
    </ul>
  );
}
