import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, isNull } from 'drizzle-orm';
import { schema } from '@agentis/db/sqlite';
import { SharedIntelligenceService } from '../../src/services/sharedIntelligence.js';
import { EpisodicMemoryStore } from '../../src/services/episodicMemoryStore.js';
import { StubEmbeddingProvider } from '../_helpers/stubEmbeddingProvider.js';
import { MemoryReflectionService } from '../../src/services/memory/memoryReflectionService.js';
import { BrainAskService } from '../../src/services/brain/brainAskService.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

let ctx: TestContext;
let brain: SharedIntelligenceService;
let episodes: EpisodicMemoryStore;

beforeEach(async () => {
  ctx = await createTestContext();
  episodes = new EpisodicMemoryStore(ctx.db, ctx.logger, new StubEmbeddingProvider());
  brain = new SharedIntelligenceService(ctx.db, ctx.bus, episodes, ctx.logger);
});
afterEach(() => ctx.close());

/** A scripted structured completer for the model-graded paths. */
function fakeCompleter(reply: Record<string, unknown> | null) {
  return { async completeStructured<T>(): Promise<T | null> { return reply as T | null; } };
}

function seedLesson(args: { runId: string; title: string; summary: string }) {
  return episodes.write({
    workspaceId: ctx.workspace.id,
    type: 'distilled_lesson',
    title: args.title,
    summary: args.summary,
    source: 'run_promotion',
    runId: args.runId,
    confidence: 0.7,
    importance: 0.6,
    trust: 0.7,
  });
}

describe('§C1 MemoryReflectionService — cross-session deduction', () => {
  it('derives a grounded generalization from a cluster spanning ≥2 runs', async () => {
    seedLesson({ runId: 'run-1', title: 'Slack export retry', summary: 'The Slack export endpoint rate limited the run; retrying with exponential backoff recovered it.' });
    seedLesson({ runId: 'run-2', title: 'Slack export throttle', summary: 'Slack export hit a rate limit again; exponential backoff retry succeeded after two attempts.' });

    const reflect = new MemoryReflectionService(ctx.db, brain, ctx.logger);
    reflect.setCompleter(fakeCompleter({
      statement: 'Slack export calls rate limit under load; retry with exponential backoff to recover.',
      title: 'Retry Slack export with backoff on rate limits',
      confidence: 0.82,
    }));

    const result = await reflect.run({ workspaceId: ctx.workspace.id });
    expect(result.generalizations).toBe(1);

    const generalizations = ctx.db.select().from(schema.memoryEpisodes)
      .where(and(eq(schema.memoryEpisodes.workspaceId, ctx.workspace.id)))
      .all()
      .filter((r) => (r.tags as string[]).includes('generalization'));
    expect(generalizations).toHaveLength(1);
    expect((generalizations[0]!.metadata as Record<string, unknown>).generalizedFrom).toHaveLength(2);
  });

  it('commits nothing without a model (never fabricates a rule)', async () => {
    seedLesson({ runId: 'run-1', title: 'Slack export retry', summary: 'Slack export rate limited; backoff retry recovered.' });
    seedLesson({ runId: 'run-2', title: 'Slack export throttle', summary: 'Slack export rate limited again; backoff retry recovered.' });
    const reflect = new MemoryReflectionService(ctx.db, brain, ctx.logger); // no completer
    const result = await reflect.run({ workspaceId: ctx.workspace.id });
    expect(result.generalizations).toBe(0);
  });

  it('drops an ungrounded generalization the model tried to invent', async () => {
    seedLesson({ runId: 'run-1', title: 'Cache warming', summary: 'Warming the cache before the batch reduced latency on the report job.' });
    seedLesson({ runId: 'run-2', title: 'Cache warming again', summary: 'Pre-warming the cache cut report latency on the nightly batch.' });
    const reflect = new MemoryReflectionService(ctx.db, brain, ctx.logger);
    reflect.setCompleter(fakeCompleter({ statement: 'Quarterly tax filings must be submitted before the regulatory deadline in each jurisdiction.', title: 'Unrelated invented rule', confidence: 0.9 }));
    const result = await reflect.run({ workspaceId: ctx.workspace.id });
    expect(result.generalizations).toBe(0); // grounding gate rejects it
  });
});

describe('§C6 procedural-skill flywheel', () => {
  it('proposes a reinforced procedural rule as an Ability draft', async () => {
    seedLesson({ runId: 'run-1', title: 'Smoke tests before deploy', summary: 'Skipping smoke tests before deploy let a regression through; smoke tests before deploy catch regressions.' });
    seedLesson({ runId: 'run-2', title: 'Smoke tests before deploy', summary: 'Running smoke tests before deploy caught a broken migration; smoke tests before deploy catch regressions.' });
    seedLesson({ runId: 'run-3', title: 'Smoke tests before deploy', summary: 'A deploy without smoke tests before deploy shipped a bug; smoke tests before deploy catch regressions.' });

    const proposals: Array<{ intent: string }> = [];
    const reflect = new MemoryReflectionService(ctx.db, brain, ctx.logger);
    reflect.setCompleter(fakeCompleter({ statement: 'Always run the smoke tests before deploying to catch regressions early.', title: 'Run smoke tests before deploy', confidence: 0.85 }));
    reflect.setSkillProposer((args) => { proposals.push({ intent: args.intent }); });

    const result = await reflect.run({ workspaceId: ctx.workspace.id });
    expect(result.generalizations).toBe(1);
    expect(result.skillsProposed).toBe(1);
    expect(proposals[0]!.intent).toMatch(/smoke tests/i);
  });
});

