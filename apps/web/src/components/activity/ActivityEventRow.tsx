/**
 * ActivityEventRow — V1-SPEC §3.3, §11.4 single row for an activity event.
 */

export interface ActivityEvent {
  id: string;
  eventType: string;
  message?: string | null;
  metadata?: Record<string, unknown> | null;
  createdAt: string;
}

export function ActivityEventRow({ event }: { event: ActivityEvent }) {
  return (
    <div className="flex items-baseline gap-2 border-b border-line/60 px-3 py-1.5 text-xs">
      <span className="w-20 shrink-0 text-text-muted">
        {new Date(event.createdAt).toLocaleTimeString()}
      </span>
      <span className="w-44 shrink-0 truncate font-mono text-accent">{event.eventType}</span>
      <span className="flex-1 truncate text-text-muted">{event.message ?? ''}</span>
    </div>
  );
}
