/**
 * Flagship example extension — proof it actually works end to end
 * (INTEGRATION-CEILING-10X §5). Runs the EXACT source shipped in
 * `postToX.example.ts` through the real ExtensionRuntime (operator-bound
 * credential, node_worker sandbox) against a mock server shaped like X's
 * real two-endpoint flow (v1.1 media upload → v2 tweet creation). This is
 * the manual/real-credential verification the plan calls for, substituting a
 * faithful mock for an actual X developer account (which this environment
 * doesn't have) — the example and the proof share one source, so they can
 * never drift apart.
 */
import http from 'node:http';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { schema } from '@agentis/db/sqlite';
import { ExtensionRuntime } from '../../src/services/extensionRuntime.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';
import { postToXManifest, postToXSource } from '../../src/extensions/examples/postToX.example.js';

let ctx: TestContext;

beforeEach(async () => {
  ctx = await createTestContext();
  process.env.AGENTIS_EXTENSION_HTTP_ALLOW_PRIVATE = 'true';
});
afterEach(() => {
  delete process.env.AGENTIS_EXTENSION_HTTP_ALLOW_PRIVATE;
  ctx.close();
});

/**
 * Mimics X's real two-endpoint contract. Deliberately asserts NOTHING inside
 * the request handler — a thrown expectation there would crash mid-response
 * and hang the caller's fetch (as it did until this was fixed); instead every
 * request body is recorded for the test to assert on AFTER the exchange
 * completes.
 */
function startMockX() {
  const seenAuth: string[] = [];
  const calls: string[] = [];
  const bodies: string[] = [];
  const server = http.createServer((req, res) => {
    seenAuth.push(req.headers.authorization ?? '');
    calls.push(req.url ?? '');
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('latin1');
      bodies.push(body);
      res.writeHead(200, { 'content-type': 'application/json' });
      if (req.url?.includes('/media/upload')) {
        res.end(JSON.stringify({ media_id_string: 'media-123' }));
      } else {
        const parsed = JSON.parse(body) as { text: string; media?: { media_ids: string[] } };
        res.end(JSON.stringify({ data: { id: 'tweet-999', text: parsed.text } }));
      }
    });
  });
  return { server, seenAuth, calls, bodies };
}

describe('Flagship example: post-to-x', () => {
  it('uploads the image, then posts the tweet referencing it — credential attached by the host, never the script', async () => {
    const { server, seenAuth, calls, bodies } = startMockX();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const port = (server.address() as import('node:net').AddressInfo).port;

    // Real X endpoints are on different hosts (api.x.com / upload.twitter.com);
    // this test drives the extension against loopback by pointing the SOURCE at
    // the mock — proving the sandbox mechanics (formData → real multipart,
    // credential → real header, two sequential fetches) with real HTTP calls.
    const localizedSource = postToXSource
      .replace('https://upload.twitter.com/1.1/media/upload.json', `http://127.0.0.1:${port}/media/upload.json`)
      .replace('https://api.x.com/2/tweets', `http://127.0.0.1:${port}/2/tweets`);

    const extensionId = randomUUID();
    const slug = `post-to-x-${extensionId.slice(0, 6)}`;
    ctx.db.insert(schema.extensions).values({
      id: extensionId,
      workspaceId: ctx.workspace.id,
      ambientId: ctx.ambient.id,
      userId: ctx.user.id,
      packageId: null,
      name: postToXManifest.name,
      slug,
      version: postToXManifest.version,
      runtime: 'node_worker',
      manifest: { ...postToXManifest, slug, source: localizedSource, allowedDomains: ['127.0.0.1'] },
    }).run();

    const credentialId = randomUUID();
    ctx.db.insert(schema.credentials).values({
      id: credentialId,
      workspaceId: ctx.workspace.id,
      ambientId: null,
      userId: ctx.user.id,
      name: 'X token',
      credentialType: 'oauth_x',
      encryptedValue: ctx.vault.encrypt(JSON.stringify({ accessToken: 'real-x-access-token' })),
    }).run();

    const svc = new ExtensionRuntime(ctx.db, ctx.logger, { dockerEnabled: false }, undefined, ctx.vault);
    svc.setCredentialBinding(extensionId, 'x_token', credentialId);

    try {
      const out = await svc.execute({
        workspaceId: ctx.workspace.id,
        extensionId,
        operationName: 'post',
        input: { text: 'Just listed: Downtown Loft', imageBase64: Buffer.from('fake-photo-bytes').toString('base64'), imageMime: 'image/png' },
        scratchpadSnapshot: {},
      });
      expect(out.ok).toBe(true);
      if (out.ok) expect(out.output).toEqual({ id: 'tweet-999', text: 'Just listed: Downtown Loft' });

      // Two real HTTP calls, in order: upload then tweet.
      expect(calls[0]).toContain('/media/upload.json');
      expect(calls[1]).toContain('/2/tweets');
      // The credential the operator bound reached BOTH real requests.
      expect(seenAuth).toEqual(['Bearer real-x-access-token', 'Bearer real-x-access-token']);
      // The upload body is real multipart carrying the image field…
      expect(bodies[0]).toContain('Content-Disposition: form-data; name="media"');
      // …and the tweet body references the media id the mock returned.
      expect(JSON.parse(bodies[1]!)).toMatchObject({ media: { media_ids: ['media-123'] } });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('posting without an image skips the upload step entirely', async () => {
    const { server, calls } = startMockX();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const port = (server.address() as import('node:net').AddressInfo).port;
    const localizedSource = postToXSource.replace('https://api.x.com/2/tweets', `http://127.0.0.1:${port}/2/tweets`);

    const extensionId = randomUUID();
    const slug = `post-to-x-${extensionId.slice(0, 6)}`;
    ctx.db.insert(schema.extensions).values({
      id: extensionId, workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id, packageId: null,
      name: postToXManifest.name, slug, version: postToXManifest.version, runtime: 'node_worker',
      manifest: { ...postToXManifest, slug, source: localizedSource, allowedDomains: ['127.0.0.1'] },
    }).run();
    const credentialId = randomUUID();
    ctx.db.insert(schema.credentials).values({
      id: credentialId, workspaceId: ctx.workspace.id, ambientId: null, userId: ctx.user.id,
      name: 'X token', credentialType: 'oauth_x', encryptedValue: ctx.vault.encrypt(JSON.stringify({ accessToken: 'tok' })),
    }).run();
    const svc = new ExtensionRuntime(ctx.db, ctx.logger, { dockerEnabled: false }, undefined, ctx.vault);
    svc.setCredentialBinding(extensionId, 'x_token', credentialId);

    try {
      const out = await svc.execute({
        workspaceId: ctx.workspace.id, extensionId, operationName: 'post',
        input: { text: 'Text-only post' }, scratchpadSnapshot: {},
      });
      expect(out.ok).toBe(true);
      expect(calls).toHaveLength(1);
      expect(calls[0]).toContain('/2/tweets');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
