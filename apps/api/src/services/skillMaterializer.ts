/**
 * SkillMaterializer — projects Brain `skill` atoms to real `SKILL.md` files on
 * disk so a CLI harness (Claude Code, etc.) loads them NATIVELY via its own
 * progressive-disclosure skill loader. We inject nothing into the prompt; the
 * file on disk IS the mechanism (Living Skills, Observation A).
 *
 * Layout: `<dir>/.claude/skills/<slug>/SKILL.md` — the standard Claude-skills
 * location, resolved relative to the harness cwd. The materialized set is the
 * agent's own scoped skills ∪ workspace-global skills, above a confidence floor
 * (proven-bad skills, demoted by the feedback loop, drop out).
 *
 * In an Agentis-managed dir (the per-agent harness home) stale slugs are pruned
 * so a deleted/demoted skill disappears. In a real project cwd we NEVER prune —
 * we only write our own slugs so we can't clobber a user's `.claude/skills`.
 */

import { mkdirSync, writeFileSync, rmSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import type { Logger } from '../logger.js';
import { harnessAgentHomeDir } from './harness/harnessAgentHome.js';
import { serializeSkillMarkdown, type SkillRecord, type SkillService } from './skillService.js';

/** Skills below this confidence are not materialized (demoted/unproven). */
export const MIN_MATERIALIZE_CONFIDENCE = 0.3;

export interface MaterializeResult {
  /** The cwd the harness should use so it finds these skills. */
  cwd: string;
  /** Skills written to disk (their ids feed the feedback loop as "available"). */
  materialized: SkillRecord[];
}

export class SkillMaterializer {
  constructor(
    private readonly skills: SkillService,
    private readonly logger: Logger,
  ) {}

  /**
   * Materialize an agent's skills into the effective harness cwd.
   * - `explicitCwd` set (a real project): write there, no pruning, and keep it
   *   as the cwd.
   * - unset: use the Agentis-managed per-agent home as the cwd (the documented
   *   harnessAgentHome design) and prune stale slugs.
   */
  materializeForAgent(workspaceId: string, agentId: string, explicitCwd?: string | null): MaterializeResult {
    const managed = !explicitCwd;
    const cwd = explicitCwd || harnessAgentHomeDir(agentId);
    const skills = this.skills
      .listForScopes(workspaceId, [agentId, null], MIN_MATERIALIZE_CONFIDENCE);
    this.#write(cwd, skills, managed, { workspaceId, agentId });
    return { cwd, materialized: skills };
  }

  /**
   * Materialize a scope union into an arbitrary directory (e.g. a swarm
   * worktree). Never prunes — the caller owns the directory's lifecycle.
   */
  materializeInto(dir: string, workspaceId: string, scopeIds: Array<string | null>): MaterializeResult {
    const skills = this.skills.listForScopes(workspaceId, scopeIds, MIN_MATERIALIZE_CONFIDENCE);
    this.#write(dir, skills, false, { workspaceId, agentId: null });
    return { cwd: dir, materialized: skills };
  }

  #write(cwd: string, skills: SkillRecord[], prune: boolean, ctx: { workspaceId: string; agentId: string | null }): void {
    try {
      const skillsRoot = path.join(cwd, '.claude', 'skills');
      const wanted = new Set(skills.map((s) => s.slug));
      if (prune && existsSync(skillsRoot)) {
        for (const entry of readdirSync(skillsRoot, { withFileTypes: true })) {
          if (entry.isDirectory() && !wanted.has(entry.name)) {
            rmSync(path.join(skillsRoot, entry.name), { recursive: true, force: true });
          }
        }
      }
      for (const skill of skills) {
        const dir = path.join(skillsRoot, skill.slug);
        mkdirSync(dir, { recursive: true });
        writeFileSync(path.join(dir, 'SKILL.md'), serializeSkillMarkdown(skill), 'utf8');
      }
      if (skills.length > 0) {
        this.logger.info('skill.materialized', { ...ctx, count: skills.length, cwd });
      }
    } catch (err) {
      // Materialization is best-effort: a disk hiccup must never block a dispatch.
      this.logger.warn('skill.materialize_failed', { ...ctx, cwd, message: (err as Error).message });
    }
  }
}
