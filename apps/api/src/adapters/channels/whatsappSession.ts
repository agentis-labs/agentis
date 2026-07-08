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

export interface WhatsAppSessionOptions {
  connectionId: string;
  authDir: string;
  logger: Logger;
  onInbound: (msg: WhatsAppInbound) => void;
  /** Notified whenever status/QR changes (for the login UI + DB status). */
  onStateChange?: (state: { status: WhatsAppSessionStatus; qr?: string; selfId?: string }) => void;
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
    this.#setStatus('closed');
  }

  /** Send a text message to a JID. Throws if the socket isn't open. */
  async sendText(jid: string, text: string): Promise<void> {
    if (!this.#sock || this.#status !== 'open') {
      throw new Error(`whatsapp session ${this.opts.connectionId} is not open (status=${this.#status})`);
    }
    // Reply to the exact JID the message came from (baileys threads it back to the
    // same chat — including `@lid` chats). Do NOT remap LID→PN: that resolves to a
    // different identity and lands the reply in a phantom chat.
    await this.#sock.sendMessage(jid, { text });
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
        void this.#handleInbound(msg).catch((err) => {
          this.opts.logger.warn('whatsapp.inbound_handler_threw', { err: (err as Error).message });
        });
      }
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async #handleInbound(msg: any): Promise<void> {
    const key = msg?.key;
    if (!key || key.fromMe) return; // ignore our own echoes
    const remoteJid: string | undefined = key.remoteJid;
    if (!remoteJid || remoteJid === 'status@broadcast') return;
    // baileys 7.x addresses many 1:1 chats by a hidden LID (`<id>@lid`). The same
    // message carries the sender's real phone-number JID in `remoteJidAlt` (from
    // the stanza's sender_pn). Key the chat off the PN so the conversation uses a
    // real number and replies thread back to the user's normal WhatsApp chat —
    // replying to the raw @lid lands in a phantom chat. Non-LID chats are
    // unchanged, and we fall back to the LID if no PN alt is present.
    const remoteJidAlt: string | undefined = key.remoteJidAlt;
    const chatJid = remoteJid.endsWith('@lid') && remoteJidAlt && remoteJidAlt.includes('@s.whatsapp.net')
      ? remoteJidAlt.replace(/:\d+@/, '@')
      : remoteJid;
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
