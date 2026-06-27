/**
 * BroadcastDispatcher — turns an @mention in the Global Chat (workspace
 * broadcast room) into a real agent turn whose reply lands back in that room.
 *
 * Before this existed, the Global Chat composer posted to a virtual
 * `__broadcast__` room that did not exist, so sending 404'd ("Room not found").
 * Now `rooms.ts` resolves the broadcast alias to a real workspace room, persists
 * the operator's message, and hands the mentioned agents to this dispatcher:
 *
 *   operator posts "@hermes say hi to @Orchy"
 *     → resolve @hermes (and any other @mentions) to agents
 *     → for each: run ChatSessionExecutor.turn(...)   // the agent THINKS
 *     → persist the reply as an 'agent' room message  // it appears in Global Chat
 *
 * Only operator-authored messages dispatch, so an agent's own reply (even when it
 * @mentions another agent) never re-triggers this loop — agent-to-agent chatter
 * stays the job of the agents' own A2A tools, which already surface in the feed.
 * Mentions are capped per message to keep a single post from fanning out.
 */

import { randomUUID } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import { REALTIME_EVENTS, REALTIME_ROOMS } from '@agentis/core';
import type { ChatMessage, ChatTurnContext } from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { AdapterManager } from '../adapters/AdapterManager.js';
import type { ConversationStore } from './conversationStore.js';
import { ChatSessionExecutor } from './chatSessionExecutor.js';
import type { EventBus } from '../event-bus.js';
import type { Logger } from '../logger.js';

export interface BroadcastDispatcherDeps {
  db: AgentisSqliteDb;
  adapters: AdapterManager;
  conversations: ConversationStore;
  bus: EventBus;
  logger: Logger;
  /** Override the turn runner (tests). Defaults to ChatSessionExecutor.turn. */
  runTurn?: typeof ChatSessionExecutor.turn;
}

/** Most agents a single operator post may wake — a guard against runaway fan-out. */
const MAX_MENTIONS_PER_MESSAGE = 3;
/** How many prior room lines the agent sees as context. */
const HISTORY_LIMIT = 12;

export class BroadcastDispatcher {
  constructor(private readonly deps: BroadcastDispatcherDeps) {}

  /**
   * Resolve @handles in `text` to agents in this workspace. Matches an agent by
   * its normalized name (lowercased, non-alphanumerics stripped), so "@Orchy"
   * and "@orchy" both hit the agent named "Orchy".
   */
  resolveMentionedAgentIds(workspaceId: string, text: string): string[] {
    const handles = new Set<string>();
    for (const match of text.matchAll(/@([a-z0-9._-]{2,40})/gi)) {
      const handle = normalizeHandle(match[1] ?? '');
      if (handle) handles.add(handle);
    }
    if (handles.size === 0) return [];
    const agents = this.deps.db
      .select()
      .from(schema.agents)
      .where(eq(schema.agents.workspaceId, workspaceId))
      .all();
    const ids: string[] = [];
    for (const agent of agents) {
      if (handles.has(normalizeHandle(agent.name))) ids.push(agent.id);
    }
    return ids;
  }

