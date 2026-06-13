/**
 * Channel adapter contract — Batch 4 / V1-SPEC §0.3 #24, §11.
 *
 * Adapters bridge an external chat surface (Telegram, Discord, …) to a
 * single agent's conversation thread. Inbound messages flow through
 * `parseInbound` → ChannelBridge → ConversationStore.appendMirrored.
 * Outbound flows through `send` invoked by ChannelBridge when the operator
 * posts in the in-app conversation.
 */

export type ChannelKind = 'telegram' | 'discord' | 'slack' | 'whatsapp';

export interface ParsedInboundMessage {
  /** Adapter-issued unique id for idempotency (e.g. Telegram update_id). */
  externalId: string;
  /** Channel-side conversation address used for replies. */
  chatId: string;
  /**
   * Subject boundary within a channel (Slack thread_ts, Discord thread id,
   * Telegram forum topic). When set, the orchestrator scopes turn history to it
   * so unrelated threads don't bleed together (OMNICHANNEL §5.3).
   */
  threadId?: string;
  body: string;
  from?: string;
}

export interface ChannelAdapter {
  readonly kind: ChannelKind;

  /**
   * Send a text message via the channel's API. Throws on transport failure.
   */
  send(args: {
    token: string;
    chatId: string;
    body: string;
  }): Promise<void>;

  /**
   * Header-level authentication of an inbound webhook. Constant-time
   * comparison required. Returns false to reject (caller emits 401).
   */
  verify(args: {
    headers: Record<string, string | undefined>;
    rawBody: string;
    secret: string | null;
  }): boolean;

  /**
   * Decode the raw webhook body into a normalized message. Returns null
   * for events the adapter chooses to ignore (e.g. status pings).
   */
  parseInbound(args: {
    rawBody: string;
    headers: Record<string, string | undefined>;
  }): ParsedInboundMessage | null;
}
