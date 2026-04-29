/**
 * GatewayHealthRail — V1-SPEC §3.3, §11.1 gateway health rail.
 */

export interface GatewayHealthGateway {
  id: string;
  name: string;
  status: string;
  lastSyncAt?: string | null;
}

export function GatewayHealthRail({ gateways }: { gateways: GatewayHealthGateway[] }) {
  return (
    <div className="rounded-2xl border border-line bg-surface p-3">
      <h2 className="mb-2 text-xs uppercase tracking-wide text-text-muted">Gateways</h2>
      {gateways.length === 0 && (
        <div className="text-sm text-text-muted">No gateways paired.</div>
      )}
      <ul className="space-y-1">
        {gateways.map((g) => (
          <li
            key={g.id}
            className="flex items-center justify-between rounded-md bg-surface-2 px-2 py-1 text-xs"
          >
            <span className="flex items-center gap-2">
              <Dot status={g.status} />
              {g.name}
            </span>
            <span className="text-text-muted">
              {g.lastSyncAt ? new Date(g.lastSyncAt).toLocaleTimeString() : '—'}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Dot({ status }: { status: string }) {
  const cls =
    status === 'connected' ? 'bg-accent' : status === 'error' ? 'bg-danger' : 'bg-text-muted';
  return <span className={`inline-block h-2 w-2 rounded-full ${cls}`} />;
}
