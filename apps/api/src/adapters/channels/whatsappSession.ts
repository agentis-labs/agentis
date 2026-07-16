/**
 * WhatsAppSession — one live baileys WhatsApp Web connection.
 *
 * This is a focused port of OpenClaw's WhatsApp socket handling
 * (`openclaw/extensions/whatsapp/src/session.ts` + `reconnect.ts`), reduced to
 * what Agentis needs for Phase 1 text conversations and kept dependency-light:
 *
 *   - `useMultiFileAuthState(authDir)` persists creds/keys on disk (per
 *     connection), so a restart re-links without a new QR.
 *   - `makeWASocket(...)` with `markOnlineOnConnect:false`, `syncFullHistory:false`.
 *   - QR is surfaced (raw + PNG data URL) for the linked-devices scan.
 *   - `connection.close` triggers backoff reconnect unless we were logged out.
 *   - inbound `messages.upsert` text → `onInbound` (→ ChannelTurnDispatcher).
 *   - `sendText(jid, text)` → `sock.sendMessage`.
 *
 * baileys is loaded lazily so an install without it (or on an unsupported
 * platform) still boots the rest of Agentis — the connection just reports
 * `error` instead of crashing the process. Same pattern as OpenClawAdapter's
 * `ws` loader.
 */

import type { Logger } from '../../logger.js';
import { ChannelDeliveryRejectedError, type ChannelDeliveryReceipt, type ChannelHealthCheck } from './types.js';

export type WhatsAppSessionStatus =
  | 'idle'
  | 'connecting'
  | 'qr'
  | 'open'
  | 'closed'
  | 'logged_out'
  | 'error';

export interface WhatsAppInbound {
  externalId: string;
  chatId: string; // the JID to reply to (key.remoteJid)
  body: string;
  from?: string;
}

export interface WhatsAppObservedOutbound {
  externalId: string;
  chatId: string;
  body: string;
}

