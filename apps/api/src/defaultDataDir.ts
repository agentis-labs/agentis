import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { CONSTANTS } from '@agentis/core';

export function resolveDefaultDataDir(cwd: string = process.cwd()): string {
  const workspaceRoot = findAgentisWorkspaceRoot(cwd);
  if (workspaceRoot) {
    const canonical = join(workspaceRoot, CONSTANTS.DEFAULT_DATA_DIR);
    return findExistingSourceDataDir(workspaceRoot) ?? canonical;
  }
  return CONSTANTS.DEFAULT_DATA_DIR;
}

function findExistingSourceDataDir(workspaceRoot: string): string | null {
  const candidates = [
    join(workspaceRoot, CONSTANTS.DEFAULT_DATA_DIR),
    join(workspaceRoot, 'apps', 'api', CONSTANTS.DEFAULT_DATA_DIR),
    join(workspaceRoot, 'packages', 'cli', CONSTANTS.DEFAULT_DATA_DIR),
  ].filter((candidate) => existsSync(candidate));

  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0] ?? null;

  return candidates
    .map((candidate) => ({ candidate, updatedAt: newestEntryMtime(candidate) }))
    .sort((left, right) => right.updatedAt - left.updatedAt)[0]?.candidate ?? null;
}

function newestEntryMtime(dir: string): number {
  const priorityFiles = ['data.db-wal', 'data.db', 'token', 'secrets.json'];
  let latest = 0;
  for (const name of priorityFiles) {
    latest = Math.max(latest, safeMtime(join(dir, name)));
  }
  if (latest > 0) return latest;
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      latest = Math.max(latest, safeMtime(join(dir, entry.name)));
    }
  } catch {
    return safeMtime(dir);
  }
  latest = Math.max(latest, safeMtime(dir));
  return latest;
}

function safeMtime(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

function findAgentisWorkspaceRoot(startDir: string): string | null {
  let dir = resolve(startDir);
  while (true) {
    const workspaceFile = join(dir, 'pnpm-workspace.yaml');
    const packageJsonFile = join(dir, 'package.json');
    if (existsSync(workspaceFile) && isAgentisWorkspacePackage(packageJsonFile)) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function isAgentisWorkspacePackage(packageJsonFile: string): boolean {
  if (!existsSync(packageJsonFile)) return false;
  try {
    const parsed = JSON.parse(readFileSync(packageJsonFile, 'utf8')) as { name?: unknown };
    return parsed.name === 'agentis';
  } catch {
    return false;
  }
}