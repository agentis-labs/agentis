/**
 * SpeechService — text-to-speech for channel voice notes. The symmetric partner
 * of TranscriptionService: instead of decoding inbound audio, it turns an agent's
 * reply text into a spoken voice note.
 *
 * Uses a **voice model** resolved from the orchestrator model router's `speech`
 * role, posting to an OpenAI-compatible `/audio/speech` endpoint and asking for
 * `response_format: "opus"`. The model emits OGG/Opus directly — exactly what a
 * WhatsApp voice note needs — so there is NO local transcoding (no ffmpeg) and
 * the caller never deals with codecs. Entirely optional: with no speech model
 * configured (or on any failure) it returns null and the caller falls back to
 * sending text, so voice output never breaks a send.
 */

import type { ModelProfile } from './orchestrator/orchestratorModelRouter.js';
import type { Logger } from '../logger.js';

export interface SpeechInput {
  text: string;
  /** Named voice, when the provider supports it (e.g. "alloy"). Optional. */
  voice?: string;
}

export interface SpeechResult {
  bytes: Buffer;
  /** Always an Opus/OGG container so it renders as a native voice note. */
  mimeType: string;
}

export interface SpeechServiceDeps {
  /** Resolves the speech (voice) model profile, or null when none is configured. */
  profile: () => ModelProfile | null;
  /** Default voice when the caller doesn't name one. */
  defaultVoice?: string;
  logger?: Logger;
  fetchImpl?: typeof fetch;
}

const OPUS_MIME = 'audio/ogg; codecs=opus';

export class SpeechService {
  constructor(private readonly deps: SpeechServiceDeps) {}

  get enabled(): boolean {
    return this.deps.profile() !== null;
  }

  /**
   * Synthesize speech from text. Returns Opus bytes ready to send as a voice
   * note, or null when no model is configured or the request fails — never throws.
   */
  async synthesize(input: SpeechInput): Promise<SpeechResult | null> {
    const profile = this.deps.profile();
    if (!profile) return null;
    const text = input.text?.trim();
    if (!text) return null;
    const fetchImpl = this.deps.fetchImpl ?? fetch;
    try {
      const url = resolveSpeechUrl(profile.baseUrl);
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(profile.apiKey ? { authorization: `Bearer ${profile.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: profile.model,
          input: text,
          voice: input.voice ?? this.deps.defaultVoice ?? 'alloy',
          response_format: 'opus',
        }),
      });
      if (!res.ok) {
        this.deps.logger?.warn?.('speech.failed', { status: res.status });
        return null;
      }
      const buf = Buffer.from(await res.arrayBuffer());
      return buf.byteLength > 0 ? { bytes: buf, mimeType: OPUS_MIME } : null;
    } catch (err) {
      this.deps.logger?.warn?.('speech.error', { err: (err as Error).message });
      return null;
    }
  }
}

/** Append `/audio/speech` to an OpenAI-compatible base URL. */
export function resolveSpeechUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, '');
  if (trimmed.endsWith('/audio/speech')) return trimmed;
  return `${trimmed}/audio/speech`;
}