describe('§C3 contradiction discovery sweep', () => {
  it('flags topically-similar durable atoms with opposing directives', async () => {
    await brain.addAtom({ workspaceId: ctx.workspace.id, content: 'Always deploy the billing service during business hours for fast rollback.', title: 'Deploy billing in business hours', source: 'system_write', confidence: 0.8 });
    await brain.addAtom({ workspaceId: ctx.workspace.id, content: 'Never deploy the billing service during business hours; do it off-peak.', title: 'Do not deploy billing in business hours', source: 'system_write', confidence: 0.8 });

    const reflect = new MemoryReflectionService(ctx.db, brain, ctx.logger);
    const result = await reflect.run({ workspaceId: ctx.workspace.id });
    expect(result.contradictionsFlagged).toBeGreaterThanOrEqual(1);

    const contradicts = ctx.db.select().from(schema.knowledgeLinks)
      .where(and(eq(schema.knowledgeLinks.workspaceId, ctx.workspace.id), eq(schema.knowledgeLinks.relation, 'contradicts')))
      .all();
    expect(contradicts.length).toBeGreaterThanOrEqual(1);
  });
});

describe('§C2 sleep-time working-set cache', () => {
  it('rebuilds + reads a per-scope working set and serves it as a Tier-0 backfill', async () => {
    await brain.addAtom({ workspaceId: ctx.workspace.id, content: 'The deploy pipeline requires a green CI run on main before promotion.', title: 'Deploy needs green CI', source: 'system_write', confidence: 0.85 });
    const count = brain.rebuildWorkingSet(ctx.workspace.id, null);
    expect(count).toBeGreaterThanOrEqual(1);
    const ws = brain.getWorkingSet(ctx.workspace.id, null);
    expect(ws.map((a) => a.title)).toContain('Deploy needs green CI');

    // A query that lexically matches a working-set atom surfaces it as Tier-0.
    const dispatch = await brain.buildDispatchContext({ workspaceId: ctx.workspace.id, taskDescription: 'what does the deploy pipeline require for promotion?', limit: 8 });
    expect(dispatch.block).toMatch(/green CI/i);
  });
});

describe('§C7 privacy-scoped team brain (RLS)', () => {
  it('hides a private atom from a different requester, shows it to its owner, and shares shared atoms with all', async () => {
    const alicePrivate = await brain.addAtom({ workspaceId: ctx.workspace.id, scopeId: 'agent-alice', content: 'Alice keeps a private shortlist of preferred procurement vendors for her runs.', title: 'Alice private vendor shortlist', source: 'agent_write', confidence: 0.8, shared: false });

    // Owner sees her own private atom …
    const asAlice = await brain.searchAtoms({ workspaceId: ctx.workspace.id, scope: 'scoped', scopeId: 'agent-alice', requesterScopeId: 'agent-alice', query: 'preferred procurement vendors shortlist' });
    expect(asAlice.map((h) => h.id)).toContain(alicePrivate.id);

    // … a different requester does NOT, even querying her scope.
    const asBob = await brain.searchAtoms({ workspaceId: ctx.workspace.id, scope: 'scoped', scopeId: 'agent-alice', requesterScopeId: 'agent-bob', query: 'preferred procurement vendors shortlist' });
    expect(asBob.map((h) => h.id)).not.toContain(alicePrivate.id);

    // A SHARED atom is visible to everyone.
    const shared = await brain.addAtom({ workspaceId: ctx.workspace.id, content: 'The procurement team prefers vendors offering net-30 payment terms.', title: 'Procurement prefers net-30', source: 'system_write', confidence: 0.8 });
    const sharedAsBob = await brain.searchAtoms({ workspaceId: ctx.workspace.id, scope: 'workspace', requesterScopeId: 'agent-bob', query: 'procurement vendors net-30 terms' });
    expect(sharedAsBob.map((h) => h.id)).toContain(shared.id);
  });
});

describe('§C4 BrainAskService — cited recall with honest abstention', () => {
  it('abstains when nothing in memory grounds the question', async () => {
    const ask = new BrainAskService(brain, ctx.logger); // no completer
    const res = await ask.ask({ workspaceId: ctx.workspace.id, query: 'what is our policy on quantum cryptography procurement?' });
    expect(res.abstained).toBe(true);
    expect(res.citations).toHaveLength(0);
    expect(res.answer).toMatch(/don'?t have|nothing/i);
  });

  it('returns a cited answer grounded in real atoms', async () => {
    await brain.addAtom({ workspaceId: ctx.workspace.id, content: 'The Salesforce migration was deferred to Q3 pending the data-cleanup workstream.', title: 'Salesforce migration deferred to Q3', source: 'operator_write', confidence: 0.9, tags: ['salesforce'] });
    const ask = new BrainAskService(brain, ctx.logger); // deterministic cited list
    const res = await ask.ask({ workspaceId: ctx.workspace.id, query: 'what did we decide about the salesforce migration?' });
    expect(res.abstained).toBe(false);
    expect(res.citations.length).toBeGreaterThanOrEqual(1);
    expect(res.answer).toMatch(/\[mem:[0-9a-f]{8}\]/);
    expect(res.answer.toLowerCase()).toContain('salesforce');
  });
});
