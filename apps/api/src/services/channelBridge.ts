/**
 * ChannelBridge — Batch 4 / V1-SPEC §0.3 #24, §11.
 *
 * One service per workspace process; owns the registry of `ChannelAdapter`
 * implementations keyed by `ChannelKind`. Responsibilities:
 *
 *   1. CRUD over `channel_connections` rows (via routes).
 *   2. Inbound: verify webhook signature → parse → idempotency check
 *      against `channel_deliveries.external_id` → ConversationStore.appendMirrored.
 *   3. Outbound: subscribed to `CONVERSATION_MESSAGE_SENT`. When the
 *      message belongs to an agent that has an active channel connection,
 *      forward to the channel via `adapter.send`. Failures are logged and
 *      the connection is flipped to `status='error'` with `lastError`.
 *
 * Token storage: `tokenEncrypted` is AES-256-GCM ciphertext via
 * CredentialVault. Plaintext NEVER leaves the bridge — neither REST routes
 * nor bus envelopes ever expose it.
 */

import { randomBytes, randomUUID } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import { AgentisError, REALTIME_EVENTS, REALTIME_ROOMS } from '@agentis/core';
import type { CredentialVault } from './credentialVault.js';
import type { ConversationStore } from './conversationStore.js';
import type { EventBus } from '../event-bus.js';
import type { Logger } from '../logger.js';
import type { ChannelAdapter, ChannelKind } from '../adapters/channels/types.js';
import type { ChannelTurnDispatcher } from './channelTurnDispatcher.js';

export interface ChannelBridgeDeps {
  db: AgentisSqliteDb;
  vault: CredentialVault;
  conversations: ConversationStore;
  bus: EventBus;
  logger: Logger;
  /** Optional override (tests). Default: TelegramChannelAdapter + DiscordChannelAdapter. */
  adapters?: Partial<Record<ChannelKind, ChannelAdapter>>;
}

export interface CreateConnectionInput {
  workspaceId: string;
  ambientId: string | null;
  userId: string;
  agentId: string;
  kind: ChannelKind;
  name: string;
  /** Plaintext bot token. Encrypted on the way in. Omitted for QR-auth kinds (WhatsApp). */
  token?: string;
  /** Optional outbound chat id default (e.g. Telegram numeric id). */
  defaultChatId?: string;
  /** Persistent transport: Telegram 'polling' or Discord 'gateway' (no public webhook). */
  transport?: 'polling' | 'webhook' | 'gateway';
}

export interface PublicConnection {
  id: string;
  workspaceId: string;
  ambientId: string | null;
  agentId: string;
  kind: ChannelKind;
  name: string;
  status: string;
  defaultChatId: string | null;
  lastEventAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * A persistent, stateful channel transport (WhatsApp socket, Telegram long-poll)
 * owned by the ChannelConnectionSupervisor. Unlike the webhook `ChannelAdapter`,
 * sends route through a live connection keyed by connectionId, not a token.
 */
export interface PersistentChannelRef {
  id: string;
  kind: string;
  settings?: unknown;
}

export interface PersistentChannelTransport {
  /** True when outbound for this connection routes through a live session. */
  handles(conn: PersistentChannelRef): boolean;
  /** True when creating this kind needs no token (QR auth, e.g. WhatsApp). */
  requiresNoToken(kind: string): boolean;
  /** Post-create hook — start polling sessions (no-op for QR-login kinds). */
  onCreated?(conn: PersistentChannelRef): void;
  send(connectionId: string, chatId: string, body: string): Promise<void>;
  /** Show/clear the typing indicator (best-effort). */
  setTyping?(connectionId: string, chatId: string, on: boolean): Promise<void>;
  /** Tear down the live session when a connection is deleted. */
  stop?(connectionId: string): Promise<void>;
}

export class ChannelBridge {
  readonly #adapters: Map<ChannelKind, ChannelAdapter>;
  #unsub: (() => void) | null = null;
  #turnDispatcher: ChannelTurnDispatcher | null = null;
  #persistent: PersistentChannelTransport | null = null;

