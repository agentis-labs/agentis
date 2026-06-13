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
 * Telegram is persistent only when `settings.transport === 'polling'` (otherwise
 * the webhook adapter handles it).
 */

import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import { REALTIME_EVENTS, REALTIME_ROOMS } from '@agentis/core';
import type { EventBus } from '../event-bus.js';
import type { Logger } from '../logger.js';
import type { CredentialVault } from './credentialVault.js';
import type { ConversationStore } from './conversationStore.js';
import type { ChannelTurnDispatcher } from './channelTurnDispatcher.js';
import { WhatsAppSession } from '../adapters/channels/whatsappSession.js';
import { TelegramSession } from '../adapters/channels/telegramSession.js';
import { DiscordSession } from '../adapters/channels/discordSession.js';
import { useVaultAuthState } from '../adapters/channels/whatsappVaultAuthState.js';

type LiveSession = WhatsAppSession | TelegramSession | DiscordSession;

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

function telegramIsPolling(settings: unknown): boolean {
  return Boolean(settings && typeof settings === 'object' && (settings as { transport?: string }).transport === 'polling');
}

function discordIsGateway(settings: unknown): boolean {
  return Boolean(settings && typeof settings === 'object' && (settings as { transport?: string }).transport === 'gateway');
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

  /** Does outbound for this connection route through a live session? */
  handles(conn: PersistentRef): boolean {
    if (conn.kind === 'whatsapp') return true;
    if (conn.kind === 'telegram') return telegramIsPolling(conn.settings);
    if (conn.kind === 'discord') return discordIsGateway(conn.settings);
    return false;
  }

  /** Kinds that authenticate without a token (QR). */
  requiresNoToken(kind: string): boolean {
    return kind === 'whatsapp';
  }

  /** Post-create hook: start polling sessions immediately (no-op for QR kinds). */
  onCreated(conn: PersistentRef): void {
    // Token-authenticated live sessions (Telegram polling, Discord gateway) can
    // start immediately. WhatsApp starts via explicit QR login (startLogin).
    const startsOnCreate = (conn.kind === 'telegram' && telegramIsPolling(conn.settings))
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

  /** Deliver an outbound message over the live session. */
  async send(connectionId: string, chatId: string, body: string): Promise<void> {
    const session = this.#sessions.get(connectionId);
    if (!session) throw new Error(`no live session for connection ${connectionId}`);
    await session.sendText(chatId, body);
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

  // ── internals ───────────────────────────────────────────

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
        onStateChange: (state) => this.#onStateChange(connectionId, state),
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

    const conversation = this.deps.conversations.getOrCreateByAgent({
      workspaceId: row.workspaceId,
      ambientId: row.ambientId,
      userId: row.userId,
      agentId: row.agentId,
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
      agentId: row.agentId,
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

  #onStateChange(connectionId: string, state: { status: string; qr?: string; selfId?: string }): void {
    const now = new Date().toISOString();
    const dbStatus = state.status === 'open' ? 'active'
      : state.status === 'logged_out' || state.status === 'error' ? 'error'
      : 'connecting';
    const row = this.deps.db
      .select({ workspaceId: schema.channelConnections.workspaceId, kind: schema.channelConnections.kind, settings: schema.channelConnections.settings })
      .from(schema.channelConnections)
      .where(eq(schema.channelConnections.id, connectionId))
      .get();
    if (!row) return;
    const settings = {
      ...((row.settings ?? {}) as Record<string, unknown>),
      transportStatus: state.status,
      ...(state.selfId ? { selfId: state.selfId } : {}),
    };
    this.deps.db
      .update(schema.channelConnections)
      .set({ status: dbStatus, settings, updatedAt: now, ...(state.status === 'open' ? { lastEventAt: now, lastError: null } : {}) })
      .where(eq(schema.channelConnections.id, connectionId))
      .run();
    this.deps.bus.publish(
      REALTIME_ROOMS.workspace(row.workspaceId),
      REALTIME_EVENTS.CHANNEL_CONNECTION_STATUS,
      { connectionId, kind: row.kind, status: state.status, ...(state.qr ? { hasQr: true } : {}) },
    );
  }
}
