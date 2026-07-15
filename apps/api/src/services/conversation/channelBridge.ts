/**
 * ChannelBridge — Batch 4 / V1-SPEC §0.3 #24, §11.
 *
 * One service per workspace process; owns the registry of `ChannelAdapter`
 * implementations keyed by `ChannelKind`. Responsibilities:
 *
 *   1. CRUD over `channel_connections` rows (via routes).
 *   2. Inbound: verify webhook signature → parse → idempotency check
 *      against `channel_deliveries.external_id` → ConversationStore.appendMirrored.
 *   3. Outbound channel replies are delivered explicitly by
 *      ChannelTurnDispatcher via `deliverToConnection`.
 *
 * Token storage: `tokenEncrypted` is AES-256-GCM ciphertext via
 * CredentialVault. Plaintext NEVER leaves the bridge — neither REST routes
 * nor bus envelopes ever expose it.
 */

import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import { AgentisError, REALTIME_EVENTS, REALTIME_ROOMS } from '@agentis/core';
import type { CredentialVault } from '../credentialVault.js';
import type { ConversationStore } from './conversationStore.js';
import type { EventBus } from '../../event-bus.js';
import type { Logger } from '../../logger.js';
import type {
  ChannelAdapter,
  ChannelDeliveryReceipt,
  ChannelHealth,
  ChannelHealthCheck,
  ChannelHealthCheckName,
  ChannelKind,
  ChannelStatus,
  OutboundAttachment,
  OutboundAttachmentRef,
  ParsedInboundMessage,
} from '../../adapters/channels/types.js';
import type { ChannelTurnDispatcher } from './channelTurnDispatcher.js';
import type { ArtifactService } from '../artifactService.js';
import type { ChannelAccess, ChannelRecipient } from './channelAccess.js';

export interface ChannelBridgeDeps {
  db: AgentisSqliteDb;
  vault: CredentialVault;
  conversations: ConversationStore;
  bus: EventBus;
  logger: Logger;
  /** Optional override (tests). Default: TelegramChannelAdapter + DiscordChannelAdapter. */
  adapters?: Partial<Record<ChannelKind, ChannelAdapter>>;
  /** Optional runtime probe for the configured agent. */
  runtimeHealth?: (args: { workspaceId: string; agentId: string }) => Promise<ChannelHealthCheck> | ChannelHealthCheck;
  /** Resolves outbound attachment references (artifact ids, data/http URLs) into bytes. */
  artifacts?: ArtifactService;
}

export interface CreateConnectionInput {
  workspaceId: string;
  ambientId: string | null;
  userId: string;
  /** Owning agent, or null/undefined for a workspace-owned (global) connection. */
  agentId?: string | null;
  kind: ChannelKind;
  name: string;
  /** Plaintext bot token. Encrypted on the way in. Omitted for QR-auth kinds (WhatsApp). */
  token?: string;
  /** Optional outbound chat id default (e.g. Telegram numeric id). */
  defaultChatId?: string;
  /** WhatsApp Cloud uses the same address as defaultChatId but labels it for setup. */
  defaultRecipient?: string;
  /** Persistent transport: Telegram 'polling' or Discord 'gateway' (no public webhook). */
  transport?: 'polling' | 'webhook' | 'gateway';
  /** WhatsApp mode: QR/Baileys local session or official Cloud API. */
  mode?: 'qr_local' | 'cloud';
  /** Slack Events API signing secret. Encrypted in settings. */
  signingSecret?: string;
  /** WhatsApp Cloud phone number id. */
  phoneNumberId?: string;
  /** WhatsApp Cloud app secret. Encrypted in settings. */
  appSecret?: string;
  /** WhatsApp Cloud webhook verify token. Encrypted in settings. */
  verifyToken?: string;
  /** Lightweight destination aliases, e.g. { me: "+12345678901", work: "C123" }. */
  targetAliases?: Record<string, string>;
}

export interface UpdateConnectionTargetsInput {
  defaultChatId?: string | null;
  targetAliases?: Record<string, string | null>;
  /** Who the agent replies to, and the per-recipient/anyone rules (CHANNEL-ACCESS-10x). */
  access?: ChannelAccess | null;
}

export interface PublicConnection {
  id: string;
  workspaceId: string;
  ambientId: string | null;
  /** Owning agent, or null for a workspace-owned (global/agentless) connection. */
  agentId: string | null;
  kind: ChannelKind;
  name: string;
  status: string;
  defaultChatId: string | null;
  targetAliases: Record<string, string>;
  access: ChannelAccess | null;
  transport: string | null;
  mode: string | null;
  transportStatus: string | null;
  /** Workspace default for this kind — deterministic sends resolve to it. */
  isDefault: boolean;
  health: ChannelHealth;
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
  requiresNoToken(kind: string, settings?: unknown): boolean;
  /** Post-create hook — start polling sessions (no-op for QR-login kinds). */
  onCreated?(conn: PersistentChannelRef): void;
  /** Current live-session state, if this transport owns the connection. */
  status?(connectionId: string): { status: string; qr?: string; selfId?: string } | null;
  send(connectionId: string, chatId: string, body: string, attachments?: OutboundAttachment[]): Promise<ChannelDeliveryReceipt>;
  /** Show/clear the typing indicator (best-effort). */
  setTyping?(connectionId: string, chatId: string, on: boolean): Promise<void>;
  /** Tear down the live session when a connection is deleted. */
  stop?(connectionId: string): Promise<void>;
}

type ChannelConnectionRow = typeof schema.channelConnections.$inferSelect;
type ChannelSettings = {
  defaultChatId?: string;
  targetAliases?: Record<string, string>;
  access?: ChannelAccess;
  transport?: 'polling' | 'webhook' | 'gateway';
  mode?: 'qr_local' | 'cloud';
  phoneNumberId?: string;
  signingSecretEncrypted?: string;
  appSecretEncrypted?: string;
  verifyTokenEncrypted?: string;
  transportStatus?: string;
  selfId?: string;
  health?: ChannelHealth;
  /** Workspace default for this KIND — the one deterministic sends (the `channel`
   *  workflow node / agentis.channel.send by kind) use when several exist. At most
   *  one connection per (workspace, kind) carries this. */
  isDefault?: boolean;
};

const GRAPH_API_VERSION = process.env.WHATSAPP_GRAPH_API_VERSION ?? 'v20.0';
const TELEGRAM_API = 'https://api.telegram.org';
const DEFAULT_HEALTH_CHECK_NAMES: ChannelHealthCheckName[] = ['credential', 'transport', 'outbound', 'inbound', 'runtime'];
const ME_ALIASES = new Set(['me', 'default']);

export class ChannelBridge {
  readonly #adapters: Map<ChannelKind, ChannelAdapter>;
  #turnDispatcher: ChannelTurnDispatcher | null = null;
  #persistent: PersistentChannelTransport | null = null;

