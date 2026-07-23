import { describe, expect, it, vi } from 'vitest';
import { SpeechService, resolveSpeechUrl } from '../../src/services/speechService.js';
import type { ModelProfile } from '../../src/services/orchestrator/orchestratorModelRouter.js';

const PROFILE: ModelProfile = { baseUrl: 'https://api.example.com/v1', model: 'tts-1', apiKey: 'sk-test' };

describe('resolveSpeechUrl', () => {
  it('appends /audio/speech to an OpenAI-compatible base', () => {
    expect(resolveSpeechUrl('https://api.example.com/v1')).toBe('https://api.example.com/v1/audio/speech');
    expect(resolveSpeechUrl('https://x/v1/audio/speech')).toBe('https://x/v1/audio/speech');
  });
});

describe('SpeechService', () => {
  it('is disabled and returns null when no model is configured', async () => {
    const svc = new SpeechService({ profile: () => null });
    expect(svc.enabled).toBe(false);
    expect(await svc.synthesize({ text: 'hi' })).toBeNull();
  });

  it('posts opus request and returns opus bytes on success', async () => {
    const audio = new Uint8Array([1, 2, 3, 4]);
    const fetchImpl = vi.fn(async () => new Response(audio, { status: 200 })) as unknown as typeof fetch;
    const svc = new SpeechService({ profile: () => PROFILE, fetchImpl, defaultVoice: 'nova' });
    const res = await svc.synthesize({ text: 'Hello there' });
    expect(res?.mimeType).toContain('opus');
    expect(res?.bytes.byteLength).toBe(4);
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(url).toBe('https://api.example.com/v1/audio/speech');
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body).toMatchObject({ model: 'tts-1', input: 'Hello there', voice: 'nova', response_format: 'opus' });
    expect((init as RequestInit).headers).toMatchObject({ authorization: 'Bearer sk-test' });
  });

  it('returns null (never throws) on a provider error or empty text', async () => {
    const fetchErr = vi.fn(async () => new Response('nope', { status: 500 })) as unknown as typeof fetch;
    const svc = new SpeechService({ profile: () => PROFILE, fetchImpl: fetchErr });
    expect(await svc.synthesize({ text: 'x' })).toBeNull();
    expect(await svc.synthesize({ text: '   ' })).toBeNull();
  });
});
