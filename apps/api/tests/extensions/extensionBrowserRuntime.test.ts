import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { eq } from 'drizzle-orm';
import { schema, type AgentisSqliteDb } from '@agentis/db/sqlite';
import type { ExtensionPermission } from '@agentis/core';
import { BrowserPool } from '../../src/services/browserPool.js';
import { BrowserSessionManager } from '../../src/services/browser/browserSessionManager.js';
import { ExtensionRuntime } from '../../src/services/extensionRuntime.js';
import { ExtensionBrowserCheckpointStore } from '../../src/extensions/browserCheckpointStore.js';
import { LocalExtensionBrowserBackend } from '../../src/extensions/browserBackend.js';
import { createLogger } from '../../src/logger.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

const logger = createLogger({ level: 'error' });
const previousPrivate = process.env.AGENTIS_BROWSER_ALLOW_PRIVATE;
let server: Server;
let baseUrl: string;
let pool: BrowserPool;
let ctx: TestContext;
let manager: BrowserSessionManager;
let checkpoints: ExtensionBrowserCheckpointStore;
let backend: LocalExtensionBrowserBackend;

beforeAll(async () => {
  process.env.AGENTIS_BROWSER_ALLOW_PRIVATE = 'true';
  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://local.test');
    if (url.pathname === '/items') {
      const page = Number(url.searchParams.get('page') ?? '1');
      res.setHeader('content-type', 'text/html');
      res.end(`<main>${page === 1
        ? '<article class="item"><a href="/a">Alpha</a><span class="price">10</span></article><article class="item"><a href="/b">Beta</a><span class="price">20</span></article>'
        : '<article class="item"><a href="/c">Gamma</a><span class="price">30</span></article>'}</main>`);
      return;
    }
    if (url.pathname === '/login') {
      res.setHeader('set-cookie', 'sid=abc123; Path=/');
      res.end('<h1>logged-in</h1>');
      return;
    }
    if (url.pathname === '/whoami') {
      const authenticated = (req.headers.cookie ?? '').includes('sid=abc123');
      res.end(`<h1>${authenticated ? 'authenticated' : 'anonymous'}</h1>`);
      return;
    }
    res.statusCode = 404;
    res.end('not found');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  pool = new BrowserPool(logger);
});

beforeEach(async () => {
  ctx = await createTestContext();
  manager = new BrowserSessionManager(pool, { logger });
  checkpoints = new ExtensionBrowserCheckpointStore(ctx.db, ctx.vault);
  backend = new LocalExtensionBrowserBackend(manager, checkpoints, logger);
});

afterEach(async () => {
  await manager.shutdown().catch(() => {});
  ctx.close();
});

afterAll(async () => {
  await pool.shutdown().catch(() => {});
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (previousPrivate === undefined) delete process.env.AGENTIS_BROWSER_ALLOW_PRIVATE;
  else process.env.AGENTIS_BROWSER_ALLOW_PRIVATE = previousPrivate;
});

