import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { SharedIntelligenceService } from '../../src/services/sharedIntelligence.js';
import { MemoryStore } from '../../src/services/memoryStore.js';
import { EpisodicMemoryStore } from '../../src/services/episodicMemoryStore.js';
import { SkillService, parseSkillMarkdown, serializeSkillMarkdown } from '../../src/services/skillService.js';
import { StubEmbeddingProvider } from '../_helpers/stubEmbeddingProvider.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

let ctx: TestContext;
let skills: SkillService;

beforeEach(async () => {
  ctx = await createTestContext();
  const episodes = new EpisodicMemoryStore(ctx.db, ctx.logger, new StubEmbeddingProvider());
  const brain = new SharedIntelligenceService(ctx.db, ctx.bus, episodes, ctx.logger);
  const memory = new MemoryStore(ctx.db, ctx.logger);
  memory.setEpisodicStore(episodes);
  skills = new SkillService(ctx.db, memory, brain, ctx.logger);
});

afterEach(() => ctx.close());

describe('SkillService + SKILL.md round-trip', () => {
  it('parses and re-serializes a SKILL.md without losing fields', () => {
    const raw = [
      '---',
      'name: Stripe Webhook Triage',
      'description: "Verify signatures before trusting a webhook payload."',
      '---',
      '',
      '# Procedure',
      '',
      '1. Recompute the HMAC.',
      '2. Reject on mismatch with 401.',
      '',
    ].join('\n');

    const parsed = parseSkillMarkdown(raw);
    expect(parsed.name).toBe('Stripe Webhook Triage');
    expect(parsed.description).toBe('Verify signatures before trusting a webhook payload.');
    expect(parsed.body).toContain('Recompute the HMAC');

    const reparsed = parseSkillMarkdown(serializeSkillMarkdown(parsed));
    expect(reparsed.name).toBe(parsed.name);
    expect(reparsed.description).toBe(parsed.description);
    expect(reparsed.body).toBe(parsed.body);
  });

  it('falls back to a heading when there is no frontmatter', () => {
    const parsed = parseSkillMarkdown('# Deploy Runbook\n\nDo the thing.');
    expect(parsed.name).toBe('Deploy Runbook');
    expect(parsed.description).toBe('');
    expect(parsed.body).toContain('Do the thing');
  });

  it('creates a skill atom whose body is the SKILL.md procedure', () => {
    const skill = skills.upsertSkill({
      workspaceId: ctx.workspace.id,
      scopeId: null,
      name: 'Deploy migrations safely',
      description: 'Gate migrations behind a reversible flag.',
      body: '# Steps\n1. Flag it.\n2. Migrate.\n3. Verify.\n',
    });
    const fetched = skills.getSkill(ctx.workspace.id, skill.id);
    expect(fetched?.description).toBe('Gate migrations behind a reversible flag.');
    expect(fetched?.body).toContain('Migrate');
    expect(fetched?.slug).toBe('deploy-migrations-safely');
  });

  it('upserts by slug within a scope (idempotent import), not duplicating', () => {
    const first = skills.upsertSkill({
      workspaceId: ctx.workspace.id, scopeId: 'agent-1', name: 'Triage', description: 'v1', body: 'old',
    });
    const second = skills.upsertSkill({
      workspaceId: ctx.workspace.id, scopeId: 'agent-1', name: 'Triage', description: 'v2', body: 'new',
    });
    expect(second.id).toBe(first.id);
    expect(skills.getSkill(ctx.workspace.id, first.id)?.body).toBe('new');
    // A different scope is a distinct skill even with the same name.
    const other = skills.upsertSkill({
      workspaceId: ctx.workspace.id, scopeId: 'agent-2', name: 'Triage', description: 'x', body: 'y',
    });
    expect(other.id).not.toBe(first.id);
  });

  it('lists skills for the scope union (agent ∪ workspace-global)', () => {
    skills.upsertSkill({ workspaceId: ctx.workspace.id, scopeId: null, name: 'Global skill', description: '', body: 'g' });
    skills.upsertSkill({ workspaceId: ctx.workspace.id, scopeId: 'agent-1', name: 'Agent skill', description: '', body: 'a' });
    skills.upsertSkill({ workspaceId: ctx.workspace.id, scopeId: 'agent-9', name: 'Other agent skill', description: '', body: 'o' });

    const forAgent1 = skills.listForScopes(ctx.workspace.id, ['agent-1', null]).map((s) => s.name).sort();
    expect(forAgent1).toEqual(['Agent skill', 'Global skill']);
    expect(forAgent1).not.toContain('Other agent skill');
  });
});
