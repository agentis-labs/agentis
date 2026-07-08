/**
 * TranscriptionService — speech-to-text for channel voice notes
 * (OMNICHANNEL-ORCHESTRATOR-10X §3.3, "WhatsApp voice just works").
 *
 * Posts audio to an OpenAI-compatible `/audio/transcriptions` endpoint resolved
 * from the orchestrator model router's `transcription` role. WhatsApp voice
 * notes are OGG/Opus, which Whisper-class models accept directly — no local
 * decode needed. Entirely optional: with no transcription model configured (or
 * on any failure) it returns null and the caller falls back to a placeholder, so
 * voice never breaks a connection.
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
}

export class TranscriptionService {
  constructor(private readonly deps: TranscriptionServiceDeps) {}

  get enabled(): boolean {
    return this.deps.profile() !== null;
  }

  /**
   * Transcribe audio to text. Returns null when no model is configured or the
   * request fails — never throws.
   */
  async transcribe(input: TranscriptionInput): Promise<string | null> {
    const profile = this.deps.profile();
    if (!profile) return null;
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
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: profile.apiKey ? { authorization: `Bearer ${profile.apiKey}` } : {},
        body: form,
      });
      if (!res.ok) {
        this.deps.logger?.warn?.('transcription.failed', { status: res.status });
        return null;
      }
      const json = (await res.json().catch(() => null)) as { text?: string } | null;
      const text = json?.text?.trim();
      return text && text.length > 0 ? text : null;
    } catch (err) {
      this.deps.logger?.warn?.('transcription.error', { err: (err as Error).message });
      return null;
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
