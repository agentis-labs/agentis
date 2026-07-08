/**
 * Claude Code import source (AGENT-TRANSITION §4).
 *
 * Claude Code keeps, on the local machine:
 *   - subagents:   ~/.claude/agents/*.md   and  <cwd>/.claude/agents/*.md
 *                  (each is a distinct agent persona → its own Agentis agent)
 *   - instructions: ~/.claude/CLAUDE.md     and  <cwd>/CLAUDE.md  (workspace)
 *   - real memory:  ~/.claude/projects/<slug>/memory/*.md
 *                   (structured fact files w/ frontmatter `type:` — the richest
 *                    source, which the legacy instruction-only reader misses)
 *
 * We surface ONE primary agent (the user's main Claude Code, owner of the
 * memory store) plus one agent per subagent file. Workspace knowledge imports
 * once, via the primary agent, so it is not duplicated across every subagent.
 */

import path from 'node:path';
import type { DiscoverCtx, DiscoveredAgent, HarnessImportSource, ImportInputs, ImportMemoryFile } from '../types.js';
import { claudeProjectSlug, deslugProject, isDir, listDirs, listFiles, parseFrontmatter, readText, scanSkills } from '../fsScan.js';
import type { ImportSkill } from '../types.js';

const EXTERNAL_PRIMARY = 'claude_code:primary';

function claudeHome(ctx: DiscoverCtx): string {
  return firstString(ctx.env.CLAUDE_CONFIG_DIR) ?? path.join(ctx.home, '.claude');
}

/** The operator's own skill dirs (auto) + marketplace plugin skills (opt-in). */
function discoverSkills(ctx: DiscoverCtx): ImportSkill[] {
  const home = claudeHome(ctx);
  const roots: Array<{ dir: string; origin: ImportSkill['origin'] }> = [
    { dir: path.join(home, 'skills'), origin: 'user' },
  ];
  if (ctx.cwd) roots.push({ dir: path.join(ctx.cwd, '.claude', 'skills'), origin: 'project' });
  // Marketplace plugin skills: ~/.claude/plugins/marketplaces/<mp>/external_plugins/<plugin>/skills
  const marketplaces = path.join(home, 'plugins', 'marketplaces');
  for (const mp of listDirs(marketplaces)) {
    const externalPlugins = path.join(marketplaces, mp, 'external_plugins');
    for (const plugin of listDirs(externalPlugins)) {
      roots.push({ dir: path.join(externalPlugins, plugin, 'skills'), origin: 'marketplace' });
    }
  }
  return scanSkills(roots);
}

/** Project memory dirs to harvest: the cwd's project if known, else all. */
function memoryDirs(ctx: DiscoverCtx): string[] {
  const projectsRoot = path.join(claudeHome(ctx), 'projects');
  if (!isDir(projectsRoot)) return [];
  if (ctx.cwd) {
    const dir = path.join(projectsRoot, claudeProjectSlug(ctx.cwd), 'memory');
    return isDir(dir) ? [dir] : [];
  }
  return listDirs(projectsRoot)
    .map((slug) => path.join(projectsRoot, slug, 'memory'))
    .filter(isDir);
}

function subagentFiles(ctx: DiscoverCtx): string[] {
  const files = [...listFiles(path.join(claudeHome(ctx), 'agents'))];
  if (ctx.cwd) files.push(...listFiles(path.join(ctx.cwd, '.claude', 'agents')));
  return files;
}

function countMemoryFiles(ctx: DiscoverCtx): number {
  let n = 0;
  for (const dir of memoryDirs(ctx)) {
    n += listFiles(dir).filter((f) => path.basename(f).toLowerCase() !== 'memory.md').length;
  }
  return n;
}

function countWorkspaceFiles(ctx: DiscoverCtx): number {
  let n = 0;
  if (readText(path.join(claudeHome(ctx), 'CLAUDE.md'))) n += 1;
  if (ctx.cwd && readText(path.join(ctx.cwd, 'CLAUDE.md'))) n += 1;
  return n;
}

