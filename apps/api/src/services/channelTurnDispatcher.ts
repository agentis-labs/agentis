/**
 * ChannelTurnDispatcher — the bridge between an inbound channel message and a
 * real orchestrator turn (OMNICHANNEL-ORCHESTRATOR-10X §3.3).
 *
 * Before this service existed, a Telegram/Slack/Discord message landed in a
 * conversation thread as an inert mirrored line and nothing else happened — the
 * orchestrator never saw it. The dispatcher closes that loop:
 *
 *   inbound message  (ChannelBridge.handleInbound)
 *     → dispatch()
 *        → resolve the connection's bound agent → an adapter that can chat
 *          (its own runtime, or the configured orchestrator runtime)
 *        → ChatSessionExecutor.turn(...)            // the orchestrator THINKS
 *        → persist the reply as an 'agent' message
 *        → deliver the reply back to the origin channel
 *
 * The webhook handler fires this fire-and-forget so the channel gets its fast
 * 200 ack while the (potentially slow) turn runs in the background.
 */

import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { AgentAdapter, ChatDelta, ChatMessage, ChatTurnContext } from '@agentis/core';
import type { AdapterManager } from '../adapters/AdapterManager.js';
import type { ConversationStore } from './conversationStore.js';
import { ChatSessionExecutor } from './chatSessionExecutor.js';
import type { ChannelIdentityService } from './channelIdentityService.js';
import type { Logger } from '../logger.js';
import type { EventBus } from '../event-bus.js';
import { publishAgentWorkStep, publishChatDeltaProgress } from './agentWorkProgress.js';

export interface ChannelTurnDeliver {
  (args: { connectionId: string; chatId: string; body: string }): Promise<void>;
}

export interface ChannelTurnDispatcherDeps {
  db: AgentisSqliteDb;
  adapters: AdapterManager;
  conversations: ConversationStore;
  logger: Logger;
  /** Workspace realtime feed for channel turns. */
  bus?: EventBus;
  /** Send the orchestrator's reply back to the origin channel. */
  deliver: ChannelTurnDeliver;
  /** Optional: show/clear the typing indicator while the turn runs. */
  setTyping?: (connectionId: string, chatId: string, on: boolean) => Promise<void>;
  /** Override the turn runner (tests). Defaults to ChatSessionExecutor.turn. */
  runTurn?: typeof ChatSessionExecutor.turn;
  /** Override the confirm runner (tests). Defaults to ChatSessionExecutor.confirm. */
  runConfirm?: typeof ChatSessionExecutor.confirm;
  /** Override the orchestrator-runtime fallback (tests). */
  fallbackAdapter?: () => AgentAdapter | undefined;
  /** Cross-surface peer identity — records senders and recalls them (§5.2). */
  identity?: ChannelIdentityService;
  /**
   * Batch rapid-fire inbound messages within this window (ms) into a single
   * turn (OMNICHANNEL §3.3). 0 (default) runs each message immediately.
   */
  debounceMs?: number;
}

interface PendingChannelConfirmation {
  turnId: string;
  conversationId: string;
  expiresAt: number;
}

interface PendingBatch {
  latest: ChannelTurnInput;
  texts: string[];
  ids: Set<string>;
  timer: ReturnType<typeof setTimeout>;
}

const CONFIRM_TTL_MS = 5 * 60 * 1000;

export interface ChannelTurnInput {
  workspaceId: string;
  ambientId: string | null;
  userId: string;
  agentId: string;
  conversationId: string;
  connectionId: string;
  kind: string;
  /** Channel-side reply address (e.g. Telegram chat id, Slack channel:thread). */
  chatId: string;
  /** Subject boundary — when set, turn history is scoped to this thread. */
  threadId?: string;
  /** The human's message text, already stripped of any `[from]` prefix. */
  text: string;
  from?: string;
  /** Conversation message id of the inbound mirror, excluded from history. */
  inboundMessageId?: string;
}

