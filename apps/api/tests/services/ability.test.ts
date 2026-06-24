/**
 * AbilityService + AbilityCompilerService — workspace-scoped behavioral
 * specialization units (docs/brain/ABILITIES.md).
 *
 * Covers the happy path: create → add examples + knowledge → compile (with no
 * LLM wired; uses the deterministic-persona fallback) → semantic scoring on
 * dispatch → context-block rendering → import/export round-trip.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { AbilityService } from '../../src/services/abilityService.js';
import { AbilityCompilerService } from '../../src/services/abilityCompilerService.js';
import { StubEmbeddingProvider } from '../_helpers/stubEmbeddingProvider.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';
import { schema } from '@agentis/db/sqlite';
import { eq } from 'drizzle-orm';

interface FakeSharedIntelligence {
  embeddingProvider(workspaceId: string): StubEmbeddingProvider;
}

let ctx: TestContext;
let abilities: AbilityService;
let compiler: AbilityCompilerService;
const provider = new StubEmbeddingProvider();
const fakeIntelligence: FakeSharedIntelligence = {
  embeddingProvider: () => provider,
};

beforeEach(async () => {
  ctx = await createTestContext();
  abilities = new AbilityService(ctx.db, ctx.logger);
  compiler = new AbilityCompilerService({
    db: ctx.db,
    logger: ctx.logger,
    abilities,
    // SharedIntelligence is shape-compatible — only embeddingProvider() is used.
    intelligence: fakeIntelligence as unknown as Parameters<typeof AbilityCompilerService.prototype['compile']>[0] extends never ? never : never,
    llm: undefined,
  } as unknown as ConstructorParameters<typeof AbilityCompilerService>[0]);
});

afterEach(() => {
  ctx.close();
});

describe('AbilityService', () => {
  it('creates, lists, updates, and deletes an ability', () => {
    const created = abilities.create({
      workspaceId: ctx.workspace.id,
      name: 'Senior UI Engineer',
      domainTag: 'ui_engineering',
      description: 'React + Tailwind specialist',
      rulesAlways: ['Use semantic HTML'],
      rulesNever: ['Inline styles'],
      specs: { stack: 'React 19 + TypeScript 5.5' },
    });
    expect(created.id).toBeDefined();
    expect(created.slug).toBe('senior-ui-engineer');
    expect(created.compileStatus).toBe('pending');

    const all = abilities.list(ctx.workspace.id);
    expect(all).toHaveLength(1);

    abilities.update(created.id, { description: 'Updated description' });
    const reread = abilities.get(created.id);
    expect(reread.description).toBe('Updated description');

    abilities.delete(created.id);
    expect(abilities.list(ctx.workspace.id)).toHaveLength(0);
  });

  it('rejects duplicate slugs in the same workspace', () => {
    abilities.create({ workspaceId: ctx.workspace.id, name: 'React Expert' });
    expect(() => abilities.create({ workspaceId: ctx.workspace.id, name: 'React Expert' }))
      .toThrowError(/already exists/);
  });

  it('tracks example + knowledge counts and marks ability dirty after compile', async () => {
    const ability = abilities.create({
      workspaceId: ctx.workspace.id,
      name: 'Data Analyst',
      domainTag: 'data_analysis',
      description: 'pandas + SQL specialist',
    });
    abilities.addExample(ability.id, {
      inputText: 'Summarize sales by region',
      outputText: 'SELECT region, SUM(amount) ...',
      qualityScore: 0.9,
    });
    abilities.addKnowledge(ability.id, {
      title: 'pandas idioms',
      content: 'Use groupby().agg() instead of apply() for performance.',
      importanceScore: 0.8,
    });
    let reloaded = abilities.get(ability.id);
    expect(reloaded.exampleCount).toBe(1);
    expect(reloaded.knowledgeCount).toBe(1);

    await compiler.compile(ability.id, ctx.workspace.id);
    reloaded = abilities.get(ability.id);
    expect(reloaded.compileStatus).toBe('ready');
    expect(reloaded.compiledPrompt).toBeTruthy();
    expect(reloaded.domainEmbedding).toHaveLength(provider.dimension);

    // After compile, mutating behavior must mark dirty.
    abilities.update(ability.id, { description: 'changed' });
    reloaded = abilities.get(ability.id);
    expect(reloaded.compileStatus).toBe('dirty');
  });

  it('compiles, scores against a task, and builds an XML context block', async () => {
    const ui = abilities.create({
      workspaceId: ctx.workspace.id,
      name: 'React UI Expert',
      domainTag: 'ui_engineering',
      description: 'React + Tailwind component specialist',
      rulesAlways: ['Use semantic HTML', 'Type props with interfaces'],
      rulesNever: ['Inline styles'],
      specs: { stack: 'React + Tailwind' },
    });
    const legal = abilities.create({
      workspaceId: ctx.workspace.id,
      name: 'Legal Reviewer',
      domainTag: 'legal',
      description: 'Contract review specialist',
      rulesAlways: ['Flag indemnity clauses'],
    });
    abilities.addExample(ui.id, {
      inputText: 'Build a responsive React pricing table',
      outputText: 'Here is a Tailwind grid with three tiers ...',
      qualityScore: 0.95,
    });
    abilities.addKnowledge(ui.id, {
      title: 'Tailwind grid system',
      content: '8px base unit. Use grid-cols-1 md:grid-cols-3 for responsive layouts.',
      importanceScore: 0.9,
    });

    await compiler.compile(ui.id, ctx.workspace.id);
    await compiler.compile(legal.id, ctx.workspace.id);

    // The semantic scorer should rank the UI ability higher for a UI task.
    const taskEmbedding = await provider.embed('Build a responsive React pricing component with Tailwind');
    const scored = abilities.scoreAbilitiesForTask(ctx.workspace.id, taskEmbedding);
    expect(scored.length).toBe(2);
    expect(scored[0]!.ability.id).toBe(ui.id);
    expect(scored[0]!.score).toBeGreaterThan(scored[1]!.score);

    const block = await abilities.buildContextBlock({
      abilityId: ui.id,
      task: 'Build a responsive React pricing component with Tailwind',
      taskEmbedding,
      provider,
      tokenBudget: 2000,
    });
    expect(block).not.toBeNull();
    expect(block!.xml).toContain('<ability');
    expect(block!.xml).toContain('React UI Expert');
    expect(block!.xml).toContain('<persona>');
    expect(block!.xml).toContain('<rules>');
    expect(block!.xml).toContain('ALWAYS');
    expect(block!.xml).toContain('Use semantic HTML');
    expect(block!.tokens).toBeGreaterThan(0);
  });

  it('round-trips an ability through export / import', async () => {
    const ability = abilities.create({
      workspaceId: ctx.workspace.id,
      name: 'API Architect',
      domainTag: 'backend_engineering',
      description: 'Node.js REST API specialist',
      rulesAlways: ['Validate inputs with zod'],
      specs: { framework: 'Hono' },
    });
    abilities.addExample(ability.id, {
      inputText: 'Design a /users endpoint',
      outputText: 'GET /users returns paginated users ...',
      qualityScore: 0.85,
    });
    await compiler.compile(ability.id, ctx.workspace.id);
    const pkg = abilities.export(ability.id);
    expect(pkg.format_version).toBe('1.0');
    expect(pkg.manifest.name).toBe('API Architect');
    expect(pkg.examples).toHaveLength(1);

    // Second workspace — create a peer user so we can import into a fresh space.
    const ws2Id = randomUUID();
    ctx.db.insert(schema.workspaces).values({
      id: ws2Id,
      userId: ctx.user.id,
      name: 'Other workspace',
      slug: 'other',
    }).run();
    const imported = abilities.importPackage({
      workspaceId: ws2Id,
      pkg,
      authorId: ctx.user.id,
    });
    expect(imported.workspaceId).toBe(ws2Id);
    expect(imported.compileStatus).toBe('pending');
    const importedExamples = abilities.listExamples(imported.id);
    expect(importedExamples).toHaveLength(1);
  });

  it('manages pins per agent', () => {
    const ability = abilities.create({
      workspaceId: ctx.workspace.id,
      name: 'Pinned Ability',
      domainTag: 'custom',
    });
    const agentId = randomUUID();
    ctx.db.insert(schema.agents).values({
      id: agentId,
      workspaceId: ctx.workspace.id,
      userId: ctx.user.id,
      ambientId: ctx.ambient.id,
      name: 'Test agent',
      slug: `test-${agentId.slice(0, 8)}`,
      capabilityTags: [] as unknown as string[],
      status: 'online',
      protocol: 'http_post',
      adapterType: 'hermes',
      transport: {} as unknown as Record<string, unknown>,
    }).run();
    const pin = abilities.pinAbility(agentId, ability.id);
    expect(pin.enabled).toBe(true);
    expect(abilities.listPinsForAgent(agentId)).toHaveLength(1);
    abilities.setPinEnabled(agentId, ability.id, false);
    expect(abilities.listPinsForAgent(agentId)[0]!.enabled).toBe(false);
    abilities.unpinAbility(agentId, ability.id);
    expect(abilities.listPinsForAgent(agentId)).toHaveLength(0);
  });

  it('publishes a synthetic KB chunk on compile for workspace-Brain visibility', async () => {
    const ability = abilities.create({
      workspaceId: ctx.workspace.id,
      name: 'Brain Visible Ability',
      domainTag: 'research',
      description: 'For testing Brain integration',
    });
    await compiler.compile(ability.id, ctx.workspace.id);
    const reloaded = abilities.get(ability.id);
    expect(reloaded.kbDocumentId).toBeTruthy();
    const kbRow = ctx.db.select().from(schema.knowledgeChunks)
      .where(eq(schema.knowledgeChunks.id, reloaded.kbDocumentId!))
      .get();
    expect(kbRow).toBeTruthy();
    expect(kbRow?.title).toContain('Brain Visible Ability');
  });
});
