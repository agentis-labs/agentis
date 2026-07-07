import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { schema } from '@agentis/db/sqlite';
import { SharedIntelligenceService } from '../../src/services/sharedIntelligence.js';
import { MemoryStore } from '../../src/services/memoryStore.js';
import { EpisodicMemoryStore } from '../../src/services/episodicMemoryStore.js';
import { SkillService } from '../../src/services/skillService.js';
import { SkillMaterializer } from '../../src/services/skillMaterializer.js';
import { StubEmbeddingProvider } from '../_helpers/stubEmbeddingProvider.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

let ctx: TestContext;
let skills: SkillService;
let materializer: SkillMaterializer;
let tmp: string;

beforeEach(async () => {
  ctx = await createTestContext();
  const episodes = new EpisodicMemoryStore(ctx.db, ctx.logger, new StubEmbeddingProvider());
  const brain = new SharedIntelligenceService(ctx.db, ctx.bus, episodes, ctx.logger);
  const memory = new MemoryStore(ctx.db, ctx.logger);
  memory.setEpisodicStore(episodes);
  skills = new SkillService(ctx.db, memory, brain, ctx.logger);
  materializer = new SkillMaterializer(skills, ctx.logger);
  tmp = mkdtempSync(path.join(os.tmpdir(), 'skillmat-'));
});

afterEach(() => { ctx.close(); rmSync(tmp, { recursive: true, force: true }); });

describe('SkillMaterializer', () => {
  it('writes SKILL.md for the scope union into <dir>/.claude/skills', () => {
    skills.upsertSkill({ workspaceId: ctx.workspace.id, scopeId: null, name: 'Global', description: 'g', body: '# global body' });
    skills.upsertSkill({ workspaceId: ctx.workspace.id, scopeId: 'agent-1', name: 'Agent One', description: 'a', body: '# agent body' });
    skills.upsertSkill({ workspaceId: ctx.workspace.id, scopeId: 'agent-9', name: 'Other', description: 'o', body: '# other' });

    const res = materializer.materializeInto(tmp, ctx.workspace.id, ['agent-1', null]);
    expect(res.materialized.map((s) => s.slug).sort()).toEqual(['agent-one', 'global']);

    const globalMd = path.join(tmp, '.claude', 'skills', 'global', 'SKILL.md');
    expect(existsSync(globalMd)).toBe(true);
    const content = readFileSync(globalMd, 'utf8');
    expect(content).toContain('name: Global');
    expect(content).toContain('# global body');
    // A skill for an unrelated scope is not materialized.
    expect(existsSync(path.join(tmp, '.claude', 'skills', 'other'))).toBe(false);
  });

  it('skips skills below the confidence floor (demoted skills drop out)', () => {
    const weak = skills.upsertSkill({ workspaceId: ctx.workspace.id, scopeId: null, name: 'Weak Skill', description: '', body: 'x' });
    ctx.db.update(schema.memoryEpisodes).set({ confidence: '0.1' }).where(eq(schema.memoryEpisodes.id, weak.id)).run();

    materializer.materializeInto(tmp, ctx.workspace.id, [null]);
    expect(existsSync(path.join(tmp, '.claude', 'skills', 'weak-skill'))).toBe(false);
  });

  it('prunes stale skills in a managed home dir', () => {
    const prev = process.env.AGENTIS_HARNESS_HOME;
    process.env.AGENTIS_HARNESS_HOME = tmp;
    try {
      const keep = skills.upsertSkill({ workspaceId: ctx.workspace.id, scopeId: 'agent-x', name: 'Keep', description: '', body: 'k' });
      const drop = skills.upsertSkill({ workspaceId: ctx.workspace.id, scopeId: 'agent-x', name: 'Drop', description: '', body: 'd' });

      const first = materializer.materializeForAgent(ctx.workspace.id, 'agent-x', null);
      const skillsDir = path.join(first.cwd, '.claude', 'skills');
      expect(existsSync(path.join(skillsDir, 'keep'))).toBe(true);
      expect(existsSync(path.join(skillsDir, 'drop'))).toBe(true);

      skills.deleteSkill(ctx.workspace.id, drop.id);
      materializer.materializeForAgent(ctx.workspace.id, 'agent-x', null);
      expect(existsSync(path.join(skillsDir, 'keep'))).toBe(true);
      expect(existsSync(path.join(skillsDir, 'drop'))).toBe(false); // pruned
      void keep;
    } finally {
      if (prev === undefined) delete process.env.AGENTIS_HARNESS_HOME;
      else process.env.AGENTIS_HARNESS_HOME = prev;
    }
  });
});
