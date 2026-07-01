/**
 * TelegramChannelAdapter — Batch 4.
 *
 * Inbound: Telegram Bot API webhooks. Authentication uses Telegram's
 * `secret_token` mechanism — the bot owner registers a per-webhook shared
 * secret, Telegram echoes it back as the `X-Telegram-Bot-Api-Secret-Token`
 * header on every delivery. We constant-time compare to the value stored on
 * the channel connection.
 *
 * Outbound: HTTPS POST to api.telegram.org/bot<token>/sendMessage.
 *
 * SSRF safety: the destination host is fixed (`api.telegram.org`); we never
 * accept a user-supplied URL.
 */

import { timingSafeEqual } from 'node:crypto';
import { AgentisError } from '@agentis/core';
import type { ChannelAdapter, ChannelHealthCheck, OutboundAttachment, ParsedInboundMessage } from './types.js';

const TELEGRAM_API = 'https://api.telegram.org';

/**
 * Effective Telegram inbound transport for a connection.
 *
 * Long polling needs no public URL, so a self-hosted / local install (no
 * AGENTIS_PUBLIC_URL) defaults to polling and "just works" with zero extra
 * config; a deployment that has a public URL defaults to the webhook. An
 * explicit operator choice ('polling' | 'webhook') always wins. This is the
 * single source of truth shared by the ChannelConnectionSupervisor (which boots
 * the live poll loop) and the ChannelBridge diagnostics, so they never disagree
 * about which transport a Telegram connection uses.
 */
export function resolveTelegramTransport(opts: { explicit?: string | null; hasPublicUrl: boolean }): 'polling' | 'webhook' {
  if (opts.explicit === 'polling' || opts.explicit === 'webhook') return opts.explicit;
  return opts.hasPublicUrl ? 'webhook' : 'polling';
}

export class TelegramChannelAdapter implements ChannelAdapter {
  readonly kind = 'telegram' as const;

  // Override for tests to capture outgoing requests.
  fetchImpl: typeof fetch = (...args) => fetch(...args);

  async probeCredential(args: { token: string }): Promise<ChannelHealthCheck> {
    const checkedAt = new Date().toISOString();
    const res = await this.fetchImpl(`${TELEGRAM_API}/bot${encodeURIComponent(args.token)}/getMe`, {
      method: 'GET',
    });
    if (res.ok) {
      const json = await res.json().catch(() => ({})) as { ok?: boolean; result?: { username?: string }; description?: string };
      if (json.ok !== false) {
        return {
          name: 'credential',
          ok: true,
          code: 'telegram_get_me_ok',
          message: json.result?.username ? `Telegram bot token is valid (@${json.result.username}).` : 'Telegram bot token is valid.',
          checkedAt,
        };
      }
      return {
        name: 'credential',
        ok: false,
        code: 'telegram_get_me_failed',
        message: json.description ?? 'Telegram rejected the bot token.',
        remediation: 'Paste the full bot token from @BotFather and save again.',
        checkedAt,
      };
    }
    const text = await res.text().catch(() => '');
    return {
      name: 'credential',
      ok: false,
      code: 'telegram_get_me_failed',
      message: `Telegram getMe failed (${res.status}): ${text.slice(0, 180) || res.statusText}`,
      remediation: 'Check that the bot token is complete and has not been revoked in @BotFather.',
      checkedAt,
    };
  }

