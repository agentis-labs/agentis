/**
 * Hermes import source (AGENT-TRANSITION §4) — the primary *multi-agent* case.
 *
 * Hermes keeps a roster of agents on the machine. We enumerate each roster
 * entry (`~/.hermes/agents/*.md` or a per-agent dir holding `AGENTS.md`) as a
 * distinct Agentis agent, plus a primary Hermes agent for the global
 * `~/.hermes/AGENTS.md` instructions + any global memory.
 */

import path from 'node:path';
import type { DiscoverCtx, DiscoveredAgent, HarnessImportSource, ImportInputs, ImportMemoryFile, ImportSkill } from '../types.js';
import { isDir, listDirs, listFiles, parseFrontmatter, readText, scanSkills } from '../fsScan.js';

const PRIMARY = 'hermes_agent:primary';

function hermesHome(ctx: DiscoverCtx): string {
  return firstString(ctx.env.HERMES_HOME) ?? path.join(ctx.home, '.hermes');
}

function globalSkills(ctx: DiscoverCtx): ImportSkill[] {
  const roots: Array<{ dir: string; origin: ImportSkill['origin'] }> = [
    { dir: path.join(hermesHome(ctx), 'skills'), origin: 'user' },
  ];
  if (ctx.cwd) roots.push({ dir: path.join(ctx.cwd, '.hermes', 'skills'), origin: 'project' });
  return scanSkills(roots);
}

function entrySkills(entry: { id: string }): ImportSkill[] {
  return scanSkills([{ dir: path.join(entry.id, 'skills'), origin: 'user' }]);
}

/** Roster entries: flat `agents/*.md` files + per-agent dirs with an AGENTS.md. */
function rosterEntries(ctx: DiscoverCtx): Array<{ id: string; name: string; instructionPath: string; memoryDir: string | null }> {
  const home = hermesHome(ctx);
  const agentsRoot = path.join(home, 'agents');
  const out: Array<{ id: string; name: string; instructionPath: string; memoryDir: string | null }> = [];
  for (const file of listFiles(agentsRoot)) {
    out.push({ id: file, name: baseName(file), instructionPath: file, memoryDir: null });
  }
  for (const dir of listDirs(agentsRoot)) {
    const full = path.join(agentsRoot, dir);
    const instr = [path.join(full, 'AGENTS.md'), path.join(full, 'HERMES.md')].find((p) => readText(p));
    if (instr) {
      const memDir = path.join(full, 'memory');
      out.push({ id: full, name: dir, instructionPath: instr, memoryDir: isDir(memDir) ? memDir : null });
    }
  }
  return out;
}

export const hermesSource: HarnessImportSource = {
  adapterType: 'hermes_agent',

  discover(ctx) {
    const home = hermesHome(ctx);
    const agents: DiscoveredAgent[] = [];

    const globalInstr = [path.join(home, 'AGENTS.md'), path.join(home, 'HERMES.md')].map(readText).find(Boolean) ?? null;
    const skills = globalSkills(ctx);
    // Content gate (B3): only a primary Hermes agent when there are global
    // instructions; an empty ~/.hermes home is not an agent. Roster entries below
    // are surfaced separately on their own substance.
    if (globalInstr || skills.length > 0) {
      agents.push({
        adapterType: 'hermes_agent',
        externalId: PRIMARY,
        name: 'Hermes',
        role: null,
        persona: globalInstr,
        detectedModel: null,
        config: ctx.cwd ? { cwd: ctx.cwd } : {},
        origin: { harness: 'Hermes Agent', rootPath: home },
        summary: { memoryFiles: 0, workspaceFiles: globalInstr ? 1 : 0, agentFiles: 0, skills: skills.length },
      });
    }

    for (const entry of rosterEntries(ctx)) {
      const raw = readText(entry.instructionPath) ?? '';
      const { data, body } = parseFrontmatter(raw);
      const memCount = entry.memoryDir ? listFiles(entry.memoryDir).length : 0;
      const skills = entrySkills(entry);
      agents.push({
        adapterType: 'hermes_agent',
        externalId: `hermes_agent:agent:${entry.id}`,
        name: data.name?.trim() || entry.name,
        role: roleHint(data),
        persona: (body.trim() || raw.trim()) || null,
        detectedModel: data.model?.trim() || null,
        config: ctx.cwd ? { cwd: ctx.cwd } : {},
        origin: { harness: 'Hermes Agent', rootPath: entry.instructionPath },
        summary: { memoryFiles: memCount, workspaceFiles: 0, agentFiles: 1, skills: skills.length },
      });
    }

    return agents;
  },

  read(agent, ctx): ImportInputs {
    const files: ImportMemoryFile[] = [];
    if (agent.externalId === PRIMARY) {
      const home = hermesHome(ctx);
      for (const p of [path.join(home, 'AGENTS.md'), path.join(home, 'HERMES.md')]) {
        const content = readText(p);
        if (content && content.trim()) {
          files.push({ path: p, name: path.basename(p), content, scopeHint: 'workspace', typeHint: 'rule', kind: 'instruction' });
        }
      }
      return { agent, files, skills: globalSkills(ctx) };
    }

    // Per-agent memory dir → that agent's private Brain.
    const entry = rosterEntries(ctx).find((e) => `hermes_agent:agent:${e.id}` === agent.externalId);
    if (entry?.memoryDir) {
      for (const p of listFiles(entry.memoryDir)) {
        const content = readText(p);
        if (!content || !content.trim()) continue;
        const { data, body } = parseFrontmatter(content);
        files.push({
          path: p,
          name: path.basename(p),
          content: body.trim() || content,
          scopeHint: 'agent',
          typeHint: (data.type || '').trim().toLowerCase() || null,
          kind: 'memory',
        });
      }
    }
    return { agent, files, skills: entry ? entrySkills(entry) : [] };
  },
};

function baseName(file: string): string {
  return path.basename(file).replace(/\.(md|mdc|markdown|txt)$/i, '').replace(/[-_]+/g, ' ');
}
function roleHint(data: Record<string, string>): string | null {
  const r = (data.role || '').trim().toLowerCase();
  return r === 'orchestrator' || r === 'manager' || r === 'worker' ? r : null;
}
function firstString(...values: Array<string | undefined>): string | undefined {
  return values.find((v) => typeof v === 'string' && v.trim().length > 0)?.trim();
}
