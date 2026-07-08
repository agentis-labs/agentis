/**
 * Cursor import source (AGENT-TRANSITION §4) — single agent.
 * Rules: ~/.cursorrules + ~/.cursor/rules/*.mdc (+ project equivalents).
 */

import path from 'node:path';
import type { DiscoverCtx, DiscoveredAgent, HarnessImportSource, ImportInputs, ImportMemoryFile, ImportSkill } from '../types.js';
import { listFiles, readText, scanSkills } from '../fsScan.js';

const PRIMARY = 'cursor:primary';

function ruleFiles(ctx: DiscoverCtx): string[] {
  const out: string[] = [];
  for (const p of [path.join(ctx.home, '.cursorrules'), ctx.cwd ? path.join(ctx.cwd, '.cursorrules') : null]) {
    if (p && readText(p)) out.push(p);
  }
  out.push(...listFiles(path.join(ctx.home, '.cursor', 'rules'), /\.(md|mdc|markdown|txt)$/i));
  if (ctx.cwd) out.push(...listFiles(path.join(ctx.cwd, '.cursor', 'rules'), /\.(md|mdc|markdown|txt)$/i));
  return out;
}

function discoverSkills(ctx: DiscoverCtx): ImportSkill[] {
  const roots: Array<{ dir: string; origin: ImportSkill['origin'] }> = [
    { dir: path.join(ctx.home, '.cursor', 'skills'), origin: 'user' },
  ];
  if (ctx.cwd) roots.push({ dir: path.join(ctx.cwd, '.cursor', 'skills'), origin: 'project' });
  return scanSkills(roots);
}

export const cursorSource: HarnessImportSource = {
  adapterType: 'cursor',

  discover(ctx) {
    const files = ruleFiles(ctx);
    const skills = discoverSkills(ctx);
    // Content gate (B3): a bare ~/.cursor dir with no rule files is not an agent.
    if (files.length === 0 && skills.length === 0) return [];
    return [{
      adapterType: 'cursor',
      externalId: PRIMARY,
      name: 'Cursor',
      role: null,
      persona: readText(path.join(ctx.home, '.cursorrules')) ?? null,
      detectedModel: null,
      config: ctx.cwd ? { cwd: ctx.cwd } : {},
      origin: { harness: 'Cursor', rootPath: path.join(ctx.home, '.cursor') },
      summary: { memoryFiles: 0, workspaceFiles: files.length, agentFiles: 0, skills: skills.length },
    }];
  },

  read(agent, ctx): ImportInputs {
    const files: ImportMemoryFile[] = [];
    for (const p of ruleFiles(ctx)) {
      const content = readText(p);
      if (content && content.trim()) {
        files.push({ path: p, name: path.basename(p), content, scopeHint: 'workspace', typeHint: 'rule', kind: 'instruction' });
      }
    }
    return { agent, files, skills: discoverSkills(ctx) };
  },
};
