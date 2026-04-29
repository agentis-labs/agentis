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
import type { ChannelAdapter, ParsedInboundMessage } from './types.js';

const DISCORD_API = 'https://discord.com/api/v10';

export class DiscordChannelAdapter implements ChannelAdapter {
  readonly kind = 'discord' as const;

  fetchImpl: typeof fetch = (...args) => fetch(...args);

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
      throw new AgentisError(
        'CHANNEL_SEND_FAILED',
        `discord sendMessage failed: ${res.status} ${text.slice(0, 200)}`,
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
