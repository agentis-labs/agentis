/**
 * DiscordChannelAdapter — Batch 4.
 *
 * V1 scope: outbound only via Discord REST `POST /channels/{id}/messages`.
 * Inbound (Discord Interactions endpoint) requires Ed25519 signature
 * verification and is intentionally out-of-scope for V1; the gateway WS
 * client is dynamic-imported as `discord.js` when available and currently
 * surfaces `CHANNEL_DISCORD_INBOUND_UNAVAILABLE` so the path is loud.
 *
 * SSRF safety: the destination host is fixed (`discord.com`).
 */

import { AgentisError } from '@agentis/core';
import type { ChannelAdapter, ChannelHealthCheck, ParsedInboundMessage } from './types.js';

const DISCORD_API = 'https://discord.com/api/v10';

export class DiscordChannelAdapter implements ChannelAdapter {
  readonly kind = 'discord' as const;

  fetchImpl: typeof fetch = (...args) => fetch(...args);

  async probeCredential(args: { token: string }): Promise<ChannelHealthCheck> {
    const checkedAt = new Date().toISOString();
    const res = await this.fetchImpl(`${DISCORD_API}/users/@me`, {
      method: 'GET',
      headers: { authorization: `Bot ${args.token}` },
    });
    if (res.ok) {
      const json = await res.json().catch(() => ({})) as { username?: string; id?: string };
      return {
        name: 'credential',
        ok: true,
        code: 'discord_bot_identity_ok',
        message: json.username ? `Discord bot token is valid for ${json.username}.` : 'Discord bot token is valid.',
        checkedAt,
      };
    }
    const text = await res.text().catch(() => '');
    return {
      name: 'credential',
      ok: false,
      code: 'discord_bot_identity_failed',
      message: `Discord bot identity check failed (${res.status}): ${text.slice(0, 180) || res.statusText}`,
      remediation: 'Paste a valid Discord bot token from the Developer Portal.',
      checkedAt,
    };
  }

  async send(args: { token: string; chatId: string; body: string }): Promise<void> {
    const url = `${DISCORD_API}/channels/${encodeURIComponent(args.chatId)}/messages`;
    const res = await this.fetchImpl(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bot ${args.token}`,
      },
      body: JSON.stringify({ content: args.body }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const hint = res.status === 403
        ? ' Check that the bot is in the server and has View Channel + Send Messages permissions.'
        : res.status === 404
          ? ' Check that the default channel ID exists and the bot can see it.'
          : '';
      throw new AgentisError(
        'CHANNEL_SEND_FAILED',
        `discord sendMessage failed: ${res.status} ${text.slice(0, 200)}${hint}`,
      );
    }
  }

  verify(): boolean {
    // Discord inbound requires Ed25519 signature verification — not shipped in V1.
    return false;
  }

  parseInbound(): ParsedInboundMessage | null {
    throw new AgentisError(
      'CHANNEL_DISCORD_INBOUND_UNAVAILABLE',
      'Discord inbound webhooks require Ed25519 verification (not shipped in V1). Use Telegram for inbound.',
    );
  }
}
