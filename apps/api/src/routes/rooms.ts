import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { and, desc, eq, inArray, lt, or } from 'drizzle-orm';
import { z } from 'zod';
import { AgentisError, CONSTANTS, REALTIME_EVENTS, REALTIME_ROOMS } from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { AuthService } from '../services/auth.js';
import type { EventBus } from '../event-bus.js';
import { getUser, requireAuth } from '../middleware/auth.js';
import { getWorkspace, requireWorkspace } from '../middleware/workspace.js';

const ROOM_KINDS = ['workspace', 'team', 'custom', 'thread'] as const;
const VISIBILITIES = ['workspace', 'team', 'private'] as const;
const AUTHOR_TYPES = ['operator', 'agent', 'system'] as const;
const CONTENT_TYPES = [
  'text', 'artifact_card', 'run_card', 'approval_card', 'canvas_embed',
  'code', 'image', 'document', 'diff', 'data_table', 'system',
] as const;

const createRoomSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().max(2000).nullable().optional(),
  kind: z.enum(ROOM_KINDS).default('custom'),
  teamId: z.string().uuid().nullable().optional(),
  visibility: z.enum(VISIBILITIES).default('workspace'),
  agentIds: z.array(z.string().uuid()).max(50).default([]),
});

const updateRoomSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  description: z.string().max(2000).nullable().optional(),
  visibility: z.enum(VISIBILITIES).optional(),
  pinnedAt: z.string().nullable().optional(),
  agentIds: z.array(z.string().uuid()).max(50).optional(),
});

const messageSchema = z.object({
  authorType: z.enum(AUTHOR_TYPES).default('operator'),
  authorId: z.string().max(160).nullable().optional(),
  contentType: z.enum(CONTENT_TYPES).default('text'),
  content: z.unknown().default({}),
  replyToId: z.string().uuid().nullable().optional(),
  mentions: z.array(z.string().uuid()).max(50).default([]),
});

const editMessageSchema = z.object({
  text: z.string().min(1).max(CONSTANTS.CONVERSATION_MESSAGE_MAX_LENGTH),
});