const HISTORY_LIMIT = 20;
const NOT_CONNECTED =
  'This agent is not connected to an interactive runtime yet, so it cannot reply over this channel. ' +
  'Connect a chat-capable harness (or configure the orchestrator runtime) and try again.';

export class ChannelTurnDispatcher {
  // Pending confirmations keyed by `${connectionId}:${chatId}` — a channel has
  // no buttons, so a tool that needs confirmation becomes a "reply yes/no" prompt
  // that the next inbound message resolves (OMNICHANNEL §3.5/§5).
  readonly #pending = new Map<string, PendingChannelConfirmation>();
  // Per-(connection,chat) batches of rapid-fire messages awaiting a debounce flush.
  readonly #batches = new Map<string, PendingBatch>();

  constructor(private readonly deps: ChannelTurnDispatcherDeps) {}

  /**
   * Handle an inbound channel message. With `debounceMs > 0`, rapid-fire
   * messages from the same chat are coalesced into one turn; otherwise the turn
   * runs immediately. Fire-and-forget safe — never throws.
   */
  async dispatch(input: ChannelTurnInput): Promise<{ replied: boolean; reason?: string }> {
    this.#publishWorkStep(input, null, {
      phase: 'received',
      step: 'channel_message',
      description: `${channelLabel(input.kind)} message received`,
      detail: input.from ? `From ${input.from}` : `Chat ${input.chatId}`,
    });
    const windowMs = this.deps.debounceMs ?? 0;
    if (windowMs <= 0) {
      return this.#executeTurn(input, input.inboundMessageId ? [input.inboundMessageId] : []);
    }
    const key = `${input.connectionId}:${input.chatId}`;
    const existing = this.#batches.get(key);
    if (existing) {
      existing.texts.push(input.text);
      if (input.inboundMessageId) existing.ids.add(input.inboundMessageId);
      existing.latest = input;
      clearTimeout(existing.timer);
      existing.timer = setTimeout(() => this.#flushBatch(key), windowMs);
      return { replied: false, reason: 'batched' };
    }
    const ids = new Set<string>();
    if (input.inboundMessageId) ids.add(input.inboundMessageId);
    this.#batches.set(key, {
      latest: input,
      texts: [input.text],
      ids,
      timer: setTimeout(() => this.#flushBatch(key), windowMs),
    });
    return { replied: false, reason: 'batched' };
  }

  #flushBatch(key: string): void {
    const batch = this.#batches.get(key);
    if (!batch) return;
    this.#batches.delete(key);
    const combined: ChannelTurnInput = { ...batch.latest, text: batch.texts.join('\n') };
    void this.#executeTurn(combined, [...batch.ids]).catch((err) => {
      this.deps.logger.error('channel.turn.batch_failed', { key, err: (err as Error).message });
    });
  }

  /**
   * Run one orchestrator turn and deliver the reply. If a confirmation from a
   * prior turn is pending for this chat and the message is a yes/no, resolve
   * that instead of starting a fresh turn. Never throws.
   */
  async #executeTurn(input: ChannelTurnInput, excludeMessageIds: string[]): Promise<{ replied: boolean; reason?: string }> {
    const clientTurnId = `channel-${randomUUID()}`;
    try {
      const adapter = this.#resolveAdapter(input.agentId, input.workspaceId);
      if (!adapter) {
        this.#publishWorkStep(input, clientTurnId, {
          phase: 'fail',
          step: 'runtime',
          description: 'Channel reply failed',
          detail: NOT_CONNECTED,
        });
        await this.#persistAndDeliver(input, NOT_CONNECTED, { deliveryStatus: 'failed' });
        return { replied: false, reason: 'no_chat_adapter' };
      }

      // Show "typing…" while the (possibly slow) turn runs; cleared in finally.
      void this.deps.setTyping?.(input.connectionId, input.chatId, true).catch(() => {});

      const pendingKey = `${input.connectionId}:${input.chatId}`;
      const pending = this.#takeFreshPending(pendingKey);
      const decision = pending ? interpretConfirmation(input.text) : null;

      let stream: AsyncIterable<import('@agentis/core').ChatDelta>;
      if (pending && decision !== null) {
        const runConfirm = this.deps.runConfirm ?? ChatSessionExecutor.confirm.bind(ChatSessionExecutor);
        stream = runConfirm(adapter, pending.turnId, decision, {
          workspaceId: input.workspaceId,
          userId: input.userId,
          conversationId: input.conversationId,
        });
      } else {
        const runTurn = this.deps.runTurn ?? ChatSessionExecutor.turn.bind(ChatSessionExecutor);
        const ctx: ChatTurnContext = {
          workspaceId: input.workspaceId,
          ambientId: input.ambientId,
          agentId: input.agentId,
          userId: input.userId,
          conversationId: input.conversationId,
          clientTurnId,
          maxTurns: 8,
          viewport: null,
        };
        const senderSummary = this.#recordIdentity(input);
        stream = runTurn(adapter, this.#buildHistory(input, excludeMessageIds), input.text, ctx, {
          channelContext: { kind: input.kind, from: input.from ?? null, chatId: input.chatId, threadId: input.threadId ?? null, senderSummary },
        });
      }

      let finalText = '';
      let finishReason = 'stop';
      let runtimeError: string | null = null;
      let confirmation: Extract<import('@agentis/core').ChatDelta, { type: 'confirmation_required' }> | null = null;
      for await (const delta of stream) {
        this.#publishDelta(input, clientTurnId, delta);
        if (delta.type === 'text') finalText += delta.delta;
        else if (delta.type === 'confirmation_required') confirmation = delta;
        else if (delta.type === 'tool_result' && delta.error) runtimeError = delta.error;
        else if (delta.type === 'done') finishReason = delta.finishReason;
      }

      // A tool needs confirmation: register it and ask the channel to reply yes/no.
      if (confirmation) {
        this.#pending.set(pendingKey, {
          turnId: confirmation.turnId,
          conversationId: input.conversationId,
          expiresAt: Date.now() + CONFIRM_TTL_MS,
        });
        const promptParts = [confirmation.title, finalText.trim(), confirmation.body?.trim(), 'Reply "yes" to confirm or "no" to cancel.'];
        const prompt = promptParts.filter((p): p is string => Boolean(p && p.length)).join('\n\n');
        await this.#persistAndDeliver(input, prompt);
        return { replied: true };
      }

      const body = finalText.trim();
      if (!body) {
        if (finishReason === 'error') {
          const failure = channelTurnFailureMessage(runtimeError);
          this.#publishWorkStep(input, clientTurnId, {
            phase: 'fail',
            step: 'runtime',
            description: 'Channel reply failed',
            detail: failure,
          });
          await this.#persistAndDeliver(input, failure, { deliveryStatus: 'failed' });
          return { replied: true, reason: 'runtime_error' };
        }
        this.deps.logger.info('channel.turn.empty_reply', {
          connectionId: input.connectionId,
          conversationId: input.conversationId,
          finishReason,
        });
        return { replied: false, reason: 'empty_reply' };
      }

      await this.#persistAndDeliver(input, body);
      this.deps.logger.info('channel.turn.replied', {
        connectionId: input.connectionId,
        conversationId: input.conversationId,
        chars: body.length,
        finishReason,
      });
      return { replied: true };
    } catch (err) {
      this.deps.logger.error('channel.turn.failed', {
        connectionId: input.connectionId,
        conversationId: input.conversationId,
        err: (err as Error).message,
      });
      const failure = channelTurnFailureMessage(err);
      this.#publishWorkStep(input, clientTurnId, {
        phase: 'fail',
        step: 'runtime',
        description: 'Channel reply failed',
        detail: failure,
      });
      await this.#persistAndDeliver(input, failure, { deliveryStatus: 'failed' });
      return { replied: true, reason: 'error_notified' };
    } finally {
      void this.deps.setTyping?.(input.connectionId, input.chatId, false).catch(() => {});
    }
  }

  /** Persist a reply as an agent message and deliver it to the channel. */
  async #persistAndDeliver(
    input: ChannelTurnInput,
    body: string,
    options: { deliveryStatus?: 'delivered' | 'failed' | 'mirrored' } = {},
  ): Promise<void> {
    this.deps.conversations.appendMirrored({
      workspaceId: input.workspaceId,
      conversationId: input.conversationId,
      sessionMessageId: `channel_reply_${randomUUID()}`,
      authorType: 'agent',
      body,
      deliveryStatus: options.deliveryStatus ?? 'delivered',
      metadata: {
        channel: input.kind,
        channelConnectionId: input.connectionId,
        channelReply: true,
        channelChatId: input.chatId,
        ...(input.threadId ? { threadId: input.threadId } : {}),
      },
    });
    await this.#safeDeliver(input, body);
  }

  #publishDelta(input: ChannelTurnInput, clientTurnId: string, delta: ChatDelta): void {
    if (!this.deps.bus) return;
    if (delta.type === 'thinking') {
      publishAgentWorkStep(this.deps.bus, {
        workspaceId: input.workspaceId,
        ambientId: input.ambientId,
        agentId: input.agentId,
        conversationId: input.conversationId,
        clientTurnId,
        phase: 'thinking',
        step: 'thinking',
        description: delta.delta,
      });
      return;
    }
    publishChatDeltaProgress(this.deps.bus, {
      workspaceId: input.workspaceId,
      ambientId: input.ambientId,
      agentId: input.agentId,
      conversationId: input.conversationId,
      clientTurnId,
    }, delta);
  }

  #publishWorkStep(
    input: ChannelTurnInput,
    clientTurnId: string | null,
    args: { phase: string; step: string; description: string; detail?: string },
  ): void {
    if (!this.deps.bus) return;
    publishAgentWorkStep(this.deps.bus, {
      workspaceId: input.workspaceId,
      ambientId: input.ambientId,
      agentId: input.agentId,
      conversationId: input.conversationId,
      ...(clientTurnId ? { clientTurnId } : {}),
      phase: args.phase,
      step: args.step,
      description: args.description,
      ...(args.detail ? { detail: args.detail } : {}),
    });
  }

  #takeFreshPending(key: string): PendingChannelConfirmation | undefined {
    const pending = this.#pending.get(key);
    if (!pending) return undefined;
    this.#pending.delete(key);
    if (pending.expiresAt <= Date.now()) return undefined;
    return pending;
  }

  /**
   * Record the sender against its cross-channel identity and return a one-line
   * recall summary for the channel context. Uses the most stable per-channel
   * handle: the sender id for Slack/Discord, the chat address for DM channels.
   */
  #recordIdentity(input: ChannelTurnInput): string | null {
    if (!this.deps.identity) return null;
    try {
      const handle = (input.kind === 'slack' || input.kind === 'discord')
        ? (input.from ?? input.chatId)
        : input.chatId;
      const { summary } = this.deps.identity.recordAndSummarize({
        workspaceId: input.workspaceId,
        channelKind: input.kind,
        handle,
        ...(input.from ? { displayName: input.from } : {}),
      });
      return summary;
    } catch (err) {
      this.deps.logger.warn('channel.identity.failed', { connectionId: input.connectionId, err: (err as Error).message });
      return null;
    }
  }

  #resolveAdapter(agentId: string, workspaceId?: string): AgentAdapter | undefined {
    const own = this.deps.adapters.get(agentId)?.adapter;
    if (own?.chat && own.capabilities?.().interactiveChat !== false) return own;
    const fallback = this.deps.fallbackAdapter ?? (() => ChatSessionExecutor.orchestratorAdapter(workspaceId));
    const runtime = fallback();
    if (runtime?.chat) return runtime;
    return undefined;
  }

  #buildHistory(input: ChannelTurnInput, excludeMessageIds: string[] = []): ChatMessage[] {
    const excluded = new Set(excludeMessageIds);
    const rows = this.deps.conversations.messages(input.conversationId, HISTORY_LIMIT);
    return rows
      .filter((row) => !excluded.has(row.id))
      .filter((row) => {
        const meta = (row.metadata ?? {}) as { channelInbound?: boolean; threadId?: string };
        // Keep operator/agent turns and channel-inbound human turns; drop bare
        // platform system notices so they don't pollute the model's context.
        if (row.authorType === 'system' && meta.channelInbound !== true) return false;
        // Subject isolation: when this turn is in a thread, only include messages
        // from the same thread (untagged agent/operator turns are always kept).
        if (input.threadId && meta.threadId && meta.threadId !== input.threadId) return false;
        return true;
      })
      .map((row) => {
        const meta = (row.metadata ?? {}) as { channelInbound?: boolean };
        const role: 'user' | 'assistant' =
          row.authorType === 'operator' || meta.channelInbound ? 'user' : 'assistant';
        return { role, content: row.body };
      });
  }

  async #safeDeliver(input: ChannelTurnInput, body: string): Promise<void> {
    try {
      await this.deps.deliver({ connectionId: input.connectionId, chatId: input.chatId, body });
    } catch (err) {
      this.deps.logger.warn('channel.turn.deliver_failed', {
        connectionId: input.connectionId,
        err: (err as Error).message,
      });
    }
  }
}

