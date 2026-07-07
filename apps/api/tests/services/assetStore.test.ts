import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { schema } from '@agentis/db/sqlite';
import { ArtifactService } from '../../src/services/artifactService.js';
import { AssetStore } from '../../src/services/assetStore.js';
import { blobRelPath, parseAssetRef } from '../../src/services/assetPaths.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

let ctx: TestContext;
let assetsDir: string;
let artifacts: ArtifactService;
let store: AssetStore;

beforeEach(async () => {
  ctx = await createTestContext();
  assetsDir = mkdtempSync(join(tmpdir(), 'agentis-assets-'));
  artifacts = new ArtifactService(ctx.db, ctx.logger, ctx.bus, assetsDir);
  store = new AssetStore(assetsDir, artifacts, ctx.db, ctx.logger);
});

afterEach(() => {
  ctx.close();
  rmSync(assetsDir, { recursive: true, force: true });
});

describe('AssetStore', () => {
  it('stores by content hash and registers an artifact referencing the blob', async () => {
    const bytes = Buffer.from('hello world', 'utf8');
    const stored = await store.put({ workspaceId: ctx.workspace.id, bytes, name: 'greeting.txt' });

    expect(stored.hash).toMatch(/^[a-f0-9]{64}$/);
    expect(stored.deduped).toBe(false);
    expect(existsSync(join(assetsDir, blobRelPath(stored.hash)))).toBe(true);

    const row = ctx.db.select().from(schema.artifacts).where(eq(schema.artifacts.id, stored.id)).get();
    expect(row?.content).toBe(`asset://${stored.hash}`);
    expect(parseAssetRef(row!.content)).toBe(stored.hash);
    expect((row!.metadata as { hash: string }).hash).toBe(stored.hash);
  });

  it('dedups identical bytes to a single blob (no second write)', async () => {
    const bytes = Buffer.from('same-content', 'utf8');
    const first = await store.put({ workspaceId: ctx.workspace.id, bytes, name: 'a.txt' });
    const second = await store.put({ workspaceId: ctx.workspace.id, bytes, name: 'b.txt' });

    expect(second.hash).toBe(first.hash);
    expect(first.deduped).toBe(false);
    expect(second.deduped).toBe(true);

    // Two artifact rows (different logical names), but exactly one blob on disk.
    const shard = join(assetsDir, 'blobs', first.hash.slice(0, 2));
    expect(readdirSync(shard)).toHaveLength(1);
  });

  it('resolves an asset:// artifact back to its bytes', async () => {
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    const stored = await store.put({ workspaceId: ctx.workspace.id, bytes, name: 'pixel.png', mime: 'image/png' });
    const resolved = await artifacts.resolveBytes(ctx.workspace.id, `artifact:${stored.id}`);
    expect(resolved.buffer.equals(bytes)).toBe(true);
    expect(resolved.mimeType).toBe('image/png');
  });

  it('gc removes an unreferenced blob but keeps referenced ones', async () => {
    const keep = await store.put({ workspaceId: ctx.workspace.id, bytes: Buffer.from('keep'), name: 'keep.txt' });
    const drop = await store.put({ workspaceId: ctx.workspace.id, bytes: Buffer.from('drop'), name: 'drop.txt' });

    // Delete the artifact that references `drop` — its blob is now unreferenced.
    ctx.db.delete(schema.artifacts).where(eq(schema.artifacts.id, drop.id)).run();

    const result = await store.gc({ graceMs: 0 });
    expect(result.removedBlobs).toBe(1);
    expect(existsSync(join(assetsDir, blobRelPath(drop.hash)))).toBe(false);
    expect(existsSync(join(assetsDir, blobRelPath(keep.hash)))).toBe(true);
  });

  it('gc spares freshly-written blobs within the grace window', async () => {
    const stored = await store.put({ workspaceId: ctx.workspace.id, bytes: Buffer.from('fresh'), name: 'fresh.txt' });
    ctx.db.delete(schema.artifacts).where(eq(schema.artifacts.id, stored.id)).run();

    const result = await store.gc({ graceMs: 60_000 });
    expect(result.removedBlobs).toBe(0);
    expect(existsSync(join(assetsDir, blobRelPath(stored.hash)))).toBe(true);
  });
});

/**
 * A run/workflow-produced artifact must file under the App that owns the
 * workflow, even when the save path holds no explicit appId (the common case:
 * the App owns the workflow and is often created after it). Without this the
 * App's Assets tab (which filters `?appId=`) is empty despite assets existing.
 */
describe('ArtifactService app-linkage', () => {
  let fkCtx: TestContext;
  let svc: ArtifactService;
  const APP = randomUUID();
  const WF = randomUUID();

  beforeEach(async () => {
    // FK off so we can wire a synthetic App→workflow ownership without a full apps row.
    fkCtx = await createTestContext({ foreignKeysOff: true });
    svc = new ArtifactService(fkCtx.db, fkCtx.logger, fkCtx.bus);
    fkCtx.db.insert(schema.workflows).values({
      id: WF, workspaceId: fkCtx.workspace.id, userId: fkCtx.user.id,
      appId: APP, title: 'Owned WF', graph: { nodes: [], edges: [] },
    }).run();
  });
  afterEach(() => fkCtx.close());

  const save = (extra: { workflowId?: string; runId?: string; appId?: string }) =>
    svc.persist({ workspaceId: fkCtx.workspace.id, type: 'image', title: 't', name: 't.png', content: 'data:image/png;base64,AA==', ...extra });
  const rowOf = (id: string) => fkCtx.db.select().from(schema.artifacts).where(eq(schema.artifacts.id, id)).get();

  it('resolves the App from workflowId when no appId is passed', () => {
    const row = rowOf(save({ workflowId: WF }).id);
    expect(row?.appId).toBe(APP);
    expect(row?.origin).toBe('app'); // origin follows the resolved App
  });

  it('resolves the App from runId via the run → workflow chain', () => {
    const runId = randomUUID();
    fkCtx.db.insert(schema.workflowRuns).values({
      id: runId, workspaceId: fkCtx.workspace.id, workflowId: WF, userId: fkCtx.user.id, runState: {},
    }).run();
    expect(rowOf(save({ runId }).id)?.appId).toBe(APP);
  });

  it('leaves a bare (ownerless) workflow unlinked', () => {
    const bareWf = randomUUID();
    fkCtx.db.insert(schema.workflows).values({
      id: bareWf, workspaceId: fkCtx.workspace.id, userId: fkCtx.user.id, title: 'Bare', graph: { nodes: [], edges: [] },
    }).run();
    const row = rowOf(save({ workflowId: bareWf }).id);
    expect(row?.appId).toBeNull();
    expect(row?.origin).toBe('workflow');
  });

  it('honors an explicit appId over provenance resolution', () => {
    const explicit = randomUUID();
    expect(rowOf(save({ workflowId: WF, appId: explicit }).id)?.appId).toBe(explicit);
  });
});
