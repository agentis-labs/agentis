import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  EmbeddingRuntimeManager,
  type ManagedEmbeddingManifest,
} from '../../src/services/embedding/embeddingRuntimeManager.js';

const content = Buffer.from('verified-model-bytes');
const manifest: ManagedEmbeddingManifest = {
  model: 'agentis/test-embedding',
  revision: 'immutable-revision',
  dtype: 'q8',
  artifacts: [{
    file: 'onnx/model_quantized.onnx',
    bytes: content.length,
    sha256: createHash('sha256').update(content).digest('hex'),
  }],
};

const roots: string[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function cacheDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'agentis-embedding-runtime-'));
  roots.push(root);
  return join(root, 'models');
}

function options(cache: string, load: (localOnly: boolean) => Promise<unknown> = async () => ({ pipeline: true })) {
  return { model: manifest.model, dtype: manifest.dtype, cacheDir: cache, load };
}

function activeArtifact(cache: string): string {
  return join(cache, 'agentis', 'test-embedding', 'onnx', 'model_quantized.onnx');
}

describe('EmbeddingRuntimeManager', () => {
  it('downloads, verifies, probes, and promotes one immutable generation', async () => {
    const cache = cacheDir();
    const fetchMock = vi.fn(async () => new Response(content));
    vi.stubGlobal('fetch', fetchMock);
    const manager = new EmbeddingRuntimeManager(manifest);
    const load = vi.fn(async (localOnly: boolean) => ({ localOnly }));
    const statuses: string[] = [];
    manager.subscribe((snapshot) => statuses.push(snapshot.status));

    await manager.run(options(cache, load));

    expect(load).toHaveBeenCalledOnce();
    expect(load).toHaveBeenCalledWith(true);
    expect(manager.snapshot().status).toBe('ready');
    expect(readFileSync(activeArtifact(cache))).toEqual(content);
    const ready = JSON.parse(readFileSync(join(cache, 'READY.json'), 'utf8')) as { generation: string };
    expect(ready.generation).toContain('.agentis-generations/immutable-revision-q8');
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(statuses).toEqual(expect.arrayContaining(['downloading', 'verifying', 'loading', 'ready']));
  });

  it('resumes an interrupted range transfer and quarantines unrelated stale fp32 temp files', async () => {
    const cache = cacheDir();
    const part = join(cache, '.agentis-staging', 'immutable-revision-q8', 'onnx', 'model_quantized.onnx.part');
    mkdirSync(dirname(part), { recursive: true });
    writeFileSync(part, content.subarray(0, 7));
    const stale = join(cache, 'agentis', 'test-embedding', 'onnx', 'model.onnx.tmp.6460.abcd');
    mkdirSync(dirname(stale), { recursive: true });
    writeFileSync(stale, 'abandoned-fp32');
    writeFileSync(join(cache, '.dtype'), 'q8\n');
    const fetchMock = vi.fn(async (_input: unknown, init?: RequestInit) => {
      expect(new Headers(init?.headers).get('range')).toBe('bytes=7-');
      return new Response(content.subarray(7), { status: 206 });
    });
    vi.stubGlobal('fetch', fetchMock);

    await new EmbeddingRuntimeManager(manifest).run(options(cache));

    expect(readFileSync(activeArtifact(cache))).toEqual(content);
    expect(existsSync(stale)).toBe(false);
    expect(readdirSync(join(cache, 'quarantine'), { recursive: true }).some((entry) => String(entry).includes('model.onnx.tmp.6460.abcd'))).toBe(true);
  });

  it('redownloads a truncated active artifact', async () => {
    const cache = cacheDir();
    mkdirSync(dirname(activeArtifact(cache)), { recursive: true });
    writeFileSync(activeArtifact(cache), content.subarray(0, 3));
    vi.stubGlobal('fetch', vi.fn(async () => new Response(content)));

    await new EmbeddingRuntimeManager(manifest).run(options(cache));

    expect(readFileSync(activeArtifact(cache))).toEqual(content);
  });

  it('commits a fully transferred part after process termination without another network request', async () => {
    const cache = cacheDir();
    const part = join(cache, '.agentis-staging', 'immutable-revision-q8', 'onnx', 'model_quantized.onnx.part');
    mkdirSync(dirname(part), { recursive: true });
    writeFileSync(part, content);
    const fetchMock = vi.fn(async () => { throw new Error('a complete part must be verified locally'); });
    vi.stubGlobal('fetch', fetchMock);

    await new EmbeddingRuntimeManager(manifest).run(options(cache));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(readFileSync(activeArtifact(cache))).toEqual(content);
  });

  it('discards a corrupt completed transfer and automatically retries from clean bytes', async () => {
    const cache = cacheDir();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(Buffer.alloc(content.length, 1)))
      .mockResolvedValueOnce(new Response(content));
    vi.stubGlobal('fetch', fetchMock);

    await new EmbeddingRuntimeManager(manifest).run(options(cache));

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(readFileSync(activeArtifact(cache))).toEqual(content);
  });

  it('never promotes a checksum mismatch or a failed inference probe', async () => {
    const checksumCache = cacheDir();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(Buffer.alloc(content.length, 1))));
    const checksumManager = new EmbeddingRuntimeManager(manifest);
    await expect(checksumManager.run(options(checksumCache))).rejects.toThrow(/checksum mismatch/i);
    expect(checksumManager.snapshot().status).toBe('degraded');
    expect(checksumManager.snapshot().errorCode).toBe('EMBEDDING_CHECKSUM_MISMATCH');
    expect(existsSync(join(checksumCache, 'READY.json'))).toBe(false);

    const probeCache = cacheDir();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(content)));
    const probeManager = new EmbeddingRuntimeManager(manifest);
    await expect(probeManager.run(options(probeCache, async () => { throw new Error('inference probe failed'); }))).rejects.toThrow(/inference probe failed/i);
    expect(existsSync(join(probeCache, 'READY.json'))).toBe(false);
  });

  it('joins concurrent warmup callers and reuses a verified cache offline', async () => {
    const cache = cacheDir();
    const fetchMock = vi.fn(async () => new Response(content));
    vi.stubGlobal('fetch', fetchMock);
    const manager = new EmbeddingRuntimeManager(manifest);
    const load = vi.fn(async () => ({ pipeline: true }));

    const [first, second] = await Promise.all([manager.run(options(cache, load)), manager.run(options(cache, load))]);
    expect(first).toBe(second);
    expect(load).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledOnce();

    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network must not be used'); }));
    const restarted = new EmbeddingRuntimeManager(manifest);
    await restarted.run({ ...options(cache), offline: true });
    expect(restarted.snapshot().status).toBe('ready');
  });
});