export interface WhatsAppSessionOptions {
  connectionId: string;
  authDir: string;
  logger: Logger;
  onInbound: (msg: WhatsAppInbound) => void;
  /** Mirror messages sent from the primary phone or another companion. */
  onOutboundObserved?: (msg: WhatsAppObservedOutbound) => void;
  /** Notified whenever status/QR changes (for the login UI + DB status). */
  onStateChange?: (state: { status: WhatsAppSessionStatus; qr?: string; selfId?: string }) => void;
  /**
   * Provider acknowledgement received after (or during) sendText. This is
   * intentionally separate from the socket write: Baileys' returned key id is
   * a client correlation id until WhatsApp emits a server acknowledgement.
   */
  onDeliveryUpdate?: (update: {
    providerMessageId: string;
    status: ChannelDeliveryReceipt['status'];
    providerStatus: number;
    recipient?: string;
  }) => void;
  /** Optional speech-to-text for voice notes. Returns null to skip. */
  transcribeAudio?: (bytes: Buffer, mimeType: string) => Promise<string | null>;
  /** Optional image understanding. Returns a text description, or null to skip. */
  describeImage?: (bytes: Buffer, mimeType: string, caption?: string) => Promise<string | null>;
  /** Optional document text extraction (PDF / text). Returns text, or null to skip. */
  extractDocument?: (bytes: Buffer, mimeType: string, fileName?: string) => Promise<string | null>;
  /**
   * Optional auth-state loader. When set (vault-backed), creds/keys persist
   * encrypted in the DB instead of plaintext files under `authDir`.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  loadAuthState?: () => Promise<{ state: any; saveCreds: () => Promise<void> }>;
}

// A minimal pino-compatible logger — baileys only needs `.child()` + levels.
// Avoids pulling pino into the dependency graph.
function silentBaileysLogger(): unknown {
  const noop = () => {};
  const logger: Record<string, unknown> = { level: 'silent' };
  for (const m of ['trace', 'debug', 'info', 'warn', 'error', 'fatal']) logger[m] = noop;
  logger.child = () => logger;
  return logger;
}

type BaileysModule = typeof import('baileys');
let cachedBaileys: { ok: true; mod: BaileysModule } | { ok: false; reason: string } | undefined;
async function loadBaileys() {
  if (cachedBaileys) return cachedBaileys;
  try {
    const mod = (await import('baileys' as string)) as BaileysModule & { default?: BaileysModule };
    // baileys (7.x, ESM) exposes its full API as named exports on the module
    // namespace; its `default` export is the bare `makeWASocket` function alone,
    // which lacks initAuthCreds/useMultiFileAuthState/DisconnectReason/etc. So the
    // usual `mod.default ?? mod` interop pattern picks the WRONG object here and
    // every destructured helper comes back undefined. Resolve to whichever object
    // actually carries the API (probe a non-default helper).
    const resolved = (typeof (mod as Partial<BaileysModule>).initAuthCreds === 'function'
      ? mod
      : mod.default) as BaileysModule | undefined;
    if (!resolved || typeof resolved.makeWASocket !== 'function') {
      throw new Error('baileys module did not expose makeWASocket');
    }
    cachedBaileys = { ok: true, mod: resolved };
  } catch (err) {
    cachedBaileys = { ok: false, reason: (err as Error).message };
  }
  return cachedBaileys;
}

const RECONNECT_INITIAL_MS = 2_000;
const RECONNECT_MAX_MS = 30_000;
const RECONNECT_FACTOR = 1.8;
const RECONNECT_MAX_ATTEMPTS = 12;
const DELIVERY_ACK_TIMEOUT_MS = Math.max(1_000, Number(process.env.AGENTIS_WHATSAPP_ACK_TIMEOUT_MS) || 8_000);

type WhatsAppDeliverySignal = {
  status: number;
  errorCode?: string;
  error?: string;
};

type WhatsAppMessageUpdate = {
  status?: unknown;
  messageStubParameters?: unknown;
};

/** Parse both success statuses and Baileys' status=0 provider rejection. */
export function whatsappDeliverySignal(update: WhatsAppMessageUpdate | null | undefined): WhatsAppDeliverySignal | null {
  if (!update) return null;
  const numeric = typeof update.status === 'number' ? update.status : Number(update.status);
  if (!Number.isFinite(numeric)) return null;
  if (numeric > 0) return { status: numeric };
  const params = Array.isArray(update.messageStubParameters) ? update.messageStubParameters : [];
  const errorCode = params[0] == null ? '' : String(params[0]).trim();
  if (!errorCode) return null;
  return { status: 0, errorCode, error: whatsappProviderRejectionMessage(errorCode) };
}

function whatsappProviderRejectionMessage(errorCode: string): string {
  if (errorCode === '463') {
    return 'WhatsApp rejected this linked-device send because a provider reach-out restriction is active (error 463).';
  }
  if (errorCode === '479') {
    return 'WhatsApp rejected the message because the recipient addressing or device session is stale or invalid.';
  }
  return `WhatsApp rejected the message (provider error ${errorCode}).`;
}

export type WhatsAppReachoutRestrictionScope = 'companion' | 'account_or_business' | 'unknown';

/** Interpret provider scope without pretending a companion restriction also blocks the primary phone. */
export function whatsappReachoutRestrictionScope(enforcementType: unknown): WhatsAppReachoutRestrictionScope {
  const value = typeof enforcementType === 'string' ? enforcementType.trim().toUpperCase() : '';
  if (value.includes('COMPANION') || value === 'WEB_COMPANION_ONLY') return 'companion';
  if (value.startsWith('BIZ_')) return 'account_or_business';
  return 'unknown';
}

/** Baileys WebMessageInfo.Status: 2 server, 3 delivered, 4+ read/played. */
export function whatsappDeliveryStatus(status: unknown): ChannelDeliveryReceipt['status'] {
  const numeric = typeof status === 'number' ? status : Number(status);
  if (!Number.isFinite(numeric) || numeric < 2) return 'queued';
  if (numeric >= 4) return 'read';
  if (numeric >= 3) return 'delivered';
  return 'accepted';
}

function normalizeWhatsAppJid(jid: string): string {
  return jid.trim().toLowerCase().replace(/:\d+@/u, '@');
}

export class WhatsAppSession {
  #status: WhatsAppSessionStatus = 'idle';
  #qr: string | undefined;
  #qrDataUrl: string | undefined;
  #selfId: string | undefined;
  #sock: Awaited<ReturnType<BaileysModule['makeWASocket']>> | undefined;
  #closed = false;
  #reconnectAttempts = 0;
  #reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  #startPromise: Promise<void> | undefined;
  // Set during connect — downloads media for the current socket/baileys module.
  #downloadMedia: ((msg: unknown) => Promise<Buffer>) | undefined;
  /** Latest provider acknowledgement per outbound client message id. */
  readonly #deliverySignals = new Map<string, WhatsAppDeliverySignal>();
  readonly #deliveryWaiters = new Map<string, Set<(signal: WhatsAppDeliverySignal) => void>>();
  readonly #deliveryRecipients = new Map<string, string>();
  readonly #locallySubmittedMessageIds = new Set<string>();

  constructor(private readonly opts: WhatsAppSessionOptions) {}

