/**
 * VisionService — image understanding for channel images (OMNICHANNEL §3.3).
 */
import { describe, expect, it, vi } from 'vitest';
import { VisionService, resolveChatCompletionsUrl } from '../../src/services/visionService.js';
import type { ModelProfile } from '../../src/services/orchestrator/orchestratorModelRouter.js';

const profile: ModelProfile = { baseUrl: 'https://api.example.com/v1', model: 'gpt-4o', apiKey: 'k' };

describe('VisionService', () => {
  it('is disabled and returns null when no model is configured', async () => {
    const svc = new VisionService({ profile: () => null });
    expect(svc.enabled).toBe(false);
    expect(await svc.describe({ bytes: Buffer.from('x'), mimeType: 'image/png' })).toBeNull();
  });

  it('posts the image as a data URL and returns the description', async () => {
    let captured: { url: string; body: Record<string, unknown> } | null = null;
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      captured = { url, body: JSON.parse(String(init.body)) };
      return new Response(JSON.stringify({ choices: [{ message: { content: '  a red bicycle  ' } }] }), { status: 200 });
    }) as unknown as typeof fetch;

    const svc = new VisionService({ profile: () => profile, fetchImpl });
    const text = await svc.describe({ bytes: Buffer.from([1, 2, 3]), mimeType: 'image/jpeg', caption: 'what is this?' });

    expect(text).toBe('a red bicycle');
    expect(captured!.url).toBe('https://api.example.com/v1/chat/completions');
    const content = (captured!.body.messages as Array<{ content: Array<{ type: string; image_url?: { url: string } }> }>)[0].content;
    const image = content.find((c) => c.type === 'image_url');
    expect(image?.image_url?.url).toMatch(/^data:image\/jpeg;base64,/);
  });

  it('returns null (never throws) on a failed request', async () => {
    const fetchImpl = (async () => new Response('nope', { status: 500 })) as unknown as typeof fetch;
    const svc = new VisionService({ profile: () => profile, fetchImpl });
    expect(await svc.describe({ bytes: Buffer.from('x'), mimeType: 'image/png' })).toBeNull();
  });

  it('resolveChatCompletionsUrl appends the endpoint idempotently', () => {
    expect(resolveChatCompletionsUrl('https://api.example.com/v1')).toBe('https://api.example.com/v1/chat/completions');
    expect(resolveChatCompletionsUrl('https://api.example.com/v1/chat/completions')).toBe('https://api.example.com/v1/chat/completions');
  });
});
