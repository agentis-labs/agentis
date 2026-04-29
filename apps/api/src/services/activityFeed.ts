/**
 * Activity feed — workspace-scoped human-readable event stream.
 *
 * The dashboard's Activity page reads via `list()`; the right-dock live strip
 * subscribes to the realtime event family.
 */

import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { REALTIME_EVENTS, REALTIME_ROOMS } from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { EventBus } from '../event-bus.js';

export interface ActivityRecord {
  workspaceId: string;
  ambientId: string | null;
  userId: string;
  eventType: string;
  actorType: 'user' | 'agent' | 'gateway' | 'system';
  actorId?: string | null;
  entityType: string;
  entityId: string;
  summary: string;
  metadata?: Record<string, unknown>;
}

export class ActivityFeedService {
  constructor(
    private readonly db: AgentisSqliteDb,
    private readonly bus: EventBus,
  ) {}

  record(rec: ActivityRecord): void {
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    this.db
      .insert(schema.activityEvents)
      .values({
        id,
        workspaceId: rec.workspaceId,
        ambientId: rec.ambientId,
        userId: rec.userId,
        eventType: rec.eventType,
        actorType: rec.actorType,
        actorId: rec.actorId ?? null,
        entityType: rec.entityType,
        entityId: rec.entityId,
        summary: rec.summary,
        metadata: rec.metadata ?? {},
        createdAt,
      })
      .run();
    this.bus.publish(REALTIME_ROOMS.workspace(rec.workspaceId), REALTIME_EVENTS.ACTIVITY_CREATED, {
      id,
      ...rec,
      createdAt,
    });
  }

  list(workspaceId: string, limit = 100) {
    const capped = Math.min(Math.max(limit, 1), 500);
    return this.db
      .select()
      .from(schema.activityEvents)
      .where(eq(schema.activityEvents.workspaceId, workspaceId))
      .all()
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
      .slice(0, capped);
  }
}