export function buildRoomRoutes(deps: { db: AgentisSqliteDb; auth: AuthService; bus: EventBus }) {
  const app = new Hono();
  app.use('*', requireAuth(deps), requireWorkspace(deps));

  app.get('/', (c) => {
    const ws = getWorkspace(c);
    const teamId = c.req.query('teamId');
    const kind = c.req.query('kind');
    const rows = deps.db.select().from(schema.rooms)
      .where(eq(schema.rooms.workspaceId, ws.workspaceId))
      .orderBy(desc(schema.rooms.lastMessageAt))
      .all()
      .filter((r) => !teamId || r.teamId === teamId)
      .filter((r) => !kind || r.kind === kind);
    const rooms = rows.map((r) => ({ ...r, agentIds: agentsForRoom(deps.db, r.id) }));
    return c.json({ rooms });
  });

  app.post('/', async (c) => {
    const ws = getWorkspace(c);
    const body = createRoomSchema.parse(await c.req.json());
    const now = new Date().toISOString();
    const room = {
      id: randomUUID(),
      workspaceId: ws.workspaceId,
      userId: ws.user.id,
      teamId: body.teamId ?? null,
      kind: body.kind,
      name: body.name,
      description: body.description ?? null,
      isTeamDefault: false,
      visibility: body.visibility,
      pinnedAt: null,
      lastMessageAt: null,
      createdAt: now,
      updatedAt: now,
    };
    deps.db.insert(schema.rooms).values(room).run();
    if (body.agentIds.length > 0) {
      validateAgents(deps.db, ws.workspaceId, body.agentIds);
      for (const agentId of body.agentIds) {
        deps.db.insert(schema.roomAgents).values({
          roomId: room.id, agentId, addedAt: now, addedBy: ws.user.id,
        }).onConflictDoNothing().run();
      }
    }
    const payload = { ...room, agentIds: body.agentIds };
    deps.bus.publish(REALTIME_ROOMS.workspace(ws.workspaceId), REALTIME_EVENTS.ROOM_CREATED, { room: payload });
    return c.json({ room: payload }, 201);
  });

  app.get('/mentions', (c) => {
    const ws = getWorkspace(c);
    const user = getUser(c);
    const limit = Math.min(Math.max(Number(c.req.query('limit') ?? 10), 1), 50);
    const scanLimit = Math.min(Math.max(Number(c.req.query('scanLimit') ?? 250), limit), 1000);
    const rows = deps.db.select().from(schema.roomMessages)
      .where(eq(schema.roomMessages.workspaceId, ws.workspaceId))
      .orderBy(desc(schema.roomMessages.createdAt))
      .limit(scanLimit)
      .all()
      .filter((message) => {
        if (message.authorType === 'operator' && message.authorId === user.id) return false;
        return messageMentionsUser(message, user);
      })
      .slice(0, limit);

    const roomIds = Array.from(new Set(rows.map((row) => row.roomId)));
    const roomRows = roomIds.length > 0
      ? deps.db.select().from(schema.rooms).where(inArray(schema.rooms.id, roomIds)).all()
      : [];
    const roomsById = new Map(roomRows.map((room) => [room.id, room]));
    return c.json({
      mentions: rows.map((message) => ({
        ...message,
        roomName: roomsById.get(message.roomId)?.name ?? 'Room',
      })),
    });
  });

  app.get('/:id', (c) => {
    const ws = getWorkspace(c);
    const room = loadRoom(deps.db, ws.workspaceId, c.req.param('id'));
    return c.json({ room: { ...room, agentIds: agentsForRoom(deps.db, room.id) } });
  });

  app.patch('/:id', async (c) => {
    const ws = getWorkspace(c);
    const existing = loadRoom(deps.db, ws.workspaceId, c.req.param('id'));
    const body = updateRoomSchema.parse(await c.req.json());
    const next: Record<string, unknown> = { updatedAt: new Date().toISOString() };
    if (body.name !== undefined) next.name = body.name;
    if (body.description !== undefined) next.description = body.description ?? null;
    if (body.visibility !== undefined) next.visibility = body.visibility;
    if (body.pinnedAt !== undefined) next.pinnedAt = body.pinnedAt;
    deps.db.update(schema.rooms).set(next).where(eq(schema.rooms.id, existing.id)).run();
    if (body.agentIds) {
      validateAgents(deps.db, ws.workspaceId, body.agentIds);
      const current = agentsForRoom(deps.db, existing.id);
      const toAdd = body.agentIds.filter((id) => !current.includes(id));
      const toRemove = current.filter((id) => !body.agentIds!.includes(id));
      const now = new Date().toISOString();
      for (const agentId of toAdd) {
        deps.db.insert(schema.roomAgents).values({
          roomId: existing.id, agentId, addedAt: now, addedBy: ws.user.id,
        }).onConflictDoNothing().run();
        deps.bus.publish(REALTIME_ROOMS.room(existing.id), REALTIME_EVENTS.ROOM_AGENT_JOINED, { roomId: existing.id, agentId });
      }
      if (toRemove.length > 0) {
        deps.db.delete(schema.roomAgents)
          .where(and(eq(schema.roomAgents.roomId, existing.id), inArray(schema.roomAgents.agentId, toRemove)))
          .run();
        for (const agentId of toRemove) {
          deps.bus.publish(REALTIME_ROOMS.room(existing.id), REALTIME_EVENTS.ROOM_AGENT_LEFT, { roomId: existing.id, agentId });
        }
      }
    }
    const room = loadRoom(deps.db, ws.workspaceId, existing.id);
    const payload = { ...room, agentIds: agentsForRoom(deps.db, room.id) };
    deps.bus.publish(REALTIME_ROOMS.workspace(ws.workspaceId), REALTIME_EVENTS.ROOM_UPDATED, { room: payload });
    return c.json({ room: payload });
  });

  app.delete('/:id', (c) => {
    const ws = getWorkspace(c);
    const existing = loadRoom(deps.db, ws.workspaceId, c.req.param('id'));
    if (existing.isTeamDefault) {
      throw new AgentisError('VALIDATION_FAILED', 'Cannot delete a team default room');
    }
    deps.db.delete(schema.rooms).where(eq(schema.rooms.id, existing.id)).run();
    deps.bus.publish(REALTIME_ROOMS.workspace(ws.workspaceId), REALTIME_EVENTS.ROOM_DELETED, { id: existing.id });
    return c.json({ ok: true, id: existing.id });
  });

  app.get('/for-team/:teamId', (c) => {
    const ws = getWorkspace(c);
    const teamId = c.req.param('teamId');
    const room = deps.db.select().from(schema.rooms)
      .where(and(
        eq(schema.rooms.workspaceId, ws.workspaceId),
        eq(schema.rooms.teamId, teamId),
        eq(schema.rooms.isTeamDefault, true),
      ))
      .get();
    if (!room) throw new AgentisError('RESOURCE_NOT_FOUND', 'No default room for team');
    return c.json({ room: { ...room, agentIds: agentsForRoom(deps.db, room.id) } });
  });

  app.get('/:id/messages', (c) => {
    const ws = getWorkspace(c);
    const room = loadRoom(deps.db, ws.workspaceId, c.req.param('id'));
    const limit = Math.min(Math.max(Number(c.req.query('limit') ?? 100), 1), 500);
    const before = c.req.query('before') ?? null;
    const beforeId = c.req.query('beforeId') ?? null;
    const messages = deps.db.select().from(schema.roomMessages)
      .where(and(
        eq(schema.roomMessages.roomId, room.id),
        ...(before
          ? [
              beforeId
                ? or(
                    lt(schema.roomMessages.createdAt, before),
                    and(eq(schema.roomMessages.createdAt, before), lt(schema.roomMessages.id, beforeId)),
                  )!
                : lt(schema.roomMessages.createdAt, before),
            ]
          : []),
      ))
      .orderBy(desc(schema.roomMessages.createdAt), desc(schema.roomMessages.id))
      .limit(limit)
      .all()
      .reverse();
    return c.json({ messages });
  });

  app.post('/:id/messages', async (c) => {
    const ws = getWorkspace(c);
    const room = loadRoom(deps.db, ws.workspaceId, c.req.param('id'));
    const body = messageSchema.parse(await c.req.json());
    const now = new Date().toISOString();
    const message = {
      id: randomUUID(),
      roomId: room.id,
      workspaceId: ws.workspaceId,
      authorType: body.authorType,
      authorId: body.authorId ?? (body.authorType === 'operator' ? ws.user.id : null),
      contentType: body.contentType,
      content: (body.content ?? {}) as Record<string, unknown>,
      replyToId: body.replyToId ?? null,
      mentions: body.mentions,
      createdAt: now,
    };
    deps.db.insert(schema.roomMessages).values(message).run();
    deps.db.update(schema.rooms).set({ lastMessageAt: now, updatedAt: now }).where(eq(schema.rooms.id, room.id)).run();
    deps.bus.publish(REALTIME_ROOMS.room(room.id), REALTIME_EVENTS.ROOM_MESSAGE_SENT, { message });
    deps.bus.publish(REALTIME_ROOMS.workspace(ws.workspaceId), REALTIME_EVENTS.ROOM_MESSAGE_RECEIVED, { roomId: room.id, message });
    return c.json({ message }, 201);
  });

  app.patch('/:id/messages/:messageId', async (c) => {
    const ws = getWorkspace(c);
    const room = loadRoom(deps.db, ws.workspaceId, c.req.param('id'));
    const messageId = c.req.param('messageId');
    const body = editMessageSchema.parse(await c.req.json());
    const existing = deps.db.select().from(schema.roomMessages)
      .where(and(
        eq(schema.roomMessages.workspaceId, ws.workspaceId),
        eq(schema.roomMessages.roomId, room.id),
        eq(schema.roomMessages.id, messageId),
      ))
      .get();
    if (!existing) throw new AgentisError('RESOURCE_NOT_FOUND', 'Message not found');
    const content = { ...(existing.content as Record<string, unknown>), text: body.text };
    deps.db.update(schema.roomMessages)
      .set({ content })
      .where(eq(schema.roomMessages.id, messageId))
      .run();
    const message = { ...existing, content };
    deps.bus.publish(REALTIME_ROOMS.room(room.id), REALTIME_EVENTS.ROOM_MESSAGE_UPDATED, { roomId: room.id, message });
    deps.bus.publish(REALTIME_ROOMS.workspace(ws.workspaceId), REALTIME_EVENTS.ROOM_MESSAGE_UPDATED, { roomId: room.id, message });
    return c.json({ message });
  });

  app.delete('/:id/messages/:messageId', (c) => {
    const ws = getWorkspace(c);
    const room = loadRoom(deps.db, ws.workspaceId, c.req.param('id'));
    const messageId = c.req.param('messageId');
    const existing = deps.db.select().from(schema.roomMessages)
      .where(and(
        eq(schema.roomMessages.workspaceId, ws.workspaceId),
        eq(schema.roomMessages.roomId, room.id),
        eq(schema.roomMessages.id, messageId),
      ))
      .get();
    if (!existing) throw new AgentisError('RESOURCE_NOT_FOUND', 'Message not found');
    deps.db.delete(schema.roomMessages).where(eq(schema.roomMessages.id, messageId)).run();
    deps.bus.publish(REALTIME_ROOMS.room(room.id), REALTIME_EVENTS.ROOM_MESSAGE_DELETED, { roomId: room.id, id: messageId });
    deps.bus.publish(REALTIME_ROOMS.workspace(ws.workspaceId), REALTIME_EVENTS.ROOM_MESSAGE_DELETED, { roomId: room.id, id: messageId });
    return c.json({ ok: true, id: messageId });
  });

  return app;
}

