/**
 * fsScan — small, safe filesystem helpers for the harness import sources.
 * All reads are best-effort: a missing file / unreadable dir yields empty, never
 * throws, so discovery degrades gracefully on any machine.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import type { ImportSkill } from './types.js';

const MAX_READ_BYTES = 512 * 1024;

export function readText(filePath: string, maxBytes = MAX_READ_BYTES): string | null {
  try {
    if (!existsSync(filePath)) return null;
    const stats = statSync(filePath);
    if (!stats.isFile() || stats.size > maxBytes) return null;
    return readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

export function isDir(p: string): boolean {
  try {
    return existsSync(p) && statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** List immediate child directory names of `dir` (sorted), best-effort. */
export function listDirs(dir: string): string[] {
  try {
    if (!isDir(dir)) return [];
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

/** List immediate files in `dir` matching `extRe` (absolute paths, sorted).
 *  Harness-internal/vendor/cache paths are excluded (B8). */
export function listFiles(dir: string, extRe = /\.(md|mdc|markdown|txt)$/i): string[] {
  try {
    if (!isDir(dir) || isExcludedPath(dir)) return [];
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && extRe.test(e.name))
      .map((e) => path.join(dir, e.name))
      .filter((p) => !isExcludedPath(p))
      .sort();
  } catch {
    return [];
  }
}

export interface Frontmatter {
  data: Record<string, string>;
  body: string;
}

/**
 * Parse a leading YAML-ish `--- … ---` frontmatter block. Only flat
 * `key: value` scalars are extracted (enough for name/description/type/model);
 * nested structures are ignored. Returns the body without the block.
 */
export function parseFrontmatter(content: string): Frontmatter {
  const match = content.match(/^﻿?---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n?/);
  if (!match) return { data: {}, body: content };
  const data: Record<string, string> = {};
  for (const line of (match[1] ?? '').split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1]!.trim();
    let value = (kv[2] ?? '').trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (value.length > 0) data[key] = value;
  }
  return { data, body: content.slice(match[0].length) };
}

/**
 * Deny-list for harness-internal / vendor / cache / tooling content (B8). These
 * paths describe the HARNESS or its bundled tools, not the user's work, and must
 * never enter the Brain. Matched case-insensitively against the full path.
 */
const DENY_SEGMENTS = [
  'plugins/cache', 'plugins\\cache', '/cache/', '\\cache\\',
  'node_modules', '.sandbox', '.sandbox-bin', '.sandbox-secrets',
  'archived_sessions', 'attachments', '/assets/', '\\assets\\',
  '-bundled', '.codex-plugin', '/logs', '\\logs', '.tmp',
];

/** True when a path is harness-internal/vendor/cache and must NOT be imported. */
export function isExcludedPath(p: string): boolean {
  const lower = p.toLowerCase();
  if (DENY_SEGMENTS.some((seg) => lower.includes(seg))) return true;
  // Vendor/tool self-documentation (api/troubleshooting/capabilities docs) living
  // under a plugin dir — describes how to use a tool, not user knowledge.
  if (/[\\/]docs[\\/]/.test(lower) && /[\\/]plugins?[\\/]/.test(lower)) return true;
  if (/[\\/]capabilities[\\/]/.test(lower)) return true;
  return false;
}

/**
 * Claude Code encodes a project's absolute cwd into its `~/.claude/projects/<x>`
 * directory name by replacing every non-alphanumeric char with `-`.
 * e.g. `C:\Users\me\app` → `C--Users-me-app`.
 */
export function claudeProjectSlug(cwd: string): string {
  return path.resolve(cwd).replace(/[^A-Za-z0-9]/g, '-');
}

/** Best-effort: derive a readable original path from a Claude project slug. */
export function deslugProject(slug: string): string {
  // Lossy (separators were flattened) — used only for display.
  return slug.replace(/-+/g, '/');
}

/**
 * Scan skill directories (the `<dir>/<skill>/SKILL.md` convention used by Claude
 * Code / Cursor) into `ImportSkill`s. Vendor/cache paths are excluded (B8).
 * `marketplace` skills are surfaced but the caller treats them as opt-in.
 */
export function scanSkills(roots: Array<{ dir: string; origin: ImportSkill['origin'] }>): ImportSkill[] {
  const out: ImportSkill[] = [];
  const seen = new Set<string>();
  for (const root of roots) {
    if (!isDir(root.dir) || isExcludedPath(root.dir)) continue;
    for (const skillDir of listDirs(root.dir)) {
      const full = path.join(root.dir, skillDir);
      const manifest = path.join(full, 'SKILL.md');
      if (isExcludedPath(full)) continue;
      const content = readText(manifest);
      if (!content || !content.trim() || seen.has(manifest)) continue;
      seen.add(manifest);
      const { data, body } = parseFrontmatter(content);
      out.push({
        path: manifest,
        name: data.name?.trim() || skillDir.replace(/[-_]+/g, ' '),
        description: data.description?.trim() || null,
        content: body.trim() || content,
        origin: root.origin,
      });
    }
  }
  return out;
}
