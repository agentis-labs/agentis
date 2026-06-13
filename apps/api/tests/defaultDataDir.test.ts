import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveDefaultDataDir } from '../src/defaultDataDir.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function createWorkspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'agentis-data-dir-'));
  tempDirs.push(root);
  writeFileSync(join(root, 'pnpm-workspace.yaml'), "packages:\n  - 'apps/*'\n  - 'packages/*'\n", 'utf8');
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'agentis', private: true }), 'utf8');
  mkdirSync(join(root, 'apps', 'api'), { recursive: true });
  mkdirSync(join(root, 'packages', 'cli'), { recursive: true });
  return root;
}

describe('resolveDefaultDataDir', () => {
  it('uses the freshest existing source data dir when the repo-root store is newest', () => {
    const workspaceRoot = createWorkspace();
    const canonical = join(workspaceRoot, '.agentis');
    const legacy = join(workspaceRoot, 'packages', 'cli', '.agentis');
    mkdirSync(canonical, { recursive: true });
    mkdirSync(legacy, { recursive: true });
    const canonicalDb = join(canonical, 'data.db');
    const legacyDb = join(legacy, 'data.db');
    writeFileSync(canonicalDb, 'root-db', 'utf8');
    writeFileSync(legacyDb, 'legacy-db', 'utf8');
    const older = new Date('2024-01-01T00:00:00.000Z');
    const newer = new Date('2025-01-01T00:00:00.000Z');
    utimesSync(legacyDb, older, older);
    utimesSync(canonicalDb, newer, newer);

    expect(resolveDefaultDataDir(join(workspaceRoot, 'apps', 'api'))).toBe(canonical);
    expect(resolveDefaultDataDir(join(workspaceRoot, 'packages', 'cli'))).toBe(canonical);
  });

  it('reuses the newest legacy source data dir when the repo-root dir is absent', () => {
    const workspaceRoot = createWorkspace();
    const apiLegacy = join(workspaceRoot, 'apps', 'api', '.agentis');
    const cliLegacy = join(workspaceRoot, 'packages', 'cli', '.agentis');
    mkdirSync(apiLegacy, { recursive: true });
    mkdirSync(cliLegacy, { recursive: true });
    const apiDb = join(apiLegacy, 'data.db');
    const cliDb = join(cliLegacy, 'data.db');
    writeFileSync(apiDb, 'api-db', 'utf8');
    writeFileSync(cliDb, 'cli-db', 'utf8');
    const older = new Date('2024-01-01T00:00:00.000Z');
    const newer = new Date('2025-01-01T00:00:00.000Z');
    utimesSync(apiDb, older, older);
    utimesSync(cliDb, newer, newer);

    expect(resolveDefaultDataDir(join(workspaceRoot, 'apps', 'api'))).toBe(cliLegacy);
    expect(resolveDefaultDataDir(join(workspaceRoot, 'packages', 'cli'))).toBe(cliLegacy);
  });

  it('falls back to a cwd-relative .agentis outside the Agentis source workspace', () => {
    const outsideDir = mkdtempSync(join(tmpdir(), 'agentis-outside-'));
    tempDirs.push(outsideDir);

    expect(resolveDefaultDataDir(outsideDir)).toBe('.agentis');
  });
});