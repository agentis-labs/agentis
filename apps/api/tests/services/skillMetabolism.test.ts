import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { SharedIntelligenceService } from '../../src/services/sharedIntelligence.js';
import { MemoryStore } from '../../src/services/memoryStore.js';
import { EpisodicMemoryStore } from '../../src/services/episodicMemoryStore.js';
import { SkillService } from '../../src/services/skillService.js';
import { StubEmbeddingProvider } from '../_helpers/stubEmbeddingProvider.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

let ctx: TestContext;
let brain: SharedIntelligenceService;
let memory: MemoryStore;
let skills: SkillService;

beforeEach(async () => {
  ctx = await createTestContext();
  const episodes = new EpisodicMemoryStore(ctx.db, ctx.logger, new StubEmbeddingProvider());
  brain = new SharedIntelligenceService(ctx.db, ctx.bus, episodes, ctx.logger);
  memory = new MemoryStore(ctx.db, ctx.logger);
  memory.setEpisodicStore(episodes);
  skills = new SkillService(ctx.db, memory, brain, ctx.logger);
});

afterEach(() => ctx.close());

describe('Living Skills metabolism', () => {
  it('drops a skill\'s confidence when a run that used it fails (via the verdict seam)', () => {
    const skill = skills.upsertSkill({ workspaceId: ctx.workspace.id, scopeId: null, name: 'Risky Skill', description: '', body: 'do it' });
    const before = skills.getSkill(ctx.workspace.id, skill.id)!.confidence;

    // The agent loaded the skill during run r1 …
    skills.recordUsage({ workspaceId: ctx.workspace.id, skillId: skill.id, runId: 'run-1', agentId: 'agent-1' });
    // … and that run was judged a failure.
    brain.applyEvaluatorVerdict({ workspaceId: ctx.workspace.id, runId: 'run-1', verdict: 'fail' });

    const after = skills.getSkill(ctx.workspace.id, skill.id)!.confidence;
    expect(after).toBeLessThan(before);
  });

  it('raises confidence on a passing run that used the skill', () => {
    const skill = skills.upsertSkill({ workspaceId: ctx.workspace.id, scopeId: null, name: 'Good Skill', description: '', body: 'do it well' });
    const before = skills.getSkill(ctx.workspace.id, skill.id)!.confidence;
    skills.recordUsage({ workspaceId: ctx.workspace.id, skillId: skill.id, runId: 'run-2' });
    brain.applyEvaluatorVerdict({ workspaceId: ctx.workspace.id, runId: 'run-2', verdict: 'pass', evaluatorConfidence: 0.9 });
    const after = skills.getSkill(ctx.workspace.id, skill.id)!.confidence;
    expect(after).toBeGreaterThan(before);
  });

  it('promotes a worked pair into a linked example that rides along on load', () => {
    const skill = skills.upsertSkill({ workspaceId: ctx.workspace.id, scopeId: null, name: 'Teachable', description: '', body: 'steps' });
    const exampleId = skills.promoteExample({ workspaceId: ctx.workspace.id, skillId: skill.id, inputText: 'add a column', outputText: 'flag, migrate, verify, flip' });
    expect(exampleId).toBeTruthy();

    const linked = skills.listLinkedExamples(ctx.workspace.id, skill.id);
    expect(linked).toHaveLength(1);
    expect(linked[0]!.content).toContain('flag, migrate, verify, flip');
  });

  it('links a run\'s failure lesson onto the skills that were active in it', () => {
    const skill = skills.upsertSkill({ workspaceId: ctx.workspace.id, scopeId: null, name: 'In Play', description: '', body: 'x' });
    const idle = skills.upsertSkill({ workspaceId: ctx.workspace.id, scopeId: null, name: 'Not In Play', description: '', body: 'y' });

    skills.recordUsage({ workspaceId: ctx.workspace.id, skillId: skill.id, runId: 'run-3' });
    const lessonId = memory.write({
      workspaceId: ctx.workspace.id, scopeId: null, kind: 'lesson', source: 'system',
      title: 'Watch out', content: 'This class of task tends to fail on step 2.',
    });

    const linkedCount = skills.linkLessonToRunSkills(ctx.workspace.id, 'run-3', lessonId);
    expect(linkedCount).toBe(1);
    expect(skills.listLinkedLessons(ctx.workspace.id, skill.id)).toHaveLength(1);
    expect(skills.listLinkedLessons(ctx.workspace.id, idle.id)).toHaveLength(0);
  });
});