/**
 * Interpret a channel reply as a yes/no decision, or null when it's neither (so
 * the message is treated as a fresh request instead). Supports English +
 * Portuguese affirmatives/negatives and the common thumbs emoji.
 */
export function interpretConfirmation(text: string): boolean | null {
  const t = text.trim().toLowerCase().replace(/[.!]+$/, '');
  if (/^(y|yes|yeah|yep|yup|ok|okay|sure|confirm|confirmed|approve|approved|do it|go ahead|go|👍|✅|sim|pode|aprovar|confirmar)$/.test(t)) {
    return true;
  }
  if (/^(n|no|nope|nah|cancel|stop|reject|rejected|don'?t|do not|abort|não|nao|cancelar|rejeitar|👎|❌)$/.test(t)) {
    return false;
  }
  return null;
}

function channelTurnFailureMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  const detail = raw.trim();
  if (isCreditOrQuotaError(detail)) {
    return 'I could not answer because the connected model runtime is out of credits, quota, or billing access. Add credits or switch the Conversation runtime in Agentis settings, then send the message again.';
  }
  if (/cancell?ed|aborted/i.test(detail)) {
    return 'The channel turn was cancelled before the agent could finish. Send the message again when the runtime is available.';
  }
  if (/timeout|timed out|deadline/i.test(detail)) {
    return 'The agent runtime timed out before it could answer this channel message. The turn is visible in Agentis, and you can retry after the runtime is responsive.';
  }
  return detail
    ? `I could not complete this channel turn: ${detail}`
    : 'I could not complete this channel turn. Check the agent runtime in Agentis and try again.';
}

function isCreditOrQuotaError(message: string): boolean {
  return /insufficient[_\s]?quota/i.test(message)
    || /insufficient[_\s]?(funds|credit|credits|balance)/i.test(message)
    || /out of credits?/i.test(message)
    || /billing|payment required|quota exceeded|exceeded your current quota/i.test(message)
    || /\bno credits?\b/i.test(message);
}

function channelLabel(kind: string): string {
  if (!kind) return 'Channel';
  return `${kind.slice(0, 1).toUpperCase()}${kind.slice(1)}`;
}
