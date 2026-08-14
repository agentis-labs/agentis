import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { schema } from '@agentis/db/sqlite';
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
  registerBrainTools(registry, {
    db: ctx.db,
    logger: ctx.logger,
    sharedIntelligence: brain,
    skills,
    memory,
  } as unknown as ToolHandlerDeps);
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
    expect(res.errorMessage).toMatch(/kind:"skill"/i);
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

describe('agentis.skill.create', () => {
  it('authors a new agent-scoped skill that is then loadable and above the materialize floor', async () => {
    const res = await registry.execute(
      {
        toolId: 'agentis.skill.create',
        arguments: {
          name: 'Onboard a WhatsApp lead',
          description: 'a new lead messages in on WhatsApp for the first time',
          body: '1. Greet.\n2. Capture name + intent.\n3. Route to the right app.',
        },
      },
      toolCtx('agent-42'),
    );
    expect(res.ok).toBe(true);
    const out = res.output as { skillId: string; slug: string; scope: string; replaced: boolean };
    expect(out.scope).toBe('agent');
    expect(out.replaced).toBe(false);
    expect(out.slug).toBe('onboard-a-whatsapp-lead');

    // Persisted with the authoring agent's scope and full body.
    const stored = skills.getSkill(ctx.workspace.id, out.skillId);
    expect(stored?.scopeId).toBe('agent-42');
    expect(stored?.body).toContain('Route to the right app');
    // Non-seed source ⇒ confidence 0.7, above the 0.3 materialize floor.
    expect(stored?.confidence ?? 0).toBeGreaterThanOrEqual(0.3);

    // Reachable through the on-demand loader for the same agent.
    const load = await registry.execute(
      { toolId: 'agentis.skill.load', arguments: { skill: 'onboard-a-whatsapp-lead' } },
      toolCtx('agent-42'),
    );
    expect(load.ok).toBe(true);
    expect((load.output as { name: string }).name).toBe('Onboard a WhatsApp lead');
  });

  it('is idempotent by slug within scope — re-creating updates and reports replaced', async () => {
    const first = await registry.execute(
      { toolId: 'agentis.skill.create', arguments: { name: 'Ship a release', description: 'cutting a release', body: 'v1 steps' } },
      toolCtx('agent-42'),
    );
    const second = await registry.execute(
      { toolId: 'agentis.skill.create', arguments: { name: 'Ship a release', description: 'cutting a release', body: 'v2 steps' } },
      toolCtx('agent-42'),
    );
    expect((second.output as { replaced: boolean }).replaced).toBe(true);
    expect((first.output as { skillId: string }).skillId).toBe((second.output as { skillId: string }).skillId);
    const stored = skills.getSkill(ctx.workspace.id, (second.output as { skillId: string }).skillId);
    expect(stored?.body).toBe('v2 steps');
  });

  it('scope:"workspace" shares the skill workspace-globally (null scope)', async () => {
    const res = await registry.execute(
      { toolId: 'agentis.skill.create', arguments: { name: 'Shared Skill', description: 'anyone can use this', body: 'steps', scope: 'workspace' } },
      toolCtx('agent-42'),
    );
    expect((res.output as { scope: string }).scope).toBe('workspace');
    const stored = skills.getSkill(ctx.workspace.id, (res.output as { skillId: string }).skillId);
    expect(stored?.scopeId).toBeNull();
    // A different agent can load a workspace-global skill.
    const load = await registry.execute({ toolId: 'agentis.skill.load', arguments: { skill: 'shared-skill' } }, toolCtx('someone-else'));
    expect(load.ok).toBe(true);
  });

  it('requires a body', async () => {
    const res = await registry.execute(
      { toolId: 'agentis.skill.create', arguments: { name: 'No body', description: 'x' } },
      toolCtx('agent-42'),
    );
    expect(res.ok).toBe(false);
    expect(res.errorCode).toBe('VALIDATION_FAILED');
  });
});

describe('specialist private Brain administration', () => {
  it('configures and verifies another specialist Brain idempotently', async () => {
    const agentId = randomUUID();
    ctx.db.insert(schema.agents).values({
      id: agentId,
      workspaceId: ctx.workspace.id,
      ambientId: ctx.ambient.id,
      userId: ctx.user.id,
      name: 'Prospector',
      adapterType: 'codex',
      capabilityTags: ['research'],
      config: {},
      status: 'online',
      role: 'prospector',
    }).run();

    const configure = () => registry.execute({
      toolId: 'agentis.agent.brain.configure',
      arguments: {
        agentId,
        memories: [{ title: 'ICP boundary', content: 'Only qualify companies with a verified service area.', kind: 'rule' }],
        skills: [{
          name: 'Qualify a prospect',
          description: 'Determine whether a prospect fits the ICP.',
          body: '1. Verify geography.\n2. Verify need.\n3. Record evidence.',
        }],
        examples: [{
          skill: 'qualify-a-prospect',
          input: 'A local clinic requests lead generation.',
          output: 'Qualified after geography and need are verified.',
        }],
      },
    }, toolCtx());

    const first = await configure();
    expect(first.ok).toBe(true);
    const firstVerification = (first.output as { verification: { counts: Record<string, number> } }).verification;
    expect(firstVerification.counts.memories).toBe(1);
    expect(firstVerification.counts.skills).toBe(1);
    expect(firstVerification.counts.examples).toBe(1);

    const second = await configure();
    expect(second.ok).toBe(true);
    const inspect = await registry.execute({
      toolId: 'agentis.agent.brain.inspect',
      arguments: { agentId },
    }, toolCtx());
    expect(inspect.ok).toBe(true);
    const counts = (inspect.output as { counts: Record<string, number> }).counts;
    expect(counts.memories).toBe(1);
    expect(counts.skills).toBe(1);
    expect(counts.examples).toBe(1);
  });

  it('rejects cross-workspace or missing specialist targets', async () => {
    const result = await registry.execute({
      toolId: 'agentis.agent.brain.configure',
      arguments: { agentId: randomUUID(), memories: [{ title: 'x', content: 'y' }] },
    }, toolCtx());
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe('RESOURCE_NOT_FOUND');
  });
});
