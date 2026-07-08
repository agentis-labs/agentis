/**
 * safeFetch — SSRF-safe HTTP client that pins the connection to the IP validated
 * at check time (defeats DNS rebinding) and re-validates every redirect hop.
 *
 * Loopback servers on ephemeral ports keep these deterministic and network-free.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { safeFetch } from '../src/services/safeFetch.js';

const servers: http.Server[] = [];

function listen(handler: http.RequestListener): Promise<number> {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    servers.push(server);
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
  });
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
});

describe('safeFetch', () => {
  it('refuses a private/loopback literal IP by default (no allowPrivate)', async () => {
    await expect(safeFetch('http://127.0.0.1:9/x')).rejects.toThrow(/private|loopback|SSRF/i);
    await expect(safeFetch('http://169.254.169.254/latest/meta-data')).rejects.toThrow();
  });

  it('reaches a loopback server when private access is opted in, returning a real Response', async () => {
    const port = await listen((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json', 'x-agentis': 'ok' });
      res.end(JSON.stringify({ hello: 'world' }));
    });
    const res = await safeFetch(`http://127.0.0.1:${port}/data`, {}, { allowPrivate: true });
    expect(res.status).toBe(200);
    expect(res.ok).toBe(true);
    expect(res.headers.get('x-agentis')).toBe('ok');
    expect(await res.json()).toEqual({ hello: 'world' });
  });

  it('follows a redirect, re-validating the hop', async () => {
    const target = await listen((_req, res) => {
      res.writeHead(200);
      res.end('final');
    });
    const origin = await listen((_req, res) => {
      res.writeHead(302, { location: `http://127.0.0.1:${target}/next` });
      res.end();
    });
    const res = await safeFetch(`http://127.0.0.1:${origin}/start`, {}, { allowPrivate: true });
    expect(await res.text()).toBe('final');
  });

  it('re-validates allowedDomains on every redirect hop (blocks a cross-host redirect)', async () => {
    // Redirect to a host that is NOT in allowedDomains — the second hop must be
    // rejected by the guard before any connection is opened.
    const origin = await listen((_req, res) => {
      res.writeHead(302, { location: 'http://127.0.0.2/evil' });
      res.end();
    });
    await expect(
      safeFetch(`http://127.0.0.1:${origin}/start`, {}, { allowPrivate: true, allowedDomains: ['127.0.0.1'] }),
    ).rejects.toThrow(/allowedDomains|NETWORK_VIOLATION/i);
  });

  it('enforces a byte cap on the response body', async () => {
    const port = await listen((_req, res) => {
      res.writeHead(200);
      res.end(Buffer.alloc(4096, 0x61));
    });
    await expect(
      safeFetch(`http://127.0.0.1:${port}/big`, { maxBytes: 1024 }, { allowPrivate: true }),
    ).rejects.toThrow(/bytes/i);
  });
});
