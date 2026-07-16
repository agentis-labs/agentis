/**
 * Channel adapter contract — Batch 4 / V1-SPEC §0.3 #24, §11.
 *
 * Adapters bridge an external chat surface (Telegram, Discord, …) to a
 * single agent's conversation thread. Inbound messages flow through
 * `parseInbound` → ChannelBridge → ConversationStore.appendMirrored.
 * Outbound flows through `send` invoked by ChannelBridge when the operator
 * posts in the in-app conversation.
 */

export type ChannelKind = 'telegram' | 'discord' | 'slack' | 'whatsapp' | 'voice';
export type ChannelStatus = 'needs_action' | 'verifying' | 'active' | 'degraded' | 'error' | 'paused';
export type ChannelHealthCheckName = 'credential' | 'transport' | 'outbound' | 'inbound' | 'runtime';

export interface ChannelHealthCheck {
  name: ChannelHealthCheckName;
  ok: boolean;
  code: string;
  message: string;
  remediation?: string;
  /** Provider-native, non-secret diagnostic evidence for precise operator decisions. */
  evidence?: Record<string, unknown>;
  checkedAt: string;
}

export interface ChannelHealth {
  status: ChannelStatus;
  checks: ChannelHealthCheck[];
  lastTestAt?: string;
}

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

/**
 * A fully-resolved outbound attachment: raw bytes plus the metadata a channel
 * API needs to upload it. The ChannelBridge resolves loose references
 * (artifact ids, data URLs, http URLs) into these before calling `send`, so
 * adapters never fetch or decode anything themselves.
 */
export interface OutboundAttachment {
  /** `image` → inline photo where the channel supports it; `file` → document upload. */
  kind: 'image' | 'file';
  filename: string;
  mimeType: string;
  data: Buffer;
}

/**
 * A loose, caller-supplied attachment reference (from `agentis.channel.send` or
 * a turn reply). The ChannelBridge resolves these into `OutboundAttachment`s.
 * Provide exactly one source: `artifactId`, or a `url` that is an `artifact:<id>`,
 * `data:` URL, or `http(s)` URL.
 */
export interface OutboundAttachmentRef {
  url?: string;
  artifactId?: string;
  filename?: string;
  mimeType?: string;
  /** Hint how to deliver; inferred from the resolved MIME type when omitted. */
  kind?: 'image' | 'file';
}

/**
 * Provider-issued proof that an outbound message was accepted by the channel.
 * A resolved socket/HTTP write without `providerMessageId` is not a delivery.
 */
export interface ChannelDeliveryReceipt {
  provider: ChannelKind;
  providerMessageId: string;
  /** `accepted` is provider acknowledgement; delivered/read require a later provider receipt. */
  status: 'accepted' | 'delivered' | 'read' | 'queued';
  acceptedAt: string;
  recipient?: string;
  /** Destination supplied by the caller before provider normalization. */
  requestedRecipient?: string;
  /** Destination resolved by the provider directory (for example WhatsApp PN canonicalization). */
  resolvedRecipient?: string;
  /** Destination echoed on the submitted provider message. Must match resolvedRecipient. */
  providerRecipient?: string;
  /**
   * False when providerMessageId is only a client correlation id and no server
   * acknowledgement has arrived yet. `sent:true` must never be derived from it.
   */
  providerAcknowledged?: boolean;
  /** Provider-native numeric/status evidence used to derive `status`. */
  providerStatus?: string | number;
  /** Multi-attachment sends may produce more than one provider message. */
  providerMessageIds?: string[];
  /** True when Agentis reused a durable receipt instead of contacting the provider again. */
  deduplicated?: boolean;
  idempotencyKey?: string;
}

/** A provider definitively rejected an outbound delivery. */
export class ChannelDeliveryRejectedError extends Error {
  readonly deliveryCertain = true;

  constructor(
    readonly provider: ChannelKind,
    readonly providerMessageId: string,
    readonly providerErrorCode: string,
    message: string,
    readonly remediation?: string,
  ) {
    super(message);
    this.name = 'ChannelDeliveryRejectedError';
  }
}

/** True only when the provider, not merely the local client, acknowledged the send. */
export function isAcknowledgedChannelDelivery(receipt: ChannelDeliveryReceipt | null | undefined): boolean {
  return Boolean(
    receipt
    && receipt.providerMessageId?.trim()
    && receipt.providerAcknowledged !== false
    && (receipt.status === 'accepted' || receipt.status === 'delivered' || receipt.status === 'read'),
  );
}

export interface ChannelAdapter {
  readonly kind: ChannelKind;

  /**
   * Send a message via the channel's API. Throws on transport failure.
   *
   * When `attachments` are present, the adapter uploads them via the channel's
   * media API (Telegram sendPhoto/sendDocument, Discord multipart, Slack
   * files). The `body` becomes the caption/text. Adapters that cannot carry a
   * given attachment should still deliver the text.
   */
  send(args: {
    token: string;
    chatId: string;
    body: string;
    settings?: Record<string, unknown>;
    attachments?: OutboundAttachment[];
  }): Promise<ChannelDeliveryReceipt>;

  /**
   * Validate channel credentials without sending a user-visible message.
   */
  probeCredential?(args: {
    token: string;
    settings?: Record<string, unknown>;
  }): Promise<ChannelHealthCheck>;

  /**
   * Prepare webhook transport for providers that need a provider API call
   * after save (Telegram setWebhook, polling deleteWebhook, etc.).
   */
  configureTransport?(args: {
    token: string;
    webhookUrl?: string;
    secret?: string | null;
    transport?: string;
  }): Promise<ChannelHealthCheck>;

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
