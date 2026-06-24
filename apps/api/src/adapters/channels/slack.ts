import { createHmac, timingSafeEqual } from 'node:crypto';
import { AgentisError } from '@agentis/core';
import type { ChannelAdapter, ChannelHealthCheck, OutboundAttachment, ParsedInboundMessage } from './types.js';

const SLACK_API = 'https://slack.com/api';

export class SlackChannelAdapter implements ChannelAdapter {
  readonly kind = 'slack' as const;
  fetchImpl: typeof fetch = (...args) => fetch(...args);

  async probeCredential(args: { token: string }): Promise<ChannelHealthCheck> {
    const checkedAt = new Date().toISOString();
    const res = await this.fetchImpl(`${SLACK_API}/auth.test`, {
      method: 'POST',
      headers: { authorization: `Bearer ${args.token}` },
    });
    const json = await res.json().catch(() => ({})) as { ok?: boolean; error?: string; team?: string; user?: string };
    if (res.ok && json.ok !== false) {
      return {
        name: 'credential',
        ok: true,
        code: 'slack_auth_test_ok',
        message: json.team ? `Slack bot token is valid for ${json.team}.` : 'Slack bot token is valid.',
        checkedAt,
      };
    }
    return {
      name: 'credential',
      ok: false,
      code: 'slack_auth_test_failed',
      message: `Slack auth.test failed: ${json.error ?? res.statusText}`,
      remediation: 'Paste a valid xoxb bot token with chat:write and Events API permissions.',
      checkedAt,
    };
  }

  async send(args: { token: string; chatId: string; body: string; attachments?: OutboundAttachment[] }): Promise<void> {
    const [channel, threadTs] = args.chatId.split(':thread:');
    const attachments = args.attachments ?? [];
    if (attachments.length > 0) {
      await this.#uploadFiles(args.token, channel!, threadTs, args.body, attachments);
      return;
    }
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
      throw new AgentisError('CHANNEL_SEND_FAILED', `slack sendMessage failed: ${this.#explain(json.error ?? res.statusText)}`);
    }
  }

  /**
   * Upload files via Slack's external-upload flow (the supported replacement for
   * the deprecated `files.upload`): getUploadURLExternal → PUT bytes →
   * completeUploadExternal. The body rides along as `initial_comment`.
   */
  async #uploadFiles(token: string, channel: string, threadTs: string | undefined, body: string, attachments: OutboundAttachment[]): Promise<void> {
    const completed: Array<{ id: string; title: string }> = [];
    for (const attachment of attachments) {
      const params = new URLSearchParams({ filename: attachment.filename, length: String(attachment.data.length) });
      const urlRes = await this.fetchImpl(`${SLACK_API}/files.getUploadURLExternal`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: `Bearer ${token}` },
        body: params.toString(),
      });
      const urlJson = await urlRes.json().catch(() => ({})) as { ok?: boolean; error?: string; upload_url?: string; file_id?: string };
      if (!urlRes.ok || urlJson.ok === false || !urlJson.upload_url || !urlJson.file_id) {
        throw new AgentisError('CHANNEL_SEND_FAILED', `slack getUploadURLExternal failed: ${this.#explain(urlJson.error ?? urlRes.statusText)}`);
      }
      const putForm = new FormData();
      putForm.set('file', new Blob([attachment.data], { type: attachment.mimeType }), attachment.filename);
      const putRes = await this.fetchImpl(urlJson.upload_url, { method: 'POST', body: putForm });
      if (!putRes.ok) {
        throw new AgentisError('CHANNEL_SEND_FAILED', `slack file upload failed (${putRes.status})`);
      }
      completed.push({ id: urlJson.file_id, title: attachment.filename });
    }
    const completeRes = await this.fetchImpl(`${SLACK_API}/files.completeUploadExternal`, {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8', authorization: `Bearer ${token}` },
      body: JSON.stringify({
        files: completed,
        channel_id: channel,
        ...(threadTs ? { thread_ts: threadTs } : {}),
        ...(body ? { initial_comment: body } : {}),
      }),
    });
    const completeJson = await completeRes.json().catch(() => ({})) as { ok?: boolean; error?: string };
    if (!completeRes.ok || completeJson.ok === false) {
      throw new AgentisError('CHANNEL_SEND_FAILED', `slack completeUploadExternal failed: ${this.#explain(completeJson.error ?? completeRes.statusText)}`);
    }
  }

  #explain(error: string): string {
    const hint = error === 'channel_not_found'
      ? ' Make sure the default channel ID exists and invite the bot to the channel.'
      : error === 'not_in_channel'
        ? ' Invite the Slack app bot to the channel, then retry.'
        : /missing_scope/i.test(error)
          ? ' Add chat:write (and files:write for attachments) to the Slack app scopes and reinstall the app.'
          : '';
    return `${error}.${hint}`;
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
    const threadTs = event.thread_ts ?? ts;
    return {
      externalId: payload.event_id ?? `${channel}:${ts}`,
      chatId: `${channel}:thread:${threadTs}`,
      threadId: `${channel}:${threadTs}`,
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
