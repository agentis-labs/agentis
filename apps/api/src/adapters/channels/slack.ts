import { createHmac, timingSafeEqual } from 'node:crypto';
import { AgentisError } from '@agentis/core';
import type { ChannelAdapter, ParsedInboundMessage } from './types.js';

const SLACK_API = 'https://slack.com/api';

export class SlackChannelAdapter implements ChannelAdapter {
  readonly kind = 'slack' as const;
  fetchImpl: typeof fetch = (...args) => fetch(...args);

  async send(args: { token: string; chatId: string; body: string }): Promise<void> {
    const [channel, threadTs] = args.chatId.split(':thread:');
    const res = await this.fetchImpl(`${SLACK_API}/chat.postMessage`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json; charset=utf-8',
        authorization: `Bearer ${args.token}`,
      },
      body: JSON.stringify({ channel, text: args.body, ...(threadTs ? { thread_ts: threadTs } : {}) }),
    });
    const json = await res.json().catch(() => ({})) as { ok?: boolean; error?: string };
    if (!res.ok || json.ok === false) {
      throw new AgentisError('CHANNEL_SEND_FAILED', `slack sendMessage failed: ${json.error ?? res.statusText}`);
    }
  }

  verify(args: { headers: Record<string, string | undefined>; rawBody: string; secret: string | null }): boolean {
    if (!args.secret) return false;
    const timestamp = args.headers['x-slack-request-timestamp'];
    const signature = args.headers['x-slack-signature'];
    if (!timestamp || !signature || Math.abs(Date.now() / 1000 - Number(timestamp)) > 60 * 5) return false;
    const base = `v0:${timestamp}:${args.rawBody}`;
    const expected = `v0=${createHmac('sha256', args.secret).update(base).digest('hex')}`;
    if (expected.length !== signature.length) return false;
    try {
      return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
    } catch {
      return false;
    }
  }

  parseInbound(args: { rawBody: string }): ParsedInboundMessage | null {
    const payload = JSON.parse(args.rawBody) as SlackEnvelope;
    if (payload.type === 'url_verification') return null;
    const event = payload.event;
    if (!event || (event.type !== 'app_mention' && event.type !== 'message')) return null;
    if (event.bot_id || event.subtype === 'bot_message') return null;
    const channel = event.channel;
    const ts = event.ts;
    if (!channel || !ts) return null;
    return {
      externalId: payload.event_id ?? `${channel}:${ts}`,
      chatId: `${channel}:thread:${event.thread_ts ?? ts}`,
      body: String(event.text ?? '').replace(/<@[^>]+>/g, '').trim(),
      from: event.user,
    };
  }
}

interface SlackEnvelope {
  type?: string;
  event_id?: string;
  event?: {
    type?: string;
    subtype?: string;
    bot_id?: string;
    channel?: string;
    user?: string;
    text?: string;
    ts?: string;
    thread_ts?: string;
  };
}