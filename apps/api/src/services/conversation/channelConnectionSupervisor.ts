/**
 * ChannelConnectionSupervisor — owns the live, persistent channel connections
 * (WhatsApp sockets; Telegram long-poll) that don't fit the stateless webhook
 * `ChannelAdapter.send(token,...)` contract.
 *
 * Responsibilities (OMNICHANNEL-ORCHESTRATOR-10X §3.4):
 *   - Boot a live session per active persistent connection at startup, and on
 *     create (Telegram polling) / login (WhatsApp QR).
 *   - WhatsApp auth persists on disk under `${dataDir}/channels/whatsapp/<id>/`
 *     (baileys multi-file auth); Telegram polling uses the stored bot token.
 *   - Route inbound session messages through the same `ChannelTurnDispatcher`
 *     the webhook path uses — one orchestrator-turn code path for every channel.
 *   - Provide `send(connectionId, chatId, body)` so `ChannelBridge.deliverToConnection`
 *     can deliver the orchestrator's reply over the live session.
 *   - Surface login QR + status for the connect UI, mirror status into the row.
 *
 * Persistent vs webhook is decided per connection: WhatsApp is always persistent;
 * Telegram is persistent when it resolves to long polling — explicitly, or by
 * default when no public URL is configured (see `resolveTelegramTransport`); the
 * webhook adapter handles Telegram only when a public URL makes a webhook viable.
 */

import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import { REALTIME_EVENTS, REALTIME_ROOMS } from '@agentis/core';
import type { EventBus } from '../../event-bus.js';
import type { Logger } from '../../logger.js';
import type { CredentialVault } from '../credentialVault.js';
import type { ConversationStore } from './conversationStore.js';
import type { ChannelTurnDispatcher } from './channelTurnDispatcher.js';
import { WhatsAppSession, type WhatsAppObservedOutbound } from '../../adapters/channels/whatsappSession.js';
import { TelegramSession } from '../../adapters/channels/telegramSession.js';
import { resolveTelegramTransport } from '../../adapters/channels/telegram.js';
import { DiscordSession } from '../../adapters/channels/discordSession.js';
import { useVaultAuthState, clearVaultAuthState } from '../../adapters/channels/whatsappVaultAuthState.js';
import type { ChannelDeliveryReceipt, ChannelHealth, ChannelHealthCheck, ChannelStatus, OutboundAttachment } from '../../adapters/channels/types.js';
import { chunkText, sleep, typingDelayMs, type HumanizeConfig } from './humanize.js';

type LiveSession = WhatsAppSession | TelegramSession | DiscordSession;

/** Collapse a burst of per-message receipts into one, preserving every provider id. */
function aggregateReceipts(receipts: ChannelDeliveryReceipt[]): ChannelDeliveryReceipt {
  const first = receipts[0]!;
  return receipts.length > 1
    ? { ...first, providerMessageIds: receipts.map((r) => r.providerMessageId) }
    : first;
}

interface PersistentRef {
  id: string;
  kind: string;
  settings?: unknown;
}

export interface ChannelConnectionSupervisorDeps {
  db: AgentisSqliteDb;
  bus: EventBus;
  logger: Logger;
  vault: CredentialVault;
  conversations: ConversationStore;
  /** Root data dir; WhatsApp auth state is stored beneath it. */
  dataDir: string;
  /** Is a public webhook URL configured? Telegram defaults to long polling when not. */
  hasPublicWebhookUrl?: () => boolean;
  dispatcher?: ChannelTurnDispatcher;
  /** Optional voice-note transcription for inbound audio (WhatsApp). */
  transcribeAudio?: (bytes: Buffer, mimeType: string) => Promise<string | null>;
  /** Optional image understanding for inbound images (WhatsApp). */
  describeImage?: (bytes: Buffer, mimeType: string, caption?: string) => Promise<string | null>;
  /** Optional document text extraction for inbound documents (WhatsApp). */
  extractDocument?: (bytes: Buffer, mimeType: string, fileName?: string) => Promise<string | null>;
}

export interface LoginState {
  status: string;
  qr?: string;
  qrDataUrl?: string;
  selfId?: string;
}

function discordIsGateway(settings: unknown): boolean {
  return Boolean(settings && typeof settings === 'object' && (settings as { transport?: string }).transport === 'gateway');
}

