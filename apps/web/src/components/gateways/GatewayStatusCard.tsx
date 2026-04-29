/**
 * GatewayStatusCard — V1-SPEC §3.3, §11.8 single-gateway status card.
 */

export interface GatewayStatusCardGateway {
  id: string;
  name: string;
  status: string;
  gatewayUrl: string;
  lastSyncAt?: string | null;
}

export function GatewayStatusCard({
  gateway,
  onSync,
  onDisconnect,
}: {
  gateway: GatewayStatusCardGateway;
  onSync?: (id: string) => void;
  onDisconnect?: (id: string) => void;
}) {
  const tone =
    gateway.status === 'connected'
      ? 'border-accent/40'
      : gateway.status === 'error'
        ? 'border-danger/40'
        : 'border-line';
  return (
    <div className={`rounded-2xl border bg-surface p-4 ${tone}`}>
      <div className="flex items-center justify-between">
        <div>
          <div className="text-sm font-medium">{gateway.name}</div>
          <div className="text-[11px] text-text-muted">{gateway.gatewayUrl}</div>
        </div>
        <span className="text-xs uppercase tracking-wide text-text-muted">{gateway.status}</span>
      </div>
      <div className="mt-2 text-[11px] text-text-muted">
        Last sync: {gateway.lastSyncAt ? new Date(gateway.lastSyncAt).toLocaleTimeString() : '—'}
      </div>
      <div className="mt-3 flex gap-2">
        {onSync && (
          <button
            onClick={() => onSync(gateway.id)}
            className="rounded-md border border-line px-2 py-1 text-xs hover:text-accent"
          >
            Sync
          </button>
        )}
        {onDisconnect && (
          <button
            onClick={() => onDisconnect(gateway.id)}
            className="rounded-md border border-danger/40 px-2 py-1 text-xs text-danger"
          >
            Disconnect
          </button>
        )}
      </div>
    </div>
  );
}
