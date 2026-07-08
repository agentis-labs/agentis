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

// Auto-recovery for a transient start failure (409 conflict, network blip). A
// 24/7 attendant must heal itself rather than wait for a manual relink, so we
// re-attempt with exponential backoff (capped) until it opens or is stopped.
const RETRY_BASE_MS = 3_000;
const RETRY_MAX_MS = 60_000;
/** A 409 conflict means another poller is active; back off harder so two instances don't thrash. */
const CONFLICT_BASE_MS = 15_000;
/** The poll loop must stay open this long before we treat it as stable and reset the backoff. */
const STABLE_OPEN_MS = 60_000;
/** After this many back-to-back conflicts with no stable open, stand down — another instance owns the bot. */
const CONFLICT_STANDDOWN = 5;
/** Standing-down poke, escalating. The first standdown retry is quick (~45s) so a
 *  *reload ghost* (the previous process's long-poll lingers ~50s after a restart,
 *  then clears) recovers within a minute. But if conflicts PERSIST — another app
 *  genuinely owns this bot token (e.g. a second gateway polling the same bot) —
 *  the delay doubles up to a cap, so we stop spamming 409 retries every 45s and
 *  settle into an occasional poke until the operator stops the other poller. */
const STANDDOWN_BASE_MS = 45_000;
const STANDDOWN_MAX_MS = 600_000;

/** A start failure we should NOT retry — the token/bot is wrong, a relink is required. */
function isPermanentTelegramError(message: string): boolean {
  return /\b401\b|\b403\b|unauthorized|forbidden|invalid token|bot was deleted|not found/i.test(message);
}

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
  /** Set by stop() so an in-flight retry cancels and a closed session stays closed. */
  #stopped = false;
  /** Consecutive failed attempts since the last SUSTAINED open (drives the backoff). */
  #attempt = 0;
  /** Consecutive 409 conflicts with no sustained open — means another instance owns the bot. */
  #conflictStreak = 0;
  #retryTimer: ReturnType<typeof setTimeout> | undefined;
  /** Fires after the poll loop has been open a while; only THEN is the backoff reset. */
  #stableTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly opts: TelegramSessionOptions) {}

  get status(): TelegramSessionStatus { return this.#status; }

  async start(): Promise<void> {
    if (this.#startPromise) return this.#startPromise;
    this.#stopped = false;
    this.#attempt = 0;
    this.#startPromise = this.#attemptStart();
    return this.#startPromise;
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#retryTimer) { clearTimeout(this.#retryTimer); this.#retryTimer = undefined; }
    this.#clearStableTimer();
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


  async #attemptStart(): Promise<void> {
    if (this.#stopped) return;
    const loaded = await loadGrammy();
    if (!loaded.ok) {
      // grammy missing is a deploy issue, not transient — do not retry.
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

    // A webhook registered on the bot makes getUpdates polling fail with
    // 409 Conflict ("terminated by other getUpdates request") — outbound sends
    // fine but the live INBOUND transport never opens. grammy does not clear it,
    // so delete any webhook (and drop the stale backlog so we don't replay old
    // messages on recovery) before starting the long-poll loop.
    try {
      await bot.api.deleteWebhook({ drop_pending_updates: true });
    } catch (err) {
      this.opts.logger.warn('telegram.delete_webhook_failed', { connectionId: this.opts.connectionId, err: (err as Error).message });
    }

    // bot.start() resolves only when the bot stops — run it detached and flip to
    // 'open' once the long-poll loop is running.
    void bot.start({
      drop_pending_updates: true,
      onStart: () => this.#onPollOpen(),
    }).catch((err) => {
      const message = (err as Error).message;
      const conflict = /\b409\b|terminated by other getUpdates|conflict/i.test(message);
      this.#clearStableTimer();
      this.#setStatus('error');
      if (isPermanentTelegramError(message)) {
        this.opts.logger.warn('telegram.start_permanent_failure', { connectionId: this.opts.connectionId, err: message });
        return; // wrong token / forbidden — a relink is required, retrying won't help.
      }
      if (conflict) {
        this.#conflictStreak += 1;
        // Persistent conflict = ANOTHER Agentis instance owns this bot. Stop
        // fighting (the flap) — stand down to a slow poke so the other instance
        // holds the connection; we recover only if it dies. Fix: run ONE instance.
        const standDown = this.#conflictStreak >= CONFLICT_STANDDOWN;
        this.opts.logger.warn(standDown ? 'telegram.conflict_standdown' : 'telegram.start_failed', {
          connectionId: this.opts.connectionId,
          err: message,
          conflictStreak: this.#conflictStreak,
          hint: standDown
            ? 'Another Agentis instance is polling this bot — standing down. Stop the duplicate/orphaned process so this one can own the connection.'
            : 'Another process is polling this bot (or a webhook is set). Ensure only ONE Agentis instance runs this connection.',
        });
        this.#scheduleRetry(standDown
          ? Math.min(STANDDOWN_BASE_MS * 2 ** (this.#conflictStreak - CONFLICT_STANDDOWN), STANDDOWN_MAX_MS)
          : Math.min(CONFLICT_BASE_MS * 2 ** (this.#conflictStreak - 1), RETRY_MAX_MS));
        return;
      }
      // A non-conflict transient error (network blip) — reset the conflict streak.
      this.#conflictStreak = 0;
      this.opts.logger.warn('telegram.start_failed', { connectionId: this.opts.connectionId, err: message });
      this.#scheduleRetry(Math.min(RETRY_BASE_MS * 2 ** this.#attempt, RETRY_MAX_MS));
    });
  }

  /** The long-poll loop is running. Only a SUSTAINED open resets the backoff — a
   *  brief open that's immediately kicked by a competing poller must not, or the
   *  backoff never grows and two instances flap forever. */
  #onPollOpen(): void {
    this.#setStatus('open');
    this.#clearStableTimer();
    this.#stableTimer = setTimeout(() => {
      this.#stableTimer = undefined;
      this.#attempt = 0;
      this.#conflictStreak = 0;
    }, STABLE_OPEN_MS);
    this.#stableTimer.unref?.();
  }

  #clearStableTimer(): void {
    if (this.#stableTimer) { clearTimeout(this.#stableTimer); this.#stableTimer = undefined; }
  }

  /**
   * Re-attempt start after `delayMs`. Each retry re-runs the deleteWebhook + poll
   * path, so a 409 from a lingering webhook clears itself. Cancelled by stop().
   */
  #scheduleRetry(delayMs: number): void {
    if (this.#stopped || this.#retryTimer) return;
    this.#attempt += 1;
    this.opts.logger.info('telegram.retry_scheduled', { connectionId: this.opts.connectionId, attempt: this.#attempt, delayMs });
    this.#retryTimer = setTimeout(() => {
      this.#retryTimer = undefined;
      if (this.#stopped) return;
      // Discard the failed bot before re-attempting (avoids a stuck poll loop).
      void this.#bot?.stop().catch(() => {});
      this.#bot = undefined;
      void this.#attemptStart();
    }, delayMs);
    this.#retryTimer.unref?.();
  }

  #setStatus(status: TelegramSessionStatus): void {
    if (this.#status === status) return;
    this.#status = status;
    this.opts.onStateChange?.({ status });
  }
}