  constructor(private readonly deps: ChannelBridgeDeps) {
    this.#adapters = new Map();
    if (deps.adapters?.telegram) this.#adapters.set('telegram', deps.adapters.telegram);
    if (deps.adapters?.discord) this.#adapters.set('discord', deps.adapters.discord);
    if (deps.adapters?.slack) this.#adapters.set('slack', deps.adapters.slack);
    if (deps.adapters?.voice) this.#adapters.set('voice', deps.adapters.voice);
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
  async deliverToConnection(args: { connectionId: string; chatId: string; body: string; attachments?: OutboundAttachmentRef[]; idempotencyKey?: string }): Promise<ChannelDeliveryReceipt> {
    const row = this.deps.db
      .select()
      .from(schema.channelConnections)
      .where(eq(schema.channelConnections.id, args.connectionId))
      .get();
    if (!row) throw new AgentisError('RESOURCE_NOT_FOUND', `channel connection ${args.connectionId} not found`);
    const attachments = await this.#resolveAttachments(row.workspaceId, args.attachments);
    const idempotencyKey = args.idempotencyKey?.trim() || null;
    const bodyHash = createHash('sha256')
      .update(args.chatId)
      .update('\0')
      .update(args.body)
      .update('\0')
      .update(JSON.stringify(attachments.map((attachment) => ({
        kind: attachment.kind,
        filename: attachment.filename,
        mimeType: attachment.mimeType,
        digest: createHash('sha256').update(attachment.data).digest('hex'),
      }))))
      .digest('hex');
    let journalId: string | null = null;
    if (idempotencyKey) {
      const existing = this.deps.db
        .select()
        .from(schema.channelOutboundDeliveries)
        .where(and(
          eq(schema.channelOutboundDeliveries.workspaceId, row.workspaceId),
          eq(schema.channelOutboundDeliveries.idempotencyKey, idempotencyKey),
        ))
        .get();
      if (existing) {
        if (existing.connectionId !== row.id || existing.chatId !== args.chatId || existing.bodyHash !== bodyHash) {
          throw new AgentisError('VALIDATION_FAILED', 'channel idempotency key was reused with a different connection, recipient, or message');
        }
        const stored = existing.receipt as ChannelDeliveryReceipt | null;
        if (existing.status === 'accepted' && stored?.providerMessageId) {
          return { ...stored, deduplicated: true, idempotencyKey };
        }
        throw new AgentisError(
          'CHANNEL_SEND_FAILED',
          `channel delivery ${idempotencyKey} already has status ${existing.status}; Agentis will not resend an uncertain/failed attempt automatically`,
        );
      }
      journalId = randomUUID();
      this.deps.db.insert(schema.channelOutboundDeliveries).values({
        id: journalId,
        workspaceId: row.workspaceId,
        connectionId: row.id,
        idempotencyKey,
        chatId: args.chatId,
        bodyHash,
        status: 'sending',
      }).run();
    }
    try {
      const receipt = await this.#sendRow(row, args.chatId, args.body, attachments);
      if (!receipt.providerMessageId?.trim()) {
        throw new AgentisError('CHANNEL_SEND_FAILED', `${row.kind} returned no provider message id; delivery is unverified`);
      }
      this.#markActive(row.id);
      const durableReceipt = idempotencyKey ? { ...receipt, idempotencyKey } : receipt;
      if (journalId) {
        this.deps.db.update(schema.channelOutboundDeliveries).set({
          status: 'accepted',
          providerMessageId: receipt.providerMessageId,
          receipt: durableReceipt,
          error: null,
          updatedAt: new Date().toISOString(),
        }).where(eq(schema.channelOutboundDeliveries.id, journalId)).run();
      }
      this.deps.bus.publish(
        REALTIME_ROOMS.workspace(row.workspaceId),
        REALTIME_EVENTS.CHANNEL_MESSAGE_SENT,
        { connectionId: row.id, kind: row.kind, agentId: row.agentId, providerMessageId: receipt.providerMessageId, status: receipt.status },
      );
      return durableReceipt;
    } catch (err) {
      const msg = (err as Error).message ?? 'send failed';
      if (journalId) {
        // The process reached the provider boundary but lacks durable proof of
        // acceptance. Keep the attempt non-retryable under this key: a blind
        // resend is worse than an explicit uncertain outcome.
        this.deps.db.update(schema.channelOutboundDeliveries).set({
          status: 'uncertain',
          error: msg,
          updatedAt: new Date().toISOString(),
        }).where(eq(schema.channelOutboundDeliveries.id, journalId)).run();
      }
      this.#markError(row.id, msg);
      throw err;
    }
  }

  hasAdapter(kind: ChannelKind): boolean {
    return this.#adapters.has(kind);
  }

  /**
   * Constant-time check of a presented voice secret against a voice connection's
   * shared secret (G6). Used by the voice reply-retrieval route so a provider can
   * authenticate when fetching the buffered reply. Returns false for a missing
   * connection or a non-voice kind.
   */
  verifyVoiceSecret(connectionId: string, presented: string): boolean {
    const row = this.deps.db
      .select({ kind: schema.channelConnections.kind, webhookSecret: schema.channelConnections.webhookSecret })
      .from(schema.channelConnections)
      .where(eq(schema.channelConnections.id, connectionId))
      .get();
    if (!row || row.kind !== 'voice' || !row.webhookSecret) return false;
    const a = Buffer.from(presented);
    const b = Buffer.from(row.webhookSecret);
    if (a.length !== b.length) return false;
    try {
      return timingSafeEqual(a, b);
    } catch {
      return false;
    }
  }

  shutdown() {}

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
    const settings: ChannelSettings = {};
    const defaultTarget = input.defaultChatId ?? input.defaultRecipient;
    if (defaultTarget) settings.defaultChatId = this.#normalizeTargetForKind(input.kind, defaultTarget);
    if (input.transport) settings.transport = input.transport;
    if (input.kind === 'telegram' && !settings.transport && !this.#publicWebhookUrl(id)) settings.transport = 'polling';
    if (input.kind === 'whatsapp') settings.mode = input.mode ?? 'qr_local';
    if (input.targetAliases) settings.targetAliases = this.#normalizeAliases(input.kind, input.targetAliases);
    if (input.signingSecret) settings.signingSecretEncrypted = this.deps.vault.encrypt(input.signingSecret);
    if (input.phoneNumberId) settings.phoneNumberId = input.phoneNumberId;
    if (input.appSecret) settings.appSecretEncrypted = this.deps.vault.encrypt(input.appSecret);
    if (input.verifyToken) settings.verifyTokenEncrypted = this.deps.vault.encrypt(input.verifyToken);
    settings.health = this.#initialHealth(input.kind, settings);
    const ref = { id, kind: input.kind, settings };
    // Voice (G6) authenticates inbound webhooks with its auto-generated per-
    // connection webhookSecret — there is no external bot token to require.
    const noToken = input.kind === 'voice' || (this.#persistent?.requiresNoToken(input.kind, settings) ?? false);
    const persistent = this.#persistent?.handles(ref) ?? false;
    // A connection must be deliverable: either via a live persistent session, a
    // registered webhook adapter, or QR auth (which needs no token at all).
    if (!noToken && !persistent && !this.#adapters.has(input.kind) && !this.#isWhatsAppCloud(input.kind, settings)) {
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
    if (this.#isWhatsAppCloud(input.kind, settings)) {
      if (!input.token || !settings.phoneNumberId || !settings.appSecretEncrypted || !settings.verifyTokenEncrypted) {
        throw new AgentisError(
          'VALIDATION_FAILED',
          'WhatsApp Cloud requires access token, phone number ID, app secret, and verify token',
        );
      }
    }
    // A specific owning agent must belong to the workspace; null = workspace-owned.
    const ownerAgentId = input.agentId ?? null;
    if (ownerAgentId) {
      const agent = this.deps.db
        .select()
        .from(schema.agents)
        .where(eq(schema.agents.id, ownerAgentId))
        .get();
      if (!agent || agent.workspaceId !== input.workspaceId) {
        throw new AgentisError('RESOURCE_NOT_FOUND', `agent ${ownerAgentId} not found`);
      }
    }
    const webhookSecret = randomBytes(24).toString('hex');
    // tokenEncrypted is NOT NULL; QR-auth kinds store an encrypted marker.
    const tokenPlain = input.token ?? `persistent:${input.kind}:${id}`;
    const initialStatus: ChannelStatus = input.kind === 'whatsapp' && settings.mode !== 'cloud'
      ? 'needs_action'
      : 'verifying';
    this.deps.db
      .insert(schema.channelConnections)
      .values({
        id,
        workspaceId: input.workspaceId,
        ambientId: input.ambientId,
        userId: input.userId,
        agentId: ownerAgentId,
        kind: input.kind,
        name: input.name,
        tokenEncrypted: this.deps.vault.encrypt(tokenPlain),
        webhookSecret,
        settings,
        status: initialStatus,
        lastEventAt: null,
        lastError: null,
      })
      .run();
    // Start polling sessions immediately (WhatsApp links via explicit QR login).
    this.#persistent?.onCreated?.(ref);
    const connection = this.get(input.workspaceId, id);
    return { connection, webhookSecret };
  }

  /**
   * Designate (or clear) the workspace DEFAULT connection for its kind — the one
   * deterministic sends resolve to when several connections of that kind exist.
   * Setting a default clears the flag on every sibling of the same kind, so the
   * (workspace, kind) → default invariant holds. Passing `isDefault:false` clears
   * it, leaving no default for that kind.
   */
  setDefault(workspaceId: string, id: string, isDefault: boolean): PublicConnection {
    const row = this.#row(workspaceId, id); // 404s if missing / wrong workspace
    const now = new Date().toISOString();
    if (isDefault) {
      // Clear the flag on all other connections of the same kind first.
      const siblings = this.deps.db
        .select()
        .from(schema.channelConnections)
        .where(and(eq(schema.channelConnections.workspaceId, workspaceId), eq(schema.channelConnections.kind, row.kind)))
        .all();
      for (const s of siblings) {
        if (s.id === id) continue;
        const ss = this.#settings(s);
        if (ss.isDefault) {
          this.deps.db.update(schema.channelConnections)
            .set({ settings: { ...ss, isDefault: false }, updatedAt: now })
            .where(eq(schema.channelConnections.id, s.id)).run();
        }
      }
    }
    this.deps.db.update(schema.channelConnections)
      .set({ settings: { ...this.#settings(row), isDefault }, updatedAt: now })
      .where(eq(schema.channelConnections.id, id)).run();
    return this.get(workspaceId, id);
  }

  /** The default connection id for a kind: the explicitly-flagged one (honored
   *  regardless of live status — a down default still fails loudly at delivery,
   *  not as "ambiguous"), else the sole ACTIVE one so a single-connection
   *  workspace needs no explicit default, else null (ambiguous). */
  defaultConnectionFor(workspaceId: string, kind: string): string | null {
    const ofKind = this.list(workspaceId).filter((c) => c.kind === kind);
    const flagged = ofKind.find((c) => c.isDefault);
    if (flagged) return flagged.id;
    const active = ofKind.filter((c) => c.status === 'active');
    return active.length === 1 ? active[0]!.id : null;
  }

  updateTargets(workspaceId: string, id: string, input: UpdateConnectionTargetsInput): PublicConnection {
    const row = this.#row(workspaceId, id);
    const settings = { ...this.#settings(row) };
    if ('defaultChatId' in input) {
      const target = input.defaultChatId?.trim();
      if (target) settings.defaultChatId = this.#normalizeTargetForKind(row.kind as ChannelKind, target);
      else delete settings.defaultChatId;
    }
    if (input.targetAliases) {
      const targetAliases = { ...(settings.targetAliases ?? {}) };
      for (const [rawAlias, rawTarget] of Object.entries(input.targetAliases)) {
        const alias = this.#normalizeAlias(rawAlias);
        if (!alias) continue;
        const target = rawTarget?.trim();
        if (target) targetAliases[alias] = this.#normalizeTargetForKind(row.kind as ChannelKind, target);
        else delete targetAliases[alias];
      }
      settings.targetAliases = targetAliases;
    }
    if ('access' in input) {
      if (!input.access) {
        delete settings.access;
      } else {
        const recipients = (input.access.recipients ?? [])
          .map((r): ChannelRecipient => ({
            handle: (r.handle ?? '').trim(),
            ...(r.name?.trim() ? { name: r.name.trim() } : {}),
            ...(r.rules?.trim() ? { rules: r.rules.trim() } : {}),
          }))
          .filter((r) => r.handle.length > 0);
        settings.access = {
          recipients,
          answerAnyone: Boolean(input.access.answerAnyone),
          ...(input.access.anyoneRules?.trim() ? { anyoneRules: input.access.anyoneRules.trim() } : {}),
          ...(input.access.unknownReply ? { unknownReply: input.access.unknownReply } : {}),
        };
      }
    }
    this.deps.db
      .update(schema.channelConnections)
      .set({ settings, updatedAt: new Date().toISOString() })
      .where(eq(schema.channelConnections.id, row.id))
      .run();
    return this.get(workspaceId, id);
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
   * Run safe provider checks and persist structured health. When a default
   * destination exists, the outbound check sends one visible test message.
   */
  async test(args: { workspaceId: string; id: string; chatId?: string; body?: string }): Promise<ChannelHealth> {
    const row = this.#row(args.workspaceId, args.id);
    const checks = await this.#runHealthChecks(row, {
      chatId: args.chatId,
      body: args.body ?? 'Agentis test message',
    });
    return this.#saveHealth(row, checks);
  }

  health(workspaceId: string, id: string): ChannelHealth {
    const row = this.#row(workspaceId, id);
    return this.#healthFromRow(row);
  }

  resolveDestination(args: { connectionId: string; to?: string | null }): { chatId: string | null; source: 'default' | 'alias' | 'explicit' | 'missing' } {
    const row = this.deps.db
      .select()
      .from(schema.channelConnections)
      .where(eq(schema.channelConnections.id, args.connectionId))
      .get();
    if (!row) throw new AgentisError('RESOURCE_NOT_FOUND', `channel connection ${args.connectionId} not found`);
    const settings = this.#settings(row);
    const requested = args.to?.trim() ?? '';
    if (!requested || ME_ALIASES.has(requested.toLowerCase())) {
      return settings.defaultChatId
        ? { chatId: settings.defaultChatId, source: 'default' }
        : { chatId: null, source: 'missing' };
    }
    const alias = this.#normalizeAlias(requested);
    const aliased = alias ? settings.targetAliases?.[alias] : undefined;
    if (aliased) return { chatId: aliased, source: 'alias' };
    return { chatId: this.#normalizeTargetForKind(row.kind as ChannelKind, requested), source: 'explicit' };
  }

  handleWebhookVerification(args: {
    connectionId: string;
    query: Record<string, string | undefined>;
  }): { ok: true; body: string; contentType?: string } {
    const row = this.deps.db
      .select()
      .from(schema.channelConnections)
      .where(eq(schema.channelConnections.id, args.connectionId))
      .get();
    if (!row) throw new AgentisError('RESOURCE_NOT_FOUND', `channel connection ${args.connectionId} not found`);
    const settings = this.#settings(row);
    if (this.#isWhatsAppCloud(row.kind as ChannelKind, settings)) {
      const expected = settings.verifyTokenEncrypted ? this.deps.vault.decrypt(settings.verifyTokenEncrypted) : '';
      const mode = args.query['hub.mode'];
      const token = args.query['hub.verify_token'];
      const challenge = args.query['hub.challenge'];
      if (mode === 'subscribe' && token && token === expected && challenge) {
        return { ok: true, body: challenge, contentType: 'text/plain; charset=utf-8' };
      }
      throw new AgentisError('CHANNEL_SIGNATURE_INVALID', 'WhatsApp webhook verify token did not match');
    }
    throw new AgentisError('VALIDATION_FAILED', `${row.kind} does not use GET webhook verification`);
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
  }): Promise<{ accepted: boolean; idempotent: boolean; messageId?: string; responseBody?: unknown; statusCode?: number }> {
    const row = this.deps.db
      .select()
      .from(schema.channelConnections)
      .where(eq(schema.channelConnections.id, args.connectionId))
      .get();
    if (!row) {
      throw new AgentisError('RESOURCE_NOT_FOUND', `channel connection ${args.connectionId} not found`);
    }
    if (row.status === 'paused') {
      throw new AgentisError('CHANNEL_CONNECTION_INACTIVE', `connection ${row.id} is not active`);
    }
    const adapter = this.#isWhatsAppCloud(row.kind as ChannelKind, this.#settings(row)) ? null : this.#requireAdapter(row.kind as ChannelKind);
    const secret = this.#webhookVerificationSecret(row);
    const ok = this.#verifyInbound(row, args.headers, args.rawBody, secret);
    if (!ok) {
      this.#markError(row.id, 'webhook signature verification failed');
      throw new AgentisError('CHANNEL_SIGNATURE_INVALID', 'channel webhook signature verification failed');
    }

    const challenge = this.#maybeProviderChallenge(row, args.rawBody);
    if (challenge) {
      this.#markActive(row.id);
      return { accepted: true, idempotent: false, responseBody: challenge, statusCode: 200 };
    }

    const parsed = adapter
      ? adapter.parseInbound({ rawBody: args.rawBody, headers: args.headers })
      : this.#parseWhatsAppCloudInbound(args.rawBody);
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

    this.#rememberDefaultChat(row, parsed.chatId);

    // A workspace-owned (null-agent) connection routes inbound to the orchestrator
    // — the workspace's front door — which then handles or delegates.
    const inboundAgentId = row.agentId ?? this.#resolveInboundAgentId(row.workspaceId);
    if (!inboundAgentId) {
      this.#markActive(row.id);
      return { accepted: false, idempotent: false };
    }
    const conversation = this.deps.conversations.getOrCreateByChannel({
      workspaceId: row.workspaceId,
      ambientId: row.ambientId,
      userId: row.userId,
      agentId: inboundAgentId,
      channelConnectionId: row.id,
      channelChatId: parsed.chatId,
      appId: row.appId ?? null,
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
        agentId: inboundAgentId,
        appId: row.appId ?? null,
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

  // ── helpers ─────────────────────────────────────────────

  async #runHealthChecks(row: ChannelConnectionRow, opts: { chatId?: string; body: string }): Promise<ChannelHealthCheck[]> {
    const settings = this.#settings(row);
    const checks: ChannelHealthCheck[] = [];
    checks.push(await this.#credentialCheck(row, settings));
    checks.push(await this.#transportCheck(row, settings));
    checks.push(await this.#outboundCheck(row, settings, opts));
    checks.push(this.#inboundCheck(row, settings));
    checks.push(await this.#runtimeCheck(row));
    return this.#dedupeChecks(checks);
  }

  async #credentialCheck(row: ChannelConnectionRow, settings: ChannelSettings): Promise<ChannelHealthCheck> {
    if (row.kind === 'whatsapp' && settings.mode !== 'cloud') {
      return this.#check('credential', true, 'whatsapp_qr_auth_local', 'WhatsApp QR auth is stored in the local live session.');
    }
    if (this.#isWhatsAppCloud(row.kind as ChannelKind, settings)) {
      if (!settings.phoneNumberId) {
        return this.#check('credential', false, 'missing_phone_number_id', 'WhatsApp Cloud phone number ID is missing.', 'Add the phone number ID from Meta Business Manager.');
      }
      return this.#check('credential', true, 'whatsapp_cloud_fields_present', 'WhatsApp Cloud credentials are present.');
    }
    const token = this.deps.vault.decrypt(row.tokenEncrypted);
    const adapter = this.#requireAdapter(row.kind as ChannelKind);
    if (!adapter.probeCredential) {
      return this.#check('credential', true, `${row.kind}_credential_probe_unavailable`, `${row.kind} credentials are present.`);
    }
    try {
      return await adapter.probeCredential({ token, settings: settings as Record<string, unknown> });
    } catch (err) {
      return this.#check(
        'credential',
        false,
        `${row.kind}_credential_probe_error`,
        (err as Error).message || `${row.kind} credential probe failed.`,
        'Check the saved token and retry.',
      );
    }
  }

  async #transportCheck(row: ChannelConnectionRow, settings: ChannelSettings): Promise<ChannelHealthCheck> {
    if (this.#persistent?.handles({ id: row.id, kind: row.kind, settings })) {
      const state = this.#persistent.status?.(row.id) ?? { status: settings.transportStatus ?? 'idle' };
      if (state.status === 'open') {
        return this.#check('transport', true, 'persistent_transport_open', `${row.kind} live transport is open.`);
      }
      const remediation = row.kind === 'whatsapp'
        ? 'Open WhatsApp Linked Devices, scan a fresh QR, and keep the local Agentis process running.'
        : row.kind === 'discord'
          ? 'Confirm the bot token, gateway intents, and restart the connection.'
          : 'Retry the connection and make sure polling can start.';
      return this.#check(
        'transport',
        false,
        'persistent_transport_not_open',
        `${row.kind} live transport is ${state.status}.`,
        remediation,
      );
    }

    if (this.#isWhatsAppCloud(row.kind as ChannelKind, settings)) {
      return this.#check('transport', true, 'whatsapp_cloud_api_ready', 'WhatsApp Cloud API transport is configured for outbound REST sends.');
    }

    if (row.kind === 'discord' && settings.transport !== 'gateway') {
      return this.#check('transport', true, 'discord_rest_ready', 'Discord REST transport is configured for outbound messages.');
    }

    const publicUrl = this.#publicWebhookUrl(row.id);
    if (!publicUrl) {
      return this.#check(
        'transport',
        false,
        'missing_public_url',
        `${row.kind} webhook transport needs AGENTIS_PUBLIC_URL.`,
        row.kind === 'telegram' ? 'Set AGENTIS_PUBLIC_URL or switch Telegram to long polling.' : 'Set AGENTIS_PUBLIC_URL and configure the provider webhook to the displayed URL.',
      );
    }
    const adapter = this.#requireAdapter(row.kind as ChannelKind);
    if (!adapter.configureTransport) {
      return this.#check('transport', true, `${row.kind}_webhook_url_available`, `${row.kind} webhook URL is available.`);
    }
    try {
      const token = this.deps.vault.decrypt(row.tokenEncrypted);
      return await adapter.configureTransport({
        token,
        webhookUrl: publicUrl,
        secret: row.webhookSecret,
        transport: settings.transport ?? 'webhook',
      });
    } catch (err) {
      return this.#check(
        'transport',
        false,
        `${row.kind}_transport_probe_error`,
        (err as Error).message || `${row.kind} transport probe failed.`,
        'Check provider webhook configuration and retry.',
      );
    }
  }

  async #outboundCheck(
    row: ChannelConnectionRow,
    settings: ChannelSettings,
    opts: { chatId?: string; body: string },
  ): Promise<ChannelHealthCheck> {
    const chatId = opts.chatId ?? settings.defaultChatId;
    if (!chatId) {
      if (row.kind === 'whatsapp' && settings.mode !== 'cloud') {
        const state = this.#persistent?.status?.(row.id) ?? { status: settings.transportStatus ?? 'idle' };
        if (state.status === 'open') {
          return this.#check(
            'outbound',
            true,
            'outbound_ready_for_explicit_recipient',
            'WhatsApp QR can send to explicit phone numbers or JIDs. No default recipient is saved yet.',
            'Save a default recipient only if you want requests like "send this to default target" to work without a number.',
          );
        }
      }
      const remediation = row.kind === 'telegram'
        ? 'Send /start to the bot, then save the numeric chat ID or wait for Agentis to record the first inbound chat.'
        : row.kind === 'whatsapp'
          ? 'Save a default recipient number/JID or send the agent a message so Agentis can record it.'
          : row.kind === 'slack'
            ? 'Save a default Slack channel ID, then invite the bot to that channel.'
            : 'Save a default Discord channel ID the bot can send to.';
      return this.#check('outbound', false, 'missing_default_target', 'No default destination is configured for outbound tests.', remediation);
    }
    try {
      const normalized = this.#normalizeTargetForKind(row.kind as ChannelKind, chatId);
      const selfCheck = await this.#telegramSelfTargetCheck(row, normalized);
      if (selfCheck) return selfCheck;
      const receipt = await this.#sendRow(row, normalized, opts.body);
      return this.#check(
        'outbound',
        true,
        'outbound_send_ok',
        `Provider accepted the test message for ${normalized} (id ${receipt.providerMessageId}).`,
      );
    } catch (err) {
      return this.#check(
        'outbound',
        false,
        'outbound_send_failed',
        (err as Error).message || 'Outbound test message failed.',
        'Fix the provider-specific send error, then run Test again.',
      );
    }
  }

  #inboundCheck(row: ChannelConnectionRow, settings: ChannelSettings): ChannelHealthCheck {
    if (row.kind === 'discord' && settings.transport !== 'gateway') {
      return this.#check('inbound', true, 'discord_outbound_only', 'Discord is configured for outbound-only REST mode.');
    }
    if (this.#persistent?.handles({ id: row.id, kind: row.kind, settings })) {
      const state = this.#persistent.status?.(row.id) ?? { status: settings.transportStatus ?? 'idle' };
      if (state.status !== 'open') {
        return this.#check('inbound', false, 'inbound_transport_not_open', `${row.kind} cannot receive messages until the live transport is open.`, 'Relink or restart the live connection.');
      }
      if (!settings.defaultChatId) {
        return row.kind === 'whatsapp'
          ? this.#check('inbound', true, 'inbound_live_ready_no_default', 'WhatsApp live inbound is ready. No default recipient is saved yet.')
          : this.#check('inbound', false, 'needs_first_inbound', `${row.kind} can receive messages, but no default reply target is known yet.`, 'Send a message to this agent from the channel so Agentis can record the first chat as the default target.');
      }
      return this.#check('inbound', true, 'inbound_live_ready', `${row.kind} live inbound is ready.`);
    }
    if (this.#isWhatsAppCloud(row.kind as ChannelKind, settings)) {
      if (!this.#publicWebhookUrl(row.id)) {
        return this.#check('inbound', false, 'missing_public_url', 'WhatsApp Cloud webhooks need a public Agentis URL.', 'Set AGENTIS_PUBLIC_URL and configure the Meta webhook callback URL.');
      }
      if (!settings.appSecretEncrypted || !settings.verifyTokenEncrypted) {
        return this.#check('inbound', false, 'missing_cloud_webhook_secret', 'WhatsApp Cloud webhook secrets are missing.', 'Save the app secret and verify token.');
      }
      return this.#check('inbound', true, 'whatsapp_cloud_webhook_ready', 'WhatsApp Cloud webhook verification is configured.');
    }
    if (row.kind === 'slack' && !settings.signingSecretEncrypted) {
      return this.#check('inbound', false, 'missing_signing_secret', 'Slack Events API signing secret is missing.', 'Save the Slack signing secret so Agentis can verify URL verification and event callbacks.');
    }
    if (!this.#publicWebhookUrl(row.id)) {
      return this.#check('inbound', false, 'missing_public_url', `${row.kind} inbound webhooks need a public Agentis URL.`, 'Set AGENTIS_PUBLIC_URL and configure the provider webhook callback URL.');
    }
    return this.#check('inbound', true, 'webhook_inbound_ready', `${row.kind} inbound webhook endpoint is ready.`);
  }

  async #runtimeCheck(row: ChannelConnectionRow): Promise<ChannelHealthCheck> {
    // Workspace-owned (agentless) connection: no specific agent runtime to probe —
    // inbound routes to the orchestrator, deterministic sends need no runtime.
    if (!row.agentId) {
      return this.#check('runtime', true, 'workspace_connection', 'Workspace-owned connection — inbound routes to the orchestrator; no dedicated agent runtime.');
    }
    const ownerAgentId = row.agentId;
    if (this.deps.runtimeHealth) {
      try {
        return await this.deps.runtimeHealth({ workspaceId: row.workspaceId, agentId: ownerAgentId });
      } catch (err) {
        return this.#check(
          'runtime',
          false,
          'runtime_probe_failed',
          (err as Error).message || 'Agent runtime probe failed.',
          'Fix the agent runtime, then test the channel again.',
        );
      }
    }
    const agent = this.deps.db.select({ id: schema.agents.id }).from(schema.agents).where(eq(schema.agents.id, ownerAgentId)).get();
    return agent
      ? this.#check('runtime', true, 'agent_runtime_target_exists', 'Channel is attached to an existing agent runtime target.')
      : this.#check('runtime', false, 'agent_missing', 'The connected agent no longer exists.', 'Reconnect the channel to an existing agent.');
  }

