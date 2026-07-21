/**
 * channelCapabilities — the machine-readable matrix of what each channel can
 * deliver (OMNICHANNEL-RICH-MESSAGING §4). Agents query it before composing so
 * they don't attempt an unsupported primitive, and the cockpit uses it to enable
 * the right composer affordances. Interactive buttons/lists are intentionally
 * absent — dropped as ban-prone/unreliable.
 */

import type { ChannelKind, OutboundMediaKind } from './types.js';

export interface ChannelCapabilities {
  kind: ChannelKind;
  /** Media kinds the channel delivers natively. */
  mediaKinds: OutboundMediaKind[];
  supportsReactions: boolean;
  /** A "typing…"/"recording…" presence indicator. */
  supportsPresence: boolean;
  supportsReadReceipts: boolean;
  supportsLocation: boolean;
  supportsContacts: boolean;
  supportsPoll: boolean;
  supportsReplyQuote: boolean;
  supportsMentions: boolean;
  /** Ordered multi-message bursts. */
  supportsBurst: boolean;
  /** Human-like pacing (needs a presence indicator to be meaningful). */
  supportsHumanize: boolean;
}

const ALL_MEDIA: OutboundMediaKind[] = ['image', 'video', 'audio', 'voice', 'sticker', 'file'];

/** Resolve the capability descriptor for a channel (and WhatsApp transport mode). */
export function channelCapabilities(kind: ChannelKind, opts?: { whatsappMode?: 'qr_local' | 'cloud' }): ChannelCapabilities {
  switch (kind) {
    case 'whatsapp': {
      const cloud = opts?.whatsappMode === 'cloud';
      return {
        kind,
        mediaKinds: ALL_MEDIA,
        supportsReactions: true,
        supportsPresence: !cloud, // linked-device baileys has presence; Cloud API does not drive it here
        supportsReadReceipts: !cloud,
        supportsLocation: true,
        supportsContacts: true,
        supportsPoll: !cloud, // polls ride the baileys socket, not the Cloud message API
        supportsReplyQuote: true,
        supportsMentions: !cloud,
        supportsBurst: true,
        supportsHumanize: !cloud,
      };
    }
    case 'telegram':
      return {
        kind, mediaKinds: ALL_MEDIA,
        supportsReactions: true, supportsPresence: true, supportsReadReceipts: false,
        supportsLocation: true, supportsContacts: true, supportsPoll: true,
        supportsReplyQuote: true, supportsMentions: true, supportsBurst: true, supportsHumanize: true,
      };
    case 'slack':
      return {
        kind, mediaKinds: ['image', 'video', 'audio', 'file'],
        supportsReactions: true, supportsPresence: false, supportsReadReceipts: false,
        supportsLocation: false, supportsContacts: false, supportsPoll: false,
        supportsReplyQuote: false, supportsMentions: true, supportsBurst: true, supportsHumanize: false,
      };
    case 'discord':
      return {
        kind, mediaKinds: ['image', 'video', 'audio', 'file'],
        supportsReactions: true, supportsPresence: false, supportsReadReceipts: false,
        supportsLocation: false, supportsContacts: false, supportsPoll: false,
        supportsReplyQuote: true, supportsMentions: true, supportsBurst: true, supportsHumanize: false,
      };
    case 'voice':
    default:
      return {
        kind, mediaKinds: [],
        supportsReactions: false, supportsPresence: false, supportsReadReceipts: false,
        supportsLocation: false, supportsContacts: false, supportsPoll: false,
        supportsReplyQuote: false, supportsMentions: false, supportsBurst: false, supportsHumanize: false,
      };
  }
}