function whatsappIsQrLocal(settings: unknown): boolean {
  return !settings || typeof settings !== 'object' || (settings as { mode?: string }).mode !== 'cloud';
}

export class ChannelConnectionSupervisor {
  readonly #sessions = new Map<string, LiveSession>();
  #dispatcher: ChannelTurnDispatcher | undefined;

  constructor(private readonly deps: ChannelConnectionSupervisorDeps) {
    this.#dispatcher = deps.dispatcher;
  }

  setDispatcher(dispatcher: ChannelTurnDispatcher) {
    this.#dispatcher = dispatcher;
  }

  /** Is a public webhook URL configured? Drives the Telegram polling default. */
  /** Agent a workspace-owned connection's inbound routes to: orchestrator, else
   *  the first agent, else null. Mirrors ChannelBridge.#resolveInboundAgentId. */
  #resolveInboundAgentId(workspaceId: string): string | null {
    const orchestrator = this.deps.db
      .select({ id: schema.agents.id })
      .from(schema.agents)
      .where(and(eq(schema.agents.workspaceId, workspaceId), eq(schema.agents.role, 'orchestrator')))
      .get();
    if (orchestrator) return orchestrator.id;
    const any = this.deps.db
      .select({ id: schema.agents.id })
      .from(schema.agents)
      .where(eq(schema.agents.workspaceId, workspaceId))
      .get();
    return any?.id ?? null;
  }

  #hasPublicWebhookUrl(): boolean {
    return this.deps.hasPublicWebhookUrl ? this.deps.hasPublicWebhookUrl() : Boolean(process.env.AGENTIS_PUBLIC_URL);
  }

  /** Telegram runs here (long polling) when it resolves to polling — explicitly, or
   *  by default on a local install with no public URL. */
  #telegramIsPolling(settings: unknown): boolean {
    const explicit = settings && typeof settings === 'object' ? (settings as { transport?: string }).transport : undefined;
    return resolveTelegramTransport({ explicit, hasPublicUrl: this.#hasPublicWebhookUrl() }) === 'polling';
  }

  /** Does outbound for this connection route through a live session? */
  handles(conn: PersistentRef): boolean {
    if (conn.kind === 'whatsapp') return whatsappIsQrLocal(conn.settings);
    if (conn.kind === 'telegram') return this.#telegramIsPolling(conn.settings);
    if (conn.kind === 'discord') return discordIsGateway(conn.settings);
    return false;
  }

  /** Kinds that authenticate without a token (QR). */
  requiresNoToken(kind: string, settings?: unknown): boolean {
    return kind === 'whatsapp' && whatsappIsQrLocal(settings);
  }

  /** Post-create hook: start polling sessions immediately (no-op for QR kinds). */
  onCreated(conn: PersistentRef): void {
    // Token-authenticated live sessions (Telegram polling, Discord gateway) can
    // start immediately. WhatsApp starts via explicit QR login (startLogin).
    const startsOnCreate = (conn.kind === 'telegram' && this.#telegramIsPolling(conn.settings))
      || (conn.kind === 'discord' && discordIsGateway(conn.settings));
    if (startsOnCreate) {
      void this.ensureSession(conn.id).start().catch((err) => {
        this.deps.logger.warn('channel.supervisor.create_start_failed', { connectionId: conn.id, err: (err as Error).message });
      });
    }
  }

  /**
   * Boot every already-active persistent connection on startup so a restart
   * restores live sessions without operator action.
   */
  async startAll(): Promise<void> {
    const rows = this.deps.db.select().from(schema.channelConnections).all();
    for (const row of rows) {
      if (row.status === 'paused') continue;
      if (!this.handles({ id: row.id, kind: row.kind, settings: row.settings })) continue;
      try {
        await this.ensureSession(row.id).start();
      } catch (err) {
        this.deps.logger.warn('channel.supervisor.boot_failed', { connectionId: row.id, err: (err as Error).message });
      }
    }
  }

  /** Start (or reuse) a WhatsApp login and return the current QR/status. */
  async startLogin(connectionId: string): Promise<LoginState> {
    const session = this.ensureSession(connectionId);
    // A definitive logged_out/error means the previously registered creds are
    // dead (device unlinked phone-side, or the session errored out). Reusing
    // them makes baileys silently retry the dead session instead of emitting a
    // fresh QR — "Relink QR" would spin forever. Clear them first so the next
    // connect attempt pairs from scratch and actually issues a new QR.
    if (session instanceof WhatsAppSession && (session.status === 'logged_out' || session.status === 'error')) {
      clearVaultAuthState({ db: this.deps.db, connectionId });
    }
    await session.start();
    return this.loginState(connectionId);
  }

  loginState(connectionId: string): LoginState {
    const session = this.#sessions.get(connectionId);
    if (!session) return { status: 'idle' };
    if (session instanceof WhatsAppSession) {
      return {
        status: session.status,
        ...(session.qr ? { qr: session.qr } : {}),
        ...(session.qrDataUrl ? { qrDataUrl: session.qrDataUrl } : {}),
        ...(session.selfId ? { selfId: session.selfId } : {}),
      };
    }
    return { status: session.status };
  }

  status(connectionId: string): LoginState | null {
    const session = this.#sessions.get(connectionId);
    if (!session) return null;
    return this.loginState(connectionId);
  }

  /**
   * Deliver an outbound message over the live session. When attachments are
   * present, each is sent as its own native media message (the first carries the
   * body as its caption), mirroring the WhatsApp Cloud + Telegram webhook paths.
   * A session that cannot carry media still delivers the text so nothing is lost.
   *
   * When a human-like `humanize` config is supplied, long text is split into a
   * natural burst and each message is preceded by a jittered "typing…" indicator
   * (§6). Presence is best-effort — a session without `setTyping` still delivers.
   */
  async send(
    connectionId: string,
    chatId: string,
    body: string,
    attachments?: OutboundAttachment[],
    humanize?: HumanizeConfig,
  ): Promise<ChannelDeliveryReceipt> {
    const session = this.#sessions.get(connectionId);
    if (!session) throw new Error(`no live session for connection ${connectionId}`);
    const media = attachments ?? [];
    const cfg = humanize?.enabled ? humanize : undefined;
    const typer = session as { setTyping?: (chatId: string, on: boolean) => Promise<void> };
    const canType = Boolean(cfg && typeof typer.setTyping === 'function');

    // Text-only: optionally chunk into a burst, typing before each piece.
    if (media.length === 0) {
      if (!cfg) return session.sendText(chatId, body);
      const chunks = chunkText(body, cfg);
      if (chunks.length <= 1) {
        await this.#typingPause(typer, chatId, body.length, cfg, canType);
        return session.sendText(chatId, chunks[0] ?? body);
      }
      const receipts: ChannelDeliveryReceipt[] = [];
      for (let i = 0; i < chunks.length; i += 1) {
        await this.#typingPause(typer, chatId, chunks[i]!.length, cfg, canType);
        receipts.push(await session.sendText(chatId, chunks[i]!));
        if (i < chunks.length - 1) await sleep(cfg.interMessageMs);
      }
      return aggregateReceipts(receipts);
    }

    const mediaSession = session as { sendMedia?: (chatId: string, attachment: OutboundAttachment, caption?: string) => Promise<ChannelDeliveryReceipt> };
    if (typeof mediaSession.sendMedia !== 'function') {
      // Session type has no media transport yet (e.g. Discord gateway). Deliver
      // the text rather than silently dropping the whole message.
      this.deps.logger.warn('channel.session_media_unsupported', { connectionId, kind: session.constructor.name, attachments: media.length });
      return session.sendText(chatId, body);
    }

    const receipts: ChannelDeliveryReceipt[] = [];
    for (let i = 0; i < media.length; i += 1) {
      const caption = i === 0 && body.trim() ? body : undefined;
      if (cfg) await this.#typingPause(typer, chatId, (caption ?? '').length + 120, cfg, canType);
      receipts.push(await mediaSession.sendMedia(chatId, media[i]!, caption));
      if (cfg && i < media.length - 1) await sleep(cfg.interMessageMs);
    }
    return aggregateReceipts(receipts);
  }

  /**
   * Show a "typing…" indicator for a jittered, length-scaled duration before a
   * message. Re-emits every ~8s because WhatsApp auto-clears composing at ~10s,
   * so a long compose stays visibly "typing" the whole time.
   */
  async #typingPause(
    typer: { setTyping?: (chatId: string, on: boolean) => Promise<void> },
    chatId: string,
    textLen: number,
    cfg: HumanizeConfig,
    canType: boolean,
  ): Promise<void> {
    const delay = typingDelayMs(textLen, cfg);
    if (delay <= 0) return;
    if (!canType || !typer.setTyping) { await sleep(delay); return; }
    const REEMIT_MS = 8_000;
    let waited = 0;
    while (waited < delay) {
      try { await typer.setTyping(chatId, true); } catch { /* presence is best-effort */ }
      const step = Math.min(REEMIT_MS, delay - waited);
      await sleep(step);
      waited += step;
    }
  }

  async outboundHealth(connectionId: string): Promise<ChannelHealthCheck | null> {
    const session = this.#sessions.get(connectionId);
    return session instanceof WhatsAppSession ? session.outboundHealthCheck() : null;
  }

  /** Add/clear a reaction on a prior message over the live session (best-effort). */
  async react(connectionId: string, chatId: string, targetMessageId: string, emoji: string): Promise<void> {
    const session = this.#sessions.get(connectionId);
    const reactor = session as { sendReaction?: (chatId: string, targetMessageId: string, emoji: string) => Promise<void> };
    if (typeof reactor.sendReaction === 'function') {
      await reactor.sendReaction(chatId, targetMessageId, emoji);
    }
  }

  async stop(connectionId: string): Promise<void> {
    const session = this.#sessions.get(connectionId);
    if (session) {
      await session.stop();
      this.#sessions.delete(connectionId);
    }
  }

  /** Show/clear the typing indicator on a live session (best-effort, no-op otherwise). */
  async setTyping(connectionId: string, chatId: string, on: boolean): Promise<void> {
    const session = this.#sessions.get(connectionId);
    if (!session) return;
    try {
      await session.setTyping(chatId, on);
    } catch {
      /* best-effort */
    }
  }

  async shutdown(): Promise<void> {
    await Promise.all([...this.#sessions.values()].map((s) => s.stop().catch(() => {})));
    this.#sessions.clear();
  }


  ensureSession(connectionId: string): LiveSession {
    const existing = this.#sessions.get(connectionId);
    if (existing) return existing;
    const row = this.deps.db
      .select()
      .from(schema.channelConnections)
      .where(eq(schema.channelConnections.id, connectionId))
      .get();
    if (!row) throw new Error(`channel connection ${connectionId} not found`);

    let session: LiveSession;
    if (row.kind === 'telegram') {
      const token = this.deps.vault.decrypt(row.tokenEncrypted);
      session = new TelegramSession({
        connectionId,
        token,
        logger: this.deps.logger,
        onInbound: (msg) => this.#onInbound(connectionId, msg),
        onStateChange: (state) => this.#onStateChange(connectionId, state),
      });
    } else if (row.kind === 'discord') {
      const token = this.deps.vault.decrypt(row.tokenEncrypted);
      session = new DiscordSession({
        connectionId,
        token,
        logger: this.deps.logger,
        onInbound: (msg) => this.#onInbound(connectionId, msg),
        onStateChange: (state) => this.#onStateChange(connectionId, state),
      });
    } else {
      const authDir = path.join(this.deps.dataDir, 'channels', 'whatsapp', connectionId);
      session = new WhatsAppSession({
        connectionId,
        authDir,
        logger: this.deps.logger,
        onInbound: (msg) => this.#onInbound(connectionId, msg),
        onOutboundObserved: (msg) => this.observeOutbound(connectionId, msg),
        onStateChange: (state) => this.#onStateChange(connectionId, state),
        onDeliveryUpdate: (update) => this.#onDeliveryUpdate(connectionId, update),
        // Persist creds/keys vault-encrypted in the DB, not plaintext on disk.
        loadAuthState: () => useVaultAuthState({ db: this.deps.db, vault: this.deps.vault, connectionId }),
        ...(this.deps.transcribeAudio ? { transcribeAudio: this.deps.transcribeAudio } : {}),
        ...(this.deps.describeImage ? { describeImage: this.deps.describeImage } : {}),
        ...(this.deps.extractDocument ? { extractDocument: this.deps.extractDocument } : {}),
      });
    }
    this.#sessions.set(connectionId, session);
    return session;
  }

  #onInbound(connectionId: string, msg: { externalId: string; chatId: string; body: string; from?: string; threadId?: string }): void {
    const row = this.deps.db
      .select()
      .from(schema.channelConnections)
      .where(eq(schema.channelConnections.id, connectionId))
      .get();
    if (!row) return;

    // Idempotency against re-delivered messages.
    const dup = this.deps.db
      .select({ id: schema.channelDeliveries.id })
      .from(schema.channelDeliveries)
      .where(eq(schema.channelDeliveries.externalId, msg.externalId))
      .get();
    if (dup) return;

    const currentSettings = row.settings && typeof row.settings === 'object' && !Array.isArray(row.settings)
      ? row.settings as Record<string, unknown>
      : {};
    if (!currentSettings.defaultChatId) {
      this.deps.db
        .update(schema.channelConnections)
        .set({
          settings: { ...currentSettings, defaultChatId: msg.chatId },
          updatedAt: new Date().toISOString(),
        })
        .where(eq(schema.channelConnections.id, connectionId))
        .run();
    }

    // Workspace-owned (null-agent) connection routes inbound to the orchestrator.
    const inboundAgentId = row.agentId ?? this.#resolveInboundAgentId(row.workspaceId);
    if (!inboundAgentId) return;
    const conversation = this.deps.conversations.getOrCreateByChannel({
      workspaceId: row.workspaceId,
      ambientId: row.ambientId,
      userId: row.userId,
      agentId: inboundAgentId,
      channelConnectionId: row.id,
      channelChatId: msg.chatId,
      appId: row.appId ?? null,
    });
    const fromTag = msg.from ? `[${msg.from}] ` : '';
    const message = this.deps.conversations.appendMirrored({
      workspaceId: row.workspaceId,
      conversationId: conversation.id,
      sessionMessageId: msg.externalId,
      authorType: 'system',
      body: `${fromTag}${msg.body}`,
      metadata: {
        channel: row.kind,
        channelConnectionId: row.id,
        channelInbound: true,
        ...(msg.threadId ? { threadId: msg.threadId } : {}),
        ...(msg.from ? { from: msg.from } : {}),
      },
    });
    this.deps.db
      .insert(schema.channelDeliveries)
      .values({
        id: randomUUID(),
        connectionId: row.id,
        workspaceId: row.workspaceId,
        externalId: msg.externalId,
        conversationMessageId: message.id,
      })
      .run();

    this.deps.bus.publish(REALTIME_ROOMS.workspace(row.workspaceId), REALTIME_EVENTS.CHANNEL_MESSAGE_RECEIVED, {
      connectionId: row.id,
      kind: row.kind,
      agentId: row.agentId,
      chatId: msg.chatId,
      messageId: message.id,
    });

    void this.#dispatcher?.dispatch({
      workspaceId: row.workspaceId,
      ambientId: row.ambientId,
      userId: row.userId,
      agentId: inboundAgentId,
      appId: row.appId ?? null,
      conversationId: conversation.id,
      connectionId: row.id,
      kind: row.kind,
      chatId: msg.chatId,
      text: msg.body,
      ...(msg.threadId ? { threadId: msg.threadId } : {}),
      ...(msg.from ? { from: msg.from } : {}),
      inboundMessageId: message.id,
    });
  }

  /** Persist an operator send observed from the primary phone or another companion. */
  observeOutbound(connectionId: string, msg: WhatsAppObservedOutbound): void {
    const row = this.deps.db.select().from(schema.channelConnections)
      .where(eq(schema.channelConnections.id, connectionId)).get();
    if (!row) return;
    const duplicate = this.deps.db.select({ id: schema.channelDeliveries.id })
      .from(schema.channelDeliveries)
      .where(eq(schema.channelDeliveries.externalId, msg.externalId)).get();
    if (duplicate) return;
    const agentisSubmission = this.deps.db.select({ id: schema.channelOutboundDeliveries.id })
      .from(schema.channelOutboundDeliveries)
      .where(and(
        eq(schema.channelOutboundDeliveries.connectionId, connectionId),
        eq(schema.channelOutboundDeliveries.providerMessageId, msg.externalId),
      )).get();
    if (agentisSubmission) return;

    const agentId = row.agentId ?? this.#resolveInboundAgentId(row.workspaceId);
    if (!agentId) return;
    const conversation = this.deps.conversations.getOrCreateByChannel({
      workspaceId: row.workspaceId,
      ambientId: row.ambientId,
      userId: row.userId,
      agentId,
      channelConnectionId: row.id,
      channelChatId: msg.chatId,
      appId: row.appId ?? null,
    });
    const message = this.deps.conversations.appendOutbound({
      workspaceId: row.workspaceId,
      conversationId: conversation.id,
      operatorId: row.userId,
      sessionMessageId: msg.externalId,
      body: msg.body,
      deliveryStatus: 'sent',
      metadata: {
        channel: row.kind,
        channelConnectionId: row.id,
        channelOutboundObserved: true,
        source: 'external_whatsapp_client',
        providerMessageId: msg.externalId,
      },
    });
    this.deps.db.insert(schema.channelDeliveries).values({
      id: randomUUID(),
      connectionId: row.id,
      workspaceId: row.workspaceId,
      externalId: msg.externalId,
      conversationMessageId: message.id,
    }).run();
    this.deps.bus.publish(REALTIME_ROOMS.workspace(row.workspaceId), REALTIME_EVENTS.CHANNEL_MESSAGE_SENT, {
      connectionId: row.id,
      kind: row.kind,
      agentId,
      chatId: msg.chatId,
      messageId: message.id,
      providerMessageId: msg.externalId,
      providerAcknowledged: true,
      observed: true,
      source: 'external_whatsapp_client',
    });
  }

  #onDeliveryUpdate(
    connectionId: string,
    update: { providerMessageId: string; status: ChannelDeliveryReceipt['status']; providerStatus: number; recipient?: string },
  ): void {
    const connection = this.deps.db
      .select({
        workspaceId: schema.channelConnections.workspaceId,
        kind: schema.channelConnections.kind,
        agentId: schema.channelConnections.agentId,
      })
      .from(schema.channelConnections)
      .where(eq(schema.channelConnections.id, connectionId))
      .get();
    if (!connection) return;
    const deliveries = this.deps.db
      .select()
      .from(schema.channelOutboundDeliveries)
      .where(and(
        eq(schema.channelOutboundDeliveries.connectionId, connectionId),
        eq(schema.channelOutboundDeliveries.providerMessageId, update.providerMessageId),
      ))
      .all();
    const rank: Record<string, number> = { sending: 0, queued: 1, accepted: 2, delivered: 3, read: 4 };
    for (const delivery of deliveries) {
      if ((rank[update.status] ?? 0) <= (rank[delivery.status] ?? 0)) continue;
      const previousReceipt = delivery.receipt && typeof delivery.receipt === 'object'
        ? delivery.receipt as ChannelDeliveryReceipt
        : null;
      const receipt: ChannelDeliveryReceipt = {
        ...(previousReceipt ?? {
          provider: 'whatsapp',
          providerMessageId: update.providerMessageId,
          acceptedAt: new Date().toISOString(),
        }),
        status: update.status,
        providerAcknowledged: true,
        providerStatus: update.providerStatus,
        ...(update.recipient ? { recipient: update.recipient, providerRecipient: update.recipient } : {}),
      };
      this.deps.db.update(schema.channelOutboundDeliveries).set({
        status: update.status,
        receipt,
        error: null,
        updatedAt: new Date().toISOString(),
      }).where(eq(schema.channelOutboundDeliveries.id, delivery.id)).run();
      const conversationMessage = this.deps.db.select().from(schema.conversationMessages)
        .where(and(
          eq(schema.conversationMessages.workspaceId, connection.workspaceId),
          eq(schema.conversationMessages.sessionMessageId, delivery.idempotencyKey),
        )).get();
      if (conversationMessage) {
        const conversation = this.deps.db.select({ agentId: schema.conversations.agentId })
          .from(schema.conversations).where(eq(schema.conversations.id, conversationMessage.conversationId)).get();
        const metadata = {
          ...(conversationMessage.metadata && typeof conversationMessage.metadata === 'object'
            ? conversationMessage.metadata as Record<string, unknown>
            : {}),
          channelDeliveryReceipt: receipt,
        };
        const deliveryStatus = update.status === 'delivered' || update.status === 'read' ? 'delivered' : 'sent';
        this.deps.db.update(schema.conversationMessages).set({ deliveryStatus, metadata })
          .where(eq(schema.conversationMessages.id, conversationMessage.id)).run();
        if (conversation) {
          this.deps.bus.publish(
            REALTIME_ROOMS.conversation(conversation.agentId),
            REALTIME_EVENTS.CONVERSATION_MESSAGE_UPDATED,
            {
              message: { ...conversationMessage, deliveryStatus, metadata },
              conversationId: conversationMessage.conversationId,
              agentId: conversation.agentId,
            },
          );
        }
      }
      const eventPayload = {
        connectionId,
        kind: connection.kind,
        agentId: connection.agentId,
        providerMessageId: update.providerMessageId,
        status: update.status,
        providerAcknowledged: true,
        ...(update.recipient ? { resolvedRecipient: update.recipient } : {}),
      };
      this.deps.bus.publish(
        REALTIME_ROOMS.workspace(connection.workspaceId),
        REALTIME_EVENTS.CHANNEL_MESSAGE_STATUS,
        eventPayload,
      );
      if ((rank[delivery.status] ?? 0) < 2) {
        this.deps.bus.publish(
          REALTIME_ROOMS.workspace(connection.workspaceId),
          REALTIME_EVENTS.CHANNEL_MESSAGE_SENT,
          eventPayload,
        );
      }
    }
  }

  #onStateChange(connectionId: string, state: { status: string; qr?: string; selfId?: string }): void {
    const now = new Date().toISOString();
    const row = this.deps.db
      .select({ workspaceId: schema.channelConnections.workspaceId, kind: schema.channelConnections.kind, settings: schema.channelConnections.settings, lastError: schema.channelConnections.lastError })
      .from(schema.channelConnections)
      .where(eq(schema.channelConnections.id, connectionId))
      .get();
    if (!row) return;
    const dbStatus: ChannelStatus = state.status === 'open' ? 'active'
      : state.status === 'logged_out' || state.status === 'error' ? 'error'
      : row.kind === 'whatsapp' ? 'needs_action' : 'verifying';
    const currentSettings = (row.settings ?? {}) as Record<string, unknown>;
    const currentHealth = isChannelHealth(currentSettings.health) ? currentSettings.health : null;
    const reconciledHealth = currentHealth ? reconcileTransportHealth(currentHealth, dbStatus, state.status, now) : null;
    const persistedStatus = reconciledHealth?.status ?? dbStatus;
    const settings = {
      ...currentSettings,
      transportStatus: state.status,
      ...(state.selfId ? { selfId: state.selfId } : {}),
      ...(reconciledHealth ? { health: reconciledHealth } : {}),
    };
    this.deps.db
      .update(schema.channelConnections)
      .set({ status: persistedStatus, settings, updatedAt: now, ...(state.status === 'open' ? { lastEventAt: now, lastError: persistedStatus === 'active' ? null : row.lastError } : {}) })
      .where(eq(schema.channelConnections.id, connectionId))
      .run();
    this.deps.bus.publish(
      REALTIME_ROOMS.workspace(row.workspaceId),
      REALTIME_EVENTS.CHANNEL_CONNECTION_STATUS,
      { connectionId, kind: row.kind, status: persistedStatus, transportStatus: state.status, ...(state.qr ? { hasQr: true } : {}) },
    );
  }
}

function isChannelHealth(value: unknown): value is ChannelHealth {
  return Boolean(value && typeof value === 'object' && Array.isArray((value as ChannelHealth).checks));
}

function reconcileTransportHealth(
  health: ChannelHealth,
  status: ChannelStatus,
  transportStatus: string,
  checkedAt: string,
): ChannelHealth {
  const transport: ChannelHealthCheck = transportStatus === 'open'
    ? {
        name: 'transport', ok: true, code: 'persistent_transport_open',
        message: 'Persistent channel transport is open.', checkedAt,
      }
    : {
        name: 'transport', ok: false, code: 'persistent_transport_not_open',
        message: `Persistent channel transport is ${transportStatus}.`,
        remediation: 'Relink or restart the live connection.', checkedAt,
      };
  const checks = health.checks.some((check) => check.name === 'transport')
    ? health.checks.map((check) => check.name === 'transport' ? transport : check)
    : [...health.checks, transport];
  const effectiveStatus: ChannelStatus = status !== 'active'
    ? status
    : checks.some((check) => !check.ok && (check.name === 'credential' || check.name === 'transport'))
      ? 'error'
      : checks.some((check) => !check.ok)
        ? 'degraded'
        : 'active';
  return { ...health, status: effectiveStatus, checks };
}
