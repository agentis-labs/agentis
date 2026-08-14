/**
 * Agent interaction feed — the backend backbone for the interaction surface
 * (UNIVERSAL-HARNESS §7, Pillar 4).
 *
 *   GET /v1/interactions?roomId=&agentId=&conversationId=&runId=&limit=&before=
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
import { and, desc, eq, lt, or } from 'drizzle-orm';
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
  /** consultation is an operator-safe, expandable private A2A thread. */
  kind: 'message' | 'activity' | 'consultation';
  eventType: string;
  actor: { type: string; id: string | null };
  summary: string;
  roomId?: string;
  entity?: { type: string; id: string };
  metadata?: Record<string, unknown>;
  consultation?: {
    id: string;
    status: string;
    caller: { id: string; name: string };
    target: { id: string; name: string; role: string | null };
    roundCount: number;
    maxRounds: number;
    substituted: boolean;
    requestedTargetAgentId: string | null;
    messages: Array<{
      id: string;
      sequenceNumber: number;
      kind: string;
      authorAgentId: string | null;
      body: string;
      metadata?: Record<string, unknown>;
      createdAt: string;
    }>;
  };
}

export function buildInteractionRoutes(deps: InteractionRoutesDeps) {
  const app = new Hono();
  app.use('*', requireAuth(deps), requireWorkspace(deps));

  app.get('/', (c) => {
    const ws = getWorkspace(c);
    const roomId = c.req.query('roomId') || null;
    const agentId = c.req.query('agentId') || null;
    const conversationId = c.req.query('conversationId') || null;
    const runId = c.req.query('runId') || null;
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
    const messages = (conversationId || runId ? [] : deps.db.select().from(schema.roomMessages)
      .where(and(...messageConds))
      .orderBy(desc(schema.roomMessages.createdAt))
      .limit(limit)
      .all())
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
    const activity = (conversationId || runId ? [] : deps.db.select().from(schema.activityEvents)
      .where(and(...activityConds))
      .orderBy(desc(schema.activityEvents.createdAt))
      .limit(limit)
      .all())
      .filter((event) => event.entityType !== 'agent_consultation')
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

    // 3) Durable consultation threads. Unlike legacy activity, agentId matches
    // either participant and conversation/run scopes are first-class columns.
    const consultationConds = [eq(schema.agentConsultations.workspaceId, ws.workspaceId)];
    if (agentId) consultationConds.push(or(
      eq(schema.agentConsultations.callerAgentId, agentId),
      eq(schema.agentConsultations.targetAgentId, agentId),
    )!);
    if (conversationId) consultationConds.push(eq(schema.agentConsultations.conversationId, conversationId));
    if (runId) consultationConds.push(eq(schema.agentConsultations.runId, runId));
    if (before) consultationConds.push(lt(schema.agentConsultations.updatedAt, before));

    const agentNames = new Map(deps.db.select({ id: schema.agents.id, name: schema.agents.name })
      .from(schema.agents)
      .where(eq(schema.agents.workspaceId, ws.workspaceId))
      .all()
      .map((agent) => [agent.id, agent.name]));
    const consultations = (roomId ? [] : deps.db.select().from(schema.agentConsultations)
      .where(and(...consultationConds))
      .orderBy(desc(schema.agentConsultations.updatedAt))
      .limit(limit)
      .all())
      .map<InteractionEvent>((row) => {
        const callerName = agentNames.get(row.callerAgentId) ?? 'Unknown agent';
        const targetName = agentNames.get(row.targetAgentId) ?? 'Unknown specialist';
        const thread = deps.db.select().from(schema.agentConsultationMessages)
          .where(and(
            eq(schema.agentConsultationMessages.workspaceId, ws.workspaceId),
            eq(schema.agentConsultationMessages.consultationId, row.id),
          ))
          .orderBy(schema.agentConsultationMessages.sequenceNumber)
          .all();
        return {
          id: row.id,
          at: row.updatedAt,
          kind: 'consultation',
          eventType: 'agent_consultation',
          actor: { type: 'agent', id: row.callerAgentId },
          summary: `${callerName} consulted ${targetName} · ${row.roundCount} ${row.roundCount === 1 ? 'round' : 'rounds'}`,
          entity: { type: 'agent_consultation', id: row.id },
          metadata: {
            status: row.status,
            source: row.source,
            conversationId: row.conversationId,
            runId: row.runId,
            substituted: row.substituted,
            requestedTargetAgentId: row.requestedTargetAgentId,
            error: row.error,
          },
          consultation: {
            id: row.id,
            status: row.status,
            caller: { id: row.callerAgentId, name: callerName },
            target: { id: row.targetAgentId, name: targetName, role: row.targetRole },
            roundCount: row.roundCount,
            maxRounds: row.maxRounds,
            substituted: row.substituted,
            requestedTargetAgentId: row.requestedTargetAgentId,
            messages: thread.map((message) => ({
              id: message.id,
              sequenceNumber: message.sequenceNumber,
              kind: message.kind,
              authorAgentId: message.authorAgentId,
              body: message.body,
              metadata: message.metadata && typeof message.metadata === 'object'
                ? message.metadata as Record<string, unknown>
                : undefined,
              createdAt: message.createdAt,
            })),
          },
        };
      });

    // Merge, newest-first, and cap.
    const events = [...messages, ...activity, ...consultations]
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
