/**
 * BroadcastDispatcher — turns an @mention in a room into a real agent turn
 * whose reply lands back in that room.
 *
 * Before this existed, the Global Chat composer posted to a virtual
 * `__broadcast__` room that did not exist, so sending 404'd ("Room not found").
 * Now `rooms.ts` resolves the broadcast alias to a real workspace room when
 * needed, persists the room message, and hands the mentioned agents to this
 * dispatcher:
 *
 *   operator posts "@hermes say hi to @Orchy"
 *     → resolve @hermes (and any other @mentions) to agents
 *     → for each: run ChatSessionExecutor.turn(...)   // the agent THINKS
 *     → persist the reply as an 'agent' room message  // it appears in the room
 *
 * Operator-authored and agent-authored messages can dispatch, so an agent can
 * pull a peer into the same room with an explicit @mention. Mentions are capped
 * per message to keep a single post from fanning out, and automatic peer relays
 * are depth-limited to avoid runaway loops.
 */

import { randomUUID } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import { REALTIME_EVENTS, REALTIME_ROOMS } from '@agentis/core';
import type { ChatMessage, ChatTurnContext } from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { AdapterManager } from '../adapters/AdapterManager.js';
import type { ConversationStore } from './conversation/conversationStore.js';
import { ChatSessionExecutor } from './chat/chatSessionExecutor.js';
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
/** Automatic agent-to-agent relays allowed after an agent reply mentions a peer. */
const MAX_AGENT_RELAY_DEPTH = 1;
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
    relayDepth?: number;
  }): void {
    const agentIds = Array.from(new Set(args.agentIds)).slice(0, MAX_MENTIONS_PER_MESSAGE);
    for (const agentId of agentIds) {
      void this.#dispatchOne({ ...args, agentId, relayDepth: args.relayDepth ?? 0 }).catch((error) => {
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
    relayDepth: number;
  }): Promise<void> {
    const name = this.#agentName(args.agentId);
    const reg = this.deps.adapters.get(args.agentId);
    if (!reg?.adapter?.chat) {
      // Not wired into an interactive harness. Don't stay silent — the operator
      // @mentioned this agent and deserves to know why nothing came back.
      this.deps.logger.info('broadcast.dispatch.skipped_no_chat', { agentId: args.agentId });
      this.#postLine(args.workspaceId, args.roomId, 'system', null,
        `⚠️ ${name} isn't connected to an interactive runtime, so it can't answer in this room.`);
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

    // `turn` is a STATIC method that reads static private fields via `this`, so it
    // must keep its class as the receiver. Calling a bare `ChatSessionExecutor.turn`
    // reference unbound throws "Receiver must be class ChatSessionExecutor" — which
    // is exactly what made every Global Chat turn fail. Bind it. (A test override is
    // a plain function and needs no binding.)
    const runTurn = this.deps.runTurn ?? ChatSessionExecutor.turn.bind(ChatSessionExecutor);
    let reply = '';
    let adapterError = '';
    let sawConfirmation = false;
    let finishReason: string | undefined;
    try {
      for await (const delta of runTurn(reg.adapter, history, args.userMessage, turnContext)) {
        if (delta.type === 'text') reply += delta.delta;
        else if (delta.type === 'confirmation_required') sawConfirmation = true;
        else if (delta.type === 'tool_result' && delta.error) adapterError = delta.error;
        else if (delta.type === 'done') { finishReason = delta.finishReason; break; }
      }
    } catch (error) {
      adapterError = error instanceof Error ? error.message : String(error);
      this.deps.logger.error('broadcast.dispatch.turn_error', { agentId: args.agentId, error: adapterError });
    }

    const text = reply.trim();
    if (text) {
      this.#postLine(args.workspaceId, args.roomId, 'agent', args.agentId, text);
      if (args.relayDepth < MAX_AGENT_RELAY_DEPTH) {
        const peerIds = this.resolveMentionedAgentIds(args.workspaceId, text)
          .filter((agentId) => agentId !== args.agentId);
        if (peerIds.length > 0) {
          this.dispatchMentions({
            workspaceId: args.workspaceId,
            ambientId: args.ambientId,
            userId: args.userId,
            roomId: args.roomId,
            agentIds: peerIds,
            userMessage: text,
            relayDepth: args.relayDepth + 1,
          });
        }
      }
      return;
    }

    // The turn produced no answer text. NEVER leave the operator wondering —
    // post an honest, scoped notice about WHY (the whole point of the feature is
    // that an @mention does something visible).
    if (sawConfirmation) {
      this.#postLine(args.workspaceId, args.roomId, 'system', null,
        `🔒 ${name} needs to run a tool that requires your approval — open its direct chat to approve it (rooms can't show approval prompts).`);
    } else if (adapterError || finishReason === 'error') {
      this.#postLine(args.workspaceId, args.roomId, 'system', null,
        `⚠️ ${name} couldn't reply: ${trimReason(adapterError) || 'its runtime returned an error.'}`);
    } else {
      this.#postLine(args.workspaceId, args.roomId, 'system', null,
        `${name} didn't have anything to add.`);
    }
  }

  /** Agent display name for an operator-facing notice; falls back gracefully. */
  #agentName(agentId: string): string {
    try {
      const row = this.deps.db
        .select({ name: schema.agents.name })
        .from(schema.agents)
        .where(eq(schema.agents.id, agentId))
        .get();
      return row?.name?.trim() || 'The agent';
    } catch {
      return 'The agent';
    }
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

  #postLine(
    workspaceId: string,
    roomId: string,
    authorType: 'agent' | 'system',
    authorId: string | null,
    text: string,
  ): void {
    const now = new Date().toISOString();
    const message = {
      id: randomUUID(),
      roomId,
      workspaceId,
      authorType,
      authorId,
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

/** Keep an operator-facing failure reason short and single-line. */
function trimReason(reason: string): string {
  const value = reason.trim().replace(/\s+/g, ' ');
  return value.length > 200 ? `${value.slice(0, 199)}…` : value;
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
