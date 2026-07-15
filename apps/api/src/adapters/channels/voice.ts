/**
 * VoiceChannelAdapter — Living Apps G6 (foundation, non-streaming).
 *
 * The point of this adapter is to prove that **voice is just another channel
 * composition**: a phone/voice provider transcribes a caller utterance to text,
 * POSTs it as a webhook, and it flows through the SAME ChannelBridge →
 * ChannelTurnDispatcher → real-turn → reply spine that text channels use. The
 * App context, contacts, takeover, multi-party threads, identity recall, and
 * permission mode all come for free — voice inherits the whole spine.
 *
 * Inbound webhook shape (provider → Agentis):
 *   { "callId": "call_123", "from": "+15551234567", "transcript": "what are your hours?" }
 * `transcript` becomes the turn body; `callId` is the reply address (chatId);
 * `from` is the caller id. Authentication uses a per-connection shared secret
 * echoed in the `x-agentis-voice-secret` header (constant-time compared), the
 * same fail-closed posture as Telegram's secret_token.
 *
 * Outbound (the agent's reply → provider): a voice provider does not hold an
 * open socket here (that is the deferred real-time tier — see TODO below). So
 * `send` STORES the reply text + an optional TTS audio URL in an in-memory
 * pending-reply buffer keyed by callId; the provider retrieves it (e.g. the
 * webhook's own response, or a follow-up poll) and vocalizes it. Synthesis is a
 * pluggable `synthesizeSpeech` hook — the default is a clearly-marked NO-OP stub
 * that returns no audio (the provider speaks the text with its own TTS).
 *
 * SSRF safety: this adapter never fetches a user-supplied URL. The optional TTS
 * hook, when wired to a real provider, owns its own egress safety.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * DEFERRED (own masterplan — G6 real-time tier): streaming audio in/out,
 * barge-in / interruption, a server-side STT engine, and a duplex media socket.
 * This foundation deliberately models voice as request/response transcription so
 * it fits the existing fire-and-forget turn spine with zero new turn engine.
 */

import { randomUUID, timingSafeEqual } from 'node:crypto';
import { AgentisError } from '@agentis/core';
import type { ChannelAdapter, ChannelDeliveryReceipt, ChannelHealthCheck, ParsedInboundMessage } from './types.js';

/** A reply captured for a voice call, ready for the provider to vocalize. */
export interface VoiceReply {
  /** The agent's text reply (what the provider should speak). */
  text: string;
  /**
   * Optional URL of synthesized speech audio. Null when no TTS hook is wired
   * (the provider speaks `text` with its own engine). Marked `speak` in the
   * outbound webhook contract.
   */
  ttsUrl: string | null;
  /** When the reply was captured (ISO-8601). */
  at: string;
}

/**
 * Pluggable text-to-speech hook. Given the reply text and the call address,
 * returns a playable audio URL, or null to let the provider do its own TTS.
 *
 * The default implementation is a NO-OP stub (returns null). A real
 * implementation would render audio (ElevenLabs/Cartesia/etc.), store it via
 * the ArtifactService, and return the artifact URL.
 */
export type VoiceSynthesizeSpeech = (args: {
  text: string;
  callId: string;
  settings?: Record<string, unknown>;
}) => Promise<string | null> | string | null;

/** The default TTS hook — a clearly-marked no-op. The provider speaks the text. */
export const noopSynthesizeSpeech: VoiceSynthesizeSpeech = () => null;

const VOICE_SECRET_HEADER = 'x-agentis-voice-secret';

export class VoiceChannelAdapter implements ChannelAdapter {
  readonly kind = 'voice' as const;

  /** Last reply per callId, awaiting retrieval by the provider. */
  readonly #pendingReplies = new Map<string, VoiceReply>();

  /** TTS hook — defaults to a no-op stub (provider-side TTS). */
  #synthesize: VoiceSynthesizeSpeech;

  constructor(opts: { synthesize?: VoiceSynthesizeSpeech } = {}) {
    this.#synthesize = opts.synthesize ?? noopSynthesizeSpeech;
  }

  /** Swap the TTS hook at runtime (e.g. wire a real provider in bootstrap). */
  setSynthesizer(synthesize: VoiceSynthesizeSpeech): void {
    this.#synthesize = synthesize;
  }

  async probeCredential(): Promise<ChannelHealthCheck> {
    // A voice connection authenticates inbound webhooks with its per-connection
    // shared secret (auto-generated on create). There is no external credential
    // to probe, so the credential check is structurally satisfied.
    return {
      name: 'credential',
      ok: true,
      code: 'voice_webhook_secret_present',
      message: 'Voice channel authenticates inbound transcription webhooks with its shared secret.',
      checkedAt: new Date().toISOString(),
    };
  }

