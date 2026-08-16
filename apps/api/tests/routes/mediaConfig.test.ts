/**
 * /v1/media/models — per-workspace media-generation model config
 * (INTEGRATION-CEILING-10X §1). Mirrors orchestratorModels.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';
import { WorkspaceMediaConfigService } from '../../src/services/workspace/workspaceMediaConfigService.js';
import { buildMediaConfigRoutes } from '../../src/routes/mediaConfig.js';

let ctx: TestContext;
let config: WorkspaceMediaConfigService;

function app() {
  return ctx.buildApp([
    {
      path: '/v1/media/models',
      app: buildMediaConfigRoutes({
        db: ctx.db,
        auth: ctx.auth,
        config,
        envDefaults: { image: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-image-1', hasApiKey: false } },
      }),
    },
  ]);
}

beforeEach(async () => {
  ctx = await createTestContext();
  config = new WorkspaceMediaConfigService({ db: ctx.db, vault: ctx.vault, logger: ctx.logger });
});

afterEach(() => ctx.close());

describe('/v1/media/models', () => {
  it('GET does not advertise an unauthenticated public default as available', async () => {
    const res = await app().request('/v1/media/models', { headers: ctx.authHeaders });
    expect(res.status).toBe(200);
    const body = await res.json() as { modalities: Array<{ modality: string; envDefault: unknown; override: unknown; effectiveModel: string | null; available: boolean }> };
    const image = body.modalities.find((m) => m.modality === 'image')!;
    expect(image.envDefault).toMatchObject({ model: 'gpt-image-1', hasApiKey: false });
    expect(image.override).toBeNull();
    expect(image.effectiveModel).toBe('gpt-image-1');
    expect(image.available).toBe(false);
  });

  it('PUT sets a full custom override (arbitrary model/baseUrl/apiKey — bring your own OpenRouter endpoint)', async () => {
    const put = await app().request('/v1/media/models/image', {
      method: 'PUT',
      headers: ctx.authHeaders,
      body: JSON.stringify({ model: 'some-vendor/some-image-model', baseUrl: 'https://openrouter.ai/api/v1', apiKey: 'or-key-123' }),
    });
    expect(put.status).toBe(200);
    const putBody = await put.json() as { modality: { model: string; baseUrl: string | null; hasApiKey: boolean } };
    expect(putBody.modality.model).toBe('some-vendor/some-image-model');
    expect(putBody.modality.baseUrl).toBe('https://openrouter.ai/api/v1');
    expect(putBody.modality.hasApiKey).toBe(true);
    // The API key is never echoed back in any subsequent GET.
    const list = await app().request('/v1/media/models', { headers: ctx.authHeaders });
    const listBody = await list.json() as { modalities: Array<{ modality: string; effectiveModel: string | null; available: boolean }> };
    const image = listBody.modalities.find((m) => m.modality === 'image')!;
    expect(image.effectiveModel).toBe('some-vendor/some-image-model');
    expect(image.available).toBe(true);
    expect(JSON.stringify(list)).not.toContain('or-key-123');
  });

  it('DELETE clears the override, reverting to the env default', async () => {
    await app().request('/v1/media/models/image', {
      method: 'PUT',
      headers: ctx.authHeaders,
      body: JSON.stringify({ model: 'custom-model' }),
    });
    const del = await app().request('/v1/media/models/image', { method: 'DELETE', headers: ctx.authHeaders });
    expect(del.status).toBe(200);
    const list = await app().request('/v1/media/models', { headers: ctx.authHeaders });
    const body = await list.json() as { modalities: Array<{ modality: string; effectiveModel: string | null; override: unknown }> };
    const image = body.modalities.find((m) => m.modality === 'image')!;
    expect(image.effectiveModel).toBe('gpt-image-1');
    expect(image.override).toBeNull();
  });

  it('rejects an unknown modality with a clear 422, not a 500', async () => {
    const res = await app().request('/v1/media/models/not-a-real-modality', {
      method: 'PUT',
      headers: ctx.authHeaders,
      body: JSON.stringify({ model: 'x' }),
    });
    expect(res.status).toBe(422);
  });
});