  constructor(private readonly deps: ChannelBridgeDeps) {
    this.#adapters = new Map();
    if (deps.adapters?.telegram) this.#adapters.set('telegram', deps.adapters.telegram);
    if (deps.adapters?.discord) this.#adapters.set('discord', deps.adapters.discord);
    if (deps.adapters?.slack) this.#adapters.set('slack', deps.adapters.slack);
  }

  registerAdapter(adapter: ChannelAdapter) {
    this.#adapters.set(adapter.kind, adapter);
  }

  /**
   * Wire the orchestrator turn dispatcher. Injected after the chat executor is
   * configured (bootstrap), so inbound channel messages run a real turn instead
   * of being mirrored inertly.
   */
  setTurnDispatcher(dispatcher: ChannelTurnDispatcher) {
    this.#turnDispatcher = dispatcher;
  }

  /** Wire the persistent-transport supervisor (WhatsApp etc.). */
  setPersistentTransport(transport: PersistentChannelTransport) {
    this.#persistent = transport;
  }

  /**
   * Show/clear the typing indicator for a connection's chat. Best-effort — only
   * persistent transports with a live session support it; webhook channels no-op.
   */
  async setTyping(connectionId: string, chatId: string, on: boolean): Promise<void> {
    if (!this.#persistent?.setTyping) return;
    const row = this.deps.db
      .select({ id: schema.channelConnections.id, kind: schema.channelConnections.kind, settings: schema.channelConnections.settings })
      .from(schema.channelConnections)
      .where(eq(schema.channelConnections.id, connectionId))
      .get();
    if (!row || !this.#persistent.handles({ id: row.id, kind: row.kind, settings: row.settings })) return;
    try {
      await this.#persistent.setTyping(connectionId, chatId, on);
    } catch {
      /* best-effort */
    }
  }

  /**
   * Deliver an outbound message to a single connection's channel. Used by the
   * turn dispatcher to send the orchestrator's reply back to the origin chat.
   * Persistent kinds (WhatsApp) route through the live socket; webhook kinds
   * (Telegram/Discord/Slack) send via the stateless adapter + decrypted token.
   */
  async deliverToConnection(args: { connectionId: string; chatId: string; body: string }): Promise<void> {
    const row = this.deps.db
      .select()
      .from(schema.channelConnections)
      .where(eq(schema.channelConnections.id, args.connectionId))
      .get();
    if (!row) throw new AgentisError('RESOURCE_NOT_FOUND', `channel connection ${args.connectionId} not found`);
    try {
      if (this.#persistent?.handles({ id: row.id, kind: row.kind, settings: row.settings })) {
        await this.#persistent.send(row.id, args.chatId, args.body);
      } else {
        const adapter = this.#requireAdapter(row.kind as ChannelKind);
        const token = this.deps.vault.decrypt(row.tokenEncrypted);
        await adapter.send({ token, chatId: args.chatId, body: args.body });
      }
      this.#markActive(row.id);
      this.deps.bus.publish(
        REALTIME_ROOMS.workspace(row.workspaceId),
        REALTIME_EVENTS.CHANNEL_MESSAGE_SENT,
        { connectionId: row.id, kind: row.kind, agentId: row.agentId },
      );
    } catch (err) {
      const msg = (err as Error).message ?? 'send failed';
      this.#markError(row.id, msg);
      throw err;
    }
  }

  hasAdapter(kind: ChannelKind): boolean {
    return this.#adapters.has(kind);
  }

  /** Subscribe to outbound conversation events for forwarding. Idempotent. */
  bindOutbound() {
    if (this.#unsub) return;
    this.#unsub = this.deps.bus.subscribe((msg) => {
      if (msg.envelope.event !== REALTIME_EVENTS.CONVERSATION_MESSAGE_SENT) return;
      const payload = msg.envelope.payload as {
        message?: { authorType?: string; body?: string };
        agentId?: string;
        conversationId?: string;
      };
      if (!payload?.agentId || payload.message?.authorType !== 'operator') return;
      void this.#forwardToChannels(payload.agentId, payload.message.body ?? '');
    });
  }

  shutdown() {
    if (this.#unsub) {
      this.#unsub();
      this.#unsub = null;
    }
  }

  // ── CRUD ────────────────────────────────────────────────

  list(workspaceId: string): PublicConnection[] {
    const rows = this.deps.db
      .select()
      .from(schema.channelConnections)
      .where(eq(schema.channelConnections.workspaceId, workspaceId))
      .orderBy(desc(schema.channelConnections.createdAt))
      .all();
    return rows.map((r) => this.#toPublic(r));
  }

  get(workspaceId: string, id: string): PublicConnection {
    const row = this.deps.db
      .select()
      .from(schema.channelConnections)
      .where(eq(schema.channelConnections.id, id))
      .get();
    if (!row || row.workspaceId !== workspaceId) {
      throw new AgentisError('RESOURCE_NOT_FOUND', `channel connection ${id} not found`);
    }
    return this.#toPublic(row);
  }

  create(input: CreateConnectionInput): { connection: PublicConnection; webhookSecret: string } {
    const id = randomUUID();
    const settings: Record<string, unknown> = {};
    if (input.defaultChatId) settings.defaultChatId = input.defaultChatId;
    if (input.transport) settings.transport = input.transport;
    const ref = { id, kind: input.kind, settings };
    const noToken = this.#persistent?.requiresNoToken(input.kind) ?? false;
    const persistent = this.#persistent?.handles(ref) ?? false;
    // A connection must be deliverable: either via a live persistent session, a
    // registered webhook adapter, or QR auth (which needs no token at all).
    if (!noToken && !persistent && !this.#adapters.has(input.kind)) {
      throw new AgentisError(
        'CHANNEL_KIND_UNAVAILABLE',
        `channel adapter for kind '${input.kind}' is not registered`,
      );
    }
    // QR-auth kinds (WhatsApp) link via QR, not a bot token; everything else
    // (including Telegram polling, which uses the bot token) requires one.
    if (!noToken && !input.token) {
      throw new AgentisError('VALIDATION_FAILED', `channel kind '${input.kind}' requires a token`);
    }
    const agent = this.deps.db
      .select()
      .from(schema.agents)
      .where(eq(schema.agents.id, input.agentId))
      .get();
    if (!agent || agent.workspaceId !== input.workspaceId) {
      throw new AgentisError('RESOURCE_NOT_FOUND', `agent ${input.agentId} not found`);
    }
    const webhookSecret = randomBytes(24).toString('hex');
    // tokenEncrypted is NOT NULL; QR-auth kinds store an encrypted marker.
    const tokenPlain = input.token ?? `persistent:${input.kind}:${id}`;
    this.deps.db
      .insert(schema.channelConnections)
      .values({
        id,
        workspaceId: input.workspaceId,
        ambientId: input.ambientId,
        userId: input.userId,
        agentId: input.agentId,
        kind: input.kind,
        name: input.name,
        tokenEncrypted: this.deps.vault.encrypt(tokenPlain),
        webhookSecret,
        settings,
        // Persistent connections aren't usable until the session is live.
        status: persistent ? 'connecting' : 'active',
        lastEventAt: null,
        lastError: null,
      })
      .run();
    // Start polling sessions immediately (WhatsApp links via explicit QR login).
    this.#persistent?.onCreated?.(ref);
    const connection = this.get(input.workspaceId, id);
    return { connection, webhookSecret };
  }

  delete(workspaceId: string, id: string): void {
    const existing = this.get(workspaceId, id); // 404s if not found
    const row = this.deps.db
      .select({ settings: schema.channelConnections.settings })
      .from(schema.channelConnections)
      .where(eq(schema.channelConnections.id, existing.id))
      .get();
    if (this.#persistent?.handles({ id: existing.id, kind: existing.kind, settings: row?.settings })) {
      void this.#persistent.stop?.(existing.id);
    }
    this.deps.db
      .delete(schema.channelConnections)
      .where(eq(schema.channelConnections.id, existing.id))
      .run();
  }

  /**
   * Send a one-off ping via the channel adapter to confirm credentials.
   * Throws on transport failure; caller surfaces the AgentisError.
   */
  async test(args: { workspaceId: string; id: string; chatId?: string; body?: string }) {
    const row = this.#row(args.workspaceId, args.id);
    const adapter = this.#requireAdapter(row.kind as ChannelKind);
    const settings = (row.settings ?? {}) as { defaultChatId?: string };
    const chatId = args.chatId ?? settings.defaultChatId;
    if (!chatId) {
      throw new AgentisError(
        'VALIDATION_FAILED',
        'channel test requires chatId (no defaultChatId on connection)',
      );
    }
    const token = this.deps.vault.decrypt(row.tokenEncrypted);
    await adapter.send({ token, chatId, body: args.body ?? 'Agentis test message' });
    this.#markActive(row.id);
  }

  // ── Inbound webhook ────────────────────────────────────

  /**
   * Handle a webhook delivery for a connection. Returns `{ accepted, idempotent }`.
   * Throws AgentisError(`UNAUTHENTICATED`) on signature failure.
   */
  async handleInbound(args: {
    connectionId: string;
    headers: Record<string, string | undefined>;
    rawBody: string;
  }): Promise<{ accepted: boolean; idempotent: boolean; messageId?: string }> {
    const row = this.deps.db
      .select()
      .from(schema.channelConnections)
      .where(eq(schema.channelConnections.id, args.connectionId))
      .get();
    if (!row) {
      throw new AgentisError('RESOURCE_NOT_FOUND', `channel connection ${args.connectionId} not found`);
    }
    if (row.status !== 'active') {
      throw new AgentisError('CHANNEL_CONNECTION_INACTIVE', `connection ${row.id} is not active`);
    }
    const adapter = this.#requireAdapter(row.kind as ChannelKind);
    const ok = adapter.verify({ headers: args.headers, rawBody: args.rawBody, secret: row.webhookSecret });
    if (!ok) {
      this.#markError(row.id, 'webhook signature verification failed');
      throw new AgentisError('CHANNEL_SIGNATURE_INVALID', 'channel webhook signature verification failed');
    }
    const parsed = adapter.parseInbound({ rawBody: args.rawBody, headers: args.headers });
    if (!parsed) {
      this.#markActive(row.id);
      return { accepted: false, idempotent: false };
    }

    // Idempotency: same externalId already processed → return last result.
    const dup = this.deps.db
      .select()
      .from(schema.channelDeliveries)
      .where(and(
        eq(schema.channelDeliveries.connectionId, row.id),
        eq(schema.channelDeliveries.externalId, parsed.externalId),
      ))
      .get();
    if (dup) {
      const result: { accepted: boolean; idempotent: boolean; messageId?: string } = {
        accepted: true,
        idempotent: true,
      };
      if (dup.conversationMessageId) result.messageId = dup.conversationMessageId;
      return result;
    }

    const conversation = this.deps.conversations.getOrCreateByAgent({
      workspaceId: row.workspaceId,
      ambientId: row.ambientId,
      userId: row.userId,
      agentId: row.agentId,
    });
    const fromTag = parsed.from ? `[${parsed.from}] ` : '';
    const message = this.deps.conversations.appendMirrored({
      workspaceId: row.workspaceId,
      conversationId: conversation.id,
      sessionMessageId: parsed.externalId,
      authorType: 'system',
      body: `${fromTag}${parsed.body}`,
      metadata: {
        channel: row.kind,
        channelConnectionId: row.id,
        channelInbound: true,
        ...(parsed.threadId ? { threadId: parsed.threadId } : {}),
        ...(parsed.from ? { from: parsed.from } : {}),
      },
    });
    this.deps.db
      .insert(schema.channelDeliveries)
      .values({
        id: randomUUID(),
        connectionId: row.id,
        workspaceId: row.workspaceId,
        externalId: parsed.externalId,
        conversationMessageId: message.id,
      })
      .run();
    this.#markActive(row.id);
    this.deps.bus.publish(REALTIME_ROOMS.workspace(row.workspaceId), REALTIME_EVENTS.CHANNEL_MESSAGE_RECEIVED, {
      connectionId: row.id,
      kind: row.kind,
      agentId: row.agentId,
      chatId: parsed.chatId,
      messageId: message.id,
    });

    // Run a real orchestrator turn for this message and deliver the reply back
    // to the channel. Fire-and-forget so the webhook gets its fast ack while the
    // (potentially slow) turn runs in the background.
    if (this.#turnDispatcher) {
      void this.#turnDispatcher.dispatch({
        workspaceId: row.workspaceId,
        ambientId: row.ambientId,
        userId: row.userId,
        agentId: row.agentId,
        conversationId: conversation.id,
        connectionId: row.id,
        kind: row.kind,
        chatId: parsed.chatId,
        text: parsed.body,
        ...(parsed.threadId ? { threadId: parsed.threadId } : {}),
        ...(parsed.from ? { from: parsed.from } : {}),
        inboundMessageId: message.id,
      });
    }

    return { accepted: true, idempotent: false, messageId: message.id };
  }

