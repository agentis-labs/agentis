/**
 * SkillLibraryService — Layer 2 §2.5 behavioral skill protocols.
 *
 * Skills live as `.md` files in the Workspace Volume's `skills/` directory
 * (human-readable, AI-writable, git-versionable — Principle #11). Platform skills
 * are seeded on first use; operator edits to a skill file win over the shipped
 * default. At dispatch, an `agent_task`'s declared `skills` are resolved here and
 * injected into the prompt between the workspace context and the task.
 */

import { PLATFORM_SKILLS, skillByName, type SkillProtocol } from '@agentis/core';
import type { WorkspaceVolumeService } from './workspaceVolume.js';

const SKILLS_DIR = 'skills';

export class SkillLibraryService {
  constructor(private readonly volume: WorkspaceVolumeService) {}

  /** Seed the platform skill `.md` files into a workspace if they're missing. */
  async ensureSeeded(workspaceId: string): Promise<void> {
    for (const s of PLATFORM_SKILLS) {
      const rel = `${SKILLS_DIR}/${s.name}.md`;
      if (!(await this.volume.exists(workspaceId, rel))) {
        await this.volume.write(workspaceId, rel, serializeSkill(s));
      }
    }
  }

  /** Resolve a skill by name: Volume file first (operator edits win), then platform default. */
  async resolve(workspaceId: string, name: string): Promise<SkillProtocol | null> {
    const raw = await this.volume.read(workspaceId, `${SKILLS_DIR}/${name}.md`);
    if (raw != null) return parseSkill(name, raw);
    return skillByName(name) ?? null;
  }

  /** List all skills available in a workspace (seeds platform skills first). */
  async list(workspaceId: string): Promise<SkillProtocol[]> {
    await this.ensureSeeded(workspaceId);
    const entries = await this.volume.list(workspaceId, SKILLS_DIR);
    const out: SkillProtocol[] = [];
    for (const e of entries) {
      if (e.kind !== 'file' || !e.name.endsWith('.md')) continue;
      const raw = await this.volume.read(workspaceId, `${SKILLS_DIR}/${e.name}`);
      if (raw != null) out.push(parseSkill(e.name.replace(/\.md$/, ''), raw));
    }
    return out;
  }

  /**
   * Build the injected skill block for a set of skill names, trimmed to a token
   * budget (lowest-priority skills dropped first — input order is priority).
   */
  async buildSkillBlock(workspaceId: string, names: string[], tokenBudget = 1500): Promise<string> {
    if (!names.length) return '';
    const blocks: string[] = [];
    let budget = tokenBudget;
    for (const name of names) {
      const skill = await this.resolve(workspaceId, name);
      if (!skill) continue;
      const cost = Math.ceil(skill.body.length / 4);
      if (cost > budget) continue;
      budget -= cost;
      blocks.push(`<skill name="${skill.name}">\n${skill.body}\n</skill>`);
    }
    return blocks.join('\n\n');
  }
}

/** Serialize a skill to markdown with YAML frontmatter. */
function serializeSkill(s: SkillProtocol): string {
  return [
    '---',
    `name: ${s.name}`,
    `version: ${s.version}`,
    `applicableTo: [${s.applicableTo.join(', ')}]`,
    `tags: [${s.tags.join(', ')}]`,
    '---',
    '',
    s.body,
    '',
  ].join('\n');
}

/** Parse a skill `.md` file (YAML-ish frontmatter + body). Tolerant of hand edits. */
function parseSkill(name: string, raw: string): SkillProtocol {
  let version = '1.0.0';
  let applicableTo: string[] = [];
  let tags: string[] = [];
  let body = raw;

  const fm = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(raw);
  if (fm) {
    body = fm[2] ?? '';
    for (const line of (fm[1] ?? '').split('\n')) {
      const m = /^([A-Za-z_]+):\s*(.*)$/.exec(line.trim());
      if (!m) continue;
      const [, key, value] = m;
      if (key === 'version') version = value!.trim();
      else if (key === 'applicableTo') applicableTo = parseList(value!);
      else if (key === 'tags') tags = parseList(value!);
    }
  }
  return { name, version, applicableTo, tags, body: body.trim() };
}

function parseList(value: string): string[] {
  return value.replace(/^\[|\]$/g, '').split(',').map((s) => s.trim()).filter(Boolean);
}