describe('node_worker ctx.browser', () => {
  it('runs a real Chromium collector with loops and structured queryAll output', async () => {
    const source = `export async function collect(inputs, ctx) {
      await ctx.browser.open({ session: 'collector', resume: true });
      const rows = [];
      for (const page of [1, 2]) {
        await ctx.browser.navigate('collector', inputs.baseUrl + '/items?page=' + page);
        const result = await ctx.browser.queryAll('collector', {
          selector: '.item',
          fields: {
            name: { selector: 'a', what: 'text' },
            href: { selector: 'a', what: 'attribute', attribute: 'href' },
            price: { selector: '.price', what: 'text' }
          }
        });
        rows.push(...result.value);
      }
      return { rows };
    }`;
    const extensionId = seedExtension(ctx.db, ctx, source, ['browser', 'browser.session.persist']);
    const runtime = runtimeFor(backend);
    const result = await runtime.execute({
      workspaceId: ctx.workspace.id,
      extensionId,
      operationName: 'collect',
      input: { baseUrl },
      scratchpadSnapshot: {},
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.output.rows).toEqual([
        { name: 'Alpha', href: '/a', price: '10' },
        { name: 'Beta', href: '/b', price: '20' },
        { name: 'Gamma', href: '/c', price: '30' },
      ]);
    }
    expect(checkpoints.count(ctx.workspace.id)).toBe(1);
    await runtime.cleanupExtensionBrowser(ctx.workspace.id, extensionId);
    expect(checkpoints.count(ctx.workspace.id)).toBe(0);
    expect(manager.size).toBe(0);
  }, 180_000);

  it('denies browser calls without the manifest permission', async () => {
    const source = `export async function collect(_inputs, ctx) {
      await ctx.browser.open({ session: 'denied' });
      return {};
    }`;
    const extensionId = seedExtension(ctx.db, ctx, source, []);
    const result = await runtimeFor(backend).execute({
      workspaceId: ctx.workspace.id,
      extensionId,
      operationName: 'collect',
      input: {},
      scratchpadSnapshot: {},
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errorCode).toBe('EXTENSION_PERMISSION_DENIED');
  });

  it('enforces allowedDomains on navigation', async () => {
    const source = `export async function collect(inputs, ctx) {
      await ctx.browser.open({ session: 'blocked' });
      await ctx.browser.navigate('blocked', inputs.url);
      return {};
    }`;
    const extensionId = seedExtension(ctx.db, ctx, source, ['browser'], ['example.com']);
    const result = await runtimeFor(backend).execute({
      workspaceId: ctx.workspace.id,
      extensionId,
      operationName: 'collect',
      input: { url: `${baseUrl}/items?page=1` },
      scratchpadSnapshot: {},
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errorCode).toBe('EXTENSION_NETWORK_VIOLATION');
  });

  it('requires explicit evaluate and auth-profile permissions', async () => {
    const authSource = `export async function collect(_inputs, ctx) {
      await ctx.browser.open({ session: 'auth', authProfile: 'operator-login' });
      return {};
    }`;
    const authExtension = seedExtension(ctx.db, ctx, authSource, ['browser']);
    const authResult = await runtimeFor(backend).execute({
      workspaceId: ctx.workspace.id,
      extensionId: authExtension,
      operationName: 'collect',
      input: {},
      scratchpadSnapshot: {},
    });
    expect(authResult.ok).toBe(false);
    if (!authResult.ok) expect(authResult.errorCode).toBe('EXTENSION_PERMISSION_DENIED');

    const evaluateSource = `export async function collect(inputs, ctx) {
      await ctx.browser.open({ session: 'evaluate' });
      await ctx.browser.navigate('evaluate', inputs.url);
      return await ctx.browser.evaluate('evaluate', 'document.title');
    }`;
    const evaluateExtension = seedExtension(ctx.db, ctx, evaluateSource, ['browser']);
    const evaluateResult = await runtimeFor(backend).execute({
      workspaceId: ctx.workspace.id,
      extensionId: evaluateExtension,
      operationName: 'collect',
      input: { url: `${baseUrl}/items?page=1` },
      scratchpadSnapshot: {},
    });
    expect(evaluateResult.ok).toBe(false);
    if (!evaluateResult.ok) expect(evaluateResult.errorCode).toBe('EXTENSION_PERMISSION_DENIED');

    const allowedEvaluateExtension = seedExtension(ctx.db, ctx, evaluateSource, ['browser', 'browser.evaluate']);
    const allowedEvaluateResult = await runtimeFor(backend).execute({
      workspaceId: ctx.workspace.id,
      extensionId: allowedEvaluateExtension,
      operationName: 'collect',
      input: { url: `${baseUrl}/items?page=1` },
      scratchpadSnapshot: {},
    });
    expect(allowedEvaluateResult.ok).toBe(true);
    if (allowedEvaluateResult.ok) expect(allowedEvaluateResult.output.value).toBe('');
  }, 180_000);

  it('rehydrates encrypted cookies after the browser manager is reconstructed', async () => {
    const source = `export async function collect(inputs, ctx) {
      await ctx.browser.open({ session: 'account', resume: true });
      await ctx.browser.navigate('account', inputs.url);
      const value = await ctx.browser.get('account', { selector: 'h1', what: 'text' });
      return { state: value.value };
    }`;
    const extensionId = seedExtension(ctx.db, ctx, source, ['browser', 'browser.session.persist']);
    const first = await runtimeFor(backend).execute({
      workspaceId: ctx.workspace.id,
      extensionId,
      operationName: 'collect',
      input: { url: `${baseUrl}/login` },
      scratchpadSnapshot: {},
    });
    expect(first.ok && first.output.state).toBe('logged-in');

    const encrypted = ctx.db.select({ value: schema.extensionBrowserCheckpoints.encryptedValue })
      .from(schema.extensionBrowserCheckpoints)
      .where(eq(schema.extensionBrowserCheckpoints.extensionId, extensionId)).get()?.value;
    expect(encrypted).toBeTruthy();
    expect(encrypted).not.toContain('abc123');

    await manager.shutdown();
    manager = new BrowserSessionManager(pool, { logger });
    backend = new LocalExtensionBrowserBackend(manager, checkpoints, logger);
    const resumed = await runtimeFor(backend).execute({
      workspaceId: ctx.workspace.id,
      extensionId,
      operationName: 'collect',
      input: { url: `${baseUrl}/whoami` },
      scratchpadSnapshot: {},
    });
    expect(resumed.ok && resumed.output.state).toBe('authenticated');

    // Same workspace + same session name, but a different extension ID, must
    // receive neither the live page nor the encrypted checkpoint.
    const otherExtensionId = seedExtension(ctx.db, ctx, source, ['browser', 'browser.session.persist']);
    const isolated = await runtimeFor(backend).execute({
      workspaceId: ctx.workspace.id,
      extensionId: otherExtensionId,
      operationName: 'collect',
      input: { url: `${baseUrl}/whoami` },
      scratchpadSnapshot: {},
    });
    expect(isolated.ok && isolated.output.state).toBe('anonymous');
  }, 180_000);
});

function runtimeFor(browserBackend: LocalExtensionBrowserBackend): ExtensionRuntime {
  return new ExtensionRuntime(ctx.db, ctx.logger, { dockerEnabled: false }, undefined, ctx.vault, browserBackend);
}

function seedExtension(
  db: AgentisSqliteDb,
  test: TestContext,
  source: string,
  permissions: ExtensionPermission[],
  allowedDomains = ['127.0.0.1'],
): string {
  const id = randomUUID();
  const slug = `browser-${id.slice(0, 8)}`;
  db.insert(schema.extensions).values({
    id,
    workspaceId: test.workspace.id,
    ambientId: test.ambient.id,
    userId: test.user.id,
    name: 'Browser collector',
    slug,
    version: '1.0.0',
    runtime: 'node_worker',
    manifest: {
      name: 'Browser collector',
      slug,
      version: '1.0.0',
      runtime: 'node_worker',
      source,
      operations: [{ name: 'collect', inputSchema: {}, outputSchema: {} }],
      permissions,
      allowedDomains,
      capabilityTags: ['browser'],
      timeoutMs: 60_000,
    },
  }).run();
  return id;
}
