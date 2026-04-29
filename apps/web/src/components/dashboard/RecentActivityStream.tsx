/**
 * RecentActivityStream — V1-SPEC §3.3, §11.1 + §11.4 activity stream card.
 */

export interface RecentActivityEvent {
  id: string;
  eventType: string;
  message?: string | null;
  createdAt: string;
}

export function RecentActivityStream({ events }: { events: RecentActivityEvent[] }) {
  return (
    <div className="rounded-2xl border border-line bg-surface p-3">
      <h2 className="mb-2 text-xs uppercase tracking-wide text-text-muted">Recent activity</h2>
      {events.length === 0 && (
        <div className="text-sm text-text-muted">Nothing has happened yet.</div>
      )}
      <ul className="space-y-1 text-xs">
        {events.slice(0, 12).map((e) => (
          <li key={e.id} className="flex items-baseline gap-2">
            <span className="text-text-muted">
              {new Date(e.createdAt).toLocaleTimeString()}
            </span>
            <span className="font-mono text-accent">{e.eventType}</span>
            {e.message && <span className="truncate text-text-muted">{e.message}</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}