  // ── Outbound forwarding ─────────────────────────────────

  async #forwardToChannels(agentId: string, body: string) {
    if (!body) return;
    const conns = this.deps.db
      .select()
      .from(schema.channelConnections)
      .where(
        and(
          eq(schema.channelConnections.agentId, agentId),
          eq(schema.channelConnections.status, 'active'),
        ),
      )
      .all();
    for (const conn of conns) {
      const adapter = this.#adapters.get(conn.kind as ChannelKind);
      if (!adapter) continue;
      const settings = (conn.settings ?? {}) as { defaultChatId?: string };
      if (!settings.defaultChatId) continue; // need a destination
      try {
        const token = this.deps.vault.decrypt(conn.tokenEncrypted);
        await adapter.send({ token, chatId: settings.defaultChatId, body });
        this.#markActive(conn.id);
        this.deps.bus.publish(
          REALTIME_ROOMS.workspace(conn.workspaceId),
          REALTIME_EVENTS.CHANNEL_MESSAGE_SENT,
          { connectionId: conn.id, kind: conn.kind, agentId },
        );
      } catch (err) {
        const msg = (err as Error).message ?? 'send failed';
        this.deps.logger.warn('channel.forward_failed', {
          connectionId: conn.id,
          kind: conn.kind,
          err: msg,
        });
        this.#markError(conn.id, msg);
      }
    }
  }

