/**
 * Blob-serving routes (Assets storage) — asserts that a content-addressed
 * artifact streams its real bytes through the authenticated HTTP stack, which
 * is what lets the Assets library render agent/app-generated media.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildArtifactRoutes } from '../../src/routes/artifacts.js';
import { ArtifactService } from '../../src/services/artifactService.js';
import { AssetStore } from '../../src/services/assetStore.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

let ctx: TestContext;
let assetsDir: string;
let store: AssetStore;

beforeEach(async () => {
  ctx = await createTestContext();
  assetsDir = mkdtempSync(join(tmpdir(), 'agentis-blob-'));
  const artifacts = new ArtifactService(ctx.db, ctx.logger, ctx.bus, assetsDir);
  store = new AssetStore(assetsDir, artifacts, ctx.db, ctx.logger);
});
afterEach(() => { ctx.close(); rmSync(assetsDir, { recursive: true, force: true }); });

function app(artifacts = new ArtifactService(ctx.db, ctx.logger, ctx.bus, assetsDir)) {
  return ctx.buildApp([{ path: '/v1/artifacts', app: buildArtifactRoutes({ db: ctx.db, auth: ctx.auth, bus: ctx.bus, artifacts, assets: store }) }]);
}

describe('/v1/artifacts/:id/content', () => {
  it('streams a stored blob with the right mime and bytes', async () => {
    const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 9, 8, 7, 6, 5]);
    const stored = await store.put({ workspaceId: ctx.workspace.id, bytes, name: 'hero.jpg', mime: 'image/jpeg' });

    const res = await app().request(`/v1/artifacts/${stored.id}/content`, { headers: ctx.authHeaders });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/jpeg');
    const body = Buffer.from(await res.arrayBuffer());
    expect(body.equals(bytes)).toBe(true);
  });

  it('serves a thumbnail for images and 404 for non-images', async () => {
    const img = await store.put({ workspaceId: ctx.workspace.id, bytes: Buffer.from([1, 2, 3]), name: 'a.png', mime: 'image/png' });
    const vid = await store.put({ workspaceId: ctx.workspace.id, bytes: Buffer.from([4, 5, 6]), name: 'a.mp4', mime: 'video/mp4' });

    const thumb = await app().request(`/v1/artifacts/${img.id}/thumbnail`, { headers: ctx.authHeaders });
    expect(thumb.status).toBe(200);
    expect(thumb.headers.get('content-type')).toBe('image/png');

    const noThumb = await app().request(`/v1/artifacts/${vid.id}/thumbnail`, { headers: ctx.authHeaders });
    expect(noThumb.status).toBe(404);
  });

  it('rejects unauthenticated requests', async () => {
    const stored = await store.put({ workspaceId: ctx.workspace.id, bytes: Buffer.from([1]), name: 'x.bin' });
    const res = await app().request(`/v1/artifacts/${stored.id}/content`);
    expect(res.status).toBe(401);
  });
});
