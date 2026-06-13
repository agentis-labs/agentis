import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { V1HarnessAdapterType } from './harnessProbe.js';
import { harnessAgentInstructionsPath } from './harnessAgentHome.js';

export type InstructionSource = 'platform' | 'workspace' | 'runtime';

export interface AgentInstructionFile {
  key: string;
  name: string;
  description?: string;
  content: string;
  readonly?: boolean;
  source: InstructionSource;
  path?: string;
}

interface AgentInstructionOwner {
  id?: string | null;
  adapterType?: string | null;
  config?: unknown;
  instructions?: string | null;
}

const MAX_READ_BYTES = 512 * 1024;

export function listAgentInstructionFiles(agent: AgentInstructionOwner): AgentInstructionFile[] {
  const files: AgentInstructionFile[] = [];
  const platformContent = typeof agent.instructions === 'string' ? agent.instructions : '';
  if (platformContent.trim().length > 0) {
    files.push({
      key: 'platform:agentis.md',
      name: 'agentis.md',
      description: 'Agentis platform instructions',
      content: platformContent,
      source: 'platform',
    });
  }

  const seen = new Set(files.map((file) => file.key));
  for (const candidate of instructionCandidates(agent)) {
    const key = fileKeyFor(candidate.path);
    if (seen.has(key)) continue;
    const file = readCandidate(candidate);
    if (file) {
      seen.add(key);
      files.push(file);
    } else if (candidate.primary) {
      // Surface the runtime's canonical instruction file even when it doesn't
      // exist yet, so the operator can create + edit it inline from the UI.
      // Done uniformly for every runtime (codex / claude_code / cursor / hermes).
      seen.add(key);
      files.push({
        key,
        name: displayName(candidate.path),
        description: `${candidate.description} — ${friendlyPath(candidate.path)} (not created yet)`,
        content: '',
        source: candidate.source,
        path: candidate.path,
      });
    }
  }
  return files;
}

export function resolveWritableInstructionFile(agent: AgentInstructionOwner, key: string): { kind: 'platform' } | { kind: 'file'; path: string } | null {
  if (key === 'platform:agentis.md' || key === 'platform:system.md') return { kind: 'platform' };
  for (const candidate of instructionCandidates(agent)) {
    const fileKey = fileKeyFor(candidate.path);
    if (fileKey === key && !candidate.readonly) return { kind: 'file', path: candidate.path };
  }
  return null;
}

export function writeInstructionFile(target: { kind: 'file'; path: string }, content: string) {
  // Create the parent dir on demand so a not-yet-created canonical runtime file
  // (e.g. ~/.codex/AGENTS.md, ~/.claude/CLAUDE.md) can be written from the UI.
  mkdirSync(path.dirname(target.path), { recursive: true });
  writeFileSync(target.path, content, 'utf8');
}

interface InstructionCandidate {
  path: string;
  source: InstructionSource;
  description: string;
  readonly?: boolean;
  /** Canonical runtime file — surfaced (creatable) even when it doesn't exist. */
  primary?: boolean;
}

function instructionCandidates(agent: AgentInstructionOwner): InstructionCandidate[] {
  const config = objectRecord(agent.config);
  const cwd = firstString(config.cwd, config.workingDirectory, config.repositoryPath, config.repoPath);
  const home = os.homedir();
  const adapterType = typeof agent.adapterType === 'string' ? agent.adapterType as V1HarnessAdapterType : null;
  const candidates: InstructionCandidate[] = [];

  if (cwd) {
    addWorkspaceCandidates(candidates, cwd);
  }

  // Runtime home instruction files — one canonical (always-surfaced, creatable)
  // file per runtime, plus any legacy variants we also recognize. Every CLI
  // runtime is handled uniformly here.
  if (adapterType === 'codex') {
    const codexHome = firstString(process.env.CODEX_HOME) ?? path.join(home, '.codex');
    addFile(candidates, path.join(codexHome, 'AGENTS.md'), 'runtime', 'Codex home instructions', { primary: true });
    addFile(candidates, path.join(codexHome, 'AGENTS'), 'runtime', 'Codex home instructions');
  }

  if (adapterType === 'claude_code') {
    const claudeHome = firstString(process.env.CLAUDE_CONFIG_DIR) ?? path.join(home, '.claude');
    addFile(candidates, path.join(claudeHome, 'CLAUDE.md'), 'runtime', 'Claude Code home instructions', { primary: true });
  }

  if (adapterType === 'cursor') {
    addFile(candidates, path.join(home, '.cursorrules'), 'runtime', 'Cursor user rules', { primary: true });
    addDirectory(candidates, path.join(home, '.cursor', 'rules'), 'runtime', 'Cursor user rule');
  }

  if (adapterType === 'hermes_agent') {
    // The agent's NATIVE instruction file: Agentis writes the agent's persona to
    // this per-agent `AGENTS.md` and runs the Hermes session there, so the harness
    // auto-injects it. Editing it here edits the exact file the agent loads. (Only
    // when no explicit cwd is configured — a real project cwd owns its own AGENTS.md.)
    if (agent.id && !cwd) {
      addFile(candidates, harnessAgentInstructionsPath(agent.id), 'runtime', 'Agent instructions (loaded natively by Hermes)', { primary: true });
    }
    const hermesHome = firstString(process.env.HERMES_HOME) ?? path.join(home, '.hermes');
    addFile(candidates, path.join(hermesHome, 'AGENTS.md'), 'runtime', 'Hermes global home instructions');
    addFile(candidates, path.join(hermesHome, 'HERMES.md'), 'runtime', 'Hermes global home instructions');
  }

  return candidates;
}

