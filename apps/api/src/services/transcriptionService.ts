/**
 * TranscriptionService — speech-to-text for channel voice notes
 * (OMNICHANNEL-ORCHESTRATOR-10X §3.3, "WhatsApp voice just works").
 *
 * Managed local Whisper is the zero-configuration baseline for inbound audio.
 * An OpenAI-compatible `/audio/transcriptions` profile resolved from the
 * orchestrator model router's `transcription` role may override/accelerate it.
 * Local FFmpeg decoding handles WhatsApp OGG/Opus and other common formats. A
 * terminal failure returns null rather than breaking the channel connection.
 */

import type { ModelProfile } from './orchestrator/orchestratorModelRouter.js';
import type { Logger } from '../logger.js';

export interface TranscriptionInput {
  bytes: Buffer;
  mimeType: string;
  /** Filename hint for the multipart upload (extension matters to some APIs). */
  filename?: string;
}

export interface TranscriptionServiceDeps {
  /** Resolves the transcription model profile, or null when none is configured. */
  profile: () => ModelProfile | null;
  logger?: Logger;
  fetchImpl?: typeof fetch;
  /** Managed on-device fallback. Input understanding must work without BYO API configuration. */
  localFallback?: { transcribe(input: TranscriptionInput): Promise<string | null> };
}

export class TranscriptionService {
  constructor(private readonly deps: TranscriptionServiceDeps) {}

  get enabled(): boolean {
    return this.deps.profile() !== null || Boolean(this.deps.localFallback);
  }

  /**
   * Transcribe audio to text. Returns null when no model is configured or the
   * request fails — never throws.
   */
  async transcribe(input: TranscriptionInput): Promise<string | null> {
    const profile = this.deps.profile();
    if (!profile) return this.deps.localFallback?.transcribe(input) ?? null;
    const fetchImpl = this.deps.fetchImpl ?? fetch;
    try {
      const url = resolveTranscriptionsUrl(profile.baseUrl);
      const form = new FormData();
      const filename = input.filename ?? defaultFilename(input.mimeType);
      // Copy into a plain Uint8Array so the Blob part type is unambiguous.
      const part = new Uint8Array(input.bytes.byteLength);
      part.set(input.bytes);
      form.append('file', new Blob([part], { type: input.mimeType }), filename);
      form.append('model', profile.model);
      form.append(
        'prompt',
        'Transcribe verbatim with standard punctuation and capitalization. Preserve the speaker’s wording and do not rewrite or summarize.',
      );
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: profile.apiKey ? { authorization: `Bearer ${profile.apiKey}` } : {},
        body: form,
      });
      if (!res.ok) {
        this.deps.logger?.warn?.('transcription.failed', { status: res.status });
        return this.deps.localFallback?.transcribe(input) ?? null;
      }
      const json = (await res.json().catch(() => null)) as { text?: string } | null;
      const text = json?.text?.trim();
      return text && text.length > 0 ? text : (this.deps.localFallback?.transcribe(input) ?? null);
    } catch (err) {
      this.deps.logger?.warn?.('transcription.error', { err: (err as Error).message });
      return this.deps.localFallback?.transcribe(input) ?? null;
    }
  }
}

/** Append `/audio/transcriptions` to an OpenAI-compatible base URL. */
export function resolveTranscriptionsUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, '');
  if (trimmed.endsWith('/audio/transcriptions')) return trimmed;
  return `${trimmed}/audio/transcriptions`;
}

function defaultFilename(mimeType: string): string {
  if (mimeType.includes('ogg')) return 'audio.ogg';
  if (mimeType.includes('mp4') || mimeType.includes('m4a')) return 'audio.m4a';
  if (mimeType.includes('mpeg') || mimeType.includes('mp3')) return 'audio.mp3';
  if (mimeType.includes('wav')) return 'audio.wav';
  return 'audio.bin';
}
