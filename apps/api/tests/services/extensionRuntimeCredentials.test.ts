/**
 * ExtensionRuntime — operator-bound credentials (INTEGRATION-CEILING-10X §3).
 * A manifest declares credentialKeys; the OPERATOR (not the extension's own
 * code) binds one to a real credentials-table row via setCredentialBinding;
 * ExtensionRuntime resolves + decrypts it and hands it to the sandbox ONLY as
 * a name the script can reference, never as a readable value.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { schema } from '@agentis/db/sqlite';
import { ExtensionRuntime } from '../../src/services/extensionRuntime.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

let ctx: TestContext;

beforeEach(async () => {
  ctx = await createTestContext();
  process.env.AGENTIS_EXTENSION_HTTP_ALLOW_PRIVATE = 'true'; // ExtensionRuntime.execute() reads this env var (not a param) to allow 127.0.0.1 in tests
});
afterEach(() => {
  delete process.env.AGENTIS_EXTENSION_HTTP_ALLOW_PRIVATE;
  ctx.close();
});

function seedNodeWorkerExtension(source: string, opts: { credentialKeys?: string[]; permissions?: string[] } = {}) {
  const id = randomUUID();
  const slug = `slug-${id.slice(0, 6)}`;
  ctx.db.insert(schema.extensions).values({
    id,
    workspaceId: ctx.workspace.id,
    ambientId: ctx.ambient.id,
    userId: ctx.user.id,
    packageId: null,
    name: 'ext',
    slug,
    version: '1.0.0',
    runtime: 'node_worker',
    manifest: {
      name: 'ext', slug, version: '1.0.0', runtime: 'node_worker',
      source, operations: [{ name: 'execute', inputSchema: {}, outputSchema: {} }],
      capabilityTags: [],
      permissions: opts.permissions ?? ['network', 'credentials'],
      allowedDomains: ['127.0.0.1'],
      ...(opts.credentialKeys ? { credentialKeys: opts.credentialKeys } : {}),
    },
  }).run();
  return id;
}

function seedCredential(value: string) {
  const id = randomUUID();
  ctx.db.insert(schema.credentials).values({
    id,
    workspaceId: ctx.workspace.id,
    ambientId: null,
    userId: ctx.user.id,
    name: 'IG token',
    credentialType: 'api_key',
    encryptedValue: ctx.vault.encrypt(value),
  }).run();
  return id;
}

describe('ExtensionRuntime — credential binding + resolution', () => {
  it('setCredentialBinding + execute: the resolved secret reaches the sandbox\'s fetch, never the script', async () => {
    const credentialId = seedCredential('real-ig-secret-abc');
    const src = `export async function execute(inputs, ctx) {
      const r = await ctx.http.fetch(inputs.url, { credential: 'instagram_token' });
      return await r.json();
    }`;
    const extensionId = seedNodeWorkerExtension(src, { credentialKeys: ['instagram_token'] });
    const svc = new ExtensionRuntime(ctx.db, ctx.logger, { dockerEnabled: false }, undefined, ctx.vault);
    svc.setCredentialBinding(extensionId, 'instagram_token', credentialId);

    const http = await import('node:http');
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ authHeader: req.headers.authorization ?? null }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const port = (server.address() as import('node:net').AddressInfo).port;
    try {
      const out = await svc.execute({
        workspaceId: ctx.workspace.id, extensionId, operationName: 'execute',
        input: { url: `http://127.0.0.1:${port}/x` }, scratchpadSnapshot: {},
      });
      expect(out.ok).toBe(true);
      if (out.ok) expect(out.output).toEqual({ authHeader: 'Bearer real-ig-secret-abc' });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('without a binding, the credential key resolves to nothing and the fetch fails closed', async () => {
    const src = `export async function execute(inputs, ctx) {
      return await (await ctx.http.fetch(inputs.url, { credential: 'instagram_token' })).json();
    }`;
    const extensionId = seedNodeWorkerExtension(src, { credentialKeys: ['instagram_token'] });
    const svc = new ExtensionRuntime(ctx.db, ctx.logger, { dockerEnabled: false }, undefined, ctx.vault);
    // No setCredentialBinding call — operator never bound it.
    const out = await svc.execute({
      workspaceId: ctx.workspace.id, extensionId, operationName: 'execute',
      input: { url: 'http://127.0.0.1:1/x' }, scratchpadSnapshot: {},
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.message).toMatch(/not available/);
  });

  it('setCredentialBinding(null) removes a binding', async () => {
    const credentialId = seedCredential('secret');
    const extensionId = seedNodeWorkerExtension('export async function execute(){return {};}', { credentialKeys: ['k'] });
    const svc = new ExtensionRuntime(ctx.db, ctx.logger, { dockerEnabled: false }, undefined, ctx.vault);
    svc.setCredentialBinding(extensionId, 'k', credentialId);
    svc.setCredentialBinding(extensionId, 'k', null);
    const row = ctx.db.select({ credentialBindings: schema.extensions.credentialBindings })
      .from(schema.extensions).where(eq(schema.extensions.id, extensionId)).get();
    expect((row?.credentialBindings as Record<string, string>)?.k).toBeUndefined();
  });

  it('without a vault threaded into ExtensionRuntime, credentials resolve to empty (fails closed, never crashes)', async () => {
    const credentialId = seedCredential('secret');
    const src = `export async function execute(inputs, ctx) {
      return await (await ctx.http.fetch(inputs.url, { credential: 'k' })).json();
    }`;
    const extensionId = seedNodeWorkerExtension(src, { credentialKeys: ['k'] });
    const svc = new ExtensionRuntime(ctx.db, ctx.logger, { dockerEnabled: false }); // no vault arg
    svc.setCredentialBinding(extensionId, 'k', credentialId);
    const out = await svc.execute({
      workspaceId: ctx.workspace.id, extensionId, operationName: 'execute',
      input: { url: 'http://127.0.0.1:1/x' }, scratchpadSnapshot: {},
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.message).toMatch(/not available/);
  });
});
