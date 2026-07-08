/**
 * MediaService — the provider-pluggable multimodal capability. These fence the
 * two things that matter: dispatch-by-modality + persist-to-artifact (so chat/
 * channels render it), and the default image provider's generate-vs-edit routing.
 * No vendor is hardcoded — a fake provider stands in for any real model.
 */
import { describe, expect, it, vi } from 'vitest';
import type { MediaProvider } from '@agentis/core';
import { MediaService, openAiImageProvider } from '../../src/services/mediaService.js';

const logger = { info() {}, warn() {}, error() {}, debug() {} } as never;

function fakeAssetStore() {
  const put = vi.fn(async (input: { bytes: Buffer; mime: string }) => ({ id: `art-${put.mock.calls.length}`, hash: 'h', size: input.bytes.length, mime: input.mime, deduped: false }));
  return { put } as never;
}

const imageProvider: MediaProvider = {
  id: 'fake-image',
  modalities: ['image'],
  async generate() {
    return [{ b64: Buffer.from('PNGDATA').toString('base64'), mime: 'image/png' }];
  },
};

describe('MediaService', () => {
  it('dispatches by modality, persists each output as an artifact, returns refs (screenshot shape)', async () => {
    const assetStore = fakeAssetStore();
    const svc = new MediaService({ assetStore, logger });
    svc.register(imageProvider);

    const out = await svc.generate({ workspaceId: 'ws1', appId: 'app1' }, { modality: 'image', prompt: 'a cat' });
    expect(out.provider).toBe('fake-image');
    expect(out.assets).toHaveLength(1);
    expect(out.assets[0]!.ref).toMatch(/^artifact:art-/);
    expect(out.assets[0]!.mimeType).toBe('image/png');
    // Persisted the DECODED bytes with provenance.
    const arg = (assetStore as unknown as { put: { mock: { calls: Array<[{ bytes: Buffer; mime: string; workspaceId: string }]> } } }).put.mock.calls[0]![0];
    expect(arg.bytes.toString()).toBe('PNGDATA');
    expect(arg.workspaceId).toBe('ws1');
  });

  it('advertises only the modalities its providers can produce', () => {
    const svc = new MediaService({ assetStore: fakeAssetStore(), logger });
    expect(svc.modalities()).toEqual([]);
    svc.register(imageProvider);
    expect(svc.modalities()).toEqual(['image']);
  });

  it('throws a clean MEDIA_UNAVAILABLE for a modality with no provider', async () => {
    const svc = new MediaService({ assetStore: fakeAssetStore(), logger });
    svc.register(imageProvider);
    await expect(svc.generate({ workspaceId: 'ws1' }, { modality: 'audio', prompt: 'x' })).rejects.toThrow(/audio/);
  });
});

describe('openAiImageProvider (one adapter behind the seam)', () => {
  it('POSTs /images/generations for text-only and /images/edits when reference images are given', async () => {
    const urls: string[] = [];
    const fetchMock = vi.fn(async (url: string) => {
      urls.push(url);
      return { ok: true, json: async () => ({ data: [{ b64_json: Buffer.from('X').toString('base64') }] }) } as unknown as Response;
    });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
    try {
      const p = openAiImageProvider({ baseUrl: 'https://example/v1/', apiKey: 'k', model: 'gpt-image-1' });
      await p.generate({ modality: 'image', prompt: 'a' });
      await p.generate({ modality: 'image', prompt: 'swap the logo', images: [{ b64: Buffer.from('Y').toString('base64'), mime: 'image/png' }] });
      expect(urls[0]).toBe('https://example/v1/images/generations');
      expect(urls[1]).toBe('https://example/v1/images/edits');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
