/**
 * WorktreeManager — per-task filesystem isolation for parallel agents.
 *
 * The keystone of safe multi-agent orchestration. When N agents run in parallel
 * (an `agent_swarm`, a delegate team, a dynamic swarm), each one MUST work in
 * its own directory — otherwise concurrent processes edit the same files and
 * clobber each other (last-writer-wins corruption, half-written builds, racing
 * git state). Before this, every parallel adapter spawned at the SAME static
 * `cwd`; this service hands each task an isolated directory instead.
 *
 * Two isolation modes, chosen automatically:
 *   - `git_worktree` — when the base directory is inside a git work tree, we
 *     `git worktree add --detach` a fresh checkout of the current HEAD. The agent
 *     gets the full repo to work in, isolated from siblings; the worktree is
 *     discarded on release (swarm semantics merge OUTPUTS, not files — preserving
 *     a branch / opening a PR is a later feature).
 *   - `temp_dir` — when the base is not a git repo (or has no base), we hand out
 *     a fresh empty temp directory. Isolation without copying a (potentially huge)
 *     tree.
 *
 * `none` is returned only when no base directory exists at all (gateway/remote
 * adapters that don't spawn local processes) — the caller then leaves
 * `task.workdir` unset and the adapter falls back to its configured cwd.
 *
 * Every operation is best-effort and NEVER throws into the run: a git failure
 * degrades to a temp dir; a cleanup failure is logged, not propagated. `release`
 * is idempotent.
 */

import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Logger } from '../logger.js';

export type WorktreeMode = 'git_worktree' | 'temp_dir' | 'none';

export interface WorktreeHandle {
  /** Isolated working directory for the task, or `undefined` when none was possible. */
  readonly path: string | undefined;
  /** How isolation was achieved (diagnostics + tests). */
  readonly mode: WorktreeMode;
  /** Idempotent, best-effort cleanup. Never throws. */
  release(): Promise<void>;
}

export interface WorktreeAcquireOptions {
  /** The agent's configured working directory; the base we isolate FROM. */
  baseCwd?: string;
  /** Stable id for naming/diagnostics (e.g. the swarm subtask id). */
  taskId: string;
}

export interface WorktreeManagerOptions {
  /** Root under which isolated dirs are created. Default: <os tmp>/agentis-worktrees. */
  root?: string;
  /** git binary. Default: `git` on PATH. */
  gitBinary?: string;
  /** Per-git-command timeout. Default 15s. */
  gitTimeoutMs?: number;
}

const NOOP_HANDLE: WorktreeHandle = {
  path: undefined,
  mode: 'none',
  release: async () => {},
};

export class WorktreeManager {
  readonly #root: string;
  readonly #git: string;
  readonly #gitTimeoutMs: number;
  #rootEnsured = false;

  constructor(
    private readonly logger: Logger,
    opts: WorktreeManagerOptions = {},
  ) {
    this.#root = opts.root ?? join(tmpdir(), 'agentis-worktrees');
    this.#git = opts.gitBinary ?? 'git';
    this.#gitTimeoutMs = opts.gitTimeoutMs ?? 15_000;
  }

  /**
   * Allocate an isolated directory for one task. Resolves a handle whose
   * `release()` tears it down. Falls back gracefully (git → temp → none) and
   * never throws — isolation is a safety enhancement, not a hard dependency.
   */
  async acquire(opts: WorktreeAcquireOptions): Promise<WorktreeHandle> {
    const base = opts.baseCwd?.trim();
    if (!base) return NOOP_HANDLE;

    await this.#ensureRoot();

    // Prefer a git worktree when the base is a repo — the agent gets the codebase.
    if (await this.#isGitWorkTree(base)) {
      const handle = await this.#acquireGitWorktree(base, opts.taskId);
      if (handle) return handle;
      // git add failed for some reason — degrade to an isolated empty dir.
    }

    return this.#acquireTempDir(opts.taskId);
  }

  // ── git worktree ───────────────────────────────────────────────────────────

  async #acquireGitWorktree(base: string, taskId: string): Promise<WorktreeHandle | null> {
    // `git worktree add` requires a path that does NOT yet exist.
    const path = join(this.#root, `wt-${sanitize(taskId)}-${randomUUID().slice(0, 8)}`);
    const add = await this.#runGit(base, ['worktree', 'add', '--detach', path]);
    if (!add.ok) {
      this.logger.warn('worktree.git_add_failed', { base, path, err: add.stderr.slice(0, 400) });
      return null;
    }
    let released = false;
    return {
      path,
      mode: 'git_worktree',
      release: async () => {
        if (released) return;
        released = true;
        // `git worktree remove` keeps git's bookkeeping clean; force past dirty trees.
        const removed = await this.#runGit(base, ['worktree', 'remove', '--force', path]);
        if (!removed.ok) {
          // Orphaned git metadata + a stray dir — prune + hard-delete as a fallback.
          await this.#runGit(base, ['worktree', 'prune']);
          await rmQuiet(path, this.logger);
        }
      },
    };
  }

  async #isGitWorkTree(base: string): Promise<boolean> {
    const res = await this.#runGit(base, ['rev-parse', '--is-inside-work-tree']);
    return res.ok && res.stdout.trim() === 'true';
  }

  // ── temp dir ─────────────────────────────────────────────────────────────

  async #acquireTempDir(taskId: string): Promise<WorktreeHandle> {
    let path: string;
    try {
      path = await mkdtemp(join(this.#root, `td-${sanitize(taskId)}-`));
    } catch (err) {
      this.logger.warn('worktree.tempdir_failed', { taskId, err: (err as Error).message });
      return NOOP_HANDLE;
    }
    let released = false;
    return {
      path,
      mode: 'temp_dir',
      release: async () => {
        if (released) return;
        released = true;
        await rmQuiet(path, this.logger);
      },
    };
  }

  // ── helpers ──────────────────────────────────────────────────────────────

  async #ensureRoot(): Promise<void> {
    if (this.#rootEnsured) return;
    try {
      await mkdir(this.#root, { recursive: true });
      this.#rootEnsured = true;
    } catch (err) {
      // Surface but don't throw — acquire() will degrade to none if dirs fail.
      this.logger.warn('worktree.root_mkdir_failed', { root: this.#root, err: (err as Error).message });
    }
  }

  #runGit(cwd: string, args: string[]): Promise<{ ok: boolean; stdout: string; stderr: string }> {
    return new Promise((resolve) => {
      let stdout = '';
      let stderr = '';
      let settled = false;
      const done = (ok: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ ok, stdout, stderr });
      };
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(this.#git, ['-C', cwd, ...args], { windowsHide: true });
      } catch (err) {
        stderr = (err as Error).message;
        return done(false);
      }
      const timer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* ignore */ }
        done(false);
      }, this.#gitTimeoutMs);
      timer.unref?.();
      child.stdout?.on('data', (d) => { stdout += String(d); });
      child.stderr?.on('data', (d) => { stderr += String(d); });
      child.on('error', (err) => { stderr += err.message; done(false); });
      child.on('close', (code) => done(code === 0));
    });
  }
}

function sanitize(taskId: string): string {
  return taskId.replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 60) || 'task';
}

async function rmQuiet(path: string, logger: Logger): Promise<void> {
  try {
    await rm(path, { recursive: true, force: true });
  } catch (err) {
    logger.warn('worktree.cleanup_failed', { path, err: (err as Error).message });
  }
}
