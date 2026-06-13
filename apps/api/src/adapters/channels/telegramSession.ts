/**
 * TelegramSession — one long-polling Telegram bot connection (grammy).
 *
 * The webhook TelegramChannelAdapter needs a public URL; long polling does not,
 * so self-hosted / local installs can run Telegram too (OMNICHANNEL §3.4). A
 * connection opts into this by storing `settings.transport = 'polling'`; the
 * ChannelConnectionSupervisor then owns a live bot here instead of the webhook
 * path. grammy is lazy-loaded so an install without it still boots.
 */

import type { Logger } from '../../logger.js';

export type TelegramSessionStatus = 'idle' | 'starting' | 'open' | 'closed' | 'error';

export interface TelegramInbound {
  externalId: string;
  chatId: string;
  body: string;
  from?: string;
  /** Forum-topic subject boundary, when the message is in a topic. */
  threadId?: string;
}

export interface TelegramSessionOptions {
  connectionId: string;
  token: string;
  logger: Logger;
  onInbound: (msg: TelegramInbound) => void;
  onStateChange?: (state: { status: TelegramSessionStatus }) => void;
}

type GrammyModule = typeof import('grammy');
let cachedGrammy: { ok: true; mod: GrammyModule } | { ok: false; reason: string } | undefined;
async function loadGrammy() {
  if (cachedGrammy) return cachedGrammy;
  try {
    const mod = (await import('grammy' as string)) as GrammyModule;
    cachedGrammy = { ok: true, mod };
  } catch (err) {
    cachedGrammy = { ok: false, reason: (err as Error).message };
  }
  return cachedGrammy;
}

export class TelegramSession {
  #status: TelegramSessionStatus = 'idle';
  #bot: InstanceType<GrammyModule['Bot']> | undefined;
  #startPromise: Promise<void> | undefined;

  constructor(private readonly opts: TelegramSessionOptions) {}

  get status(): TelegramSessionStatus { return this.#status; }

  async start(): Promise<void> {
    if (this.#startPromise) return this.#startPromise;
    this.#startPromise = this.#start();
    return this.#startPromise;
  }

  async stop(): Promise<void> {
    try { await this.#bot?.stop(); } catch { /* best-effort */ }
    this.#bot = undefined;
    this.#startPromise = undefined;
    this.#setStatus('closed');
  }

  async sendText(chatId: string, text: string): Promise<void> {
    if (!this.#bot) throw new Error(`telegram session ${this.opts.connectionId} is not started`);
    await this.#bot.api.sendMessage(chatId, text);
  }

  /** Show the "typing…" chat action (auto-expires ~5s; best-effort). */
  async setTyping(chatId: string, on: boolean): Promise<void> {
    if (!this.#bot || !on) return; // Telegram has no explicit "stop typing"
    try {
      await this.#bot.api.sendChatAction(chatId, 'typing');
    } catch {
      /* best-effort */
    }
  }

  // ── internals ───────────────────────────────────────────

  async #start(): Promise<void> {
    const loaded = await loadGrammy();
    if (!loaded.ok) {
      this.opts.logger.warn('telegram.grammy_unavailable', { reason: loaded.reason });
      this.#setStatus('error');
      return;
    }
    this.#setStatus('starting');
    const bot = new loaded.mod.Bot(this.opts.token);
    this.#bot = bot;

    bot.on('message:text', (ctx) => {
      try {
        const text = ctx.message?.text;
        if (!text) return;
        const chatId = String(ctx.chat.id);
        const topicId = (ctx.message as { message_thread_id?: number } | undefined)?.message_thread_id;
        this.opts.onInbound({
          externalId: String(ctx.update.update_id),
          chatId,
          body: text,
          ...(ctx.from?.first_name ? { from: ctx.from.first_name } : {}),
          ...(topicId ? { threadId: `${chatId}:${topicId}` } : {}),
        });
      } catch (err) {
        this.opts.logger.warn('telegram.inbound_handler_threw', { err: (err as Error).message });
      }
    });

    bot.catch((err) => {
      this.opts.logger.warn('telegram.bot_error', { connectionId: this.opts.connectionId, err: String(err.error ?? err) });
    });

    // bot.start() resolves only when the bot stops — run it detached and flip to
    // 'open' once the long-poll loop is running.
    void bot.start({
      onStart: () => this.#setStatus('open'),
    }).catch((err) => {
      this.opts.logger.warn('telegram.start_failed', { connectionId: this.opts.connectionId, err: (err as Error).message });
      this.#setStatus('error');
    });
  }

  #setStatus(status: TelegramSessionStatus): void {
    if (this.#status === status) return;
    this.#status = status;
    this.opts.onStateChange?.({ status });
  }
}
