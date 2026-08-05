/**
 * /v1/extensions — route unit tests.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { schema } from '@agentis/db/sqlite';
import { buildExtensionRoutes } from '../../src/routes/extensions.js';
import { ExtensionLibraryService } from '../../src/services/extensionLibrary.js';
import { WorkspaceVolumeService } from '../../src/services/workspace/workspaceVolume.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

let ctx: TestContext;
let dataDir: string;
let extensionLibrary: ExtensionLibraryService;

beforeEach(async () => {
  ctx = await createTestContext();
  dataDir = await mkdtemp(path.join(tmpdir(), 'agentis-ext-routes-'));
  extensionLibrary = new ExtensionLibraryService(new WorkspaceVolumeService(dataDir), ctx.db);
});
afterEach(async () => {
  ctx.close();
  await rm(dataDir, { recursive: true, force: true });
});

function app() {
  return ctx.buildApp([
    { path: '/v1/extensions', app: buildExtensionRoutes({ db: ctx.db, auth: ctx.auth, extensionLibrary }) },
  ]);
}

describe('GET /v1/extensions', () => {
  it('returns workspace extensions', async () => {
    ctx.db
      .insert(schema.extensions)
      .values({
        id: randomUUID(),
        workspaceId: ctx.workspace.id,
        ambientId: ctx.ambient.id,
        userId: ctx.user.id,
        packageId: null,
        name: 'Echo',
        slug: 'echo',
        version: '1.0.0',
        runtime: 'node_worker',
        manifest: {
          name: 'Echo',
          slug: 'echo',
          version: '1.0.0',
          runtime: 'node_worker',
          operations: [{ name: 'execute', inputSchema: {}, outputSchema: {} }],
        },
      })
      .run();
    const res = await app().request('/v1/extensions', { headers: ctx.authHeaders });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { extensions: unknown[] };
    expect(body.extensions).toHaveLength(1);
  });

  it('rejects without auth (401)', async () => {
    const res = await app().request('/v1/extensions');
    expect(res.status).toBe(401);
  });
});

describe('POST /v1/extensions/install-local', () => {
  it('installs an extension from a local manifest', async () => {
    const res = await app().request('/v1/extensions/install-local', {
      method: 'POST',
      headers: ctx.authHeaders,
      body: JSON.stringify({
        manifest: {
          name: 'My Extension',
          slug: 'my-extension',
          version: '0.1.0',
          runtime: 'node_worker',
          source: 'export async function execute(inputs) { return inputs; }',
          capabilityTags: ['utility'],
          operations: [{ name: 'execute', inputSchema: {}, outputSchema: {} }],
        },
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { extension: { slug: string; runtime: string } };
    expect(body.extension.slug).toBe('my-extension');
    expect(body.extension.runtime).toBe('node_worker');
  });

  it('updates a duplicate local install through the canonical extension library', async () => {
    const first = await app().request('/v1/extensions/install-local', {
      method: 'POST',
      headers: ctx.authHeaders,
      body: JSON.stringify({
        manifest: {
          name: 'AI News Site Monitor',
          slug: 'ai-news-site-monitor',
          version: '1.0.0',
          runtime: 'node_worker',
          source: 'export async function fetchPosts() { return { posts: [] }; }',
          operations: [{ name: 'fetchPosts', inputSchema: {}, outputSchema: {} }],
        },
      }),
    });
    const second = await app().request('/v1/extensions/install-local', {
      method: 'POST',
      headers: ctx.authHeaders,
      body: JSON.stringify({
        manifest: {
          name: 'AI News Site Monitor',
          slug: 'ai-news-site-monitor-listener',
          version: '1.0.0',
          runtime: 'node_worker',
          source: 'export async function listen(input, ctx) { await ctx.emit(input); return {}; }',
          permissions: ['listener', 'listener.emit'],
          operations: [{ name: 'listen', inputSchema: {}, outputSchema: {}, isListenerSource: true }],
        },
        permissionsAcknowledged: ['listener', 'listener.emit'],
      }),
    });

    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    const firstBody = (await first.json()) as { extension: { id: string } };
    const secondBody = (await second.json()) as { extension: { id: string; created: boolean; matchedBy: string } };
    expect(secondBody.extension.id).toBe(firstBody.extension.id);
    expect(secondBody.extension.created).toBe(false);
    expect(secondBody.extension.matchedBy).toBe('identity');
    expect(ctx.db.select().from(schema.extensions).all()).toHaveLength(1);
  });

  it('returns 422 on invalid runtime', async () => {
    const res = await app().request('/v1/extensions/install-local', {
      method: 'POST',
      headers: ctx.authHeaders,
      body: JSON.stringify({
        manifest: {
          name: 'X',
          slug: 'x',
          version: '0.1.0',
          runtime: 'wasm',
          entrypoint: 'index.js',
        },
      }),
    });
    expect(res.status).toBe(422);
  });

  it('returns 422 on missing manifest', async () => {
    const res = await app().request('/v1/extensions/install-local', {
      method: 'POST',
      headers: ctx.authHeaders,
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(422);
  });

  it('returns 422 when a local node_worker has no source', async () => {
    const res = await app().request('/v1/extensions/install-local', {
      method: 'POST',
      headers: ctx.authHeaders,
      body: JSON.stringify({
        manifest: {
          name: 'Missing Code',
          slug: 'missing-code',
          version: '0.1.0',
          runtime: 'node_worker',
          entrypoint: 'index.js',
        },
      }),
    });
    expect(res.status).toBe(422);
  });
});

describe('POST /v1/extensions/install-component', () => {
  it('persists a portable Component V2 bundle and upgrades the requested extension in place', async () => {
    const extensionId = randomUUID();
    ctx.db.insert(schema.extensions).values({
      id: extensionId,
      workspaceId: ctx.workspace.id,
      ambientId: ctx.ambient.id,
      userId: ctx.user.id,
      packageId: null,
      name: 'Legacy prospect search',
      slug: 'prospect-search',
      version: '1.0.0',
      runtime: 'node_worker',
      manifest: {
        name: 'Legacy prospect search',
        slug: 'prospect-search',
        version: '1.0.0',
        runtime: 'node_worker',
        source: 'export async function execute() { return {}; }',
        operations: [{ name: 'execute', inputSchema: {}, outputSchema: {} }],
      },
    }).run();

    const files = [
      portableFile('index.js', 'export async function execute(input) { return input; }'),
      portableFile('package-lock.json', '{"lockfileVersion":3}'),
    ];
    const bundleHash = createHash('sha256');
    for (const file of files) {
      bundleHash.update(file.path);
      bundleHash.update('\0');
      bundleHash.update(Buffer.from(file.dataBase64, 'base64'));
      bundleHash.update('\0');
    }
    const bundleDigest = bundleHash.digest('hex');
    const previousDataDir = process.env.AGENTIS_DATA_DIR;
    process.env.AGENTIS_DATA_DIR = dataDir;
    try {
      const res = await app().request('/v1/extensions/install-component', {
        method: 'POST',
        headers: ctx.authHeaders,
        body: JSON.stringify({
          extensionId,
          bundleFiles: files,
          permissionsAcknowledged: [],
          manifest: {
            name: 'Deterministic prospect search',
            slug: 'prospect-search',
            version: '2.0.0',
            runtime: 'component_oci',
            permissions: [],
            allowedDomains: [],
            capabilityTags: ['prospecting'],
            component: {
              manifestVersion: 2,
              id: 'prospect-search',
              version: '2.0.0',
              runtime: { language: 'node', version: '20' },
              entrypoint: 'index.js',
              operations: [{ name: 'execute', inputSchema: {}, outputSchema: {} }],
              dependencyLock: 'package-lock.json',
              bundleHash: bundleDigest,
              permissions: [],
              allowedDomains: [],
              resources: { cpu: 1, memoryMb: 128, timeoutSec: 30 },
            },
          },
        }),
      });

      const body = (await res.json()) as { extension: { id: string; upgraded: boolean; manifest: Record<string, unknown> }; error?: unknown };
      if (res.status !== 200) throw new Error(`install-component returned ${res.status}: ${JSON.stringify(body)}`);
      expect(body.extension.id).toBe(extensionId);
      expect(body.extension.upgraded).toBe(true);
      const row = ctx.db.select().from(schema.extensions).all().find((item) => item.id === extensionId)!;
      expect(row.runtime).toBe('component_oci');
      expect(row.packageId).toBeNull();
      expect(row.manifest).toMatchObject({
        runtime: 'component_oci',
        bundleDir: expect.stringContaining(bundleDigest),
        component: { manifestVersion: 2, id: 'prospect-search' },
      });
    } finally {
      if (previousDataDir === undefined) delete process.env.AGENTIS_DATA_DIR;
      else process.env.AGENTIS_DATA_DIR = previousDataDir;
    }
  });
});

function portableFile(filePath: string, contents: string) {
  const bytes = Buffer.from(contents);
  return {
    path: filePath,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    dataBase64: bytes.toString('base64'),
  };
}

describe('GET /v1/extensions/listener-sources', () => {
  it('only returns executable listener sources with listener.emit permission', async () => {
    ctx.db.insert(schema.extensions).values([
      {
        id: randomUUID(),
        workspaceId: ctx.workspace.id,
        ambientId: ctx.ambient.id,
        userId: ctx.user.id,
        packageId: null,
        name: 'Incomplete Listener',
        slug: 'incomplete-listener',
        version: '1.0.0',
        runtime: 'node_worker',
        manifest: {
          name: 'Incomplete Listener',
          slug: 'incomplete-listener',
          version: '1.0.0',
          runtime: 'node_worker',
          operations: [{ name: 'listen', inputSchema: {}, outputSchema: {}, isListenerSource: true }],
          permissions: ['listener'],
        },
      },
      {
        id: randomUUID(),
        workspaceId: ctx.workspace.id,
        ambientId: ctx.ambient.id,
        userId: ctx.user.id,
        packageId: null,
        name: 'Ready Listener',
        slug: 'ready-listener',
        version: '1.0.0',
        runtime: 'node_worker',
        manifest: {
          name: 'Ready Listener',
          slug: 'ready-listener',
          version: '1.0.0',
          runtime: 'node_worker',
          operations: [{ name: 'listen', inputSchema: {}, outputSchema: {}, isListenerSource: true }],
          permissions: ['listener', 'listener.emit'],
        },
      },
    ]).run();

    const res = await app().request('/v1/extensions/listener-sources', { headers: ctx.authHeaders });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sources: Array<{ slug: string }> };
    expect(body.sources.map((source) => source.slug)).toEqual(['ready-listener']);
  });
});