  get status(): WhatsAppSessionStatus { return this.#status; }
  get qr(): string | undefined { return this.#qr; }
  get qrDataUrl(): string | undefined { return this.#qrDataUrl; }
  get selfId(): string | undefined { return this.#selfId; }

  /**
   * Boot the socket. Idempotent while a start is in flight or the session is
   * live (connecting/qr/open). From a terminal state (error/closed/logged_out)
   * it relaunches with a fresh QR, so "generate a new QR" actually works without
   * a server restart.
   */
  async start(): Promise<void> {
    const live = this.#status === 'connecting' || this.#status === 'qr' || this.#status === 'open';
    if (this.#startPromise && live) return this.#startPromise;
    this.#closed = false;
    this.#reconnectAttempts = 0;
    if (this.#reconnectTimer) {
      clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = undefined;
    }
    this.#startPromise = this.#connect().catch((err) => {
      this.opts.logger.warn('whatsapp.start_failed', { connectionId: this.opts.connectionId, err: (err as Error).message });
      this.#setStatus('error');
    });
    return this.#startPromise;
  }

  async stop(): Promise<void> {
    this.#closed = true;
    if (this.#reconnectTimer) clearTimeout(this.#reconnectTimer);
    try { this.#sock?.end?.(undefined); } catch { /* best-effort */ }
    this.#sock = undefined;
    this.#startPromise = undefined;
    this.#deliverySignals.clear();
    this.#deliveryWaiters.clear();
    this.#deliveryRecipients.clear();
    this.#locallySubmittedMessageIds.clear();
    this.#setStatus('closed');
  }

  /** Send a text message to a JID. Throws if the socket isn't open. */
  async sendText(jid: string, text: string): Promise<ChannelDeliveryReceipt> {
    if (!this.#sock || this.#status !== 'open') {
      throw new Error(`whatsapp session ${this.opts.connectionId} is not open (status=${this.#status})`);
    }
    // Reply to the exact JID the message came from (baileys threads it back to the
    // same chat — including `@lid` chats). Do NOT remap LID→PN: that resolves to a
    // different identity and lands the reply in a phantom chat.
    // Resolve explicit phone-number JIDs first. A socket write can otherwise
    // resolve for an invalid/unregistered address while no real chat exists.
    // Provider-native LIDs/groups are intentionally left untouched.
    let recipient = jid;
    if (jid.endsWith('@s.whatsapp.net') && typeof this.#sock.onWhatsApp === 'function') {
      const matches = await this.#sock.onWhatsApp(jid);
      const match = Array.isArray(matches)
        ? matches.find((entry: { exists?: boolean }) => entry?.exists === true)
        : undefined;
      if (!match) throw new Error(`whatsapp recipient ${jid} is not registered or could not be resolved`);
      if (typeof match.jid === 'string' && match.jid) recipient = match.jid;
    }
    const sent = await this.#sock.sendMessage(recipient, { text });
    const providerMessageId = typeof sent?.key?.id === 'string' ? sent.key.id.trim() : '';
    if (!providerMessageId) {
      throw new Error('whatsapp provider accepted no message id; outbound delivery is unverified');
    }
    this.#locallySubmittedMessageIds.add(providerMessageId);
    if (this.#locallySubmittedMessageIds.size > 2_000) {
      const oldest = this.#locallySubmittedMessageIds.values().next().value as string | undefined;
      if (oldest) this.#locallySubmittedMessageIds.delete(oldest);
    }
    const providerRecipient = typeof sent?.key?.remoteJid === 'string' && sent.key.remoteJid
      ? sent.key.remoteJid
      : recipient;
    if (normalizeWhatsAppJid(providerRecipient) !== normalizeWhatsAppJid(recipient)) {
      throw new Error(`whatsapp provider recipient mismatch: resolved ${recipient}, submitted ${providerRecipient}`);
    }
    this.#deliveryRecipients.set(providerMessageId, providerRecipient);
    const immediateStatus = typeof sent?.status === 'number' ? sent.status : 0;
    const signal = immediateStatus >= 2
      ? { status: immediateStatus }
      : await this.#waitForDeliveryAck(providerMessageId, DELIVERY_ACK_TIMEOUT_MS);
    if (signal.errorCode) {
      let rejectionMessage = signal.error ?? whatsappProviderRejectionMessage(signal.errorCode);
      let remediation = signal.errorCode === '463'
        ? 'Inspect the linked-device reach-out restriction and do not retry the same companion transport until its enforcement window ends.'
        : 'Relink the WhatsApp connection or refresh the recipient identity before one controlled retry.';
      if (signal.errorCode === '463' && typeof this.#sock.fetchAccountReachoutTimelock === 'function') {
        try {
          const timelock = await this.#sock.fetchAccountReachoutTimelock();
          const scope = whatsappReachoutRestrictionScope(timelock?.enforcementType);
          const ends = timelock?.timeEnforcementEnds instanceof Date
            ? timelock.timeEnforcementEnds.toISOString()
            : undefined;
          if (scope === 'companion') {
            rejectionMessage = `WhatsApp rejected the Agentis linked-device send because companion outbound is restricted${timelock?.enforcementType ? ` (${timelock.enforcementType})` : ''}${ends ? ` until ${ends}` : ''}. The primary phone app may still send normally.`;
            remediation = 'Pause outbound sends from this linked Agentis session until the companion restriction expires. A successful phone-app send does not prove the linked companion is unblocked.';
          }
        } catch {
          // Preserve the provider rejection even when the diagnostic query is unavailable.
        }
      }
      throw new ChannelDeliveryRejectedError(
        'whatsapp',
        providerMessageId,
        signal.errorCode,
        rejectionMessage,
        remediation,
      );
    }
    const providerStatus = signal.status;
    const status = whatsappDeliveryStatus(providerStatus);
    return {
      provider: 'whatsapp',
      providerMessageId,
      status,
      acceptedAt: new Date().toISOString(),
      recipient: providerRecipient,
      requestedRecipient: jid,
      resolvedRecipient: recipient,
      providerRecipient,
      providerAcknowledged: status !== 'queued',
      providerStatus,
    };
  }

  async #waitForDeliveryAck(messageId: string, timeoutMs: number): Promise<WhatsAppDeliverySignal> {
    const known = this.#deliverySignals.get(messageId);
    if (known && (known.status >= 2 || known.errorCode)) return known;
    return await new Promise<WhatsAppDeliverySignal>((resolve) => {
      let settled = false;
      const finish = (signal: WhatsAppDeliverySignal) => {
        if (settled || (signal.status < 2 && !signal.errorCode)) return;
        settled = true;
        clearTimeout(timer);
        const waiters = this.#deliveryWaiters.get(messageId);
        waiters?.delete(finish);
        if (waiters?.size === 0) this.#deliveryWaiters.delete(messageId);
        resolve(signal);
      };
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.#deliveryWaiters.get(messageId)?.delete(finish);
        if (this.#deliveryWaiters.get(messageId)?.size === 0) this.#deliveryWaiters.delete(messageId);
        resolve(this.#deliverySignals.get(messageId) ?? { status: 0 });
      }, timeoutMs);
      timer.unref?.();
      const waiters = this.#deliveryWaiters.get(messageId) ?? new Set<(signal: WhatsAppDeliverySignal) => void>();
      waiters.add(finish);
      this.#deliveryWaiters.set(messageId, waiters);
      const raced = this.#deliverySignals.get(messageId);
      if (raced && (raced.status >= 2 || raced.errorCode)) finish(raced);
    });
  }

  #recordDeliveryAck(messageId: string, status: number): void {
    if (!messageId || !Number.isFinite(status)) return;
    const previous = this.#deliverySignals.get(messageId);
    if (previous?.errorCode || status <= (previous?.status ?? 0)) return;
    const signal = { status };
    this.#deliverySignals.set(messageId, signal);
    for (const resolve of this.#deliveryWaiters.get(messageId) ?? []) resolve(signal);
    if (status >= 2) {
      try {
        this.opts.onDeliveryUpdate?.({
          providerMessageId: messageId,
          status: whatsappDeliveryStatus(status),
          providerStatus: status,
          ...(this.#deliveryRecipients.get(messageId) ? { recipient: this.#deliveryRecipients.get(messageId) } : {}),
        });
      } catch (err) {
        this.opts.logger.warn('whatsapp.delivery_update_handler_failed', {
          connectionId: this.opts.connectionId,
          providerMessageId: messageId,
          err: (err as Error).message,
        });
      }
    }
    // Bound cache growth for long-lived sessions.
    if (this.#deliverySignals.size > 2_000) {
      const oldest = this.#deliverySignals.keys().next().value as string | undefined;
      if (oldest) {
        this.#deliverySignals.delete(oldest);
        this.#deliveryRecipients.delete(oldest);
      }
    }
  }

  #recordDeliveryRejection(messageId: string, signal: WhatsAppDeliverySignal): void {
    if (!messageId || !signal.errorCode) return;
    this.#deliverySignals.set(messageId, signal);
    for (const resolve of this.#deliveryWaiters.get(messageId) ?? []) resolve(signal);
    this.opts.logger.warn('whatsapp.delivery_rejected', {
      connectionId: this.opts.connectionId,
      providerMessageId: messageId,
      providerErrorCode: signal.errorCode,
    });
  }

  /** Read-only provider account checks. This never sends a user-visible message. */
  async outboundHealthCheck(): Promise<ChannelHealthCheck> {
    const checkedAt = new Date().toISOString();
    if (!this.#sock || this.#status !== 'open') {
      return {
        name: 'outbound', ok: false, code: 'whatsapp_transport_not_open',
        message: `WhatsApp transport is ${this.#status}.`,
        remediation: 'Relink or restart the WhatsApp connection.', checkedAt,
      };
    }
    try {
      const [timelockResult, capResult] = await Promise.allSettled([
        this.#sock.fetchAccountReachoutTimelock?.(),
        this.#sock.fetchNewChatMessageCap?.(),
      ]);
      const timelock = timelockResult.status === 'fulfilled' ? timelockResult.value : undefined;
      const cap = capResult.status === 'fulfilled' ? capResult.value : undefined;
      if (timelock?.isActive) {
        const enforcementType = typeof timelock.enforcementType === 'string' ? timelock.enforcementType : undefined;
        const scope = whatsappReachoutRestrictionScope(enforcementType);
        const ends = timelock.timeEnforcementEnds instanceof Date
          ? timelock.timeEnforcementEnds.toISOString()
          : undefined;
        const companion = scope === 'companion';
        return {
          name: 'outbound', ok: false,
          code: companion ? 'whatsapp_companion_outbound_timelocked' : 'whatsapp_reachout_timelocked',
          message: companion
            ? `WhatsApp has restricted outbound sends from linked companion devices${enforcementType ? ` (${enforcementType})` : ''}${ends ? ` until ${ends}` : ''}. The primary phone app can remain usable and may show no warning.`
            : `WhatsApp reports an active reach-out restriction${enforcementType ? ` (${enforcementType})` : ''}${ends ? ` until ${ends}` : ''}.`,
          remediation: companion
            ? 'Pause Agentis QR-session outbound until the companion restriction expires. Do not use successful primary-phone sends as evidence that this linked transport is ready.'
            : 'Pause affected outbound automation until WhatsApp lifts the restriction; do not repeatedly retry rejected recipients.',
          evidence: {
            providerErrorCode: '463',
            enforcementType: enforcementType ?? null,
            restrictionScope: scope,
            appliesToTransport: 'whatsapp_linked_companion',
            primaryPhoneMayRemainUsable: companion,
            enforcementEndsAt: ends ?? null,
            newChatCap: cap ?? null,
          },
          checkedAt,
        };
      }
      const total = typeof cap?.total_quota === 'number' ? cap.total_quota : undefined;
      const used = typeof cap?.used_quota === 'number' ? cap.used_quota : undefined;
      if (cap?.capping_status === 'CAPPED' || (total !== undefined && used !== undefined && total > 0 && used >= total)) {
        return {
          name: 'outbound', ok: false, code: 'whatsapp_new_chat_cap_reached',
          message: `WhatsApp's new-chat limit is exhausted${total !== undefined && used !== undefined ? ` (${used}/${total})` : ''}. Existing chats may still work.`,
          remediation: 'Wait for the provider quota cycle to reset or use an approved WhatsApp Business API transport.', checkedAt,
        };
      }
      const quota = total !== undefined && used !== undefined ? ` New-chat usage: ${used}/${total}.` : '';
      return {
        name: 'outbound', ok: true,
        code: cap?.capping_status && cap.capping_status !== 'NONE'
          ? 'whatsapp_new_chat_limit_warning'
          : 'whatsapp_outbound_account_ready',
        message: `WhatsApp reports no active reach-out timelock.${quota}`,
        checkedAt,
      };
    } catch (err) {
      return {
        name: 'outbound', ok: false, code: 'whatsapp_account_probe_failed',
        message: `Could not inspect WhatsApp outbound account state: ${(err as Error).message}`,
        remediation: 'Confirm the linked session is healthy, then run Channel Test again.', checkedAt,
      };
    }
  }

  /** Show/clear the "typing…" presence in a chat (best-effort). */
  async setTyping(jid: string, on: boolean): Promise<void> {
    if (!this.#sock || this.#status !== 'open') return;
    try {
      await this.#sock.sendPresenceUpdate(on ? 'composing' : 'paused', jid);
    } catch {
      /* presence is best-effort */
    }
  }


  async #connect(): Promise<void> {
    const loaded = await loadBaileys();
    if (!loaded.ok) {
      this.opts.logger.warn('whatsapp.baileys_unavailable', { reason: loaded.reason });
      this.#setStatus('error');
      return;
    }
    const baileys = loaded.mod;
    const { makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion, makeCacheableSignalKeyStore, DisconnectReason, Browsers, downloadMediaMessage } = baileys;
    const browser: [string, string, string] =
      typeof Browsers?.appropriate === 'function' ? Browsers.appropriate('Agentis') : ['Agentis', 'Chrome', '1.0.0'];

    this.#setStatus('connecting');
    // Vault-backed auth state when provided; otherwise baileys' on-disk files.
    const { state, saveCreds } = this.opts.loadAuthState
      ? await this.opts.loadAuthState()
      : await useMultiFileAuthState(this.opts.authDir);
    const logger = silentBaileysLogger();
    let version: [number, number, number] | undefined;
    try {
      ({ version } = await fetchLatestBaileysVersion());
    } catch {
      // fall back to baileys' bundled version when the fetch fails offline
    }

    const sock = makeWASocket({
      auth: {
        creds: state.creds,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        keys: makeCacheableSignalKeyStore(state.keys, logger as any),
      },
      ...(version ? { version } : {}),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      logger: logger as any,
      browser,
      syncFullHistory: false,
      markOnlineOnConnect: false,
    });
    this.#sock = sock;
    const silentLog = logger;
    this.#downloadMedia = (msg: unknown) =>
      downloadMediaMessage(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        msg as any,
        'buffer',
        {},
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { logger: silentLog as any, reuploadRequest: sock.updateMediaMessage },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ) as Promise<Buffer>;

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr } = update;
      if (qr) {
        void this.#onQr(qr);
      }
      if (connection === 'open') {
        this.#reconnectAttempts = 0;
        this.#qr = undefined;
        this.#qrDataUrl = undefined;
        this.#selfId = sock.user?.id;
        this.#setStatus('open');
      } else if (connection === 'close') {
        const statusCode = readDisconnectStatus(lastDisconnect?.error);
        const loggedOut = statusCode === DisconnectReason.loggedOut;
        if (loggedOut) {
          this.opts.logger.warn('whatsapp.logged_out', { connectionId: this.opts.connectionId });
          this.#setStatus('logged_out');
          return;
        }
        this.#setStatus('closed');
        this.#scheduleReconnect();
      }
    });

    sock.ev.on('messages.upsert', (event) => {
      if (event.type !== 'notify') return;
      for (const msg of event.messages) {
        void this.#handleMessage(msg).catch((err) => {
          this.opts.logger.warn('whatsapp.inbound_handler_threw', { err: (err as Error).message });
        });
      }
    });

    // `sendMessage()` returning an id proves only local submission. These
    // provider events are the actual server/delivery/read acknowledgement.
    sock.ev.on('messages.update', (updates) => {
      for (const item of updates) {
        const id = typeof item.key?.id === 'string' ? item.key.id : '';
        const signal = whatsappDeliverySignal(item.update as WhatsAppMessageUpdate);
        if (!id || !signal) continue;
        if (signal.errorCode) this.#recordDeliveryRejection(id, signal);
        else if (signal.status > 0) this.#recordDeliveryAck(id, signal.status);
      }
    });
    sock.ev.on('message-receipt.update', (updates) => {
      for (const item of updates) {
        const id = typeof item.key?.id === 'string' ? item.key.id : '';
        const receipt = item.receipt as { receiptTimestamp?: unknown; readTimestamp?: unknown; playedTimestamp?: unknown };
        const status = receipt.playedTimestamp || receipt.readTimestamp ? 4 : receipt.receiptTimestamp ? 3 : 0;
        if (id && status > 0) this.#recordDeliveryAck(id, status);
      }
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async #handleMessage(msg: any): Promise<void> {
    const key = msg?.key;
    if (!key) return;
    if (key.fromMe) {
      const externalId = typeof key.id === 'string' ? key.id.trim() : '';
      if (!externalId || this.#locallySubmittedMessageIds.has(externalId)) return;
      const chatId = observedWhatsAppChatJid(key);
      if (!chatId || chatId === 'status@broadcast') return;
      const body = extractWhatsAppText(msg.message) ?? '[Outbound WhatsApp message]';
      // Allow the explicit Agentis send path to persist its provider id first.
      // The supervisor performs a second durable dedupe before mirroring.
      const timer = setTimeout(() => this.opts.onOutboundObserved?.({ externalId, chatId, body }), 750);
      if (typeof timer === 'object' && 'unref' in timer) timer.unref();
      return;
    }
    await this.#handleInbound(msg);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async #handleInbound(msg: any): Promise<void> {
    const key = msg?.key;
    if (!key || key.fromMe) return;
    const remoteJid: string | undefined = key.remoteJid;
    if (!remoteJid || remoteJid === 'status@broadcast') return;
    // baileys 7.x addresses many 1:1 chats by a hidden LID (`<id>@lid`). The same
    // message carries the sender's real phone-number JID in `remoteJidAlt` (from
    // the stanza's sender_pn). Key the chat off the PN so the conversation uses a
    // real number and replies thread back to the user's normal WhatsApp chat —
    // replying to the raw @lid lands in a phantom chat. Non-LID chats are
    // unchanged, and we fall back to the LID if no PN alt is present.
    const chatJid = observedWhatsAppChatJid(key) ?? remoteJid;
    if (chatJid !== remoteJid) {
      this.opts.logger.info('whatsapp.lid_mapped_to_pn', { connectionId: this.opts.connectionId, lid: remoteJid, repliesTo: chatJid });
    } else if (remoteJid.endsWith('@lid')) {
      // LID chat with no phone-number alt in the stanza — we can only reply to the
      // LID, which may not thread. Surface it so the cause is visible if it recurs.
      this.opts.logger.warn('whatsapp.lid_no_pn_alt', { connectionId: this.opts.connectionId, lid: remoteJid });
    }
    const externalId = String(key.id ?? `${chatJid}:${msg.messageTimestamp ?? Date.now()}`);
    const from = msg.pushName ? String(msg.pushName) : undefined;

    let body = extractWhatsAppText(msg.message);

    // Voice note → transcribe to text (OMNICHANNEL §3.3). Only when a
    // transcription model is configured; otherwise the voice note is skipped.
    if (!body) {
      const audio = unwrapAudioMessage(msg.message);
      if (audio && this.opts.transcribeAudio && this.#downloadMedia) {
        try {
          const bytes = await this.#downloadMedia(msg);
          const transcript = await this.opts.transcribeAudio(bytes, String(audio.mimetype ?? 'audio/ogg'));
          if (transcript) body = `🎤 ${transcript}`;
        } catch (err) {
          this.opts.logger.warn('whatsapp.transcribe_failed', { err: (err as Error).message });
        }
      }
    }

    // Image → describe via the vision model (OMNICHANNEL §3.3 media ingestion).
    if (!body) {
      const image = unwrapImageMessage(msg.message);
      if (image && this.opts.describeImage && this.#downloadMedia) {
        try {
          const bytes = await this.#downloadMedia(msg);
          const caption = typeof image.caption === 'string' ? image.caption : undefined;
          const description = await this.opts.describeImage(bytes, String(image.mimetype ?? 'image/jpeg'), caption);
          if (description) body = `??? ${description}`;
        } catch (err) {
          this.opts.logger.warn('whatsapp.describe_image_failed', { err: (err as Error).message });
        }
      }
    }

    // Document (PDF / text) → extract text so the orchestrator can read it.
    if (!body) {
      const doc = unwrapDocumentMessage(msg.message);
      if (doc && this.opts.extractDocument && this.#downloadMedia) {
        try {
          const bytes = await this.#downloadMedia(msg);
          const fileName = typeof doc.fileName === 'string' ? doc.fileName : undefined;
          const text = await this.opts.extractDocument(bytes, String(doc.mimetype ?? 'application/octet-stream'), fileName);
          if (text) {
            const label = fileName ? `📄 ${fileName}\n` : '📄 ';
            body = `${label}${text}`;
          }
        } catch (err) {
          this.opts.logger.warn('whatsapp.extract_document_failed', { err: (err as Error).message });
        }
      }
    }

    if (!body) return; // nothing usable (non-text, no transcription/description/extraction)
    this.opts.onInbound({ externalId, chatId: chatJid, body, ...(from ? { from } : {}) });
  }

  async #onQr(qr: string): Promise<void> {
    this.#qr = qr;
    this.#setStatus('qr');
    try {
      const qrcode = (await import('qrcode' as string)) as typeof import('qrcode');
      this.#qrDataUrl = await qrcode.toDataURL(qr);
      this.#emitState();
    } catch (err) {
      this.opts.logger.debug?.('whatsapp.qr_render_failed', { err: (err as Error).message });
    }
  }

  #scheduleReconnect(): void {
    if (this.#closed) return;
    if (this.#reconnectAttempts >= RECONNECT_MAX_ATTEMPTS) {
      this.opts.logger.warn('whatsapp.reconnect_exhausted', { connectionId: this.opts.connectionId });
      this.#setStatus('error');
      return;
    }
    const delay = Math.min(
      RECONNECT_MAX_MS,
      Math.round(RECONNECT_INITIAL_MS * RECONNECT_FACTOR ** this.#reconnectAttempts * (0.85 + Math.random() * 0.3)),
    );
    this.#reconnectAttempts += 1;
    this.#reconnectTimer = setTimeout(() => {
      this.#startPromise = this.#connect().catch((err) => {
        this.opts.logger.warn('whatsapp.reconnect_failed', { connectionId: this.opts.connectionId, err: (err as Error).message });
        this.#scheduleReconnect();
      });
    }, delay);
  }

