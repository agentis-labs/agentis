/**
 * channelSend — the single resolve-authorize-deliver flow for sending a message
 * on a native channel connection.
 *
 * Extracted so BOTH the `agentis.channel.send` agent tool AND the deterministic
 * `channel` workflow node share one implementation: resolve the connection (by
 * explicit id, or by kind when there's exactly one active authorized one),
 * enforce per-agent §3.3 authority, resolve the destination chat, deliver, and
 * return a structured receipt. A workflow node was previously impossible — the
 * only send path was the agent tool — so "deterministic first contact" workflows
 * could compute a message but never actually send it.
 */
import type { ChannelBridge } from './channelBridge.js';
import type { ConnectionGrantService } from '../connectionGrants.js';
import { ChannelDeliveryRejectedError, isAcknowledgedChannelDelivery, type ChannelDeliveryReceipt, type ChannelKind, type OutboundAttachmentRef } from '../../adapters/channels/types.js';

const CHANNEL_KINDS = new Set<ChannelKind>(['telegram', 'discord', 'slack', 'whatsapp', 'voice']);

export interface ChannelSendArgs {
  workspaceId: string;
  body: string;
  /** Resolve by kind (e.g. "whatsapp") when connectionId is omitted. */
  kind?: string | null;
  /** Pin an exact connection. */
  connectionId?: string | null;
  /** Destination ("default"/"me" → the saved default target; else a phone/JID/alias). */
  to?: string | null;
  /** Calling agent — gates §3.3 authority. Null/undefined = deterministic/system caller (allowed). */
  agentId?: string | null;
  attachments?: OutboundAttachmentRef[];
  /** Stable run+node key for durable at-most-once workflow delivery. */
  idempotencyKey?: string;
}

export type ChannelSendResult =
  | { sent: true; verified: true; connectionId: string; kind: string; to: string; targetSource: string; status: string; attachments: number; providerMessageId: string; deliveryStatus: ChannelDeliveryReceipt['status']; acceptedAt: string; receipt: ChannelDeliveryReceipt }
  | { sent: false; verified?: false; errorCode: string; error: string; remediation?: string; candidates?: unknown[]; connection?: unknown; receipt?: ChannelDeliveryReceipt };

/** What the flow needs from the bridge — structural so tests can fake it. */
export interface ChannelSendDeps {
  channels: Pick<ChannelBridge, 'list' | 'resolveDestination' | 'deliverToConnection' | 'defaultConnectionFor'>;
  connectionGrants?: Pick<ConnectionGrantService, 'authorize'>;
}

function isMe(value: string): boolean {
  return /^(me|default)$/i.test(value.trim());
}

function resolveCandidate(
  connections: ReturnType<ChannelBridge['list']>,
  kind: ChannelKind | null,
  to: string,
) {
  const active = connections.filter((c) => c.status === 'active' && (!kind || c.kind === kind));
  if (to && !isMe(to)) return active.length === 1 ? active[0] : null;
  const withDefault = active.filter((c) => Boolean(c.defaultChatId));
  return withDefault.length === 1 ? withDefault[0] : null;
}

/** Resolve → authorize → deliver. Never throws for an expected failure — returns
 *  a `{ sent:false, errorCode }` the caller (tool or node) can surface. */
