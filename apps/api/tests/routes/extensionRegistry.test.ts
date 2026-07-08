/**
 * /v1/extensions/registry routes — bridge integration with mocked RegistryClient.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { Hono } from 'hono';
import { schema } from '@agentis/db/sqlite';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';
import { buildExtensionRegistryRoutes } from '../../src/routes/extensionRegistry.js';
import { RegistryClient } from '../../src/services/registryClient.js';
import { ActivityFeedService } from '../../src/services/activityFeed.js';

function fakeEntry(slug: string, body: string) {
  const sha256 = createHash('sha256').update(body).digest('hex');
  return {
    entryId: slug,
    entryType: 'skill' as const,
    slug,
    title: 'Hello',
    summary: 'demo',
    version: '0.1.0',
    author: { username: 'a', displayName: 'A' },
    artifacts: [
      {
        artifactType: 'skill_bundle' as const,
        sha256,
        downloadUrl: 'https://example.test/skills/' + slug + '/content',
      },
    ],
  };
}

function buildBridge(entries: Record<string, { entry: ReturnType<typeof fakeEntry>; bytes: Buffer }>) {
  const bridge = new RegistryClient({ registryUrl: 'https://example.test/api', timeoutMs: 1000, logger: console as never });
  vi.spyOn(bridge, 'isConfigured').mockReturnValue(true);
  vi.spyOn(bridge, 'breakerState').mockReturnValue({ state: 'closed', failures: 0, openedAt: null } as never);
  vi.spyOn(bridge, 'search').mockImplementation(async () => ({ entries: Object.values(entries).map((e) => e.entry) }));
  vi.spyOn(bridge, 'getEntry').mockImplementation(async ({ slug }) => {
    const hit = entries[slug];
    if (!hit) throw new Error('not found');
    return hit.entry;
  });
  vi.spyOn(bridge, 'fetchArtifactBytes').mockImplementation(async ({ slug }) => {
    const hit = entries[slug];
    if (!hit) throw new Error('not found');
    return { bytes: hit.bytes };
  });
  return bridge;
}

describe('/v1/extensions/registry', () => {
  let ctx: TestContext;
  let activity: ActivityFeedService;
  beforeEach(async () => {
    ctx = await createTestContext();
    activity = new ActivityFeedService(ctx.db, ctx.bus);
  });
  afterEach(() => ctx.close());

  it('GET /status returns configured + breaker', async () => {
    const bridge = buildBridge({});
    const app = ctx.buildApp([{ path: '/v1/extensions/registry', app: buildExtensionRegistryRoutes({ db: ctx.db, auth: ctx.auth, registry: bridge, activity }) }]);
    const res = await app.request('/v1/extensions/registry/status', { headers: ctx.authHeaders });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.configured).toBe(true);
    expect(body.breaker.state).toBe('closed');
  });

  it('GET /registry returns entries from the bridge', async () => {
    const bridge = buildBridge({ demo: { entry: fakeEntry('demo', 'console.log(1)'), bytes: Buffer.from('console.log(1)') } });
    const app = ctx.buildApp([{ path: '/v1/extensions/registry', app: buildExtensionRegistryRoutes({ db: ctx.db, auth: ctx.auth, registry: bridge, activity }) }]);
    const res = await app.request('/v1/extensions/registry', { headers: ctx.authHeaders });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.entries).toHaveLength(1);
    expect(body.entries[0].slug).toBe('demo');
  });

  it('POST /install/:slug verifies SHA-256 and writes installed_registry_artifacts + activity row', async () => {
    const bytes = Buffer.from('export default {}');
    const bridge = buildBridge({ demo: { entry: fakeEntry('demo', bytes.toString()), bytes } });
    const app = ctx.buildApp([{ path: '/v1/extensions/registry', app: buildExtensionRegistryRoutes({ db: ctx.db, auth: ctx.auth, registry: bridge, activity }) }]);
    const res = await app.request('/v1/extensions/registry/install/demo', {
      method: 'POST',
      headers: { ...ctx.authHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({ permissionsAcknowledged: true }),
    });
    expect(res.status).toBe(201);
    const installed = ctx.db.select().from(schema.installedRegistryArtifacts).all();
    expect(installed).toHaveLength(1);
    expect(installed[0]!.entryId).toBe('demo');
    const events = ctx.db.select().from(schema.activityEvents).all();
    expect(events.some((e) => e.eventType === 'extension_registry.installed')).toBe(true);
  });

  it('POST /install/:slug rejects when permissionsAcknowledged is missing', async () => {
    const bytes = Buffer.from('export default {}');
    const bridge = buildBridge({ demo: { entry: fakeEntry('demo', bytes.toString()), bytes } });
    const app = ctx.buildApp([{ path: '/v1/extensions/registry', app: buildExtensionRegistryRoutes({ db: ctx.db, auth: ctx.auth, registry: bridge, activity }) }]);
    const res = await app.request('/v1/extensions/registry/install/demo', {
      method: 'POST',
      headers: { ...ctx.authHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it('POST /install/:slug rejects when SHA-256 does not match', async () => {
    const bytes = Buffer.from('actual content');
    const entry = fakeEntry('demo', 'different content');
    const bridge = buildBridge({ demo: { entry, bytes } });
    const app = ctx.buildApp([{ path: '/v1/extensions/registry', app: buildExtensionRegistryRoutes({ db: ctx.db, auth: ctx.auth, registry: bridge, activity }) }]);
    const res = await app.request('/v1/extensions/registry/install/demo', {
      method: 'POST',
      headers: { ...ctx.authHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({ permissionsAcknowledged: true }),
    });
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error?.code).toBe('EXTENSION_REGISTRY_HASH_MISMATCH');
  });

  it('POST /install/:slug blocks artifacts containing secrets', async () => {
    const awsKey = ['AKIA', 'ABCDEFGHIJKLMNOP'].join('');
    const bytes = Buffer.from(`const k = "${awsKey}";`);
    const bridge = buildBridge({ bad: { entry: fakeEntry('bad', bytes.toString()), bytes } });
    const app = ctx.buildApp([{ path: '/v1/extensions/registry', app: buildExtensionRegistryRoutes({ db: ctx.db, auth: ctx.auth, registry: bridge, activity }) }]);
    const res = await app.request('/v1/extensions/registry/install/bad', {
      method: 'POST',
      headers: { ...ctx.authHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({ permissionsAcknowledged: true }),
    });
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error?.code).toBe('EXTENSION_REGISTRY_SCAN_BLOCKED');
  });
});
