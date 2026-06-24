/**
 * WorktreeManager — per-task filesystem isolation for parallel agents.
 *
 * Covers the three acquisition modes (none / temp_dir / git_worktree), idempotent
 * best-effort release, unique allocation under concurrency, and the real git
 * worktree lifecycle (add → isolated checkout → remove).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile, mkdir, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorktreeManager } from '../../src/services/worktreeManager.js';
import { createLogger } from '../../src/logger.js';

const logger = createLogger({ level: 'error' });

function gitAvailable(): boolean {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
const HAS_GIT = gitAvailable();

let root: string;
let scratch: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wtm-root-'));
  scratch = await mkdtemp(join(tmpdir(), 'wtm-scratch-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true }).catch(() => {});
  await rm(scratch, { recursive: true, force: true }).catch(() => {});
});

describe('WorktreeManager', () => {
  it('returns mode "none" with no path when no base directory is given', async () => {
    const mgr = new WorktreeManager(logger, { root });
    const handle = await mgr.acquire({ taskId: 't1' });
    expect(handle.mode).toBe('none');
    expect(handle.path).toBeUndefined();
    // release is a safe no-op.
    await expect(handle.release()).resolves.toBeUndefined();
  });

  it('allocates an isolated temp dir for a non-git base, then removes it on release', async () => {
    const mgr = new WorktreeManager(logger, { root });
    const handle = await mgr.acquire({ baseCwd: scratch, taskId: 'node-1::swarm::0' });

    expect(handle.mode).toBe('temp_dir');
    expect(handle.path).toBeDefined();
    expect(existsSync(handle.path!)).toBe(true);
    // Lives under the configured root, not the base — true isolation.
    expect(handle.path!.startsWith(root)).toBe(true);
    expect(handle.path!).not.toBe(scratch);

    await handle.release();
    expect(existsSync(handle.path!)).toBe(false);
  });

  it('hands concurrent acquisitions distinct directories', async () => {
    const mgr = new WorktreeManager(logger, { root });
    const handles = await Promise.all(
      Array.from({ length: 8 }, (_, i) => mgr.acquire({ baseCwd: scratch, taskId: `c::${i}` })),
    );
    const paths = handles.map((h) => h.path);
    expect(new Set(paths).size).toBe(8);
    for (const h of handles) expect(existsSync(h.path!)).toBe(true);
    await Promise.all(handles.map((h) => h.release()));
    for (const h of handles) expect(existsSync(h.path!)).toBe(false);
  });

  it('release is idempotent', async () => {
    const mgr = new WorktreeManager(logger, { root });
    const handle = await mgr.acquire({ baseCwd: scratch, taskId: 'idem' });
    await handle.release();
    // Second release must not throw even though the dir is already gone.
    await expect(handle.release()).resolves.toBeUndefined();
  });

  it.skipIf(!HAS_GIT)(
    'creates an isolated git worktree checkout for a git base and tears it down on release',
    async () => {
      // Hermetic throwaway repo with one commit so HEAD exists.
      const repo = await mkdtemp(join(tmpdir(), 'wtm-repo-'));
      try {
        const git = (...args: string[]) =>
          execFileSync('git', args, {
            cwd: repo,
            stdio: 'ignore',
            env: {
              ...process.env,
              GIT_AUTHOR_NAME: 't',
              GIT_AUTHOR_EMAIL: 't@t',
              GIT_COMMITTER_NAME: 't',
              GIT_COMMITTER_EMAIL: 't@t',
            },
          });
        git('init');
        await writeFile(join(repo, 'README.md'), '# isolated\n');
        git('add', '.');
        git('commit', '-m', 'init');

        const mgr = new WorktreeManager(logger, { root });
        const handle = await mgr.acquire({ baseCwd: repo, taskId: 'node-1::swarm::3' });

        expect(handle.mode).toBe('git_worktree');
        expect(handle.path).toBeDefined();
        expect(existsSync(handle.path!)).toBe(true);
        // The worktree is a real checkout of HEAD — the committed file is present.
        const files = await readdir(handle.path!);
        expect(files).toContain('README.md');
        // git tracks it as a registered worktree. (git reports forward slashes
        // even on Windows, so normalize separators before comparing.)
        const norm = (p: string) => p.replace(/\\/g, '/');
        const list = norm(execFileSync('git', ['worktree', 'list'], { cwd: repo }).toString());
        expect(list).toContain(norm(handle.path!));

        await handle.release();
        expect(existsSync(handle.path!)).toBe(false);
        const after = norm(execFileSync('git', ['worktree', 'list'], { cwd: repo }).toString());
        expect(after).not.toContain(norm(handle.path!));
      } finally {
        await rm(repo, { recursive: true, force: true }).catch(() => {});
      }
    },
  );

  it('degrades to a temp dir when the root cannot be created under a file path', async () => {
    // Point root at a path whose parent is a FILE — mkdir recursive fails, and we
    // must still not throw (isolation is best-effort).
    const filePath = join(scratch, 'not-a-dir');
    await mkdir(scratch, { recursive: true }).catch(() => {});
    await writeFile(filePath, 'x');
    const mgr = new WorktreeManager(logger, { root: join(filePath, 'sub') });
    const handle = await mgr.acquire({ baseCwd: scratch, taskId: 'degrade' });
    // Either none (mkdtemp failed) — never a throw.
    expect(['none', 'temp_dir']).toContain(handle.mode);
    await expect(handle.release()).resolves.toBeUndefined();
  });
});
