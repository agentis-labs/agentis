/**
 * DiscordSession — one live Discord gateway connection (discord.js).
 *
 * The DiscordChannelAdapter sends over REST but cannot receive regular messages
 * (Discord delivers those over the gateway, not webhooks). A connection opts
 * into two-way Discord by storing `settings.transport = 'gateway'`; the
 * ChannelConnectionSupervisor then owns a live client here.
 *
 * Requires the privileged **Message Content** intent enabled on the bot in the
 * Discord developer portal. discord.js is lazy-loaded so an install without it
 * still boots — the connection reports `error` instead of crashing.
 */

import type { Logger } from '../../logger.js';
import type { ChannelDeliveryReceipt } from './types.js';

export type DiscordSessionStatus = 'idle' | 'starting' | 'open' | 'closed' | 'error';

export interface DiscordInbound {
  externalId: string;
  chatId: string; // channel id to reply to
  body: string;
  from?: string;
  threadId?: string;
}

export interface DiscordSessionOptions {
  connectionId: string;
  token: string;
  logger: Logger;
  onInbound: (msg: DiscordInbound) => void;
  onStateChange?: (state: { status: DiscordSessionStatus }) => void;
}

type DiscordModule = typeof import('discord.js');
let cachedDiscord: { ok: true; mod: DiscordModule } | { ok: false; reason: string } | undefined;
async function loadDiscord() {
  if (cachedDiscord) return cachedDiscord;
  try {
    const mod = (await import('discord.js' as string)) as DiscordModule;
    cachedDiscord = { ok: true, mod };
  } catch (err) {
    cachedDiscord = { ok: false, reason: (err as Error).message };
  }
  return cachedDiscord;
}

export class DiscordSession {
  #status: DiscordSessionStatus = 'idle';
  #client: InstanceType<DiscordModule['Client']> | undefined;
  #startPromise: Promise<void> | undefined;

  constructor(private readonly opts: DiscordSessionOptions) {}

  get status(): DiscordSessionStatus { return this.#status; }

  async start(): Promise<void> {
    if (this.#startPromise) return this.#startPromise;
    this.#startPromise = this.#start();
    return this.#startPromise;
  }

  async stop(): Promise<void> {
    try { await this.#client?.destroy(); } catch { /* best-effort */ }
    this.#client = undefined;
    this.#startPromise = undefined;
    this.#setStatus('closed');
  }

  async sendText(channelId: string, text: string): Promise<ChannelDeliveryReceipt> {
    const channel = await this.#resolveSendable(channelId);
    if (!channel) throw new Error(`discord channel ${channelId} is not sendable`);
    const sent = await channel.send(text) as unknown as { id?: string };
    const providerMessageId = typeof sent?.id === 'string' ? sent.id.trim() : '';
    if (!providerMessageId) throw new Error('discord provider accepted no message id; outbound delivery is unverified');
    return { provider: 'discord', providerMessageId, status: 'accepted', acceptedAt: new Date().toISOString(), recipient: channelId };
  }

  async setTyping(channelId: string, on: boolean): Promise<void> {
    if (!on) return; // Discord typing auto-expires (~10s)
    try {
      const channel = await this.#resolveSendable(channelId);
      // sendTyping exists on text-based channels.
      await (channel as unknown as { sendTyping?: () => Promise<void> })?.sendTyping?.();
    } catch {
      /* best-effort */
    }
  }


  async #start(): Promise<void> {
    const loaded = await loadDiscord();
    if (!loaded.ok) {
      this.opts.logger.warn('discord.unavailable', { reason: loaded.reason });
      this.#setStatus('error');
      return;
    }
    const { Client, GatewayIntentBits, Partials, Events } = loaded.mod;
    this.#setStatus('starting');
    const client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
      ],
      partials: [Partials.Channel],
    });
    this.#client = client;

    client.once(Events.ClientReady, () => this.#setStatus('open'));
    client.on(Events.Error, (err: Error) => {
      this.opts.logger.warn('discord.client_error', { connectionId: this.opts.connectionId, err: err.message });
    });
    client.on(Events.MessageCreate, (message: import('discord.js').Message) => {
      try {
        if (message.author?.bot) return; // ignore bots (incl. ourselves)
        const text = message.content;
        if (!text) return;
        const isThread = typeof (message.channel as { isThread?: () => boolean }).isThread === 'function'
          && (message.channel as { isThread: () => boolean }).isThread();
        this.opts.onInbound({
          externalId: message.id,
          chatId: message.channelId,
          body: text,
          ...(message.author?.username ? { from: message.author.username } : {}),
          ...(isThread ? { threadId: message.channelId } : {}),
        });
      } catch (err) {
        this.opts.logger.warn('discord.inbound_handler_threw', { err: (err as Error).message });
      }
    });

    try {
      await client.login(this.opts.token);
    } catch (err) {
      this.opts.logger.warn('discord.login_failed', { connectionId: this.opts.connectionId, err: (err as Error).message });
      this.#setStatus('error');
    }
  }

  async #resolveSendable(channelId: string): Promise<{ send: (text: string) => Promise<unknown> } | null> {
    if (!this.#client) return null;
    const channel = this.#client.channels.cache.get(channelId)
      ?? (await this.#client.channels.fetch(channelId).catch(() => null));
    if (channel && 'send' in channel && typeof (channel as { send?: unknown }).send === 'function') {
      return channel as unknown as { send: (text: string) => Promise<unknown> };
    }
    return null;
  }

  #setStatus(status: DiscordSessionStatus): void {
    if (this.#status === status) return;
    this.#status = status;
    this.opts.onStateChange?.({ status });
  }
}
