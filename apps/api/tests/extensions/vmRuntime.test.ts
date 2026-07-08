/**
 * node:vm fallback runtime — proves operator extensions execute with ZERO
 * native dependencies (isolated-vm is not installed on CI / this host).
 */

import http from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import { runNodeWorkerExtension } from '../../src/extensions/nodeWorkerRuntime.js';
import { createLogger } from '../../src/logger.js';
import type { ExtensionManifest } from '@agentis/core';

const logger = createLogger({ level: 'error' });

function manifest(source: string, operations = [{ name: 'run', inputSchema: {}, outputSchema: {} }]): ExtensionManifest {
  return { name: 'T', slug: 't', version: '1.0.0', runtime: 'node_worker', source, operations, capabilityTags: [] };
}

describe('vm fallback runtime', () => {
  it('runs a pure operation and returns structured output', async () => {
    const src = `export async function run(inputs, ctx) { return { doubled: inputs.n * 2, slug: ctx.meta.extension.slug }; }`;
    const out = await runNodeWorkerExtension({
      manifest: manifest(src),
      operationName: 'run',
      source: src,
      input: { n: 21 },
      scratchpad: {},
      allowedDomains: [],
      permissions: [],
      allowPrivateNetwork: false,
      timeoutMs: 2000,
      logger,
    });
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.output).toEqual({ doubled: 42, slug: 't' });
  });

  it('denies network without the permission', async () => {
    const src = `export async function run(inputs, ctx) { await ctx.http.fetch('https://example.com'); return {}; }`;
    const out = await runNodeWorkerExtension({
      manifest: manifest(src), operationName: 'run', source: src, input: {}, scratchpad: {},
      allowedDomains: [], permissions: [], allowPrivateNetwork: false, timeoutMs: 2000, logger,
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.errorCode).toBe('EXTENSION_PERMISSION_DENIED');
  });

  it('exposes a standards-compatible fetch response to generated extensions', async () => {
    // safeFetch pins the connection to the validated IP via node:http (defeating
    // DNS rebinding) rather than calling global fetch — so we exercise it against
    // a REAL loopback server (allowPrivateNetwork lets it reach 127.0.0.1).
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json', 'x-agentis': 'ready' });
      res.end(JSON.stringify({ title: 'Agentis' }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const port = (server.address() as import('node:net').AddressInfo).port;
    const src = `export async function run() {
      const response = await fetch('http://127.0.0.1:${port}/feed');
      return {
        ok: response.ok,
        status: response.status,
        header: response.headers.get('x-agentis'),
        text: await response.text(),
        json: await response.json(),
      };
    }`;
    try {
      const out = await runNodeWorkerExtension({
        manifest: manifest(src),
        operationName: 'run',
        source: src,
        input: {},
        scratchpad: {},
        allowedDomains: [],
        permissions: ['network'],
        allowPrivateNetwork: true,
        timeoutMs: 2000,
        logger,
      });
      expect(out.ok).toBe(true);
      if (out.ok) {
        expect(out.output).toEqual({
          ok: true,
          status: 200,
          header: 'ready',
          text: '{"title":"Agentis"}',
          json: { title: 'Agentis' },
        });
      }
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('drives the listener-source contract (ctx.emit / ctx.kv) under permissions', async () => {
    const src = `export async function watch(inputs, ctx) {
      const last = ctx.kv.get('last') || 0;
      ctx.emit({ id: last + 1 });
      ctx.kv.set('last', last + 1);
      ctx.setCursor(last + 1);
      return {};
    }`;
    const emit = vi.fn();
    const store = new Map<string, unknown>();
    let cursor: unknown = 0;
    const out = await runNodeWorkerExtension({
      manifest: manifest(src, [{ name: 'watch', inputSchema: {}, outputSchema: {} }]),
      operationName: 'watch',
      source: src,
      input: {},
      scratchpad: {},
      allowedDomains: [],
      permissions: ['listener', 'listener.emit', 'listener.cursor', 'kv.read', 'kv.write'],
      allowPrivateNetwork: false,
      timeoutMs: 2000,
      logger,
      listenerHooks: {
        emit,
        getCursor: () => cursor,
        setCursor: (v) => { cursor = v; },
        kvGet: (k) => store.get(k),
        kvSet: (k, v) => { store.set(k, v); },
      },
    });
    expect(out.ok).toBe(true);
    expect(emit).toHaveBeenCalledWith({ id: 1 });
    expect(store.get('last')).toBe(1);
    expect(cursor).toBe(1);
  });
});
