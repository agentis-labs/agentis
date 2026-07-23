/**
 * uploadMaterializer — asset refs → controlled temp files for browser upload,
 * never raw agent FS paths (BROWSERPOOL-10X §7). Verifies bytes land correctly,
 * caps hold, and cleanup removes everything.
 */
import { describe, it, expect } from 'vitest';
import { readFile, stat } from 'node:fs/promises';
import { makeUploadMaterializer } from '../../src/services/browser/uploadMaterializer.js';
import type { ArtifactService } from '../../src/services/artifactService.js';

function fakeArtifacts(map: Record<string, { buffer: Buffer; filename: string }>): ArtifactService {
  return {
    resolveBytes: async (_ws: string, ref: string) => {
      const hit = map[ref];
      if (!hit) throw new Error(`no such ref ${ref}`);
      return { buffer: hit.buffer, mimeType: 'application/octet-stream', filename: hit.filename };
    },
  } as unknown as ArtifactService;
}

describe('makeUploadMaterializer', () => {
  it('materializes refs to temp files with the resolved bytes, then cleans up', async () => {
    const artifacts = fakeArtifacts({
      'artifact:1': { buffer: Buffer.from('photo-one'), filename: 'a.jpg' },
      'artifact:2': { buffer: Buffer.from('photo-two'), filename: 'b.jpg' },
    });
    const materialize = makeUploadMaterializer(artifacts, 'ws');
    const { paths, cleanup } = await materialize(['artifact:1', 'artifact:2']);

    expect(paths).toHaveLength(2);
    expect((await readFile(paths[0]!)).toString()).toBe('photo-one');
    expect((await readFile(paths[1]!)).toString()).toBe('photo-two');
    expect(paths[0]).toMatch(/a\.jpg$/);

    await cleanup();
    await expect(stat(paths[0]!)).rejects.toThrow();
  });

  it('strips path components from the resolved filename (no traversal)', async () => {
    const artifacts = fakeArtifacts({ 'r': { buffer: Buffer.from('x'), filename: '../../etc/passwd' } });
    const materialize = makeUploadMaterializer(artifacts, 'ws');
    const { paths, cleanup } = await materialize(['r']);
    expect(paths[0]).not.toContain('..');
    expect(paths[0]).toMatch(/passwd$/);
    await cleanup();
  });

  it('rejects an empty ref list', async () => {
    const materialize = makeUploadMaterializer(fakeArtifacts({}), 'ws');
    await expect(materialize([])).rejects.toThrow(/at least one/i);
  });

  it('rejects more than the file-count cap', async () => {
    const materialize = makeUploadMaterializer(fakeArtifacts({}), 'ws');
    await expect(materialize(Array.from({ length: 11 }, (_, i) => `r${i}`))).rejects.toThrow(/at most/i);
  });

  it('rejects and cleans up when the total size cap is exceeded', async () => {
    const big = Buffer.alloc(30 * 1024 * 1024, 1);
    const artifacts = fakeArtifacts({ a: { buffer: big, filename: 'a' }, b: { buffer: big, filename: 'b' } });
    const materialize = makeUploadMaterializer(artifacts, 'ws');
    await expect(materialize(['a', 'b'])).rejects.toThrow(/exceeds/i);
  });
});