  #setStatus(status: WhatsAppSessionStatus): void {
    if (this.#status === status && status !== 'qr') return;
    this.#status = status;
    this.#emitState();
  }

  #emitState(): void {
    this.opts.onStateChange?.({
      status: this.#status,
      ...(this.#qr ? { qr: this.#qr } : {}),
      ...(this.#selfId ? { selfId: this.#selfId } : {}),
    });
  }
}

function observedWhatsAppChatJid(key: { remoteJid?: unknown; remoteJidAlt?: unknown }): string | null {
  const remoteJid = typeof key.remoteJid === 'string' ? key.remoteJid : '';
  if (!remoteJid) return null;
  const remoteJidAlt = typeof key.remoteJidAlt === 'string' ? key.remoteJidAlt : '';
  return remoteJid.endsWith('@lid') && remoteJidAlt.includes('@s.whatsapp.net')
    ? remoteJidAlt.replace(/:\d+@/u, '@')
    : remoteJid;
}

/**
 * Extract the human-visible text from a baileys message (port of OpenClaw's
 * `extract.ts` `extractText`, reduced to the common text shapes). Walks the
 * common wrapper messages so ephemeral/viewOnce text still resolves.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function extractWhatsAppText(message: any): string | undefined {
  let m = message;
  // Unwrap the common envelope wrappers.
  for (let i = 0; i < 4 && m && typeof m === 'object'; i += 1) {
    const inner = m.ephemeralMessage?.message
      ?? m.viewOnceMessage?.message
      ?? m.viewOnceMessageV2?.message
      ?? m.viewOnceMessageV2Extension?.message
      ?? m.documentWithCaptionMessage?.message;
    if (!inner) break;
    m = inner;
  }
  if (!m || typeof m !== 'object') return undefined;
  const conversation = typeof m.conversation === 'string' ? m.conversation.trim() : '';
  if (conversation) return conversation;
  const extended = m.extendedTextMessage?.text;
  if (typeof extended === 'string' && extended.trim()) return extended.trim();
  const caption = m.imageMessage?.caption ?? m.videoMessage?.caption ?? m.documentMessage?.caption;
  if (typeof caption === 'string' && caption.trim()) return caption.trim();
  return undefined;
}

/** Return the audioMessage (voice note or audio file), unwrapping envelopes. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function unwrapAudioMessage(message: any): { mimetype?: string } | undefined {
  let m = message;
  for (let i = 0; i < 4 && m && typeof m === 'object'; i += 1) {
    if (m.audioMessage) return m.audioMessage as { mimetype?: string };
    const inner = m.ephemeralMessage?.message
      ?? m.viewOnceMessage?.message
      ?? m.viewOnceMessageV2?.message
      ?? m.viewOnceMessageV2Extension?.message;
    if (!inner) break;
    m = inner;
  }
  return undefined;
}

/** Return the imageMessage (or image-mime document), unwrapping envelopes. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function unwrapImageMessage(message: any): { mimetype?: string; caption?: string } | undefined {
  let m = message;
  for (let i = 0; i < 4 && m && typeof m === 'object'; i += 1) {
    if (m.imageMessage) return m.imageMessage as { mimetype?: string; caption?: string };
    const doc = m.documentMessage;
    if (doc && typeof doc.mimetype === 'string' && doc.mimetype.startsWith('image/')) {
      return doc as { mimetype?: string; caption?: string };
    }
    const inner = m.ephemeralMessage?.message
      ?? m.viewOnceMessage?.message
      ?? m.viewOnceMessageV2?.message
      ?? m.viewOnceMessageV2Extension?.message
      ?? m.documentWithCaptionMessage?.message;
    if (!inner) break;
    m = inner;
  }
  return undefined;
}

/** Return a non-image documentMessage (PDF, text, …), unwrapping envelopes. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function unwrapDocumentMessage(message: any): { mimetype?: string; fileName?: string; caption?: string } | undefined {
  let m = message;
  for (let i = 0; i < 4 && m && typeof m === 'object'; i += 1) {
    const doc = m.documentMessage;
    if (doc && !(typeof doc.mimetype === 'string' && doc.mimetype.startsWith('image/'))) {
      return doc as { mimetype?: string; fileName?: string; caption?: string };
    }
    const inner = m.ephemeralMessage?.message
      ?? m.viewOnceMessage?.message
      ?? m.viewOnceMessageV2?.message
      ?? m.documentWithCaptionMessage?.message;
    if (!inner) break;
    m = inner;
  }
  return undefined;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function readDisconnectStatus(error: any): number | undefined {
  const status = error?.output?.statusCode ?? error?.statusCode;
  return typeof status === 'number' ? status : undefined;
}
