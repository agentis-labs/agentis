/**
 * ConversationStore — V1-SPEC §0.3 item 23, §11 (conversation surface).
 *
 * Operator-agent threads, with optional mirroring of OpenClaw Gateway
 * sessions. Inbound mirror writes (from the SessionMirror) flow through
 * `appendMirrored()`; operator outbound messages flow through `sendOutbound()`.
 * The store is the single source of truth for the dashboard's
 * /v1/conversations endpoints.
 */

import { randomUUID } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import { AgentisError, REALTIME_EVENTS, REALTIME_ROOMS, type RealtimeEventName } from '@agentis/core';
import type { EventBus } from '../event-bus.js';

export interface ConversationStoreDeps {
  db: AgentisSqliteDb;
  bus: EventBus;
}

export class ConversationStore {
  constructor(private readonly deps: ConversationStoreDeps) {}

  list(workspaceId: string) {
    return this.deps.db
      .select()
      .from(schema.conversations)
      .where(eq(schema.conversations.workspaceId, workspaceId))
      .orderBy(desc(schema.conversations.lastMessageAt))
      .all();
  }

  getOrCreateByAgent(args: {
    workspaceId: string;
    ambientId: string | null;
    userId: string;
    agentId: string;
    mirroredSessionId?: string | null;
  }) {
    const existing = this.deps.db
      .select()
      .from(schema.conversations)
      .where(
        and(
          eq(schema.conversations.workspaceId, args.workspaceId),
          eq(schema.conversations.agentId, args.agentId),
        ),
      )
      .get();
    if (existing) {
      if (args.mirroredSessionId && !existing.mirroredSessionId) {
        this.deps.db
          .update(schema.conversations)
          .set({ mirroredSessionId: args.mirroredSessionId })
          .where(eq(schema.conversations.id, existing.id))
          .run();
        existing.mirroredSessionId = args.mirroredSessionId;
      }
      return existing;
    }
    const row = {
      id: randomUUID(),
      workspaceId: args.workspaceId,
      ambientId: args.ambientId,
      userId: args.userId,
      agentId: args.agentId,
      mirroredSessionId: args.mirroredSessionId ?? null,
      unreadCount: 0,
      lastMessageAt: null,
    };
    this.deps.db.insert(schema.conversations).values(row).run();
    return this.deps.db
      .select()
      .from(schema.conversations)
      .where(eq(schema.conversations.id, row.id))
      .get()!;
  }

  messages(conversationId: string, limit = 50) {
    return this.deps.db
      .select()
      .from(schema.conversationMessages)
      .where(eq(schema.conversationMessages.conversationId, conversationId))
      .orderBy(desc(schema.conversationMessages.createdAt))
      .limit(limit)
      .all()
      .reverse();
  }

  /** Append an outbound operator message and emit the realtime event. */
  appendOutbound(args: {
    workspaceId: string;
    conversationId: string;
    operatorId: string;
    body: string;
    deliveryStatus?: 'sent' | 'delivered' | 'failed';
  }) {
    return this.#append({
      conversationId: args.conversationId,
      workspaceId: args.workspaceId,
      authorType: 'operator',
      authorId: args.operatorId,
      sessionMessageId: null,
      body: args.body,
      deliveryStatus: args.deliveryStatus ?? 'sent',
      eventName: REALTIME_EVENTS.CONVERSATION_MESSAGE_SENT,
    });
  }

  /** Append a mirrored gateway message (inbound). */
  appendMirrored(args: {
    workspaceId: string;
    conversationId: string;
    sessionMessageId: string;
    body: string;
    authorType: 'agent' | 'system';
  }) {
    return this.#append({
      conversationId: args.conversationId,
      workspaceId: args.workspaceId,
      authorType: args.authorType,
      authorId: null,
      sessionMessageId: args.sessionMessageId,
      body: args.body,
      deliveryStatus: 'mirrored',
      eventName: REALTIME_EVENTS.CONVERSATION_MESSAGE_RECEIVED,
    });
  }

  markRead(workspaceId: string, conversationId: string) {
    this.deps.db
      .update(schema.conversations)
      .set({ unreadCount: 0 })
      .where(
        and(
          eq(schema.conversations.workspaceId, workspaceId),
          eq(schema.conversations.id, conversationId),
        ),
      )
      .run();
  }

  #append(args: {
    conversationId: string;
    workspaceId: string;
    authorType: 'operator' | 'agent' | 'system';
    authorId: string | null;
    sessionMessageId: string | null;
    body: string;
    deliveryStatus: 'sent' | 'delivered' | 'failed' | 'mirrored';
    eventName: RealtimeEventName;
  }) {
    if (!args.body || args.body.length === 0) {
      throw new AgentisError('VALIDATION_FAILED', 'Conversation message body required');
    }
    const conversation = this.deps.db
      .select()
      .from(schema.conversations)
      .where(eq(schema.conversations.id, args.conversationId))
      .get();
    if (!conversation || conversation.workspaceId !== args.workspaceId) {
      throw new AgentisError('RESOURCE_NOT_FOUND', `conversation ${args.conversationId} not found`);
    }
    // Idempotency: if a mirrored message with the same sessionMessageId
    // already exists, return it instead of inserting a duplicate.
    if (args.sessionMessageId) {
      const existing = this.deps.db
        .select()
        .from(schema.conversationMessages)
        .where(
          and(
            eq(schema.conversationMessages.conversationId, args.conversationId),
            eq(schema.conversationMessages.sessionMessageId, args.sessionMessageId),
          ),
        )
        .get();
      if (existing) return existing;
    }
    const row = {
      id: randomUUID(),
      conversationId: args.conversationId,
      workspaceId: args.workspaceId,
      authorType: args.authorType,
      authorId: args.authorId,
      sessionMessageId: args.sessionMessageId,
      body: args.body,
      metadata: {},
      deliveryStatus: args.deliveryStatus,
    };
    this.deps.db.insert(schema.conversationMessages).values(row).run();
    const now = new Date().toISOString();
    this.deps.db
      .update(schema.conversations)
      .set({
        lastMessageAt: now,
        unreadCount: args.authorType === 'operator' ? conversation.unreadCount : conversation.unreadCount + 1,
        updatedAt: now,
      })
      .where(eq(schema.conversations.id, args.conversationId))
      .run();
    this.deps.bus.publish(
      REALTIME_ROOMS.conversation(conversation.agentId),
      args.eventName,
      { message: row, conversationId: args.conversationId, agentId: conversation.agentId },
    );
    return row;
  }
}
