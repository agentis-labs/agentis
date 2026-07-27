/**
 * Extension sandbox ceiling — custom headers, multipart/binary upload, and
 * declarative credential attachment (INTEGRATION-CEILING-10X §3). Runs through
 * `runNodeWorkerExtension` end-to-end (this host has no `isolated-vm`, so this
 * exercises the real node:vm fallback path, matching vmRuntime.test.ts).
 */
import http from 'node:http';
import { describe, expect, it } from 'vitest';
import { runNodeWorkerExtension } from '../../src/extensions/nodeWorkerRuntime.js';
import { createLogger } from '../../src/logger.js';
import type { ExtensionManifest } from '@agentis/core';

const logger = createLogger({ level: 'error' });

function manifest(source: string): ExtensionManifest {
  return { name: 'T', slug: 't', version: '1.0.0', runtime: 'node_worker', source, operations: [{ name: 'run', inputSchema: {}, outputSchema: {} }], capabilityTags: [] };
}

async function withEchoServer(handler: (req: http.IncomingMessage, body: Buffer) => { status: number; json: unknown }) {
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const { status, json } = handler(req, Buffer.concat(chunks));
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(json));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as import('node:net').AddressInfo).port;
  return { port, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

describe('extension sandbox — custom headers', () => {
  it('a script-supplied header reaches the real server (previously dropped entirely)', async () => {
    const { port, close } = await withEchoServer((req) => ({ status: 200, json: { seenHeader: req.headers['x-custom-header'] ?? null } }));
    const src = `export async function run() {
      const r = await fetch('http://127.0.0.1:${port}/x', { headers: { 'X-Custom-Header': 'from-extension' } });
      return await r.json();
    }`;
    try {
      const out = await runNodeWorkerExtension({
        manifest: manifest(src), operationName: 'run', source: src, input: {}, scratchpad: {},
        allowedDomains: [], permissions: ['network'], allowPrivateNetwork: true, timeoutMs: 2000, logger,
      });
      expect(out.ok).toBe(true);
      if (out.ok) expect(out.output).toEqual({ seenHeader: 'from-extension' });
    } finally {
      await close();
    }
  });
});

describe('extension sandbox — multipart/binary upload', () => {
  it('formData parts arrive at the server as a real multipart body (image upload from an extension)', async () => {
    const { port, close } = await withEchoServer((req, body) => {
      const text = body.toString('latin1');
      return {
        status: 200,
        json: {
          contentType: req.headers['content-type'] ?? null,
          hasImageField: text.includes('name="image"'),
          hasCaptionField: text.includes('name="caption"') && text.includes('a listing photo'),
        },
      };
    });
    const src = `export async function run() {
      const r = await fetch('http://127.0.0.1:${port}/upload', {
        method: 'POST',
        formData: [
          { name: 'caption', value: 'a listing photo' },
          { name: 'image', filename: 'photo.png', contentType: 'image/png', dataBase64: 'iVBORw0KGgo=' },
        ],
      });
      return await r.json();
    }`;
    try {
      const out = await runNodeWorkerExtension({
        manifest: manifest(src), operationName: 'run', source: src, input: {}, scratchpad: {},
        allowedDomains: [], permissions: ['network'], allowPrivateNetwork: true, timeoutMs: 2000, logger,
      });
      expect(out.ok).toBe(true);
      if (out.ok) {
        const output = out.output as { contentType: string; hasImageField: boolean; hasCaptionField: boolean };
        expect(output.contentType).toMatch(/^multipart\/form-data; boundary=/);
        expect(output.hasImageField).toBe(true);
        expect(output.hasCaptionField).toBe(true);
      }
    } finally {
      await close();
    }
  });
});

describe('extension sandbox — declarative credential attachment', () => {
  it('the host attaches the REAL secret to the outgoing request; the script never sees it', async () => {
    const { port, close } = await withEchoServer((req) => ({ status: 200, json: { authHeader: req.headers.authorization ?? null } }));
    const src = `export async function run() {
      // The script can only ever reference the credential by NAME — there is no
      // "credentials" global, no ctx.credentials, nothing to read the secret from.
      const hasGlobalCredentialsLeak = typeof credentials !== 'undefined';
      const r = await fetch('http://127.0.0.1:${port}/post', { credential: 'ig_token' });
      const body = await r.json();
      return { hasGlobalCredentialsLeak, serverSawAuthHeader: body.authHeader };
    }`;
    try {
      const out = await runNodeWorkerExtension({
        manifest: manifest(src), operationName: 'run', source: src, input: {}, scratchpad: {},
        allowedDomains: [], permissions: ['network', 'credentials'], allowPrivateNetwork: true, timeoutMs: 2000, logger,
        credentials: { ig_token: { value: 'ig-real-secret-999' } },
      });
      expect(out.ok).toBe(true);
      if (out.ok) {
        const output = out.output as { hasGlobalCredentialsLeak: boolean; serverSawAuthHeader: string };
        // The real secret DID reach the server (the host attached it)…
        expect(output.serverSawAuthHeader).toBe('Bearer ig-real-secret-999');
        // …but the sandboxed script had no global/variable exposing the raw value.
        expect(output.hasGlobalCredentialsLeak).toBe(false);
      }
    } finally {
      await close();
    }
  });

  it('using a credential without the `credentials` permission is denied', async () => {
    const src = `export async function run() {
      await fetch('http://example.com/x', { credential: 'ig_token' });
      return {};
    }`;
    const out = await runNodeWorkerExtension({
      manifest: manifest(src), operationName: 'run', source: src, input: {}, scratchpad: {},
      allowedDomains: [], permissions: ['network'], allowPrivateNetwork: false, timeoutMs: 2000, logger,
      credentials: { ig_token: { value: 'secret' } },
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.errorCode).toBe('EXTENSION_PERMISSION_DENIED');
  });

  it('referencing an undeclared/unbound credential key fails closed with a clear error, not silent injection', async () => {
    const { port, close } = await withEchoServer(() => ({ status: 200, json: {} }));
    const src = `export async function run() {
      await fetch('http://127.0.0.1:${port}/x', { credential: 'not_bound_anywhere' });
      return {};
    }`;
    try {
      const out = await runNodeWorkerExtension({
        manifest: manifest(src), operationName: 'run', source: src, input: {}, scratchpad: {},
        allowedDomains: [], permissions: ['network', 'credentials'], allowPrivateNetwork: true, timeoutMs: 2000, logger,
        credentials: {}, // nothing bound
      });
      expect(out.ok).toBe(false);
      if (!out.ok) expect(out.message).toMatch(/not available/);
    } finally {
      await close();
    }
  });
});
