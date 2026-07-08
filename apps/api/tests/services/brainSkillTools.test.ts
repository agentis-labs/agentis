import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import type { AgentisToolContext } from '@agentis/core';
import { AgentisToolRegistry } from '../../src/services/agentisToolRegistry.js';
import { registerBrainTools } from '../../src/services/agentisToolHandlers/brain.js';
import type { ToolHandlerDeps } from '../../src/services/agentisToolHandlers/deps.js';
import { SharedIntelligenceService } from '../../src/services/sharedIntelligence.js';
import { MemoryStore } from '../../src/services/memory/memoryStore.js';
import { EpisodicMemoryStore } from '../../src/services/episodicMemoryStore.js';
import { SkillService } from '../../src/services/skillService.js';
import { StubEmbeddingProvider } from '../_helpers/stubEmbeddingProvider.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

let ctx: TestContext;
let registry: AgentisToolRegistry;
let skills: SkillService;

function toolCtx(agentId: string | null = null): AgentisToolContext {
  return { workspaceId: ctx.workspace.id, agentId, caller: 'agent' } as unknown as AgentisToolContext;
}

beforeEach(async () => {
  ctx = await createTestContext();
  const episodes = new EpisodicMemoryStore(ctx.db, ctx.logger, new StubEmbeddingProvider());
  const brain = new SharedIntelligenceService(ctx.db, ctx.bus, episodes, ctx.logger);
  const memory = new MemoryStore(ctx.db, ctx.logger);
  memory.setEpisodicStore(episodes);
  skills = new SkillService(ctx.db, memory, brain, ctx.logger);
  registry = new AgentisToolRegistry({ logger: ctx.logger });
  registerBrainTools(registry, { logger: ctx.logger, sharedIntelligence: brain, skills } as unknown as ToolHandlerDeps);
});

afterEach(() => ctx.close());

describe('agentis.skill.load', () => {
  it('loads a skill full body by slug and by id', async () => {
    const created = skills.upsertSkill({
      workspaceId: ctx.workspace.id, scopeId: null,
      name: 'Deploy Migrations Safely', description: 'Gate migrations behind a flag.',
      body: '# Steps\n1. Flag it.\n2. Migrate.\n3. Verify.\n',
    });

    const bySlug = await registry.execute({ toolId: 'agentis.skill.load', arguments: { skill: 'deploy-migrations-safely' } }, toolCtx());
    expect(bySlug.ok).toBe(true);
    const out = bySlug.output as { name: string; body: string; slug: string };
    expect(out.name).toBe('Deploy Migrations Safely');
    expect(out.body).toContain('Migrate');

    const byId = await registry.execute({ toolId: 'agentis.skill.load', arguments: { skill: created.id } }, toolCtx());
    expect(byId.ok).toBe(true);
  });

  it('resolves an agent-scoped skill for that agent', async () => {
    skills.upsertSkill({ workspaceId: ctx.workspace.id, scopeId: 'agent-7', name: 'Private Skill', description: '', body: 'secret steps' });
    const res = await registry.execute({ toolId: 'agentis.skill.load', arguments: { skill: 'private-skill' } }, toolCtx('agent-7'));
    expect(res.ok).toBe(true);
    expect((res.output as { body: string }).body).toBe('secret steps');
  });

  it('returns a not-found error for an unknown skill', async () => {
    const res = await registry.execute({ toolId: 'agentis.skill.load', arguments: { skill: 'nope' } }, toolCtx());
    expect(res.ok).toBe(false);
    expect(res.errorCode).toBe('RESOURCE_NOT_FOUND');
  });
});

describe('agentis.brain.search', () => {
  it('executes and excludes the skill library by default', async () => {
    skills.upsertSkill({ workspaceId: ctx.workspace.id, scopeId: null, name: 'A Skill', description: 'about widgets', body: 'x' });
    const res = await registry.execute({ toolId: 'agentis.brain.search', arguments: { query: 'widgets' } }, toolCtx());
    expect(res.ok).toBe(true);
    const out = res.output as { count: number; results: Array<{ kind: string }> };
    // Default search never surfaces skill-library atoms.
    expect(out.results.every((r) => r.kind !== 'skill' && r.kind !== 'example')).toBe(true);
  });

  it('validates that query is required', async () => {
    const res = await registry.execute({ toolId: 'agentis.brain.search', arguments: {} }, toolCtx());
    expect(res.ok).toBe(false);
    expect(res.errorCode).toBe('VALIDATION_FAILED');
  });
});