  /**
   * `send` captures the agent's reply for the provider to vocalize. The voice
   * provider has no socket held open here (deferred real-time tier), so the text
   * is buffered per call + optionally synthesized to a TTS audio URL via the
   * pluggable hook (default no-op). Never throws on the happy path.
   */
  async send(args: {
    token: string;
    chatId: string;
    body: string;
    settings?: Record<string, unknown>;
  }): Promise<ChannelDeliveryReceipt> {
    let ttsUrl: string | null = null;
    try {
      ttsUrl = await this.#synthesize({ text: args.body, callId: args.chatId, settings: args.settings });
    } catch {
      // TTS is best-effort; a synthesis failure must not drop the text reply —
      // the provider can still speak the text with its own engine.
      ttsUrl = null;
    }
    this.#pendingReplies.set(args.chatId, {
      text: args.body,
      ttsUrl,
      at: new Date().toISOString(),
    });
    return {
      provider: 'voice',
      providerMessageId: `voice-queue:${randomUUID()}`,
      status: 'queued',
      acceptedAt: new Date().toISOString(),
      recipient: args.chatId,
    };
  }

  /**
   * Retrieve (and consume) the buffered reply for a call. Returns null when no
   * reply is pending. The webhook route exposes this so the provider can fetch
   * the agent's spoken answer after posting the transcript.
   */
  takeReply(callId: string): VoiceReply | null {
    const reply = this.#pendingReplies.get(callId);
    if (!reply) return null;
    this.#pendingReplies.delete(callId);
    return reply;
  }

  /** Non-consuming peek (tests / diagnostics). */
  peekReply(callId: string): VoiceReply | null {
    return this.#pendingReplies.get(callId) ?? null;
  }

  /**
   * Authenticate the inbound webhook with a constant-time compare of the
   * `x-agentis-voice-secret` header against the connection's shared secret.
   * Fails closed: with no configured secret, an unauthenticated POST from
   * anywhere would dispatch a turn, so reject until a secret is set.
   */
  verify(args: { headers: Record<string, string | undefined>; rawBody: string; secret: string | null }): boolean {
    if (!args.secret) return false;
    const presented = args.headers[VOICE_SECRET_HEADER] ?? '';
    const a = Buffer.from(presented);
    const b = Buffer.from(args.secret);
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  }

  /**
   * Decode `{ callId, from, transcript }` into a normalized inbound message.
   * Returns null for transcription events with no usable transcript (e.g. a
   * silent utterance / status ping) so the bridge ignores them.
   */
  parseInbound(args: { rawBody: string; headers: Record<string, string | undefined> }): ParsedInboundMessage | null {
    let payload: unknown;
    try {
      payload = JSON.parse(args.rawBody);
    } catch {
      throw new AgentisError('VALIDATION_FAILED', 'voice webhook body is not JSON');
    }
    const event = payload as VoiceInboundEvent;
    const callId = typeof event.callId === 'string' ? event.callId.trim() : '';
    const transcript = typeof event.transcript === 'string' ? event.transcript.trim() : '';
    if (!callId) {
      throw new AgentisError('VALIDATION_FAILED', 'voice webhook missing callId');
    }
    if (!transcript) {
      return null; // nothing the agent can act on (silence / partial / status)
    }
    const from = typeof event.from === 'string' && event.from.trim() ? event.from.trim() : undefined;
    // Idempotency: prefer a provider-supplied turn/utterance id; else derive a
    // stable id from the call + transcript so an exact redelivery dedupes while
    // distinct utterances on the same call each get their own turn.
    const utteranceId = typeof event.utteranceId === 'string' && event.utteranceId.trim()
      ? event.utteranceId.trim()
      : `${callId}:${hashTranscript(transcript)}`;
    const result: ParsedInboundMessage = {
      externalId: `voice:${utteranceId}`,
      chatId: callId,
      body: transcript,
    };
    if (from) result.from = from;
    return result;
  }
}

/** Stable, collision-resistant-enough id for an utterance within a call. */
function hashTranscript(transcript: string): string {
  // djb2 — small, deterministic, no crypto needed (this is an idempotency key,
  // not a security primitive; the webhook is already authenticated by verify()).
  let h = 5381;
  for (let i = 0; i < transcript.length; i += 1) {
    h = ((h << 5) + h + transcript.charCodeAt(i)) >>> 0;
  }
  return h.toString(36);
}

interface VoiceInboundEvent {
  callId?: string;
  from?: string;
  transcript?: string;
  /** Optional provider-supplied utterance/turn id for idempotency. */
  utteranceId?: string;
}
