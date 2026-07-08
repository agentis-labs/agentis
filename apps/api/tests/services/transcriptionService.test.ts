/**
 * TranscriptionService — voice-note speech-to-text (OMNICHANNEL §3.3).
 */

import { describe, expect, it, vi } from 'vitest';
import {
  TranscriptionService,
  resolveTranscriptionsUrl,
} from '../../src/services/transcriptionService.js';
import type { ModelProfile } from '../../src/services/orchestrator/orchestratorModelRouter.js';

const profile: ModelProfile = { baseUrl: 'https://api.example.com/v1', model: 'whisper-1', apiKey: 'k' };

describe('TranscriptionService', () => {
  it('is disabled and returns null when no model is configured', async () => {
    const svc = new TranscriptionService({ profile: () => null });
    expect(svc.enabled).toBe(false);
    expect(await svc.transcribe({ bytes: Buffer.from('x'), mimeType: 'audio/ogg' })).toBeNull();
  });

  it('posts multipart audio and returns the transcript text', async () => {
    const calls: Array<{ url: string; auth?: string; model?: unknown; filename?: string }> = [];
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      const form = init.body as FormData;
      calls.push({
        url,
        auth: (init.headers as Record<string, string>)?.authorization,
        model: form.get('model'),
        filename: (form.get('file') as File)?.name,
      });
      return new Response(JSON.stringify({ text: '  hello world  ' }), { status: 200 });
    }) as unknown as typeof fetch;

    const svc = new TranscriptionService({ profile: () => profile, fetchImpl });
    const text = await svc.transcribe({ bytes: Buffer.from([1, 2, 3]), mimeType: 'audio/ogg; codecs=opus' });

    expect(text).toBe('hello world');
    expect(calls[0]!.url).toBe('https://api.example.com/v1/audio/transcriptions');
    expect(calls[0]!.auth).toBe('Bearer k');
    expect(calls[0]!.model).toBe('whisper-1');
    expect(calls[0]!.filename).toBe('audio.ogg');
  });

  it('returns null (never throws) on a failed request', async () => {
    const fetchImpl = (async () => new Response('nope', { status: 500 })) as unknown as typeof fetch;
    const svc = new TranscriptionService({ profile: () => profile, fetchImpl });
    expect(await svc.transcribe({ bytes: Buffer.from('x'), mimeType: 'audio/ogg' })).toBeNull();
  });

  it('resolveTranscriptionsUrl appends the endpoint idempotently', () => {
    expect(resolveTranscriptionsUrl('https://api.example.com/v1')).toBe('https://api.example.com/v1/audio/transcriptions');
    expect(resolveTranscriptionsUrl('https://api.example.com/v1/')).toBe('https://api.example.com/v1/audio/transcriptions');
    expect(resolveTranscriptionsUrl('https://api.example.com/v1/audio/transcriptions')).toBe('https://api.example.com/v1/audio/transcriptions');
  });
});
