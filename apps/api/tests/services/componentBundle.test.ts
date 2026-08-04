import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ComponentManifestV2 } from '@agentis/core';
import { inspectComponentBundle, installComponentBundle, validateComponentManifest } from '../../src/extensions/componentBundle.js';

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
