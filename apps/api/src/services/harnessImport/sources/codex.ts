/**
 * Codex import source (AGENT-TRANSITION §4) — single agent.
 * Instructions: ~/.codex/AGENTS.md (+ project AGENTS.md). Memory: any
 * ~/.codex/memory/*.md the user keeps.
 */

import path from 'node:path';
import type { DiscoverCtx, DiscoveredAgent, HarnessImportSource, ImportInputs, ImportMemoryFile, ImportSkill } from '../types.js';
import { isDir, listFiles, parseFrontmatter, readText, scanSkills } from '../fsScan.js';

const PRIMARY = 'codex:primary';

function codexHome(ctx: DiscoverCtx): string {
  return firstString(ctx.env.CODEX_HOME) ?? path.join(ctx.home, '.codex');
}

function discoverSkills(ctx: DiscoverCtx): ImportSkill[] {
  const home = codexHome(ctx);
  const roots: Array<{ dir: string; origin: ImportSkill['origin'] }> = [
    { dir: path.join(home, 'skills'), origin: 'user' },
  ];
  if (ctx.cwd) roots.push({ dir: path.join(ctx.cwd, '.codex', 'skills'), origin: 'project' });
  return scanSkills(roots);
}

export const codexSource: HarnessImportSource = {
  adapterType: 'codex',

  discover(ctx) {
    const home = codexHome(ctx);
    const instr = readText(path.join(home, 'AGENTS.md'));
    const memDir = path.join(home, 'memories');
    const projectInstr = ctx.cwd ? readText(path.join(ctx.cwd, 'AGENTS.md')) : null;
    const memCount = isDir(memDir) ? listFiles(memDir).length : 0;
    const skillCount = discoverSkills(ctx).length;
    // Content gate (B3): real substance only — not just an empty ~/.codex home.
    if (!instr && !projectInstr && memCount === 0 && skillCount === 0) return [];
    return [{
      adapterType: 'codex',
      externalId: PRIMARY,
      name: 'Codex',
      role: null,
      persona: instr ?? null,
      detectedModel: null,
      config: ctx.cwd ? { cwd: ctx.cwd } : {},
      origin: { harness: 'Codex', rootPath: home },
      summary: {
        memoryFiles: memCount,
        workspaceFiles: (instr ? 1 : 0) + (projectInstr ? 1 : 0),
        agentFiles: 0,
        skills: skillCount,
      },
    }];
  },

  read(agent, ctx): ImportInputs {
    const home = codexHome(ctx);
    const files: ImportMemoryFile[] = [];
    for (const p of [path.join(home, 'AGENTS.md'), ctx.cwd ? path.join(ctx.cwd, 'AGENTS.md') : null]) {
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