  async configureTransport(args: {
    token: string;
    webhookUrl?: string;
    secret?: string | null;
    transport?: string;
  }): Promise<ChannelHealthCheck> {
    const checkedAt = new Date().toISOString();
    if (args.transport === 'polling') {
      const res = await this.fetchImpl(`${TELEGRAM_API}/bot${encodeURIComponent(args.token)}/deleteWebhook`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ drop_pending_updates: false }),
      });
      if (res.ok) {
        return {
          name: 'transport',
          ok: true,
          code: 'telegram_polling_ready',
          message: 'Telegram webhook is cleared, so long polling can receive updates.',
          checkedAt,
        };
      }
      const text = await res.text().catch(() => '');
      return {
        name: 'transport',
        ok: false,
        code: 'telegram_polling_webhook_clear_failed',
        message: `Telegram deleteWebhook failed (${res.status}): ${text.slice(0, 180) || res.statusText}`,
        remediation: 'Retry the test, or clear the webhook from Telegram before using polling.',
        checkedAt,
      };
    }

    if (!args.webhookUrl) {
      return {
        name: 'transport',
        ok: false,
        code: 'missing_public_url',
        message: 'Telegram webhook mode needs a public Agentis URL.',
        remediation: 'Set AGENTIS_PUBLIC_URL or switch Telegram to long polling.',
        checkedAt,
      };
    }

    const res = await this.fetchImpl(`${TELEGRAM_API}/bot${encodeURIComponent(args.token)}/setWebhook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        url: args.webhookUrl,
        ...(args.secret ? { secret_token: args.secret } : {}),
      }),
    });
    const json = await res.json().catch(() => ({})) as { ok?: boolean; description?: string };
    if (res.ok && json.ok !== false) {
      return {
        name: 'transport',
        ok: true,
        code: 'telegram_webhook_ready',
        message: 'Telegram webhook is configured.',
        checkedAt,
      };
    }
    return {
      name: 'transport',
      ok: false,
      code: 'telegram_set_webhook_failed',
      message: json.description ?? `Telegram setWebhook failed (${res.status}).`,
      remediation: 'Check that AGENTIS_PUBLIC_URL is reachable by Telegram and retry the test.',
      checkedAt,
    };
  }

  async send(args: { token: string; chatId: string; body: string; attachments?: OutboundAttachment[] }): Promise<void> {
    const attachments = args.attachments ?? [];
    if (attachments.length === 0) {
      await this.#sendMessage(args.token, args.chatId, args.body);
      return;
    }
    // First attachment carries the body as its caption; the rest go captionless.
    for (let i = 0; i < attachments.length; i += 1) {
      const caption = i === 0 ? args.body : '';
      await this.#sendMedia(args.token, args.chatId, attachments[i]!, caption);
    }
  }

  async #sendMessage(token: string, chatId: string, body: string): Promise<void> {
    const url = `${TELEGRAM_API}/bot${encodeURIComponent(token)}/sendMessage`;
    const res = await this.fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: body }),
    });
    if (!res.ok) await this.#throwSendError(res, chatId, 'sendMessage');
  }

  async #sendMedia(token: string, chatId: string, attachment: OutboundAttachment, caption: string): Promise<void> {
    const isPhoto = attachment.kind === 'image';
    const method = isPhoto ? 'sendPhoto' : 'sendDocument';
    const field = isPhoto ? 'photo' : 'document';
    const form = new FormData();
    form.set('chat_id', chatId);
    if (caption) form.set('caption', caption.slice(0, 1024));
    form.set(field, new Blob([new Uint8Array(attachment.data)], { type: attachment.mimeType }), attachment.filename);
    const url = `${TELEGRAM_API}/bot${encodeURIComponent(token)}/${method}`;
    const res = await this.fetchImpl(url, { method: 'POST', body: form });
    if (!res.ok) await this.#throwSendError(res, chatId, method);
  }

  async #throwSendError(res: Response, chatId: string, method: string): Promise<never> {
    const text = await res.text().catch(() => '');
    let description = text.slice(0, 200);
    try {
      const json = JSON.parse(text) as { description?: string };
      if (json.description) description = json.description;
    } catch {
      /* non-JSON body — keep the raw text */
    }
    // "chat not found" is Telegram's response when the bot has never had a
    // conversation with this chat. Bots cannot initiate chats: the user must
    // message the bot first (or the chat must be a group the bot has joined),
    // and the chat ID must be that conversation's numeric ID. Surface that
    // instead of the opaque API string.
    const hint = /chat not found/i.test(description)
      ? `: the bot can't message chat "${chatId}" until that chat messages the bot first (open the bot in Telegram and press Start), and the chat ID must be the numeric ID of that conversation`
      : '';
    throw new AgentisError(
      'CHANNEL_SEND_FAILED',
      `telegram ${method} failed (${res.status}): ${description}${hint}`,
    );
  }

  verify(args: {
    headers: Record<string, string | undefined>;
    rawBody: string;
    secret: string | null;
  }): boolean {
    // Fail closed: with no configured secret_token an inbound webhook cannot be
    // authenticated, so a POST from anywhere on the internet would otherwise
    // dispatch an orchestrator turn. Reject until the operator sets a secret
    // (Telegram echoes it in x-telegram-bot-api-secret-token on every update).
    if (!args.secret) return false;
    const presented = args.headers['x-telegram-bot-api-secret-token'] ?? '';
    const a = Buffer.from(presented);
    const b = Buffer.from(args.secret);
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  }

  parseInbound(args: { rawBody: string }): ParsedInboundMessage | null {
    let payload: unknown;
    try {
      payload = JSON.parse(args.rawBody);
    } catch {
      throw new AgentisError('VALIDATION_FAILED', 'telegram webhook body is not JSON');
    }
    const update = payload as TelegramUpdate;
    const updateId = update?.update_id;
    const msg = update?.message ?? update?.edited_message ?? null;
    if (!msg || typeof msg.text !== 'string' || msg.text.length === 0) {
      return null; // ignore non-text updates (stickers, photos, status, …)
    }
    if (typeof updateId !== 'number' || !msg.chat?.id) {
      throw new AgentisError('VALIDATION_FAILED', 'telegram webhook missing update_id or chat.id');
    }
    const fromName = msg.from
      ? [msg.from.first_name, msg.from.last_name].filter(Boolean).join(' ') ||
        msg.from.username ||
        String(msg.from.id)
      : undefined;
    const result: ParsedInboundMessage = {
      externalId: `telegram:${updateId}`,
      chatId: String(msg.chat.id),
      body: msg.text,
    };
    if (fromName) result.from = fromName;
    return result;
  }
}

interface TelegramUpdate {
  update_id?: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
}
interface TelegramMessage {
  text?: string;
  chat?: { id?: number | string };
  from?: { id: number; username?: string; first_name?: string; last_name?: string };
}