  async #sendRow(row: ChannelConnectionRow, chatId: string, body: string, attachments: OutboundAttachment[] = []): Promise<ChannelDeliveryReceipt> {
    const settings = this.#settings(row);
    const normalizedChatId = this.#normalizeTargetForKind(row.kind as ChannelKind, chatId);
    const selfCheck = await this.#telegramSelfTargetCheck(row, normalizedChatId);
    if (selfCheck) {
      throw new AgentisError('CHANNEL_SEND_FAILED', `${selfCheck.message} ${selfCheck.remediation ?? ''}`.trim());
    }
    if (this.#persistent?.handles({ id: row.id, kind: row.kind, settings })) {
      return this.#persistent.send(row.id, normalizedChatId, body, attachments.length ? attachments : undefined);
    }
    if (this.#isWhatsAppCloud(row.kind as ChannelKind, settings)) {
      return this.#sendWhatsAppCloud(row, settings, normalizedChatId, body, attachments);
    }
    const adapter = this.#requireAdapter(row.kind as ChannelKind);
    const token = this.deps.vault.decrypt(row.tokenEncrypted);
    return adapter.send({
      token,
      chatId: normalizedChatId,
      body,
      settings: settings as Record<string, unknown>,
      ...(attachments.length ? { attachments } : {}),
    });
  }

  /** Resolve loose attachment references into uploadable bytes (artifact ids, data/http URLs). */
  async #resolveAttachments(workspaceId: string, refs: OutboundAttachmentRef[] | undefined): Promise<OutboundAttachment[]> {
    if (!refs || refs.length === 0) return [];
    if (!this.deps.artifacts) {
      throw new AgentisError('VALIDATION_FAILED', 'channel attachments require the artifact service (not wired)');
    }
    const out: OutboundAttachment[] = [];
    for (const ref of refs) {
      const source = ref.artifactId ?? ref.url;
      if (!source || !source.trim()) {
        throw new AgentisError('VALIDATION_FAILED', 'each attachment needs an artifactId or url');
      }
      const hint: { filename?: string; mimeType?: string } = {};
      if (ref.filename) hint.filename = ref.filename;
      if (ref.mimeType) hint.mimeType = ref.mimeType;
      const resolved = await this.deps.artifacts.resolveBytes(workspaceId, source, hint);
      const kind = ref.kind ?? (resolved.mimeType.startsWith('image/') ? 'image' : 'file');
      out.push({ kind, filename: resolved.filename, mimeType: resolved.mimeType, data: resolved.buffer });
    }
    return out;
  }

  async #sendWhatsAppCloud(row: ChannelConnectionRow, settings: ChannelSettings, chatId: string, body: string, attachments: OutboundAttachment[] = []): Promise<ChannelDeliveryReceipt> {
    const phoneNumberId = settings.phoneNumberId;
    if (!phoneNumberId) {
      throw new AgentisError('VALIDATION_FAILED', 'WhatsApp Cloud phone number ID is missing');
    }
    const token = this.deps.vault.decrypt(row.tokenEncrypted);
    if (attachments.length > 0) {
      // First attachment carries the body as its caption; the rest go captionless.
      const receipts: ChannelDeliveryReceipt[] = [];
      for (let i = 0; i < attachments.length; i += 1) {
        receipts.push(await this.#sendWhatsAppCloudMedia(token, phoneNumberId, chatId, attachments[i]!, i === 0 ? body : ''));
      }
      const first = receipts[0]!;
      return { ...first, providerMessageIds: receipts.map((receipt) => receipt.providerMessageId) };
    }
    const res = await fetch(`https://graph.facebook.com/${GRAPH_API_VERSION}/${encodeURIComponent(phoneNumberId)}/messages`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: chatId,
        type: 'text',
        text: { preview_url: false, body },
      }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new AgentisError(
        'CHANNEL_SEND_FAILED',
        `whatsapp cloud send failed (${res.status}): ${text.slice(0, 240) || res.statusText}`,
      );
    }
    const json = await res.json().catch(() => ({})) as { messages?: Array<{ id?: string }> };
    const providerMessageId = json.messages?.[0]?.id?.trim() ?? '';
    if (!providerMessageId) {
      throw new AgentisError('CHANNEL_SEND_FAILED', 'whatsapp cloud accepted no provider message id; delivery is unverified');
    }
    return { provider: 'whatsapp', providerMessageId, status: 'accepted', acceptedAt: new Date().toISOString(), recipient: chatId };
  }

  /** Upload media to the WhatsApp Cloud media endpoint, then send a message referencing it. */
  async #sendWhatsAppCloudMedia(token: string, phoneNumberId: string, chatId: string, attachment: OutboundAttachment, caption: string): Promise<ChannelDeliveryReceipt> {
    const base = `https://graph.facebook.com/${GRAPH_API_VERSION}/${encodeURIComponent(phoneNumberId)}`;
    const uploadForm = new FormData();
    uploadForm.set('messaging_product', 'whatsapp');
    uploadForm.set('file', new Blob([new Uint8Array(attachment.data)], { type: attachment.mimeType }), attachment.filename);
    uploadForm.set('type', attachment.mimeType);
    const uploadRes = await fetch(`${base}/media`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: uploadForm,
    });
    const uploadJson = await uploadRes.json().catch(() => ({})) as { id?: string; error?: { message?: string } };
    if (!uploadRes.ok || !uploadJson.id) {
      throw new AgentisError('CHANNEL_SEND_FAILED', `whatsapp cloud media upload failed (${uploadRes.status}): ${uploadJson.error?.message ?? uploadRes.statusText}`);
    }
    const isImage = attachment.kind === 'image';
    const mediaType = isImage ? 'image' : 'document';
    const media: Record<string, unknown> = { id: uploadJson.id };
    if (caption) media.caption = caption;
    if (!isImage) media.filename = attachment.filename;
    const res = await fetch(`${base}/messages`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', to: chatId, type: mediaType, [mediaType]: media }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new AgentisError('CHANNEL_SEND_FAILED', `whatsapp cloud media send failed (${res.status}): ${text.slice(0, 240) || res.statusText}`);
    }
    const json = await res.json().catch(() => ({})) as { messages?: Array<{ id?: string }> };
    const providerMessageId = json.messages?.[0]?.id?.trim() ?? '';
    if (!providerMessageId) {
      throw new AgentisError('CHANNEL_SEND_FAILED', 'whatsapp cloud accepted no provider message id for media; delivery is unverified');
    }
    return { provider: 'whatsapp', providerMessageId, status: 'accepted', acceptedAt: new Date().toISOString(), recipient: chatId };
  }

  #saveHealth(row: ChannelConnectionRow, checks: ChannelHealthCheck[]): ChannelHealth {
    const now = new Date().toISOString();
    const health: ChannelHealth = {
      status: this.#statusFromChecks(checks),
      checks,
      lastTestAt: now,
    };
    const settings = { ...this.#settings(row), health };
    this.deps.db
      .update(schema.channelConnections)
      .set({
        settings,
        status: health.status,
        lastError: checks.find((check) => !check.ok)?.message?.slice(0, 500) ?? null,
        updatedAt: now,
        ...(health.status === 'active' ? { lastEventAt: now } : {}),
      })
      .where(eq(schema.channelConnections.id, row.id))
      .run();
    this.deps.bus.publish(
      REALTIME_ROOMS.workspace(row.workspaceId),
      REALTIME_EVENTS.CHANNEL_CONNECTION_STATUS,
      { connectionId: row.id, kind: row.kind, status: health.status, health },
    );
    return health;
  }

  #healthFromRow(row: ChannelConnectionRow): ChannelHealth {
    const settings = this.#settings(row);
    if (settings.health && Array.isArray(settings.health.checks)) return settings.health;
    return this.#initialHealth(row.kind as ChannelKind, settings, row.status as ChannelStatus);
  }

  #initialHealth(kind: ChannelKind, settings: ChannelSettings, status?: ChannelStatus): ChannelHealth {
    const now = new Date().toISOString();
    const initialStatus = status ?? (kind === 'whatsapp' && settings.mode !== 'cloud' ? 'needs_action' : 'verifying');
    return {
      status: initialStatus,
      checks: DEFAULT_HEALTH_CHECK_NAMES.map((name) => ({
        name,
        ok: false,
        code: 'not_checked',
        message: `${name} has not been checked yet.`,
        remediation: name === 'outbound' ? 'Save the channel and run Test.' : undefined,
        checkedAt: now,
      })),
    };
  }

  #statusFromChecks(checks: ChannelHealthCheck[]): ChannelStatus {
    if (checks.length === 0) return 'verifying';
    if (checks.every((check) => check.ok)) return 'active';
    const failed = checks.filter((check) => !check.ok);
    if (failed.some((check) => check.code.includes('missing') || check.code.includes('needs') || check.code.includes('not_open'))) {
      return 'needs_action';
    }
    if (failed.some((check) => check.name === 'credential' || check.name === 'transport' || check.name === 'outbound')) {
      return 'error';
    }
    return 'degraded';
  }

  #dedupeChecks(checks: ChannelHealthCheck[]): ChannelHealthCheck[] {
    const byName = new Map<ChannelHealthCheckName, ChannelHealthCheck>();
    for (const check of checks) byName.set(check.name, check);
    return DEFAULT_HEALTH_CHECK_NAMES.map((name) => byName.get(name) ?? this.#check(name, false, 'not_checked', `${name} has not been checked yet.`));
  }

  #check(
    name: ChannelHealthCheckName,
    ok: boolean,
    code: string,
    message: string,
    remediation?: string,
  ): ChannelHealthCheck {
    return {
      name,
      ok,
      code,
      message,
      ...(remediation ? { remediation } : {}),
      checkedAt: new Date().toISOString(),
    };
  }

  #settings(row: Pick<ChannelConnectionRow, 'settings'>): ChannelSettings {
    const value = row.settings;
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value as ChannelSettings
      : {};
  }

  #normalizeAliases(kind: ChannelKind, aliases: Record<string, string | null | undefined>): Record<string, string> {
    const normalized: Record<string, string> = {};
    for (const [rawAlias, rawTarget] of Object.entries(aliases)) {
      const alias = this.#normalizeAlias(rawAlias);
      const target = rawTarget?.trim();
      if (alias && target) normalized[alias] = this.#normalizeTargetForKind(kind, target);
    }
    return normalized;
  }

  #normalizeAlias(value: string): string | null {
    const normalized = value.trim().toLowerCase().replace(/\s+/g, ' ');
    if (!normalized || normalized.length > 80) return null;
    return normalized;
  }

  #normalizeTargetForKind(kind: ChannelKind, target: string): string {
    const trimmed = target.trim();
    if (!trimmed) throw new AgentisError('VALIDATION_FAILED', 'channel destination is required');
    if (kind === 'telegram') return this.#normalizeTelegramTarget(trimmed);
    if (kind !== 'whatsapp') return trimmed;
    if (/@(s\.whatsapp\.net|g\.us|newsletter)$/i.test(trimmed)) return trimmed;
    const digits = trimmed.replace(/[^\d]/g, '');
    if (digits.length < 8 || digits.length > 20) {
      throw new AgentisError(
        'VALIDATION_FAILED',
        'WhatsApp destination must be a phone number with country code, a user JID, a group JID, or a newsletter JID',
      );
    }
    return `${digits}@s.whatsapp.net`;
  }

  /**
   * Telegram targets are numeric chat IDs (negative for groups/supergroups) or a
   * public @username. Operators routinely paste the labelled value the Telegram
   * UI shows (e.g. "ID: 7905735992") — strip the surrounding label so we store
   * the bare ID, otherwise sendMessage fails with "chat not found". Only a label
   * that wraps a single id is stripped, so @usernames and other forms pass through
   * untouched.
   */
  #normalizeTelegramTarget(value: string): string {
    if (value.startsWith('@')) return value;
    const match = value.match(/^[^\d-]*(-?\d+)$/);
    return match ? match[1]! : value;
  }

  async #telegramSelfTargetCheck(row: ChannelConnectionRow, chatId: string): Promise<ChannelHealthCheck | null> {
    if (row.kind !== 'telegram') return null;
    if (!this.#adapters.get('telegram')?.probeCredential) return null;
    try {
      const token = this.deps.vault.decrypt(row.tokenEncrypted);
      const res = await fetch(`${TELEGRAM_API}/bot${encodeURIComponent(token)}/getMe`, { method: 'GET' });
      if (!res.ok) return null;
      const json = await res.json().catch(() => ({})) as { ok?: boolean; result?: { id?: number; username?: string } };
      if (json.ok === false) return null;
      const botId = json.result?.id ? String(json.result.id) : '';
      const username = json.result?.username?.replace(/^@/, '').toLowerCase() ?? '';
      const target = chatId.trim().replace(/^@/, '').toLowerCase();
      if (target && (target === botId || (username && target === username))) {
        return this.#check(
          'outbound',
          false,
          'telegram_target_is_bot',
          "Telegram target points to the bot itself. Bots can't send messages to themselves.",
          'Open the bot from your personal Telegram account, send /start, then save that human chat ID as the target.',
        );
      }
    } catch {
      return null;
    }
    return null;
  }

  #isWhatsAppCloud(kind: ChannelKind, settings: ChannelSettings): boolean {
    return kind === 'whatsapp' && settings.mode === 'cloud';
  }

  #publicWebhookUrl(connectionId: string): string | null {
    const base = process.env.AGENTIS_PUBLIC_URL?.replace(/\/+$/, '');
    return base ? `${base}/v1/webhooks/channel/${connectionId}` : null;
  }

  #webhookVerificationSecret(row: ChannelConnectionRow): string | null {
    const settings = this.#settings(row);
    if (row.kind === 'slack') {
      return settings.signingSecretEncrypted ? this.deps.vault.decrypt(settings.signingSecretEncrypted) : null;
    }
    if (this.#isWhatsAppCloud(row.kind as ChannelKind, settings)) {
      return settings.appSecretEncrypted ? this.deps.vault.decrypt(settings.appSecretEncrypted) : null;
    }
    return row.webhookSecret;
  }

  #verifyInbound(row: ChannelConnectionRow, headers: Record<string, string | undefined>, rawBody: string, secret: string | null): boolean {
    const settings = this.#settings(row);
    if (this.#isWhatsAppCloud(row.kind as ChannelKind, settings)) {
      return this.#verifyWhatsAppCloudSignature(headers, rawBody, secret);
    }
    return this.#requireAdapter(row.kind as ChannelKind).verify({ headers, rawBody, secret });
  }

  #verifyWhatsAppCloudSignature(headers: Record<string, string | undefined>, rawBody: string, secret: string | null): boolean {
    if (!secret) return false;
    const presented = headers['x-hub-signature-256'] ?? '';
    if (!presented.startsWith('sha256=')) return false;
    const expected = `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`;
    if (expected.length !== presented.length) return false;
    try {
      return timingSafeEqual(Buffer.from(expected), Buffer.from(presented));
    } catch {
      return false;
    }
  }

  #maybeProviderChallenge(row: ChannelConnectionRow, rawBody: string): unknown | null {
    if (row.kind !== 'slack') return null;
    try {
      const payload = JSON.parse(rawBody) as { type?: string; challenge?: string };
      if (payload.type === 'url_verification' && typeof payload.challenge === 'string') {
        return { challenge: payload.challenge };
      }
    } catch {
      /* normal parser will report invalid JSON */
    }
    return null;
  }

  #parseWhatsAppCloudInbound(rawBody: string): ParsedInboundMessage | null {
    let payload: unknown;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      throw new AgentisError('VALIDATION_FAILED', 'whatsapp cloud webhook body is not JSON');
    }
    const entries = (payload as { entry?: Array<{ changes?: Array<{ value?: { messages?: unknown[] } }> }> }).entry ?? [];
    for (const entry of entries) {
      for (const change of entry.changes ?? []) {
        const messages = change.value?.messages ?? [];
        for (const item of messages) {
          const msg = item as {
            id?: string;
            from?: string;
            type?: string;
            text?: { body?: string };
            button?: { text?: string };
            interactive?: { button_reply?: { title?: string }; list_reply?: { title?: string } };
          };
          const body = msg.type === 'text'
            ? msg.text?.body
            : msg.button?.text ?? msg.interactive?.button_reply?.title ?? msg.interactive?.list_reply?.title;
          if (!msg.id || !msg.from || !body) continue;
          return {
            externalId: `whatsapp:${msg.id}`,
            chatId: msg.from,
            body,
            from: msg.from,
          };
        }
      }
    }
    return null;
  }

  #rememberDefaultChat(row: ChannelConnectionRow, chatId: string): void {
    const settings = this.#settings(row);
    if (settings.defaultChatId) return;
    const now = new Date().toISOString();
    this.deps.db
      .update(schema.channelConnections)
      .set({
        settings: { ...settings, defaultChatId: chatId },
        updatedAt: now,
      })
      .where(eq(schema.channelConnections.id, row.id))
      .run();
  }

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

  /** The agent a workspace-owned connection's inbound routes to: the orchestrator
   *  (the workspace front door), else the first agent, else null (no agents). */
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

  #toPublic(row: typeof schema.channelConnections.$inferSelect): PublicConnection {
    const settings = this.#settings(row);
    return {
      id: row.id,
      workspaceId: row.workspaceId,
      ambientId: row.ambientId,
      agentId: row.agentId,
      kind: row.kind as ChannelKind,
      name: row.name,
      status: row.status,
      defaultChatId: settings.defaultChatId ?? null,
      targetAliases: settings.targetAliases ?? {},
      access: settings.access ?? null,
      transport: settings.transport ?? null,
      mode: settings.mode ?? null,
      transportStatus: settings.transportStatus ?? null,
      isDefault: settings.isDefault === true,
      health: this.#healthFromRow(row),
      lastEventAt: row.lastEventAt,
      lastError: row.lastError,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}
