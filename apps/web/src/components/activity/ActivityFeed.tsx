/**
 * ActivityFeed — V1-SPEC §3.3, §11.4 scrollable activity feed.
 */

import { ActivityEventRow, type ActivityEvent } from './ActivityEventRow';

export function ActivityFeed({ events }: { events: ActivityEvent[] }) {
  return (
    <div className="rounded-2xl border border-line bg-surface">
      {events.length === 0 && (
        <div className="p-4 text-sm text-text-muted">No activity yet.</div>
      )}
      {events.map((e) => (
        <ActivityEventRow key={e.id} event={e} />
      ))}
    </div>
  );
}
