/**
 * WorkspaceVolumeService — the persistent, mutable filesystem for a workspace
 * (WORKFLOW-10X-MASTERPLAN §4.4 "Workspace Volume").
 *
 * Root on host: `{AGENTIS_DATA_DIR}/workspace/{workspaceId}/`. Unlike the
 * ArtifactStore (immutable per-run receipts), the Volume is read+write and
 * persists across runs and workflows — it's the agent's "hard drive."
 *
 * Every path is resolved against the workspace root and guarded against escape
 * (`..`, absolute paths, symlink tricks): a relative path that resolves outside
 * the root throws `WORKSPACE_VOLUME_PATH_ESCAPE`. This is the single chokepoint
 * the Coder agent's `write_file` tool and the browser `serve_project` op go
 * through, so the boundary is enforced in exactly one place.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { AgentisError } from '@agentis/core';

/** Conventional top-level directories (created lazily on first write). */
export const VOLUME_DIRS = ['projects', 'sites', 'reports', 'datasets', 'assets', 'context'] as const;

export interface VolumeEntry {
  name: string;
  /** Path relative to the workspace root, POSIX-style. */
  path: string;
  kind: 'file' | 'dir';
  /** Bytes — files only. */
  size?: number;
  modifiedAt: string;
}

export class WorkspaceVolumeService {
  constructor(private readonly dataDir: string) {}

  /** Absolute path to a workspace's volume root. */
  rootFor(workspaceId: string): string {
    return path.join(path.resolve(this.dataDir), 'workspace', sanitizeId(workspaceId));
  }

  /**
   * Resolve a workspace-relative path to an absolute one, refusing anything
   * that escapes the workspace root.
   */
  resolve(workspaceId: string, relPath: string): string {
    const root = this.rootFor(workspaceId);
    const normalized = path.normalize(relPath).replace(/^([/\\])+/, '');
    const abs = path.resolve(root, normalized);
    const rel = path.relative(root, abs);
    if (rel === '' ) return abs;
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new AgentisError('WORKSPACE_VOLUME_PATH_ESCAPE', `Path "${relPath}" escapes the workspace volume`);
    }
    return abs;
  }

  async exists(workspaceId: string, relPath: string): Promise<boolean> {
    const abs = this.resolve(workspaceId, relPath);
    try {
      await this.#assertNoSymlinkTraversal(workspaceId, abs);
      await fs.access(abs);
      return true;
    } catch (err) {
      if (err instanceof AgentisError) throw err;
      return false;
    }
  }

  /** Read a UTF-8 file. Returns null when the file does not exist. */
  async read(workspaceId: string, relPath: string): Promise<string | null> {
    const abs = this.resolve(workspaceId, relPath);
    try {
      await this.#assertNoSymlinkTraversal(workspaceId, abs);
      return await fs.readFile(abs, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  /** Write a UTF-8 file, creating parent directories as needed. */
  async write(workspaceId: string, relPath: string, content: string): Promise<VolumeEntry> {
    const abs = this.resolve(workspaceId, relPath);
    await this.#assertNoSymlinkTraversal(workspaceId, abs);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await this.#assertNoSymlinkTraversal(workspaceId, abs);
    await fs.writeFile(abs, content, 'utf8');
    const stat = await fs.stat(abs);
    return {
      name: path.basename(abs),
      path: toPosix(path.relative(this.rootFor(workspaceId), abs)),
      kind: 'file',
      size: stat.size,
      modifiedAt: stat.mtime.toISOString(),
    };
  }

  /** Append to a UTF-8 file, creating it (and parents) if absent. */
  async append(workspaceId: string, relPath: string, content: string): Promise<void> {
    const abs = this.resolve(workspaceId, relPath);
    await this.#assertNoSymlinkTraversal(workspaceId, abs);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await this.#assertNoSymlinkTraversal(workspaceId, abs);
    await fs.appendFile(abs, content, 'utf8');
  }

  /** List a directory (non-recursive). Returns [] when the dir is absent. */
  async list(workspaceId: string, relDir = ''): Promise<VolumeEntry[]> {
    const abs = this.resolve(workspaceId, relDir);
    let dirents;
    try {
      await this.#assertNoSymlinkTraversal(workspaceId, abs);
      dirents = await fs.readdir(abs, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
    const root = this.rootFor(workspaceId);
    const out: VolumeEntry[] = [];
    for (const d of dirents) {
      const childAbs = path.join(abs, d.name);
      const stat = await fs.lstat(childAbs).catch(() => null);
      if (stat?.isSymbolicLink()) {
        throw new AgentisError('WORKSPACE_VOLUME_PATH_ESCAPE', 'Symbolic links are not allowed in workspace volume paths');
      }
      out.push({
        name: d.name,
        path: toPosix(path.relative(root, childAbs)),
        kind: d.isDirectory() ? 'dir' : 'file',
        ...(d.isFile() && stat ? { size: stat.size } : {}),
        modifiedAt: stat ? stat.mtime.toISOString() : new Date().toISOString(),
      });
    }
    return out.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'dir' ? -1 : 1));
  }

  /** Ensure the workspace root + conventional directories exist. */
  async ensureScaffold(workspaceId: string): Promise<void> {
    const root = this.rootFor(workspaceId);
    await this.#assertNoSymlinkTraversal(workspaceId, root);
    await fs.mkdir(root, { recursive: true });
    await this.#assertNoSymlinkTraversal(workspaceId, root);
    for (const dir of VOLUME_DIRS) {
      const target = path.join(root, dir);
      await this.#assertNoSymlinkTraversal(workspaceId, target);
      await fs.mkdir(target, { recursive: true });
      await this.#assertNoSymlinkTraversal(workspaceId, target);
    }
  }

  async #assertNoSymlinkTraversal(workspaceId: string, abs: string): Promise<void> {
    const volumeBase = path.join(path.resolve(this.dataDir), 'workspace');
    const root = this.rootFor(workspaceId);
    const rel = path.relative(root, abs);
    const paths = [volumeBase, root];
    let current = root;
    for (const part of rel.split(path.sep).filter(Boolean)) {
      current = path.join(current, part);
      paths.push(current);
    }
    for (const target of paths) {
      try {
        const stat = await fs.lstat(target);
        if (stat.isSymbolicLink()) {
          throw new AgentisError('WORKSPACE_VOLUME_PATH_ESCAPE', 'Symbolic links are not allowed in workspace volume paths');
        }
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
        throw err;
      }
    }
  }
}

function sanitizeId(id: string): string {
  // Workspace ids are UUIDs in practice; defend against traversal regardless.
  if (!/^[A-Za-z0-9_-]+$/.test(id)) {
    throw new AgentisError('VALIDATION_FAILED', `Invalid workspaceId for volume path: ${id}`);
  }
  return id;
}

function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}