function addWorkspaceCandidates(candidates: InstructionCandidate[], cwd: string) {
  const root = path.resolve(cwd);
  addFile(candidates, path.join(root, 'AGENTS.md'), 'workspace', 'Workspace instructions');
  addFile(candidates, path.join(root, 'AGENTS'), 'workspace', 'Workspace instructions');
  addFile(candidates, path.join(root, 'CLAUDE.md'), 'workspace', 'Claude workspace instructions');
  addFile(candidates, path.join(root, 'GEMINI.md'), 'workspace', 'Gemini workspace instructions');
  addFile(candidates, path.join(root, '.cursorrules'), 'workspace', 'Cursor workspace rules');
  addDirectory(candidates, path.join(root, '.cursor', 'rules'), 'workspace', 'Cursor workspace rule');
}

function addDirectory(candidates: InstructionCandidate[], dir: string, source: InstructionSource, description: string) {
  if (!existsSync(dir)) return;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries.sort()) {
    if (!/\.(md|mdc|txt)$/i.test(entry)) continue;
    addFile(candidates, path.join(dir, entry), source, description);
  }
}

function addFile(candidates: InstructionCandidate[], filePath: string, source: InstructionSource, description: string, opts?: { primary?: boolean; readonly?: boolean }) {
  candidates.push({ path: path.resolve(filePath), source, description, primary: opts?.primary, readonly: opts?.readonly });
}

function readCandidate(candidate: InstructionCandidate): AgentInstructionFile | null {
  if (!existsSync(candidate.path)) return null;
  let stats;
  try {
    stats = statSync(candidate.path);
  } catch {
    return null;
  }
  if (!stats.isFile()) return null;
  if (stats.size > MAX_READ_BYTES) {
    return {
      key: fileKeyFor(candidate.path),
      name: displayName(candidate.path),
      description: `${candidate.description} - file is too large to edit here`,
      content: '',
      readonly: true,
      source: candidate.source,
      path: candidate.path,
    };
  }
  try {
    return {
      key: fileKeyFor(candidate.path),
      name: displayName(candidate.path),
      description: `${candidate.description} - ${friendlyPath(candidate.path)}`,
      content: readFileSync(candidate.path, 'utf8'),
      readonly: candidate.readonly,
      source: candidate.source,
      path: candidate.path,
    };
  } catch {
    return null;
  }
}

function fileKeyFor(filePath: string): string {
  return `file:${Buffer.from(path.resolve(filePath), 'utf8').toString('base64url')}`;
}

function displayName(filePath: string): string {
  const base = path.basename(filePath);
  const parent = path.basename(path.dirname(filePath));
  if (parent === '.codex' || parent === '.claude' || parent === '.hermes') return `${parent}/${base}`;
  if (parent === 'rules') return `.cursor/rules/${base}`;
  return base;
}

function friendlyPath(filePath: string): string {
  const home = os.homedir();
  const resolved = path.resolve(filePath);
  const rel = path.relative(home, resolved);
  if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return path.join('~', rel);
  return resolved;
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  }
  return null;
}
