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
import type { ChannelAdapter, ParsedInboundMessage } from './types.js';

const TELEGRAM_API = 'https://api.telegram.org';

export class TelegramChannelAdapter implements ChannelAdapter {
  readonly kind = 'telegram' as const;

  // Override for tests to capture outgoing requests.
  fetchImpl: typeof fetch = (...args) => fetch(...args);

  async send(args: { token: string; chatId: string; body: string }): Promise<void> {
    const url = `${TELEGRAM_API}/bot${encodeURIComponent(args.token)}/sendMessage`;
    const res = await this.fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: args.chatId, text: args.body }),
    });
    if (!res.ok) {
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
        ? `: the bot can't message chat "${args.chatId}" until that chat messages the bot first (open the bot in Telegram and press Start), and the chat ID must be the numeric ID of that conversation`
        : '';
      throw new AgentisError(
        'CHANNEL_SEND_FAILED',
        `telegram sendMessage failed (${res.status}): ${description}${hint}`,
      );
    }
  }

  verify(args: {
    headers: Record<string, string | undefined>;
    rawBody: string;
    secret: string | null;
  }): boolean {
    if (!args.secret) return true; // no secret configured → accept (not recommended)
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
