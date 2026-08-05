import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ComponentManifestV2 } from '@agentis/core';
import { createHash } from 'node:crypto';
import { inspectComponentBundle, installComponentBundle, installPortableComponentBundle, validateComponentManifest } from '../../src/extensions/componentBundle.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  delete process.env.AGENTIS_DATA_DIR;
});

describe('Component v2 bundle', () => {
  it('installs a locked Python bundle into content-addressed storage', () => {
    const source = temp('component-source-');
    const data = temp('component-data-');
    process.env.AGENTIS_DATA_DIR = data;
    writeFileSync(join(source, 'main.py'), 'import json\nprint(json.dumps({"ok": True}))\n');
    writeFileSync(join(source, 'requirements.lock'), '');
    const hash = inspectComponentBundle(source).hash;
    const manifest = component({ bundleHash: hash });
    const first = installComponentBundle(source, manifest);
    const second = installComponentBundle(source, manifest);
    expect(first).toMatchObject({ bundleHash: hash, fileCount: 2, created: true });
    expect(first.bundleDir).toBe(join(data, 'components', hash));
    expect(second.created).toBe(false);
  });

  it('rejects unsupported runtimes and tampered bundle hashes', () => {
    const source = temp('component-source-');
    process.env.AGENTIS_DATA_DIR = temp('component-data-');
    writeFileSync(join(source, 'main.py'), 'print({})');
    writeFileSync(join(source, 'requirements.lock'), '');
    expect(() => validateComponentManifest(component({ runtime: { language: 'python', version: '3.11' } }))).toThrow('Python 3.12');
    expect(() => installComponentBundle(source, component({ bundleHash: '0'.repeat(64) }))).toThrow('hash mismatch');
  });

  it('installs verified portable bundleFiles without a mounted host directory', () => {
    const data = temp('component-data-');
    process.env.AGENTIS_DATA_DIR = data;
    const files = [portable('main.py', 'print({"ok": True})\n'), portable('requirements.lock', '')]
      .sort((a, b) => a.path.localeCompare(b.path));
    const aggregate = createHash('sha256');
    for (const file of files) aggregate.update(file.path).update('\0').update(Buffer.from(file.dataBase64, 'base64')).update('\0');
    const hash = aggregate.digest('hex');
    const installed = installPortableComponentBundle(files, component({ bundleHash: hash }));
    expect(installed).toMatchObject({ bundleHash: hash, fileCount: 2, created: true });
    expect(installed.bundleDir).toBe(join(data, 'components', hash));
    expect(() => installPortableComponentBundle([{ ...files[0]!, sha256: '0'.repeat(64) }, files[1]!], component())).toThrow('checksum mismatch');
    writeFileSync(join(installed.bundleDir, 'main.py'), 'tampered');
    expect(() => installPortableComponentBundle(files, component({ bundleHash: hash }))).toThrow('corrupted');
  });
});

function temp(prefix: string): string { const root = mkdtempSync(join(tmpdir(), prefix)); roots.push(root); mkdirSync(root, { recursive: true }); return root; }
function component(overrides: Partial<ComponentManifestV2> = {}): ComponentManifestV2 {
  return {
    manifestVersion: 2,
    id: 'python-example',
    version: '1.0.0',
    runtime: { language: 'python', version: '3.12' },
    entrypoint: 'main.py',
    dependencyLock: 'requirements.lock',
    bundleHash: '',
    permissions: [],
    operations: [{ name: 'execute', inputSchema: {}, outputSchema: {} }],
    resources: { cpu: 0.5, memoryMb: 128, timeoutSec: 30 },
    ...overrides,
  };
}

function portable(path: string, value: string) {
  const data = Buffer.from(value);
  return { path, sha256: createHash('sha256').update(data).digest('hex'), dataBase64: data.toString('base64') };
}
