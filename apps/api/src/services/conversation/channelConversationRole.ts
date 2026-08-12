/**
 * Channel actor identity and conversational side are deliberately separate.
 * An Agentis operator is the "user" in desktop chat, but speaks from the
 * business/assistant side when replying to an external customer.
 */

export type ChannelParticipantSide = 'customer' | 'business';

export interface ChannelMessageRoleInput {
  authorType: string;
  participantSide?: string | null;
  metadata?: unknown;
}

export function resolveChannelParticipantSide(
  message: ChannelMessageRoleInput,
  channelScoped = true,
): ChannelParticipantSide | null {
  if (message.participantSide === 'customer' || message.participantSide === 'business') {
    return message.participantSide;
  }
  const metadata = message.metadata && typeof message.metadata === 'object' && !Array.isArray(message.metadata)
    ? message.metadata as { channelInbound?: unknown; channelReply?: unknown; channelOutboundObserved?: unknown; operatorTakeover?: unknown }
    : {};
  if (metadata.channelInbound === true) return 'customer';
  if (!channelScoped) return null;
  if (message.authorType === 'agent' || message.authorType === 'assistant') return 'business';
  if (message.authorType === 'operator'
    && (metadata.channelReply === true || metadata.channelOutboundObserved === true || metadata.operatorTakeover === true)) {
    return 'business';
  }
  // Legacy channel conversations did not mark operator sends consistently.
  if (message.authorType === 'operator') return 'business';
  return null;
}

export function channelModelRole(
  message: ChannelMessageRoleInput,
  channelScoped = true,
): 'user' | 'assistant' | 'system' {
  const side = resolveChannelParticipantSide(message, channelScoped);
  if (side === 'customer') return 'user';
  if (side === 'business') return 'assistant';
  if (message.authorType === 'system') return 'system';
  return message.authorType === 'operator' ? 'user' : 'assistant';
}
