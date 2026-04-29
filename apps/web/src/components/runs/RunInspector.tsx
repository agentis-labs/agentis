/**
 * RunInspector — V1-SPEC §3.3, §11.3 single-run inspector panel.
 *
 * Renders the per-run event ledger as a chronologically ordered list.
 * Owning page wires fetching the ledger via /v1/runs/:id/ledger.
 */

export interface RunInspectorEvent {
  id: string;
  sequenceNumber: number;
  eventType: string;
  nodeId?: string | null;
  taskId?: string | null;
  payload: unknown;
  createdAt: string;
}

export function RunInspector({
  runId,
  events,
}: {
  runId: string;
  events: RunInspectorEvent[];
}) {
  return (
    <div className="rounded-2xl border border-line bg-surface p-3">
      <div className="mb-2 flex items-center gap-2 text-xs text-text-muted">
        <span className="font-mono">{runId.slice(0, 8)}</span>
        <span>{events.length} ledger events</span>
      </div>
      <div className="max-h-[60vh] overflow-auto">
        {events.length === 0 && (
          <div className="text-sm text-text-muted">Ledger empty.</div>
        )}
        {events.map((e) => (
          <div key={e.id} className="border-b border-line/60 px-2 py-1 text-xs">
            <div className="flex items-baseline gap-2">
              <span className="w-6 shrink-0 text-right font-mono text-text-muted">
                {e.sequenceNumber}
              </span>
              <span className="font-mono text-accent">{e.eventType}</span>
              {e.nodeId && (
                <span className="text-text-muted">node {e.nodeId}</span>
              )}
              <span className="ml-auto text-text-muted">
                {new Date(e.createdAt).toLocaleTimeString()}
              </span>
            </div>
            {!!e.payload && Object.keys(e.payload as object).length > 0 && (
              <pre className="mt-1 overflow-x-auto text-[10px] text-text-muted">
                {JSON.stringify(e.payload, null, 2)}
              </pre>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