  /**
   * Fire-and-forget: run each mentioned agent's turn and post its reply into the
   * room. Never throws — a failing agent is logged and posts an honest line so
   * the operator is not left wondering.
   */
  dispatchMentions(args: {
    workspaceId: string;
    ambientId: string | null;
    userId: string;
    roomId: string;
    agentIds: string[];
    userMessage: string;
  }): void {
    const agentIds = Array.from(new Set(args.agentIds)).slice(0, MAX_MENTIONS_PER_MESSAGE);
    for (const agentId of agentIds) {
      void this.#dispatchOne({ ...args, agentId }).catch((error) => {
        this.deps.logger.error('broadcast.dispatch.failed', {
          agentId,
          roomId: args.roomId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }
  }

  async #dispatchOne(args: {
    workspaceId: string;
    ambientId: string | null;
    userId: string;
    roomId: string;
    agentId: string;
    userMessage: string;
  }): Promise<void> {
    const reg = this.deps.adapters.get(args.agentId);
    if (!reg?.adapter?.chat) {
      // Not wired into an interactive harness — stay quiet rather than spam the
      // room with a capability error on every mention.
      this.deps.logger.info('broadcast.dispatch.skipped_no_chat', { agentId: args.agentId });
      return;
    }

    const conversation = this.deps.conversations.getOrCreateByAgent({
      workspaceId: args.workspaceId,
      ambientId: args.ambientId,
      userId: args.userId,
      agentId: args.agentId,
    });

    const history = this.#roomHistory(args.roomId, args.agentId);
    const turnContext: ChatTurnContext = {
      workspaceId: args.workspaceId,
      ambientId: args.ambientId,
      agentId: args.agentId,
      userId: args.userId,
      conversationId: conversation.id,
      executionMode: 'chat',
      maxTurns: 4,
    };

    const runTurn = this.deps.runTurn ?? ChatSessionExecutor.turn;
    let reply = '';
    try {
      for await (const delta of runTurn(reg.adapter, history, args.userMessage, turnContext)) {
        if (delta.type === 'text') reply += delta.delta;
        if (delta.type === 'done') break;
      }
    } catch (error) {
      this.deps.logger.error('broadcast.dispatch.turn_error', {
        agentId: args.agentId,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    const text = reply.trim();
    if (!text) return;
    this.#postAgentReply(args.workspaceId, args.roomId, args.agentId, text);
  }

  /** Recent room lines as chat history (operator → user, agent → assistant). */
  #roomHistory(roomId: string, agentId: string): ChatMessage[] {
    const rows = this.deps.db
      .select()
      .from(schema.roomMessages)
      .where(eq(schema.roomMessages.roomId, roomId))
      .orderBy(desc(schema.roomMessages.createdAt), desc(schema.roomMessages.id))
      .limit(HISTORY_LIMIT)
      .all()
      .reverse();
    const history: ChatMessage[] = [];
    for (const row of rows) {
      if (row.authorType === 'system') continue;
      const content = roomMessageText(row.content);
      if (!content) continue;
      // The agent's own past lines read back as 'assistant'; everyone else
      // (operator and other agents) reads as 'user' so it can react to them.
      history.push({
        role: row.authorType === 'agent' && row.authorId === agentId ? 'assistant' : 'user',
        content,
      });
    }
    return history;
  }

  #postAgentReply(workspaceId: string, roomId: string, agentId: string, text: string): void {
    const now = new Date().toISOString();
    const message = {
      id: randomUUID(),
      roomId,
      workspaceId,
      authorType: 'agent' as const,
      authorId: agentId,
      contentType: 'text' as const,
      content: { text } as Record<string, unknown>,
      replyToId: null,
      mentions: [] as string[],
      createdAt: now,
    };
    this.deps.db.insert(schema.roomMessages).values(message).run();
    this.deps.db
      .update(schema.rooms)
      .set({ lastMessageAt: now, updatedAt: now })
      .where(eq(schema.rooms.id, roomId))
      .run();
    this.deps.bus.publish(REALTIME_ROOMS.room(roomId), REALTIME_EVENTS.ROOM_MESSAGE_SENT, { message });
    this.deps.bus.publish(REALTIME_ROOMS.workspace(workspaceId), REALTIME_EVENTS.ROOM_MESSAGE_RECEIVED, { roomId, message });
  }
}

function normalizeHandle(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function roomMessageText(content: unknown): string {
  if (!content) return '';
  if (typeof content === 'string') return content;
  if (typeof content !== 'object') return String(content);
  const record = content as Record<string, unknown>;
  return [record.text, record.body, record.caption, record.summary, record.title]
    .filter((value): value is string => typeof value === 'string')
    .join('\n')
    .trim();
}
