import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useRealtime } from '../lib/realtime';

interface ActivityEvent {
  id: string;
  eventType: string;
  actorType: string;
  summary: string;
  createdAt: string;
}

export function ActivityPage() {
  const [items, setItems] = useState<ActivityEvent[]>([]);
  useEffect(() => {
    void api<{ events: ActivityEvent[] }>('/v1/activity?limit=200').then((d) => setItems(d.events));
  }, []);
  useRealtime(['activity.created'], () => {
    void api<{ events: ActivityEvent[] }>('/v1/activity?limit=200').then((d) => setItems(d.events));
  });
  return (
    <div className="p-6">
      <h1 className="mb-4 text-lg font-medium">Activity</h1>
      <ul className="divide-y divide-line rounded-2xl border border-line bg-surface">
        {items.map((e) => (
          <li key={e.id} className="flex items-center gap-3 px-4 py-3 text-sm">
            <span className="rounded-full bg-surface-2 px-2 py-0.5 text-[10px] uppercase tracking-wide text-text-muted">
              {e.actorType}
            </span>
            <span className="text-accent">{e.eventType}</span>
            <span className="text-text-muted">{e.summary}</span>
            <span className="ml-auto text-xs text-text-muted">{new Date(e.createdAt).toLocaleString()}</span>
          </li>
        ))}
        {items.length === 0 && <li className="px-4 py-6 text-sm text-text-muted">No activity yet.</li>}
      </ul>
    </div>
  );
}