export async function resolveAndSend(deps: ChannelSendDeps, args: ChannelSendArgs): Promise<ChannelSendResult> {
  const body = typeof args.body === 'string' ? args.body.trim() : '';
  const attachments = args.attachments ?? [];
  if (!body && attachments.length === 0) {
    return { sent: false, errorCode: 'VALIDATION_FAILED', error: 'provide a body or at least one attachment' };
  }
  const kind = typeof args.kind === 'string' && CHANNEL_KINDS.has(args.kind as ChannelKind) ? (args.kind as ChannelKind) : null;
  const connectionId = typeof args.connectionId === 'string' && args.connectionId.trim() ? args.connectionId.trim() : null;
  const requestedTo = typeof args.to === 'string' ? args.to.trim() : '';

  const connections = deps.channels.list(args.workspaceId);
  // Resolution order: explicit connectionId → the workspace DEFAULT connection of
  // the kind (or the sole active one) → for a kindless call, the single active
  // one. This is what makes a deterministic send unambiguous when several
  // connections of a kind exist (e.g. two WhatsApp numbers) — the operator
  // designates one default and automation uses it.
  let candidate: (typeof connections)[number] | undefined;
  if (connectionId) {
    candidate = connections.find((c) => c.id === connectionId);
  } else if (kind) {
    const defaultId = deps.channels.defaultConnectionFor(args.workspaceId, kind);
    candidate = defaultId ? connections.find((c) => c.id === defaultId) : undefined;
  } else {
    candidate = resolveCandidate(connections, null, requestedTo) ?? undefined;
  }
  if (!candidate) {
    const ofKind = connections.filter((c) => !kind || c.kind === kind);
    const candidates = ofKind.map((c) => ({ id: c.id, kind: c.kind, name: c.name, status: c.status, defaultChatId: c.defaultChatId, targetAliases: c.targetAliases, isDefault: c.isDefault, healthStatus: c.health.status }));
    const activeOfKind = ofKind.filter((c) => c.status === 'active');
    return {
      sent: false,
      errorCode: 'CHANNEL_TARGET_AMBIGUOUS_OR_MISSING',
      error: !kind
        ? 'No single active channel matched. Provide connectionId or kind, and a destination.'
        : activeOfKind.length === 0
          ? `No active ${kind} connection. Connect one in Settings → Channels.`
          : `${activeOfKind.length} active ${kind} connections and no default is set — pass an explicit connectionId, or mark one as the default for ${kind} (Settings → Channels) so deterministic sends resolve.`,
      candidates,
    };
  }

  // §3.3 — an AGENT may only send on a connection it OWNS or was granted.
  // Deterministic/system callers (no agentId) always pass. A workspace-owned
  // connection (candidate.agentId null) has no owner, but ConnectionGrantService
  // already treats "no governing grants" as open — so consulting it here is safe
  // for BOTH owned and workspace connections, and lets an operator restrict a
  // shared/global connection to specific agents by issuing grants on it.
  if (args.agentId && deps.connectionGrants) {
    const decision = deps.connectionGrants.authorize({ workspaceId: args.workspaceId, connectionId: candidate.id, agentId: args.agentId, required: 'send' });
    if (!decision.ok) {
      return {
        sent: false,
        errorCode: 'CONNECTION_SCOPE_MISSING',
        error: decision.reason ?? `not authorized to send on '${candidate.name}'`,
        remediation: `Not authorized to send on '${candidate.name}'. Request it with agentis.connection.request { connectionId: "${candidate.id}", scope: "send" } — an operator approves it.`,
        connection: { id: candidate.id, kind: candidate.kind, name: candidate.name },
      };
    }
  }

  const resolved = deps.channels.resolveDestination({ connectionId: candidate.id, to: requestedTo || null });
  const chatId = resolved.chatId;
  if (!chatId) {
    return {
      sent: false,
      errorCode: 'CHANNEL_DEFAULT_TARGET_MISSING',
      error: `${candidate.kind} connection '${candidate.name}' has no destination — pass a recipient in "to" or save a default target.`,
      connection: { id: candidate.id, kind: candidate.kind, status: candidate.status },
    };
  }

  let receipt: ChannelDeliveryReceipt;
  try {
    receipt = await deps.channels.deliverToConnection({
      connectionId: candidate.id,
      chatId,
      body,
      ...(attachments.length ? { attachments } : {}),
      ...(args.idempotencyKey ? { idempotencyKey: args.idempotencyKey } : {}),
    });
  } catch (err) {
    if (err instanceof ChannelDeliveryRejectedError) {
      return {
        sent: false,
        verified: false,
        errorCode: 'CHANNEL_PROVIDER_REJECTED',
        error: err.message,
        ...(err.remediation ? { remediation: err.remediation } : {}),
        connection: {
          id: candidate.id,
          kind: candidate.kind,
          name: candidate.name,
          providerMessageId: err.providerMessageId,
          providerErrorCode: err.providerErrorCode,
        },
      };
    }
    throw err;
  }
  const providerMessageId = receipt?.providerMessageId?.trim() ?? '';
  if (!providerMessageId) {
    return {
      sent: false,
      verified: false,
      errorCode: 'CHANNEL_DELIVERY_UNVERIFIED',
      error: `${candidate.kind} transport returned without provider-issued message proof. The delivery outcome is unknown and must not advance downstream state.`,
      remediation: 'Inspect the channel/provider before retrying; an unverified attempt may still have reached the recipient.',
      connection: { id: candidate.id, kind: candidate.kind, name: candidate.name },
      ...(receipt ? { receipt } : {}),
    };
  }
  if (!isAcknowledgedChannelDelivery(receipt)) {
    return {
      sent: false,
      verified: false,
      errorCode: 'CHANNEL_DELIVERY_PENDING',
      error: `${candidate.kind} accepted the local submission but has not provided server acknowledgement. Downstream state was not advanced.`,
      remediation: 'Wait for a provider acknowledgement and inspect the durable delivery receipt before retrying. Do not resend blindly: the original attempt may still be accepted later.',
      connection: { id: candidate.id, kind: candidate.kind, name: candidate.name },
      receipt,
    };
  }
  return {
    sent: true,
    verified: true,
    connectionId: candidate.id,
    kind: candidate.kind,
    to: receipt.recipient ?? chatId,
    targetSource: resolved.source,
    status: candidate.status,
    attachments: attachments.length,
    providerMessageId,
    deliveryStatus: receipt.status,
    acceptedAt: receipt.acceptedAt,
    receipt,
  };
}

/** The port the workflow engine consumes for the `channel` node. */
export interface ChannelSendPort {
  send(args: ChannelSendArgs): Promise<ChannelSendResult>;
}

export function createChannelSendPort(deps: ChannelSendDeps): ChannelSendPort {
  return { send: (args) => resolveAndSend(deps, args) };
}