function loadRoom(db: AgentisSqliteDb, workspaceId: string, id: string) {
  const row = db.select().from(schema.rooms)
    .where(and(eq(schema.rooms.id, id), eq(schema.rooms.workspaceId, workspaceId)))
    .get();
  if (!row) throw new AgentisError('RESOURCE_NOT_FOUND', 'Room not found');
  return row;
}

function agentsForRoom(db: AgentisSqliteDb, roomId: string): string[] {
  return db.select().from(schema.roomAgents)
    .where(eq(schema.roomAgents.roomId, roomId))
    .all()
    .map((row) => row.agentId);
}

function validateAgents(db: AgentisSqliteDb, workspaceId: string, agentIds: string[]) {
  if (agentIds.length === 0) return;
  const found = db.select().from(schema.agents)
    .where(and(eq(schema.agents.workspaceId, workspaceId), inArray(schema.agents.id, agentIds)))
    .all();
  if (found.length !== agentIds.length) {
    throw new AgentisError('RESOURCE_NOT_FOUND', 'One or more agents not found in workspace');
  }
}

function messageMentionsUser(
  message: typeof schema.roomMessages.$inferSelect,
  user: { id: string; username: string; displayName?: string | null; email?: string | null },
): boolean {
  const mentions = Array.isArray(message.mentions) ? message.mentions.map(String) : [];
  if (mentions.includes(user.id)) return true;
  const text = messageText(message.content);
  if (!text) return false;
  const normalized = text.toLowerCase().replace(/[_\s.-]+/g, '_');
  return mentionHandles(user).some((handle) => normalized.includes(`@${handle}`));
}

function mentionHandles(user: { username: string; displayName?: string | null; email?: string | null }): string[] {
  const values = [user.username, user.displayName ?? '', user.email?.split('@')[0] ?? ''];
  return Array.from(new Set(values.map((value) => value.trim().toLowerCase().replace(/[_\s.-]+/g, '_')).filter(Boolean)));
}

function messageText(content: unknown): string {
  if (!content) return '';
  if (typeof content === 'string') return content;
  if (typeof content !== 'object') return String(content);
  const record = content as Record<string, unknown>;
  return [record.text, record.body, record.summary, record.title]
    .filter((value): value is string => typeof value === 'string')
    .join('\n');
}