  // ── helpers ─────────────────────────────────────────────

  #row(workspaceId: string, id: string) {
    const row = this.deps.db
      .select()
      .from(schema.channelConnections)
      .where(eq(schema.channelConnections.id, id))
      .get();
    if (!row || row.workspaceId !== workspaceId) {
      throw new AgentisError('RESOURCE_NOT_FOUND', `channel connection ${id} not found`);
    }
    return row;
  }

  #requireAdapter(kind: ChannelKind): ChannelAdapter {
    const adapter = this.#adapters.get(kind);
    if (!adapter) {
      throw new AgentisError(
        'CHANNEL_KIND_UNAVAILABLE',
        `channel adapter for kind '${kind}' is not registered`,
      );
    }
    return adapter;
  }

  #markActive(id: string) {
    const now = new Date().toISOString();
    this.deps.db
      .update(schema.channelConnections)
      .set({ status: 'active', lastEventAt: now, lastError: null, updatedAt: now })
      .where(eq(schema.channelConnections.id, id))
      .run();
  }

  #markError(id: string, message: string) {
    const now = new Date().toISOString();
    const row = this.deps.db
      .select({ workspaceId: schema.channelConnections.workspaceId })
      .from(schema.channelConnections)
      .where(eq(schema.channelConnections.id, id))
      .get();
    this.deps.db
      .update(schema.channelConnections)
      .set({ status: 'error', lastError: message.slice(0, 500), updatedAt: now })
      .where(eq(schema.channelConnections.id, id))
      .run();
    if (row) {
      this.deps.bus.publish(
        REALTIME_ROOMS.workspace(row.workspaceId),
        REALTIME_EVENTS.CHANNEL_CONNECTION_STATUS,
        { connectionId: id, status: 'error', error: message },
      );
    }
  }

  #toPublic(row: typeof schema.channelConnections.$inferSelect): PublicConnection {
    const settings = (row.settings ?? {}) as { defaultChatId?: string };
    return {
      id: row.id,
      workspaceId: row.workspaceId,
      ambientId: row.ambientId,
      agentId: row.agentId,
      kind: row.kind as ChannelKind,
      name: row.name,
      status: row.status,
      defaultChatId: settings.defaultChatId ?? null,
      lastEventAt: row.lastEventAt,
      lastError: row.lastError,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}
