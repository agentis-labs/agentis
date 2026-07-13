import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { schema } from '@agentis/db/sqlite';
import { SharedIntelligenceService } from '../../src/services/sharedIntelligence.js';
import { EpisodicMemoryStore } from '../../src/services/episodicMemoryStore.js';
import { MemoryStore } from '../../src/services/memory/memoryStore.js';
import { StubEmbeddingProvider } from '../_helpers/stubEmbeddingProvider.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

let ctx: TestContext;
let brain: SharedIntelligenceService;

beforeEach(async () => {
  ctx = await createTestContext();
  const episodes = new EpisodicMemoryStore(ctx.db, ctx.logger, new StubEmbeddingProvider());
  brain = new SharedIntelligenceService(ctx.db, ctx.bus, episodes, ctx.logger);
});

afterEach(() => ctx.close());

function lastAccessedAt(id: string): string | null {
  const row = ctx.db
    .select({ lastAccessedAt: schema.memoryEpisodes.lastAccessedAt })
    .from(schema.memoryEpisodes)
    .where(eq(schema.memoryEpisodes.id, id))
    .get();
  return row?.lastAccessedAt ?? null;
}

describe('SharedIntelligenceService — dispatch retrieval marks access', () => {
  it('bumps lastAccessedAt for episodes surfaced into a dispatch context', async () => {
    const atom = await brain.addAtom({
      workspaceId: ctx.workspace.id,
      content: 'Always deploy database migrations behind a reversible feature flag.',
      confidence: 0.92,
      source: 'system_write',
      tags: ['deployment'],
    });

    // Freshly written episodes have not been accessed yet.
    expect(lastAccessedAt(atom.id)).toBeNull();

    const dispatch = await brain.buildDispatchContext({
      workspaceId: ctx.workspace.id,
      taskDescription: 'How should we deploy database migrations safely?',
      limit: 8,
    });

    // The atom was injected into the dispatch block …
    expect(dispatch.atomIds).toContain(atom.id);
    expect(dispatch.block).toMatch(/reversible feature flag/i);
    // … and that injection counts as an access for adaptive forgetting.
    expect(lastAccessedAt(atom.id)).not.toBeNull();
  });

  it('recalls a stored memory with a missing embedding via lexical fallback (hybrid recall)', async () => {
    const atom = await brain.addAtom({
      workspaceId: ctx.workspace.id,
      content: 'My name is Robson Prado.',
      confidence: 1,
      source: 'operator_write',
    });
    // Simulate an operator-inserted / un-embedded / mixed-provider memory: strip the
    // vector so semantic scoring yields 0. Before the hybrid fix this atom was
    // invisible to agent recall even though the UI's lexical search found it.
    ctx.db.update(schema.memoryEpisodes)
      .set({ embedding: null, embeddingModel: null, embeddingDims: null })
      .where(eq(schema.memoryEpisodes.id, atom.id))
      .run();

    const hits = await brain.searchAtoms({
      workspaceId: ctx.workspace.id,
      query: "what's my name",
      scope: 'workspace',
      limit: 5,
    });
    expect(hits.some((h) => h.content.includes('Robson Prado'))).toBe(true);
  });

  it('honors an agent-scoped governing rule as constitutional for that agent only, regardless of query relevance', async () => {
    const memory = new MemoryStore(ctx.db, ctx.logger);
    const closerId = 'agent-closer';
    // A hard guardrail pinned to ONE specialist's mind (scopeId = agentId), the
    // way the orchestrator should persist a correction (kind:'rule').
    const ruleId = memory.write({
      workspaceId: ctx.workspace.id,
      scopeId: closerId,
      kind: 'rule',
      source: 'operator',
      title: 'Never answer as the store',
      content: 'The Closer must never draft or send a message as if it were the store. Outreach only, workflow-gated.',
      importance: 0.7,
    });

    // Dispatch for the Closer on a task that has NOTHING to do with the rule —
    // a query-relevance tier would never surface it; the constitutional tier must.
    const own = await brain.buildDispatchContext({
      workspaceId: ctx.workspace.id,
      agentId: closerId,
      scopeId: closerId,
      taskDescription: 'Summarize this month sales spreadsheet into three bullets.',
      limit: 8,
    });
    expect(own.atomIds).toContain(ruleId);
    expect(own.block).toMatch(/never answer as the store/i);

    // A DIFFERENT agent must not inherit another specialist's private guardrail.
    const other = await brain.buildDispatchContext({
      workspaceId: ctx.workspace.id,
      agentId: 'agent-other',
      scopeId: 'agent-other',
      taskDescription: 'Summarize this month sales spreadsheet into three bullets.',
      limit: 8,
    });
    expect(other.atomIds).not.toContain(ruleId);
  });

  it('does not touch episodes that are not surfaced', async () => {
    const surfaced = await brain.addAtom({
      workspaceId: ctx.workspace.id,
      content: 'Prefer feature flags for risky deploys.',
      confidence: 0.9,
      source: 'system_write',
    });
    const unrelated = await brain.addAtom({
      workspaceId: ctx.workspace.id,
      content: 'The quarterly marketing budget review happens in March.',
      confidence: 0.4,
      source: 'system_write',
    });

    await brain.buildDispatchContext({
      workspaceId: ctx.workspace.id,
      taskDescription: 'feature flags for risky deploys',
      limit: 2,
    });

    expect(lastAccessedAt(surfaced.id)).not.toBeNull();
    expect(lastAccessedAt(unrelated.id)).toBeNull();
  });
});
