import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { SharedIntelligenceService } from '../../src/services/sharedIntelligence.js';
import { MemoryStore } from '../../src/services/memory/memoryStore.js';
import { EpisodicMemoryStore } from '../../src/services/episodicMemoryStore.js';
import { StubEmbeddingProvider } from '../_helpers/stubEmbeddingProvider.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

let ctx: TestContext;
let brain: SharedIntelligenceService;
let memory: MemoryStore;

beforeEach(async () => {
  ctx = await createTestContext();
  const episodes = new EpisodicMemoryStore(ctx.db, ctx.logger, new StubEmbeddingProvider());
  brain = new SharedIntelligenceService(ctx.db, ctx.bus, episodes, ctx.logger);
  memory = new MemoryStore(ctx.db, ctx.logger);
  memory.setEpisodicStore(episodes);
});

afterEach(() => ctx.close());

describe('Skill-library plane (skill + example atom kinds)', () => {
  it('round-trips skill/example through MemoryStore on their own plane', () => {
    const skillId = memory.write({
      workspaceId: ctx.workspace.id,
      scopeId: null,
      kind: 'skill',
      source: 'operator',
      title: 'Deploy migrations safely',
      content: 'Run database migrations behind a reversible feature flag; verify rollback first.',
    });
    const exampleId = memory.write({
      workspaceId: ctx.workspace.id,
      scopeId: null,
      kind: 'example',
      source: 'operator',
      title: 'Example: guarded migration',
      content: 'Task: ship a schema change. Response: gate it behind a flag, migrate, verify, then flip.',
    });
    const ruleId = memory.write({
      workspaceId: ctx.workspace.id,
      scopeId: null,
      kind: 'rule',
      source: 'operator',
      title: 'Deploy rule',
      content: 'Always deploy risky changes behind a feature flag.',
    });

    // byId reconstructs the true kind for skill-library atoms.
    expect(memory.byId(ctx.workspace.id, skillId)?.kind).toBe('skill');
    expect(memory.byId(ctx.workspace.id, exampleId)?.kind).toBe('example');

    // The skill-library plane lists skill + example, and NOT workspace memory.
    const libIds = memory.list({ workspaceId: ctx.workspace.id, scopeId: null, plane: 'skill_library' }).map((m) => m.id);
    expect(libIds).toContain(skillId);
    expect(libIds).toContain(exampleId);
    expect(libIds).not.toContain(ruleId);

    // The workspace-memory plane lists the rule, and NOT skill/example.
    const memIds = memory.list({ workspaceId: ctx.workspace.id, scopeId: null }).map((m) => m.id);
    expect(memIds).toContain(ruleId);
    expect(memIds).not.toContain(skillId);
    expect(memIds).not.toContain(exampleId);
  });

  it('surfaces skill/example as distinct atom kinds in the brain graph', () => {
    memory.write({
      workspaceId: ctx.workspace.id, scopeId: null, kind: 'skill', source: 'operator',
      title: 'Skill: triage webhooks', content: 'Verify signatures before trusting a webhook payload.',
    });
    memory.write({
      workspaceId: ctx.workspace.id, scopeId: null, kind: 'example', source: 'operator',
      title: 'Example: bad signature', content: 'A mismatched HMAC → reject with 401.',
    });

    const graph = brain.getGraph(ctx.workspace.id, {});
    const kinds = new Set(graph.nodes.map((n) => n.atomKind));
    expect(kinds.has('skill')).toBe(true);
    expect(kinds.has('example')).toBe(true);
  });

  it('never force-injects skill/example into the dispatch context', async () => {
    const skillId = memory.write({
      workspaceId: ctx.workspace.id, scopeId: null, kind: 'skill', source: 'operator',
      title: 'Deploy migrations safely',
      content: 'Run database migrations behind a reversible feature flag; verify rollback first.',
    });
    const exampleId = memory.write({
      workspaceId: ctx.workspace.id, scopeId: null, kind: 'example', source: 'operator',
      title: 'Example: guarded migration',
      content: 'Migrate behind a feature flag, verify, then flip.',
    });
    // A governing rule is a positive control — it MUST be injected (constitutional tier).
    const ruleId = memory.write({
      workspaceId: ctx.workspace.id, scopeId: null, kind: 'rule', source: 'operator',
      title: 'Deploy rule', content: 'Always deploy database migrations behind a feature flag.',
    });

    const dispatch = await brain.buildDispatchContext({
      workspaceId: ctx.workspace.id,
      taskDescription: 'How should we deploy database migrations behind a feature flag?',
      limit: 10,
    });

    // The governing rule is present; the skill and its example are NOT — they are
    // reached on demand (search / materialization), never force-injected.
    expect(dispatch.atomIds).toContain(ruleId);
    expect(dispatch.atomIds).not.toContain(skillId);
    expect(dispatch.atomIds).not.toContain(exampleId);
  });
});
