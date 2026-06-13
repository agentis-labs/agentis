/**
 * RegistryClient — anonymous bridge translation + offline behaviour.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { RegistryClient } from '../../src/services/registryClient.js';
import { createLogger } from '../../src/logger.js';

const logger = createLogger({ level: 'error' });

describe('RegistryClient', () => {
  let originalFetch: typeof fetch;
  beforeEach(() => {
    originalFetch = global.fetch;
  });
  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('isConfigured() is false when no registry URL', () => {
    const b = new RegistryClient({ timeoutMs: 1000, logger });
    expect(b.isConfigured()).toBe(false);
  });

  it('search() throws EXTENSION_REGISTRY_UNAVAILABLE when not configured', async () => {
    const b = new RegistryClient({ timeoutMs: 1000, logger });
    await expect(b.search({ q: 'x' })).rejects.toMatchObject({ code: 'EXTENSION_REGISTRY_UNAVAILABLE' });
  });

  it('search() translates upstream {results} into RegistryEntry shape', async () => {
    global.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          results: [
            {
              slug: 'hello',
              name: 'Hello',
              description: 'demo',
              author: 'alice',
              version: '0.1.0',
              hash: 'a'.repeat(64),
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    ) as never;
    const b = new RegistryClient({ registryUrl: 'https://example.test/api', timeoutMs: 1000, logger });
    const page = await b.search({ q: 'hello' });
    expect(page.entries).toHaveLength(1);
    expect(page.entries[0]!.slug).toBe('hello');
    expect(page.entries[0]!.title).toBe('Hello');
    expect(page.entries[0]!.artifacts[0]!.sha256).toBe('a'.repeat(64));
  });

  it('search() also accepts {extensions} as the array key', async () => {
    global.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ extensions: [{ slug: 's1', version: '1.0.0' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    ) as never;
    const b = new RegistryClient({ registryUrl: 'https://example.test/api', timeoutMs: 1000, logger });
    const page = await b.search({});
    expect(page.entries[0]!.slug).toBe('s1');
  });

  it('fetchArtifactBytes() handles JSON content responses', async () => {
    global.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ content: 'hi', sha256: 'b'.repeat(64) }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    ) as never;
    const b = new RegistryClient({ registryUrl: 'https://example.test/api', timeoutMs: 1000, logger });
    const r = await b.fetchArtifactBytes({ slug: 'x' });
    expect(r.bytes.toString()).toBe('hi');
    expect(r.declaredSha256).toBe('b'.repeat(64));
  });

  it('fetchArtifactBytes() handles plain-text content responses', async () => {
    global.fetch = vi.fn(async () =>
      new Response('raw script', { status: 200, headers: { 'content-type': 'text/plain' } }),
    ) as never;
    const b = new RegistryClient({ registryUrl: 'https://example.test/api', timeoutMs: 1000, logger });
    const r = await b.fetchArtifactBytes({ slug: 'x' });
    expect(r.bytes.toString()).toBe('raw script');
  });

  it('throws EXTENSION_REGISTRY_UNAVAILABLE on upstream 5xx', async () => {
    global.fetch = vi.fn(async () => new Response('boom', { status: 502 })) as never;
    const b = new RegistryClient({ registryUrl: 'https://example.test/api', timeoutMs: 1000, logger });
    await expect(b.fetchArtifactBytes({ slug: 'x' })).rejects.toMatchObject({ code: 'EXTENSION_REGISTRY_UNAVAILABLE' });
  });
});