export const claudeCodeSource: HarnessImportSource = {
  adapterType: 'claude_code',

  discover(ctx) {
    const agents: DiscoveredAgent[] = [];
    const home = claudeHome(ctx);

    // 1) The primary Claude Code agent — owner of the memory store + workspace
    //    instructions. Always surfaced when a Claude home exists.
    const homeInstructions = readText(path.join(home, 'CLAUDE.md'));
    const memoryCount = countMemoryFiles(ctx);
    const workspaceCount = countWorkspaceFiles(ctx);
    // Skills the operator owns (user/project) count toward the primary agent;
    // marketplace skills are opt-in so they don't pad the auto count.
    const ownSkills = discoverSkills(ctx).filter((s) => s.origin !== 'marketplace').length;
    // Content gate (B3): only surface the primary agent when there is real
    // substance to bring — never an empty Claude home.
    if (memoryCount > 0 || homeInstructions || workspaceCount > 0 || ownSkills > 0) {
      agents.push({
        adapterType: 'claude_code',
        externalId: EXTERNAL_PRIMARY,
        name: 'Claude Code',
        role: null,
        persona: homeInstructions ?? null,
        detectedModel: null,
        config: ctx.cwd ? { cwd: ctx.cwd } : {},
        origin: { harness: 'Claude Code', rootPath: home },
        summary: { memoryFiles: memoryCount, workspaceFiles: workspaceCount, agentFiles: 0, skills: ownSkills },
      });
    }

    // 2) One agent per subagent definition.
    for (const file of subagentFiles(ctx)) {
      const raw = readText(file);
      if (!raw) continue;
      const { data, body } = parseFrontmatter(raw);
      const name = data.name?.trim() || titleFromFile(file);
      agents.push({
        adapterType: 'claude_code',
        externalId: `claude_code:agent:${file}`,
        name,
        role: roleHint(data),
        persona: body.trim() || raw.trim(),
        detectedModel: data.model?.trim() || null,
        config: ctx.cwd ? { cwd: ctx.cwd } : {},
        origin: { harness: 'Claude Code', rootPath: file },
        summary: { memoryFiles: 0, workspaceFiles: 0, agentFiles: 1, skills: 0 },
      });
    }

    return agents;
  },

  read(agent, ctx): ImportInputs {
    const files: ImportMemoryFile[] = [];
    if (agent.externalId !== EXTERNAL_PRIMARY) {
      // Subagents contribute identity only (their persona becomes instructions);
      // workspace knowledge is imported once through the primary agent.
      return { agent, files, skills: [] };
    }

    const home = claudeHome(ctx);

    // Workspace instruction files.
    for (const p of [path.join(home, 'CLAUDE.md'), ctx.cwd ? path.join(ctx.cwd, 'CLAUDE.md') : null]) {
      if (!p) continue;
      const content = readText(p);
      if (content && content.trim()) {
        files.push({ path: p, name: path.basename(p), content, scopeHint: 'workspace', typeHint: 'rule', kind: 'instruction' });
      }
    }

    // Real memory stores — the structured fact files.
    for (const dir of memoryDirs(ctx)) {
      const project = deslugProject(path.basename(path.dirname(dir)));
      for (const p of listFiles(dir)) {
        if (path.basename(p).toLowerCase() === 'memory.md') continue; // index of pointers, not facts
        const content = readText(p);
        if (!content || !content.trim()) continue;
        const { data, body } = parseFrontmatter(content);
        const typeHint = (data.type || data.metadata_type || '').trim().toLowerCase() || null;
        files.push({
          path: p,
          name: path.basename(p),
          content: body.trim() || content,
          // D1: an imported agent's personal memory store is THAT agent's
          // accumulated knowledge → agent scope (visible on the agent).
          scopeHint: 'agent',
          typeHint,
          kind: 'memory',
        });
        void project;
      }
    }

    return { agent, files, skills: discoverSkills(ctx) };
  },
};

function titleFromFile(file: string): string {
  return path.basename(file).replace(/\.(md|mdc|markdown|txt)$/i, '').replace(/[-_]+/g, ' ').replace(/\b\w/g, (m) => m.toUpperCase());
}

function roleHint(data: Record<string, string>): string | null {
  const r = (data.role || '').trim().toLowerCase();
  if (r === 'orchestrator' || r === 'manager' || r === 'worker') return r;
  return null;
}

function firstString(...values: Array<string | undefined>): string | undefined {
  return values.find((v) => typeof v === 'string' && v.trim().length > 0)?.trim();
}
