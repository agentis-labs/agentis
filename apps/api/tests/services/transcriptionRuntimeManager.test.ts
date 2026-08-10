import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  TranscriptionRuntimeManager,
  type ManagedTranscriptionManifest,
} from '../../src/services/transcriptionRuntimeManager.js';

const roots: string[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'agentis-transcription-runtime-'));
  roots.push(root);
  const bytes = Buffer.from('verified-model-artifact');
  const manifest: ManagedTranscriptionManifest = {
    model: 'Agentis/test-stt',
    revision: 'immutable-revision',
    dtype: 'q8',
    artifacts: [{
      file: 'onnx/model_quantized.onnx',
      bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    }],
  };
  return { root, bytes, manifest };
}

describe('TranscriptionRuntimeManager', () => {
  it('prepares verified bytes without loading ONNX into the API process', async () => {
    const { root, bytes, manifest } = await fixture();
    const target = path.join(root, ...manifest.model.split('/'), 'onnx', 'model_quantized.onnx');
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, bytes);
    const manager = new TranscriptionRuntimeManager(manifest);

    await manager.prepare({ cacheDir: root, offline: true });

    expect(manager.snapshot()).toMatchObject({ status: 'prepared', progress: 100 });
  });

  it('adopts and verifies an existing cache without network access', async () => {
    const { root, bytes, manifest } = await fixture();
    const target = path.join(root, ...manifest.model.split('/'), 'onnx', 'model_quantized.onnx');
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, bytes);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const load = vi.fn(async () => ({ pipeline: true }));
    const manager = new TranscriptionRuntimeManager(manifest);

    await manager.run({ cacheDir: root, offline: true, load });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(load).toHaveBeenCalledWith(expect.objectContaining({ localFilesOnly: true }));
    expect(manager.snapshot().status).toBe('ready');
    expect(JSON.parse(await readFile(path.join(root, 'READY.json'), 'utf8'))).toMatchObject({
      model: manifest.model,
      revision: manifest.revision,
    });
  });

  it('downloads immutable bytes, verifies their checksum and activates atomically', async () => {
    const { root, bytes, manifest } = await fixture();
    const fetchMock = vi.fn(async () => new Response(bytes, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const manager = new TranscriptionRuntimeManager(manifest);

    await manager.run({ cacheDir: root, load: async () => ({ pipeline: true }) });

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining(`/resolve/${manifest.revision}/onnx/model_quantized.onnx`),
      expect.any(Object),
    );
    const active = path.join(root, ...manifest.model.split('/'), 'onnx', 'model_quantized.onnx');
    expect(await readFile(active)).toEqual(bytes);
    expect(manager.snapshot()).toMatchObject({ status: 'ready', progress: 100, error: null });
  });

  it('fails deterministically offline without attempting a download', async () => {
    const { root, manifest } = await fixture();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const manager = new TranscriptionRuntimeManager(manifest);

    await expect(manager.run({ cacheDir: root, offline: true, load: async () => ({}) }))
      .rejects.toMatchObject({ code: 'TRANSCRIPTION_MODEL_UNAVAILABLE' });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(manager.snapshot()).toMatchObject({
      status: 'degraded',
      errorCode: 'TRANSCRIPTION_OFFLINE_CACHE_MISS',
    });
  });

  it('preserves the previous cache before an explicit repair', async () => {
    const { root, bytes, manifest } = await fixture();
    const target = path.join(root, ...manifest.model.split('/'), 'onnx', 'model_quantized.onnx');
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, Buffer.from('corrupt'));
    vi.stubGlobal('fetch', vi.fn(async () => new Response(bytes, { status: 200 })));
    const manager = new TranscriptionRuntimeManager(manifest);

    const result = await manager.repair({ cacheDir: root, load: async () => ({ pipeline: true }) });

    expect(result.backupDir).toBeTruthy();
    expect(await readFile(path.join(result.backupDir!, ...manifest.model.split('/'), 'onnx', 'model_quantized.onnx')))
      .toEqual(Buffer.from('corrupt'));
    expect(await readFile(target)).toEqual(bytes);
  });
});
