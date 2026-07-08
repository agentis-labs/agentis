/**
 * Agent interaction feed — the backend backbone for the interaction surface
 * (UNIVERSAL-HARNESS §7, Pillar 4).
 *
 *   GET /v1/interactions?roomId=&agentId=&limit=&before=
 *
 * Returns a single, time-ordered timeline that unifies the two ways agents
 * interact with each other:
 *   - chat between agents  — `room_messages` authored by an agent
 *   - beyond chat          — `activity_events` whose actor is an agent
 *                            (delegation, task hand-off, tool calls, status…)
 *
 * Operator↔agent chat already has its own surfaces; this endpoint is the
 * "watch the agents work together" view. It is read-only and composes existing
 * tables — no new storage. The realtime UI layers live updates on top via the
 * existing event bus; this provides the backfill + query.
 */

import { Hono } from 'hono';
import { and, desc, eq, lt } from 'drizzle-orm';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { AuthService } from '../services/auth.js';
import { requireAuth } from '../middleware/auth.js';
import { getWorkspace, requireWorkspace } from '../middleware/workspace.js';

export interface InteractionRoutesDeps {
  db: AgentisSqliteDb;
  auth: AuthService;
}

export interface InteractionEvent {
  id: string;
  at: string;
  /** chat = an agent message in a room; activity = a non-chat agent action. */
  kind: 'message' | 'activity';
  eventType: string;
  actor: { type: string; id: string | null };
  summary: string;
  roomId?: string;
  entity?: { type: string; id: string };
  metadata?: Record<string, unknown>;
}

export function buildInteractionRoutes(deps: InteractionRoutesDeps) {
  const app = new Hono();
  app.use('*', requireAuth(deps), requireWorkspace(deps));

  app.get('/', (c) => {
    const ws = getWorkspace(c);
    const roomId = c.req.query('roomId') || null;
    const agentId = c.req.query('agentId') || null;
    const before = c.req.query('before') || null;
    const limit = Math.min(Math.max(Number(c.req.query('limit')) || 50, 1), 200);

    // 1) Agent-authored room messages.
    const messageConds = [
      eq(schema.roomMessages.workspaceId, ws.workspaceId),
      eq(schema.roomMessages.authorType, 'agent'),
    ];
    if (roomId) messageConds.push(eq(schema.roomMessages.roomId, roomId));
    if (agentId) messageConds.push(eq(schema.roomMessages.authorId, agentId));
    if (before) messageConds.push(lt(schema.roomMessages.createdAt, before));
    const messages = deps.db.select().from(schema.roomMessages)
      .where(and(...messageConds))
      .orderBy(desc(schema.roomMessages.createdAt))
      .limit(limit)
      .all()
      .map<InteractionEvent>((m) => ({
        id: m.id,
        at: m.createdAt,
        kind: 'message',
        eventType: 'agent_message',
        actor: { type: 'agent', id: m.authorId },
        summary: messageSummary(m.content),
        roomId: m.roomId,
      }));

    // 2) Agent-actor activity events (delegation, hand-off, tool calls, status…).
    const activityConds = [
      eq(schema.activityEvents.workspaceId, ws.workspaceId),
      eq(schema.activityEvents.actorType, 'agent'),
    ];
    if (agentId) activityConds.push(eq(schema.activityEvents.actorId, agentId));
    if (before) activityConds.push(lt(schema.activityEvents.createdAt, before));
    const activity = deps.db.select().from(schema.activityEvents)
      .where(and(...activityConds))
      .orderBy(desc(schema.activityEvents.createdAt))
      .limit(limit)
      .all()
      .map<InteractionEvent>((e) => ({
        id: e.id,
        at: e.createdAt,
        kind: 'activity',
        eventType: e.eventType,
        actor: { type: e.actorType, id: e.actorId },
        summary: e.summary,
        entity: { type: e.entityType, id: e.entityId },
        metadata: (e.metadata && typeof e.metadata === 'object' ? e.metadata as Record<string, unknown> : undefined),
      }));

    // Merge, newest-first, and cap.
    const events = [...messages, ...activity]
      .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
      .slice(0, limit);

    const nextBefore = events.length === limit ? events[events.length - 1]!.at : null;
    return c.json({ events, nextBefore });
  });

  return app;
}

function messageSummary(content: unknown): string {
  if (typeof content === 'string') return content.slice(0, 500);
  if (content && typeof content === 'object') {
    const text = (content as { text?: unknown }).text;
    if (typeof text === 'string') return text.slice(0, 500);
    return JSON.stringify(content).slice(0, 500);
  }
  return '';
}
