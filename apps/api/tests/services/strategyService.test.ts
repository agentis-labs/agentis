/**
 * StrategyService + the Experiment→Strategy bridge (Evolution Loop MEASURE→LEARN).
 *
 * Invariants:
 *  - a recorded A/B outcome flows into the strategy for that arm (the bridge);
 *  - confidence is OUTCOME-weighted and sample-aware (Laplace), not recurrence;
 *  - a promoted strategy is mirrored as a recallable App-Brain atom.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { schema } from '@agentis/db/sqlite';
import { AppStore } from '@agentis/app';
import { SharedIntelligenceService } from '../../src/services/sharedIntelligence.js';
import { EpisodicMemoryStore } from '../../src/services/episodicMemoryStore.js';
import { StrategyService, strategyConfidence } from '../../src/services/app/strategyService.js';
import { ExperimentService } from '../../src/services/experiments.js';
import { StubEmbeddingProvider } from '../_helpers/stubEmbeddingProvider.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

let ctx: TestContext;
let strategies: StrategyService;
let experiments: ExperimentService;
let appId: string;

beforeEach(async () => {
  ctx = await createTestContext();
  const episodes = new EpisodicMemoryStore(ctx.db, ctx.logger, new StubEmbeddingProvider());
  const brain = new SharedIntelligenceService(ctx.db, ctx.bus, episodes, ctx.logger);
  strategies = new StrategyService({ db: ctx.db, shared: brain, logger: ctx.logger });
  experiments = new ExperimentService(ctx.db, (evt) => { void strategies.recordExperimentOutcome(evt); });
  appId = new AppStore(ctx.db).create(ctx.workspace.id, ctx.user.id, { name: 'Outreach', description: 'x' }).id;
});
afterEach(() => ctx.close());

describe('strategyConfidence (Laplace, sample-aware)', () => {
  it('untried is 0.5 and does not overclaim on tiny samples', () => {
    expect(strategyConfidence(0, 0)).toBeCloseTo(0.5);
    expect(strategyConfidence(1, 1)).toBeLessThan(0.7); // 2/3, not 1.0
    expect(strategyConfidence(50, 50)).toBeGreaterThan(strategyConfidence(1, 1));
  });
});

describe('StrategyService', () => {
  it('proposes idempotently and lists best-first', () => {
    strategies.propose({ workspaceId: ctx.workspace.id, appId, key: 'a', hypothesis: 'open with a question', experimentKey: 'first_msg', variant: 'A' });
    strategies.propose({ workspaceId: ctx.workspace.id, appId, key: 'a', hypothesis: 'open with a question (v2)', experimentKey: 'first_msg', variant: 'A' });
    const list = strategies.list(ctx.workspace.id, appId);
    expect(list.length).toBe(1);
    expect(list[0]!.hypothesis).toContain('v2');
  });

  it('bridges recorded A/B outcomes into the matching strategy, outcome-weighted', () => {
    strategies.propose({ workspaceId: ctx.workspace.id, appId, key: 'a', hypothesis: 'ask', experimentKey: 'first_msg', variant: 'A' });
    strategies.propose({ workspaceId: ctx.workspace.id, appId, key: 'b', hypothesis: 'demo', experimentKey: 'first_msg', variant: 'B' });
    experiments.define({ workspaceId: ctx.workspace.id, appId, key: 'first_msg', variants: ['A', 'B'] });

    // Route 6 subjects; force outcomes per arm by recording explicitly.
    const winA = ['s1', 's2', 's3'];
    const loseB = ['s4', 's5', 's6'];
    for (const s of winA) { experiments.assign({ workspaceId: ctx.workspace.id, key: 'first_msg', subjectKey: s }); }
    for (const s of loseB) { experiments.assign({ workspaceId: ctx.workspace.id, key: 'first_msg', subjectKey: s }); }
    // Record outcomes directly against each subject's actual assigned arm.
    const results0 = experiments.results(ctx.workspace.id, 'first_msg')!;
    void results0;
    // Drive deterministic outcomes: mark every subject in arm A as won, arm B as lost.
    const rows = ctx.db.select().from(schema.experimentAssignments).all();
    for (const r of rows) {
      experiments.record({ workspaceId: ctx.workspace.id, key: 'first_msg', subjectKey: r.subjectKey, outcome: r.variant === 'A' ? 'won' : 'lost' });
    }

    const a = strategies.get(ctx.workspace.id, appId, 'a')!;
    const b = strategies.get(ctx.workspace.id, appId, 'b')!;
    expect(a.trials).toBeGreaterThan(0);
    expect(b.trials).toBeGreaterThan(0);
    expect(a.winRate).toBe(1);
    expect(b.winRate).toBe(0);
    expect(a.confidence).toBeGreaterThan(b.confidence);
  });

  it('promotes a winner and mirrors a recallable strategy atom', async () => {
    strategies.propose({ workspaceId: ctx.workspace.id, appId, key: 'a', hypothesis: 'ask a question', metric: 'conversion_rate' });
    strategies.recordOutcome({ workspaceId: ctx.workspace.id, appId, key: 'a', success: true });
    const promoted = await strategies.promote(ctx.workspace.id, appId, 'a');
    expect(promoted?.status).toBe('proven');
    const atoms = ctx.db.select().from(schema.memoryEpisodes)
      .where(and(eq(schema.memoryEpisodes.workspaceId, ctx.workspace.id), eq(schema.memoryEpisodes.scopeId, appId))).all()
      .filter((r) => ((r.tags as string[] | null) ?? []).includes('strategy'));
    expect(atoms.length).toBeGreaterThanOrEqual(1);
  });
});
