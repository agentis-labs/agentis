import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { V1HarnessAdapterType } from './harnessProbe.js';

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
    const file = readCandidate(candidate);
    if (!file || seen.has(file.key)) continue;
    seen.add(file.key);
    files.push(file);
  }
  return files;
}

export function resolveWritableInstructionFile(agent: AgentInstructionOwner, key: string): { kind: 'platform' } | { kind: 'file'; path: string } | null {
  if (key.startsWith('platform:')) return { kind: 'platform' };
  for (const candidate of instructionCandidates(agent)) {
    const fileKey = fileKeyFor(candidate.path);
    if (fileKey === key && !candidate.readonly) return { kind: 'file', path: candidate.path };
  }
  return null;
}

export function writeInstructionFile(target: { kind: 'file'; path: string }, content: string) {
  writeFileSync(target.path, content, 'utf8');
}

interface InstructionCandidate {
  path: string;
  source: InstructionSource;
  description: string;
  readonly?: boolean;
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

  if (adapterType === 'codex') {
    const codexHome = firstString(process.env.CODEX_HOME) ?? path.join(home, '.codex');
    addFile(candidates, path.join(codexHome, 'AGENTS'), 'runtime', 'Codex home instructions');
    addFile(candidates, path.join(codexHome, 'AGENTS.md'), 'runtime', 'Codex home instructions');
  }

  if (adapterType === 'claude_code') {
    const claudeHome = firstString(process.env.CLAUDE_CONFIG_DIR) ?? path.join(home, '.claude');
    addFile(candidates, path.join(claudeHome, 'CLAUDE.md'), 'runtime', 'Claude home instructions');
    addFile(candidates, path.join(claudeHome, 'agents.md'), 'runtime', 'Claude home instructions');
  }

  if (adapterType === 'cursor') {
    addFile(candidates, path.join(home, '.cursorrules'), 'runtime', 'Cursor user rules');
    addDirectory(candidates, path.join(home, '.cursor', 'rules'), 'runtime', 'Cursor user rule');
  }

  if (adapterType === 'hermes_agent') {
    const hermesHome = firstString(process.env.HERMES_HOME) ?? path.join(home, '.hermes');
    addFile(candidates, path.join(hermesHome, 'AGENTS.md'), 'runtime', 'Hermes home instructions');
    addFile(candidates, path.join(hermesHome, 'HERMES.md'), 'runtime', 'Hermes home instructions');
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

function addFile(candidates: InstructionCandidate[], filePath: string, source: InstructionSource, description: string) {
  candidates.push({ path: path.resolve(filePath), source, description });
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
