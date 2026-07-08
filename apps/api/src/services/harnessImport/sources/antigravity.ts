/**
 * Antigravity CLI import source (AGENT-TRANSITION §4) — single agent.
 * Antigravity (`agy`) keeps its config under `~/.gemini/antigravity-cli/` and
 * reads GEMINI.md / AGENTS.md (shared with the Gemini CLI lineage). Overridable
 * via ANTIGRAVITY_HOME.
 */

import path from 'node:path';
import type { DiscoverCtx, DiscoveredAgent, HarnessImportSource, ImportInputs, ImportMemoryFile, ImportSkill } from '../types.js';
import { isDir, listFiles, parseFrontmatter, readText, scanSkills } from '../fsScan.js';

const PRIMARY = 'antigravity:primary';

function antigravityHome(ctx: DiscoverCtx): string {
  return firstString(ctx.env.ANTIGRAVITY_HOME)
    ?? path.join(firstString(ctx.env.GEMINI_HOME) ?? path.join(ctx.home, '.gemini'), 'antigravity-cli');
}

function discoverSkills(ctx: DiscoverCtx): ImportSkill[] {
  const home = antigravityHome(ctx);
  const roots: Array<{ dir: string; origin: ImportSkill['origin'] }> = [
    { dir: path.join(home, 'skills'), origin: 'user' },
  ];
  if (ctx.cwd) roots.push({ dir: path.join(ctx.cwd, '.antigravity', 'skills'), origin: 'project' });
  return scanSkills(roots);
}

export const antigravitySource: HarnessImportSource = {
  adapterType: 'antigravity',

  discover(ctx) {
    const home = antigravityHome(ctx);
    const instr = readText(path.join(home, 'GEMINI.md'))
      ?? readText(path.join(home, 'AGENTS.md'))
      ?? readText(path.join(home, '..', 'GEMINI.md'));
    const memDir = path.join(home, 'memories');
    const projectInstr = ctx.cwd
      ? readText(path.join(ctx.cwd, 'GEMINI.md')) ?? readText(path.join(ctx.cwd, 'AGENTS.md'))
      : null;
    const memCount = isDir(memDir) ? listFiles(memDir).length : 0;
    const skillCount = discoverSkills(ctx).length;
    // Content gate (B3): real substance only — not just an empty antigravity-cli home.
    if (!instr && !projectInstr && memCount === 0 && skillCount === 0) return [];
    return [{
      adapterType: 'antigravity',
      externalId: PRIMARY,
      name: 'Antigravity CLI',
      role: null,
      persona: instr ?? null,
      detectedModel: null,
      config: ctx.cwd ? { cwd: ctx.cwd } : {},
      origin: { harness: 'Antigravity CLI', rootPath: home },
      summary: {
        memoryFiles: memCount,
        workspaceFiles: (instr ? 1 : 0) + (projectInstr ? 1 : 0),
        agentFiles: 0,
        skills: skillCount,
      },
    }];
  },

  read(agent, ctx): ImportInputs {
    const home = antigravityHome(ctx);
    const files: ImportMemoryFile[] = [];
    const instructionPaths = [
      path.join(home, 'GEMINI.md'),
      path.join(home, 'AGENTS.md'),
      ctx.cwd ? path.join(ctx.cwd, 'GEMINI.md') : null,
      ctx.cwd ? path.join(ctx.cwd, 'AGENTS.md') : null,
    ];
    for (const p of instructionPaths) {
      if (!p) continue;
      const content = readText(p);
      if (content && content.trim()) {
        files.push({ path: p, name: path.basename(p), content, scopeHint: 'workspace', typeHint: 'rule', kind: 'instruction' });
      }
    }
    const memDir = path.join(home, 'memories');
    for (const p of listFiles(memDir)) {
      const content = readText(p);
      if (!content || !content.trim()) continue;
      const { data, body } = parseFrontmatter(content);
      files.push({ path: p, name: path.basename(p), content: body.trim() || content, scopeHint: 'agent', typeHint: (data.type || '').trim().toLowerCase() || null, kind: 'memory' });
    }
    return { agent, files, skills: discoverSkills(ctx) };
  },
};

function firstString(...values: Array<string | undefined>): string | undefined {
  return values.find((v) => typeof v === 'string' && v.trim().length > 0)?.trim();
}
